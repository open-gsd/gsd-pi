import { type AgentMessage, uuidv7 } from "@gsd/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@gsd/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.js";
import {
	CURRENT_SESSION_VERSION,
	type BranchSummaryEntry,
	type CompactionEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "./session-manager-types.js";
import { buildSessionContext, getLatestCompactionEntry } from "./session-manager-context.js";
import {
	buildSessionInfosWithConcurrency,
	findMostRecentSession,
	getDefaultSessionDir,
	listSessionsFromDir,
	loadEntriesFromFile,
	type SessionListProgress,
} from "./session-manager-list.js";
import {
	generateSessionEntryId,
	migrateSessionEntries,
	migrateToCurrentVersion,
	parseSessionEntries,
} from "./session-manager-migration.js";

export {
	CURRENT_SESSION_VERSION,
	type BranchSummaryEntry,
	type CompactionEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "./session-manager-types.js";

export {
	buildSessionContext,
	getLatestCompactionEntry,
} from "./session-manager-context.js";

export {
	findMostRecentSession,
	getDefaultSessionDir,
	listSessionsFromDir,
	loadEntriesFromFile,
	type SessionListProgress,
} from "./session-manager-list.js";

export {
	migrateSessionEntries,
	parseSessionEntries,
} from "./session-manager-migration.js";

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
	| "getUsageTotals"
	| "addExternalUsage"
>;

/** Provider-reported usage for work executed outside this session's message entries. */
export interface ExternalUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const EXTERNAL_USAGE_FIELDS: readonly (keyof ExternalUsageSnapshot)[] = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cost",
];

/**
 * `custom` entry type carrying one child's durable usage high-water mark
 * (#2836). Appended whenever a reconcile advances a key's high-water, and
 * folded back into the accumulator when the session file is loaded, so a
 * restart/resume restores prior child cost instead of resetting the footer
 * to parent-only usage. Data shape: `{ key: string, snapshot: ExternalUsageSnapshot }`.
 */
const EXTERNAL_USAGE_ENTRY_TYPE = "external-usage";

/**
 * Validate a durable external-usage record. Returns a short corruption reason
 * for diagnostics (#2836), or undefined when the record is well-formed: shape
 * must be intact and every field a finite number, so a corrupt record is
 * skipped whole (with its warning) instead of partially contributing.
 */
function validateExternalUsageRecord(
	data: { key?: unknown; snapshot?: Record<string, unknown> } | undefined,
): string | undefined {
	if (!data || typeof data !== "object") return "data is missing or not an object";
	if (typeof data.key !== "string" || !data.key) return "key is missing or not a non-empty string";
	if (typeof data.snapshot !== "object" || data.snapshot === null) return "snapshot is missing or not an object";
	const invalidFields = EXTERNAL_USAGE_FIELDS.filter(
		(field) => typeof data.snapshot![field] !== "number" || !Number.isFinite(data.snapshot![field] as number),
	);
	if (invalidFields.length > 0) return `invalid fields: ${invalidFields.join(", ")}`;
	return undefined;
}

function finiteOrZero(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createSessionId(): string {
	return uuidv7();
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private externalUsageByKey: Map<string, { snapshot: ExternalUsageSnapshot; generation: number }> = new Map();
	private externalUsageTotals: ExternalUsageSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	/**
	 * Bumped on every session switch. A reporting child binds to the generation
	 * that owned its first snapshot; once the session switches, that child's
	 * later updates are dropped instead of billing the new session for the old
	 * one's work (a background child can keep reporting across a switch).
	 */
	private externalUsageGeneration = 0;

	/**
	 * External usage is session-scoped: switching or starting a session drops
	 * the totals but keeps the per-key bindings as generation-stamped
	 * tombstones, so a still-running reporter from the old session is dropped
	 * instead of billing the new session for old work (#2821).
	 */
	private _resetExternalUsage(): void {
		this.externalUsageGeneration++;
		this.externalUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	}

	private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile);
		} else {
			this.newSession();
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._resetExternalUsage();
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = loadEntriesFromFile(this.sessionFile);

			// If file was empty or corrupted (no valid header), truncate and start fresh
			// to avoid appending messages without a session header (which breaks the session)
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this._reconstructExternalUsage();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this._resetExternalUsage();
		this.sessionId = options?.id ?? createSessionId();
		if (options?.cwd) {
			this.cwd = resolvePath(options.cwd);
		}
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(this.sessionFile, content);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		if (!hasAssistant) {
			// Mark as not flushed so when assistant arrives, all entries get written
			this.flushed = false;
			return;
		}

		if (!this.flushed) {
			for (const e of this.fileEntries) {
				appendFileSync(this.sessionFile, `${JSON.stringify(e)}\n`);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateSessionEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateSessionEntryId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Also strip durable external-usage records (#2836): branching re-uses
		// this manager for a different session (#2821), and the branched file
		// must not carry the discarded session's child spend — otherwise a
		// later resume of the branch would reconstruct it.
		const strippedUsage = path.some(
			(e) => e.type === "custom" && (e as CustomEntry).customType === EXTERNAL_USAGE_ENTRY_TYPE,
		);
		const pathWithoutLabels = path.filter(
			(e) => e.type !== "label"
				&& !(e.type === "custom" && (e as CustomEntry).customType === EXTERNAL_USAGE_ENTRY_TYPE),
		);
		if (strippedUsage) {
			// Reparent retained entries to their nearest retained ancestor so
			// removing the records cannot orphan a descendant and break the
			// conversation chain. Clone first: the entry objects are still
			// referenced by this session's index and must not be mutated.
			let previousId: string | null = null;
			for (let i = 0; i < pathWithoutLabels.length; i++) {
				pathWithoutLabels[i] = { ...pathWithoutLabels[i]!, parentId: previousId };
				previousId = pathWithoutLabels[i]!.id;
			}
		}

		// Branching re-uses this manager for a different session (#2821): the
		// branched conversation must not inherit the discarded session's
		// external (child-process) usage.
		this._resetExternalUsage();

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateSessionEntryId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Only write the file now if it contains an assistant message.
			// Otherwise defer to _persist(), which creates the file on the
			// first assistant response, matching the newSession() contract
			// and avoiding the duplicate-header bug when _persist()'s
			// no-assistant guard later resets flushed to false.
			const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateSessionEntryId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		// Extract cwd from session header if possible, otherwise use process.cwd()
		const entries = loadEntriesFromFile(resolvedPath);
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
		const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const mostRecent = findMostRecentSession(dir);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		appendFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`);

		// Copy all non-header entries from source
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const sessions = await listSessionsFromDir(dir, onProgress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				onProgress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}

	/**
	 * Usage totals accumulated from this session's own assistant message
	 * entries. With `includeExternalUsage` the reconciled session-scoped
	 * external usage (child-process subagents, #2821) is added on top —
	 * opt-in because consumers derive per-conversation properties (the
	 * footer's cache percentage) from the token fields, and child tokens
	 * must not distort those.
	 */
	getUsageTotals(options?: { includeExternalUsage?: boolean }): {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	} {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;

		for (const entry of this.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			const usage = message.usage;
			if (!usage) continue;
			input += usage.input ?? 0;
			output += usage.output ?? 0;
			cacheRead += usage.cacheRead ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
			cost += usage.cost?.total ?? 0;
		}

		if (options?.includeExternalUsage) {
			input += this.externalUsageTotals.input;
			output += this.externalUsageTotals.output;
			cacheRead += this.externalUsageTotals.cacheRead;
			cacheWrite += this.externalUsageTotals.cacheWrite;
			cost += this.externalUsageTotals.cost;
		}

		return { input, output, cacheRead, cacheWrite, cost };
	}

	/**
	 * Record cumulative provider-reported usage for work executed outside this
	 * session's message entries (child-process subagent sessions, #2821).
	 *
	 * `key` must be stable for the reporting child's execution lifetime. Each
	 * call reconciles the snapshot against the key's high-water mark and banks
	 * only positive per-field deltas, so repeated, late, or replayed partial
	 * updates never double count. A key binds to the session generation that
	 * first reported it: after a session switch, that child's later snapshots
	 * are dropped rather than billing the new session for old work. Totals are
	 * kept for the session's lifetime: child completion and worker-row expiry
	 * never reduce them, and failed or interrupted children keep whatever
	 * usage they already reported.
	 *
	 * Persisted sessions (#2836): a key's first registration (even at zero)
	 * and every high-water advance are appended as `external-usage` custom
	 * entries, so loading the session file again (restart/resume) reconstructs
	 * the same totals through the same positive-delta reconciliation and a
	 * registered child stays owned across a same-session resume. In-memory
	 * sessions keep #2826 behavior.
	 */
	addExternalUsage(key: string, usage: ExternalUsageSnapshot): void {
		const banked = this._bankExternalUsage(key, usage);
		if (!banked) return;
		// Persist the first registration even at zero: the launch path binds
		// keys with a zero snapshot before any await (#2826), and without a
		// durable record a same-session resume would leave that key on a stale
		// generation tombstone, permanently dropping its first real report
		// (#2836). Advances persist the new high-water; repeats stay free.
		if (!banked.changed) return;
		if (!this.persist || !this.sessionFile) return;
		this.appendCustomEntry(EXTERNAL_USAGE_ENTRY_TYPE, { key, snapshot: banked.snapshot });
	}

	/**
	 * Reconcile `usage` for `key` against its high-water mark. Returns the
	 * stored per-key snapshot plus whether this call changed it (first
	 * registration for the key, or a positive delta banked), or undefined when
	 * the report is dropped (empty key, or the key is bound to a superseded
	 * session generation).
	 */
	private _bankExternalUsage(
		key: string,
		usage: ExternalUsageSnapshot,
	): { snapshot: ExternalUsageSnapshot; changed: boolean } | undefined {
		if (!key) return undefined;
		const bound = this.externalUsageByKey.get(key);
		if (bound && bound.generation !== this.externalUsageGeneration) return undefined;
		const previous = bound?.snapshot;
		let advanced = false;
		for (const field of EXTERNAL_USAGE_FIELDS) {
			const value = finiteOrZero(usage[field]);
			const delta = value - finiteOrZero(previous?.[field]);
			if (delta > 0) {
				this.externalUsageTotals[field] += delta;
				advanced = true;
			}
		}
		const snapshot: ExternalUsageSnapshot = {
			input: Math.max(finiteOrZero(usage.input), finiteOrZero(previous?.input)),
			output: Math.max(finiteOrZero(usage.output), finiteOrZero(previous?.output)),
			cacheRead: Math.max(finiteOrZero(usage.cacheRead), finiteOrZero(previous?.cacheRead)),
			cacheWrite: Math.max(finiteOrZero(usage.cacheWrite), finiteOrZero(previous?.cacheWrite)),
			cost: Math.max(finiteOrZero(usage.cost), finiteOrZero(previous?.cost)),
		};
		this.externalUsageByKey.set(key, {
			generation: this.externalUsageGeneration,
			snapshot,
		});
		return { snapshot, changed: advanced || !bound };
	}

	/**
	 * Rebuild the external-usage accumulator from the loaded session file
	 * (#2836): fold the per-key high-water marks recorded by addExternalUsage
	 * back through the same positive-delta reconciliation, in file order, so
	 * repeated or out-of-order durable snapshots reconcile idempotently and a
	 * resumed session starts from its real prior child cost. Entries are read,
	 * never re-written here. A live child whose key was restored reconciles
	 * against the restored high-water (its next cumulative snapshot banks no
	 * delta); a key absent from the file keeps its stale generation tombstone
	 * and stays dropped, as with any session switch (#2826).
	 */
	private _reconstructExternalUsage(): void {
		const records: Array<{ key: string; snapshot: ExternalUsageSnapshot }> = [];
		for (const entry of this.fileEntries) {
			if (entry.type !== "custom") continue;
			const custom = entry as CustomEntry;
			if (custom.customType !== EXTERNAL_USAGE_ENTRY_TYPE) continue;
			const data = custom.data as { key?: unknown; snapshot?: Record<string, unknown> } | undefined;
			const reason = validateExternalUsageRecord(data);
			if (reason) {
				// #2836: corrupt durable usage must surface, never silently
				// lower (or fabricate) the restored total. The entry is
				// skipped; the diagnostic names the session entry.
				console.warn(
					`[session] ignoring corrupt external-usage entry ${custom.id}: ${reason}`,
				);
				continue;
			}
			const raw = data!.snapshot!;
			records.push({
				key: data!.key as string,
				snapshot: {
					input: raw.input as number,
					output: raw.output as number,
					cacheRead: raw.cacheRead as number,
					cacheWrite: raw.cacheWrite as number,
					cost: raw.cost as number,
				},
			});
		}
		// Rebind each restored key to the current generation once: the load
		// bumped it, and a stale tombstone from before the switch must not
		// drop the key's own restored state. The entries themselves then
		// reconcile in file order through the normal positive-delta path, so
		// repeated or out-of-order durable snapshots stay idempotent.
		for (const key of new Set(records.map((record) => record.key))) {
			this.externalUsageByKey.delete(key);
		}
		for (const record of records) {
			this._bankExternalUsage(record.key, record.snapshot);
		}
	}

	wasInterrupted(): boolean {
		return false;
	}
}
