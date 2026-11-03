import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Message, TextContent } from "@gsd/pi-ai";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

import { getAgentDir as getDefaultAgentDir } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionMessageEntry,
} from "./session-manager-types.js";

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(resolvedAgentDir, "sessions", safePath);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const content = readFileSync(resolvedFilePath, "utf8");
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as SessionHeader).id !== "string") {
		return [];
	}

	return entries;
}

const SESSION_ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

function isValidExactSessionEntry(entry: FileEntry, version: number): boolean {
	const value = entry as unknown as Record<string, unknown>;
	if (typeof value.timestamp !== "string" || !value.timestamp.trim()) return false;
	if (version >= 2 && (typeof value.id !== "string" || !value.id.trim()
		|| (value.parentId !== null && typeof value.parentId !== "string"))) return false;

	switch (value.type) {
		case "message": {
			const message = value.message;
			if (!message || typeof message !== "object" || Array.isArray(message)) return false;
			const messageValue = message as { role?: unknown; content?: unknown };
			return typeof messageValue.role === "string"
				&& (typeof messageValue.content === "string" || Array.isArray(messageValue.content));
		}
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "model_change":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "compaction":
			return typeof value.summary === "string" && typeof value.tokensBefore === "number"
				&& (typeof value.firstKeptEntryId === "string"
					|| (version < 2 && typeof value.firstKeptEntryIndex === "number"));
		case "branch_summary":
			return typeof value.fromId === "string" && typeof value.summary === "string";
		case "custom":
			return typeof value.customType === "string";
		case "custom_message":
			return typeof value.customType === "string"
				&& (typeof value.content === "string" || Array.isArray(value.content));
		case "label":
			return typeof value.targetId === "string"
				&& (value.label === undefined || typeof value.label === "string");
		case "session_info":
			return value.name === undefined || typeof value.name === "string";
		default:
			return false;
	}
}

/**
 * Load a session for an exact resume. Unlike loadEntriesFromFile, this never
 * skips malformed lines or treats a missing/invalid header as an empty session.
 */
export function loadExistingEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(resolvedFilePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(code === "ENOENT"
			? "Cannot resume exact GSD session: session file was not found"
			: "Cannot resume exact GSD session: session file could not be read");
	}
	if (!info.isFile()) {
		throw new Error("Cannot resume exact GSD session: path is not a regular file");
	}

	let content: string;
	try {
		content = readFileSync(resolvedFilePath, "utf8");
	} catch {
		throw new Error("Cannot resume exact GSD session: session file could not be read");
	}

	const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		throw new Error("Cannot resume exact GSD session: session file is empty");
	}

	const entries = lines.map((line, index) => {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new Error(`Cannot resume exact GSD session: malformed entry at line ${index + 1}`);
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as FileEntry).type !== "string") {
			throw new Error(`Cannot resume exact GSD session: invalid entry at line ${index + 1}`);
		}
		const type = (entry as FileEntry).type;
		if (index === 0 ? type !== "session" : !SESSION_ENTRY_TYPES.has(type)) {
			throw new Error(`Cannot resume exact GSD session: unsupported entry type at line ${index + 1}`);
		}
		return entry as FileEntry;
	});

	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string" || !header.id.trim()
		|| typeof header.cwd !== "string" || !header.cwd.trim()
		|| typeof header.timestamp !== "string" || !header.timestamp.trim()
		|| (header.version !== undefined && (!Number.isInteger(header.version) || header.version < 1))) {
		throw new Error("Cannot resume exact GSD session: session header is invalid");
	}
	const version = header.version ?? 1;
	if (version > CURRENT_SESSION_VERSION) {
		throw new Error("Cannot resume exact GSD session: session version is newer than this GSD runtime");
	}
	for (let index = 1; index < entries.length; index++) {
		if (!isValidExactSessionEntry(entries[index], version)) {
			throw new Error(`Cannot resume exact GSD session: malformed entry at line ${index + 1}`);
		}
	}
	return entries;
}

function isValidSessionFile(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(512);
		const bytesRead = readSync(fd, buffer, 0, 512, 0);
		closeSync(fd);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		if (!firstLine) return false;
		const header = JSON.parse(firstLine);
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

export function findMostRecentSession(sessionDir: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getLastActivityTime(entries: FileEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const message = (entry as SessionMessageEntry).message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const entryTimestamp = (entry as SessionEntryBase).timestamp;
		if (typeof entryTimestamp === "string") {
			const t = new Date(entryTimestamp).getTime();
			if (!Number.isNaN(t)) {
				lastActivityTime = Math.max(lastActivityTime ?? 0, t);
			}
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries: FileEntry[] = [];
		const lines = content.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// Skip malformed lines
			}
		}

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header.type !== "session") return null;

		const stats = await stat(filePath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;

		for (const entry of entries) {
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const modified = getSessionModifiedDate(entries, header, stats.mtime);

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}
