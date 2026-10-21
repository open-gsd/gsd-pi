// Project/App: gsd-pi
// File Purpose: Interactive terminal tool execution renderer for commands, tool calls, diffs, images, and summaries.
import { normalizeToolArguments } from "@gsd/pi-ai";
import {
	allocateImageId,
	Box,
	Container,
	getCapabilities,
	Image,
	isImageLine,
	type ImageDimensions,
	imageFallback,
	Spacer,
	style,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	padRight,
} from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition, ToolRenderContext } from "@gsd/pi-coding-agent/core/extensions/types.js";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "@gsd/pi-coding-agent/core/tools/edit-diff.js";
import { allTools } from "@gsd/pi-coding-agent/core/tools/index.js";
import { getReadTuiMaxDisplayLines } from "@gsd/pi-coding-agent/core/tools/read.js";
import { getDisplayReason } from "@gsd/pi-coding-agent/core/tools/render-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@gsd/pi-coding-agent/core/tools/truncate.js";
import { convertToPng } from "@gsd/pi-coding-agent/utils/image-convert.js";
import { sanitizeBinaryOutput } from "@gsd/pi-coding-agent/utils/shell.js";
import { getLanguageFromPath, highlightCode, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { shortenPath } from "@gsd/pi-coding-agent/utils/shorten-path.js";
import { renderDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
import {
	renderCommandCard,
	renderCompactToolStrip,
	renderPlainToolMessage,
	collapseBlankLines,
	isRailAnimationEnabled,
	rightAlign,
	type StatusTone,
} from "./transcript-design.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
// During partial write tool-call streaming, re-highlight the first N lines fully
// to keep multiline tokenization mostly correct without re-highlighting the full file.
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
// Expanded in-flight tool cards animate their rail by re-rendering the transcript
// on a fixed-cadence timer. The cadence is matched to the rail's own step
// (RUNNING_RAIL_FRAME_MS in transcript-design): one re-render == one cell of head
// movement, so the motion is smooth and no frame is wasted. Collapsed strips have
// no animated rail; their only self-changing field is the elapsed whole-second
// counter, so they refresh on a slower cadence. Both timers are gated by the
// `terminal.toolRailAnimation` user setting (isRailAnimationEnabled): when it is
// off, the timer is never armed and the rail renders statically, so even a tool
// that runs for 30 minutes costs zero idle CPU. (A genuinely hung tool is finalized
// at the source by agent-loop's raceToolExecutionAgainstAbort, which gives the card
// a result and lets the timer stop on its own.)
const RUNNING_RAIL_RENDER_INTERVAL_MS = 70;
const RUNNING_COMPACT_RENDER_INTERVAL_MS = 1000;

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

/**
 * Normalize control characters for terminal preview rendering.
 * Keep tool arguments unchanged, sanitize only display text.
 */
function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null; // Invalid type
}

/**
 * Split a Claude Code MCP tool name (`mcp__<server>__<tool>`) into its parts.
 * Returns null for non-prefixed names. Duplicated from the claude-code-cli
 * extension (parseMcpToolName) so this package doesn't have to import across
 * the resources/extensions boundary.
 */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice("mcp__".length);
	const delim = rest.indexOf("__");
	if (delim <= 0 || delim === rest.length - 2) return null;
	return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}

/**
 * Prettify a raw tool name for display. Prefers the registered `label`
 * ("Complete Slice") when available; otherwise strips a leading `gsd_`
 * prefix and converts snake_case to Title Case.
 */
function prettifyToolName(name: string, label?: string): string {
	if (label && label.trim().length > 0) return label;
	const stripped = name.replace(/^gsd_/, "");
	if (stripped.length === 0) return name;
	return stripped
		.split("_")
		.map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
		.join(" ");
}

const COMPACT_ARG_VALUE_LIMIT = 60;
const GENERIC_OUTPUT_PREVIEW_LINES = 10;
const GENERIC_ARGS_JSON_PREVIEW_LINES = 10;

export type ToolExecutionPhase = {
	label: string;
	count: number;
	durationMs: number;
	targets?: string[];
	actionLabel?: string;
};

type ToolTargetMetadata = {
	kind?: string;
	action?: string;
	inputPath?: string;
	resolvedPath?: string;
	pattern?: string;
	glob?: string;
	line?: number;
	range?: {
		start?: number;
		end?: number;
	};
};

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function formatCommandPreview(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function appendLineOrRange(displayPath: string | undefined, target: ToolTargetMetadata): string | undefined {
	if (!displayPath) return undefined;
	if (typeof target.line === "number" && Number.isFinite(target.line)) {
		return `${displayPath}:${target.line}`;
	}
	const start = target.range?.start;
	if (typeof start === "number" && Number.isFinite(start)) {
		const end = target.range?.end;
		const suffix =
			typeof end === "number" && Number.isFinite(end) && end !== start
				? `${start}-${end}`
				: `${start}`;
		return `${displayPath}:${suffix}`;
	}
	return displayPath;
}

function formatToolTarget(target: ToolTargetMetadata): string | undefined {
	const path = target.resolvedPath || target.inputPath;
	const displayPath = path ? shortenPath(path) : undefined;
	if (target.kind === "search") {
		const searchTarget = displayPath ?? target.inputPath ?? ".";
		const label = target.pattern ? `${target.pattern} in ${searchTarget}` : searchTarget;
		return target.glob ? `${label} (${target.glob})` : label;
	}
	return appendLineOrRange(displayPath, target);
}

function directDetailsTarget(details: unknown, action: string): ToolTargetMetadata | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const rawPath = record.resolvedPath ?? record.inputPath ?? record.file_path ?? record.path;
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) return undefined;
	const target: ToolTargetMetadata = {
		kind: "file",
		action,
		resolvedPath: typeof record.resolvedPath === "string" ? record.resolvedPath : rawPath,
		inputPath: typeof record.inputPath === "string" ? record.inputPath : rawPath,
	};
	if (typeof record.line === "number") {
		target.line = record.line;
	}
	const range = record.range;
	if (range && typeof range === "object") {
		const rangeRecord = range as Record<string, unknown>;
		target.range = {
			start: typeof rangeRecord.start === "number" ? rangeRecord.start : undefined,
			end: typeof rangeRecord.end === "number" ? rangeRecord.end : undefined,
		};
	}
	return target;
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = str(args[key]);
		if (value === null) continue;
		if (value) return value;
	}
	return "";
}

function formatArgsPathTarget(path: string | null, args: Record<string, unknown>): string | undefined {
	if (!path) return undefined;
	const start = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	const range =
		start !== undefined || limit !== undefined
			? {
					start: start ?? 1,
					end: limit !== undefined ? (start ?? 1) + Math.max(0, limit - 1) : undefined,
				}
			: undefined;
	return appendLineOrRange(shortenPath(path), { range });
}

function stripLineSuffix(target: string): string {
	return target.replace(/:\d+(?:-\d+)?$/, "");
}

function uniqueTargets(targets: string[] | undefined): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const target of targets ?? []) {
		if (!target || seen.has(target)) continue;
		seen.add(target);
		unique.push(target);
	}
	return unique;
}

function summarizePhaseLabel(phase: ToolExecutionPhase): string {
	const phaseTargets = uniqueTargets(phase.targets);
	const baseTargets = uniqueTargets(phaseTargets.map(stripLineSuffix));
	if (phase.label === "File changes" && baseTargets.length > 0) {
		const fileWord = baseTargets.length === 1 ? "file" : "files";
		const actionWord =
			phase.actionLabel === "write"
				? phase.count === 1
					? "write"
					: "writes"
				: phase.actionLabel === undefined
					? phase.count === 1
						? "action"
						: "actions"
					: phase.count === 1
						? "edit"
						: "edits";
		return `${phase.label} · ${baseTargets.length} ${fileWord}, ${phase.count} ${actionWord}`;
	}
	if (phase.label === "Context reads" && baseTargets.length > 0) {
		const fileWord = baseTargets.length === 1 ? "file" : "files";
		return `${phase.label} · ${baseTargets.length} ${fileWord}`;
	}
	if (phase.label === "Setup / shell" && phaseTargets.length > 0) {
		return `${phase.label} · ${phase.count} ${phase.count === 1 ? "command" : "commands"}`;
	}
	return `${phase.label} ${phase.count} ${phase.count === 1 ? "action" : "actions"}`;
}

function summarizePhaseTargets(phase: ToolExecutionPhase, width: number): string | undefined {
	const phaseTargets = uniqueTargets(phase.targets);
	if (phaseTargets.length === 0) return undefined;
	const shown = phaseTargets.slice(0, 3);
	const suffix = phaseTargets.length > shown.length ? ` +${phaseTargets.length - shown.length} more` : "";
	return truncateToWidth(shown.join(" · ") + suffix, width, "");
}

/**
 * Format tool args for the generic-renderer fallback. Produces a one-line
 * `k=v, k=v` summary when every value is a primitive that fits inline; falls
 * back to a truncated JSON dump for structurally complex args.
 */
function formatCompactArgs(args: unknown, expanded: boolean): string {
	if (args == null) return "";
	if (typeof args !== "object") return String(args);

	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return "";

	const allPrimitive = entries.every(([, value]) => {
		const t = typeof value;
		return t === "number" || t === "boolean" || t === "string" || value == null;
	});

	if (allPrimitive) {
		return entries
			.map(([key, value]) => {
				if (typeof value === "string") {
					const truncated =
						!expanded && value.length > COMPACT_ARG_VALUE_LIMIT
							? `${value.slice(0, COMPACT_ARG_VALUE_LIMIT - 1)}…`
							: value;
					return `${key}=${JSON.stringify(truncated)}`;
				}
				if (value == null) return `${key}=null`;
				return `${key}=${String(value)}`;
			})
			.join(", ");
	}

	// Complex args: show truncated JSON.
	const lines = JSON.stringify(args, null, 2).split("\n");
	const maxLines = expanded ? lines.length : GENERIC_ARGS_JSON_PREVIEW_LINES;
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(0, maxLines).join("\n") + "\n...";
}

function stableJsonStringify(value: unknown): string {
	return JSON.stringify(value, (_key, nestedValue) => {
		if (nestedValue == null || typeof nestedValue !== "object" || Array.isArray(nestedValue)) {
			return nestedValue;
		}
		return Object.fromEntries(
			Object.keys(nestedValue as Record<string, unknown>)
				.sort()
				.map((key) => [key, (nestedValue as Record<string, unknown>)[key]]),
		);
	});
}

function normalizeComparableArgs(toolName: string, args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	return normalizeToolArguments(toolName, { ...(args as Record<string, unknown>) });
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: any;
	private expanded = false;
	private explicitlyCollapsed = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition;
	private ui: TUI;
	private cwd: string;
	private readonly startedAt = Date.now();
	private endedAt: number | undefined;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Cached resolved image dimensions to avoid re-triggering async parsing
	// when updateDisplay() recreates Image components (#3455).
	private resolvedImageDimensions: Map<number, ImageDimensions> = new Map();
	// Stable Kitty image ids, keyed by image index. updateDisplay() destroys and
	// recreates Image components on every streaming tick; without a stable id each
	// recreation would call allocateImageId() and get a fresh random id, so the
	// Kitty placement key (imageId, p) would change every render and the terminal
	// would STACK a new placement instead of replacing the old one — painting
	// overlapping copies over the chat and footer. Reusing one id per image index
	// keeps the placement identity stable so re-emits replace in place.
	private stableImageIds: Map<number, number> = new Map();
	// Incremental syntax highlighting cache for write tool call args
	private writeHighlightCache?: WriteHighlightCache;
	// When true, this component intentionally renders no lines
	private hideComponent = false;
	private toolRenderState: Record<string, unknown> = {};
	private runningRailTimer: ReturnType<typeof setInterval> | undefined;
	private runningRailTimerIntervalMs: number | undefined;

	private createRenderContext(): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: String(this.args?.id ?? this.toolName),
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent: undefined,
			state: this.toolRenderState,
			cwd: this.cwd,
			executionStarted: true,
			argsComplete: !this.isPartial,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private get normalizedToolName(): string {
		return typeof this.toolName === "string" ? this.toolName.toLowerCase() : "";
	}

	/** Match pending tool calls when stream adapters disagree on toolCallId. */
	matchesInvocation(toolName: string, args: unknown): boolean {
		const other = typeof toolName === "string" ? toolName.toLowerCase() : "";
		if (this.normalizedToolName !== other) return false;
		return (
			stableJsonStringify(normalizeComparableArgs(this.normalizedToolName, this.args) ?? null) ===
			stableJsonStringify(normalizeComparableArgs(other, args) ?? null)
		);
	}

	/** True while the tool call is still running (no final result yet). */
	isInFlight(): boolean {
		return this.isPartial || !this.result;
	}

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.toolDefinition = toolDefinition;
		this.ui = ui;
		this.cwd = cwd;

		this.contentBox = new Box(0, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 0, 0, (text: string) => theme.bg("toolPendingBg", text));

		// Use contentBox for bash (visual truncation) or custom tools with custom renderers
		// Use contentText for built-in tools (including overrides without custom renderers)
		if (this.normalizedToolName === "bash" || (toolDefinition && !this.shouldUseBuiltInRenderer())) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	/**
	 * Check if we should use built-in rendering for this tool.
	 * Returns true if the tool name is a built-in AND either there's no toolDefinition
	 * or the toolDefinition doesn't provide custom renderers.
	 */
	private shouldUseBuiltInRenderer(): boolean {
		const normalizedToolName = this.normalizedToolName;
		const isBuiltInName = normalizedToolName in allTools;
		const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
		return isBuiltInName && !hasCustomRenderers;
	}

	dispose(): void {
		this.stopRunningRailTimer();
		this.convertedImages.clear();
		this.stableImageIds.clear();
		this.imageComponents = [];
		this.imageSpacers = [];
		this.editDiffPreview = undefined;
		this.writeHighlightCache = undefined;
		this.result = undefined;
	}

	private getRunningRenderIntervalMs(): number | undefined {
		if (!this.isInFlight() || this.hideComponent || !isRailAnimationEnabled()) {
			return undefined;
		}
		return this.showExpandedBody() ? RUNNING_RAIL_RENDER_INTERVAL_MS : RUNNING_COMPACT_RENDER_INTERVAL_MS;
	}

	private syncRunningRailTimer(): void {
		const intervalMs = this.getRunningRenderIntervalMs();
		if (intervalMs === undefined) {
			this.stopRunningRailTimer();
			return;
		}
		if (this.runningRailTimer && this.runningRailTimerIntervalMs === intervalMs) return;

		this.stopRunningRailTimer();
		this.runningRailTimerIntervalMs = intervalMs;
		this.runningRailTimer = setInterval(() => {
			// Stop or re-arm if the tool finishes, is hidden, the animation setting is
			// toggled, or the card switches between compact and expanded rendering.
			if (this.getRunningRenderIntervalMs() !== intervalMs) {
				this.syncRunningRailTimer();
				return;
			}
			this.ui.requestRender();
		}, intervalMs);
		this.runningRailTimer.unref?.();
	}

	/**
	 * Re-evaluate the running-rail timer after the `terminal.toolRailAnimation`
	 * setting is toggled live. Arms the timer if animation is now on (and the card
	 * is still in-flight) or stops it if now off; the static-vs-sweep rail picks up
	 * the new setting on the next render.
	 */
	refreshRailAnimation(): void {
		this.syncRunningRailTimer();
	}

	private stopRunningRailTimer(): void {
		if (!this.runningRailTimer) return;
		clearInterval(this.runningRailTimer);
		this.runningRailTimer = undefined;
		this.runningRailTimerIntervalMs = undefined;
	}

	updateArgs(args: any): void {
		this.args = args;
		if (this.normalizedToolName === "write" && this.isPartial) {
			this.updateWriteHighlightCacheIncremental();
		}
		this.updateDisplay();
	}

	private highlightSingleLine(line: string, lang: string): string {
		const highlighted = highlightCode(line, lang);
		return highlighted[0] ?? "";
	}

	private refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
		const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
		if (prefixCount === 0) return;

		const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
		const prefixHighlighted = highlightCode(prefixSource, cache.lang);
		for (let i = 0; i < prefixCount; i++) {
			cache.highlightedLines[i] =
				prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
		}
	}

	private rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): void {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		const displayContent = normalizeDisplayText(fileContent);
		const normalized = replaceTabs(displayContent);
		this.writeHighlightCache = {
			rawPath,
			lang,
			rawContent: fileContent,
			normalizedLines: normalized.split("\n"),
			highlightedLines: highlightCode(normalized, lang),
		};
	}

	private updateWriteHighlightCacheIncremental(): void {
		const rawPath = str(this.args?.file_path ?? this.args?.path);
		const fileContent = str(this.args?.content);
		if (rawPath === null || fileContent === null) {
			this.writeHighlightCache = undefined;
			return;
		}

		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		if (!this.writeHighlightCache) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		const cache = this.writeHighlightCache;
		if (cache.lang !== lang || cache.rawPath !== rawPath) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (!fileContent.startsWith(cache.rawContent)) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (fileContent.length === cache.rawContent.length) {
			return;
		}

		const deltaRaw = fileContent.slice(cache.rawContent.length);
		const deltaDisplay = normalizeDisplayText(deltaRaw);
		const deltaNormalized = replaceTabs(deltaDisplay);
		cache.rawContent = fileContent;

		if (cache.normalizedLines.length === 0) {
			cache.normalizedLines.push("");
			cache.highlightedLines.push("");
		}

		const segments = deltaNormalized.split("\n");
		const lastIndex = cache.normalizedLines.length - 1;
		cache.normalizedLines[lastIndex] += segments[0];
		cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

		for (let i = 1; i < segments.length; i++) {
			cache.normalizedLines.push(segments[i]);
			cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
		}

		this.refreshWriteHighlightPrefix(cache);
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial) {
			this.endedAt = this.endedAt ?? Date.now();
		}
		if (this.normalizedToolName === "write" && !isPartial) {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.maybeConvertImagesForKitty();
	}

	/**
	 * Mark a tool call as historical when replaying from session context and
	 * no matching tool result is available. Happens after compaction squashes
	 * tool_result messages out of history — the tool call block survives but
	 * the result is gone. Without this, the component stays in "Running" state
	 * forever even though the tool completed long ago.
	 */
	markHistoricalNoResult(): void {
		if (this.result) return; // real result already set, nothing to do
		this.isPartial = false;
		this.endedAt = this.endedAt ?? Date.now();
		this.result = {
			content: [],
			isError: false,
		};
		this.updateDisplay();
	}

	/**
	 * Finalize a pending tool call as failed/interrupted while preserving any streamed partial output.
	 *
	 * Guard: a tool that already produced a settled, non-partial result must NOT be
	 * touched just because the surrounding turn was aborted (e.g. the user pressed
	 * ESC during a later tool's await). Only genuinely-incomplete tool calls should
	 * be marked interrupted.
	 */
	completeWithError(message?: string): void {
		if (this.result && !this.isPartial) {
			return;
		}
		this.isPartial = false;
		this.endedAt = this.endedAt ?? Date.now();
		if (this.result) {
			let content = this.result.content;
			if (message) {
				const alreadyHasMessage = content.some((block) => block.type === "text" && block.text === message);
				if (!alreadyHasMessage) {
					content = [...content, { type: "text", text: message }];
				}
			}
			this.result = { ...this.result, content, isError: true };
		} else {
			this.result = {
				content: message ? [{ type: "text", text: message }] : [],
				isError: true,
			};
		}
		this.updateDisplay();
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// Only needed for Kitty protocol
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// Convert async
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.explicitlyCollapsed = !expanded;
		this.updateDisplay();
	}

	private shouldDefaultExpandBody(): boolean {
		// If the user explicitly collapsed (ctrl+o), don't auto-expand even for
		// edit/write tools — the global collapse must be respected.
		if (this.explicitlyCollapsed) return false;
		if (this.expanded) return true;
		if (this.result?.isError) return false;
		return false;
	}

	private showExpandedBody(): boolean {
		return this.shouldDefaultExpandBody();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		const frameWidth = Math.max(20, width);
		const contentWidth = Math.max(1, frameWidth);
		const frameTone: "pending" | "success" | "error" =
			this.result?.isError ? "error" : this.isPartial || !this.result ? "pending" : "success";
		const elapsed = formatElapsed((this.endedAt ?? Date.now()) - this.startedAt);
		const statusWord = this.isPartial || !this.result ? "running" : this.result.isError ? "failed" : "success";
		const frameStatus = `${statusWord} · ${elapsed}`;
		const parsed = parseMcpToolName(this.toolName);
		const frameLabel = parsed
			? `${parsed.server}·${parsed.tool}`
			: prettifyToolName(this.toolName, this.toolDefinition?.label) || "unknown";
		const recommendedTone: StatusTone =
			frameTone === "pending" ? "running" : frameTone === "error" ? "error" : "success";

		if (this.normalizedToolName === "bash" && !this.showExpandedBody() && !this.result?.isError) {
			const command = str(this.args?.command);
			return renderCommandCard(command && command.length > 0 ? formatCommandPreview(command) : frameLabel, frameWidth, {
				status: frameStatus,
				tone: recommendedTone,
			});
		}
		const hasImages = this.result?.content?.some((block) => block.type === "image") ?? false;
		if (!this.showExpandedBody() && !this.result?.isError && !hasImages) {
			const compactTarget = this.getCompactTarget();
			return renderCompactToolStrip(frameLabel, compactTarget, frameWidth, {
				status: frameStatus,
				tone: recommendedTone,
				hidden: !this.isPartial && !!this.result,
			});
		}
		// collapseBlankLines merges consecutive blank rows. An inline image reserves
		// its height as (rows-1) trailing blank padding lines after the sequence;
		// collapsing those would shrink a tall image to a single row and the terminal
		// would paint the full image over everything below it. Preserve the exact
		// line structure whenever the content includes an image.
		const renderedBody = super.render(contentWidth);
		const lines = hasImages || renderedBody.some((l) => isImageLine(l))
			? renderedBody
			: collapseBlankLines(renderedBody);
		const rightParts = [frameStatus];
		if (this.expanded) {
			rightParts.push("ctrl+o collapse");
		}
		return renderPlainToolMessage(lines, frameWidth, {
			title: frameLabel,
			target: this.getCompactTarget(),
			meta: rightParts.join(" · "),
			tone: recommendedTone,
		});
	}

	private shouldRenderCompactSuccess(): boolean {
		if (this.expanded || this.isPartial || !this.result || this.result.isError) return false;
		const hasImages = this.result.content?.some((block) => block.type === "image") ?? false;
		return !hasImages;
	}

	getRollupPhase(): ToolExecutionPhase | null {
		if (!this.shouldRenderCompactSuccess()) return null;
		const label = this.getPhaseLabel();
		const endedAt = this.endedAt ?? Date.now();
		const target = this.getCompactTarget();
		return {
			label,
			count: 1,
			durationMs: Math.max(0, endedAt - this.startedAt),
			targets: target ? [target] : undefined,
			actionLabel: this.getCompactAction(),
		};
	}

	private getPhaseLabel(): string {
		const name = this.normalizedToolName;
		const displayName = prettifyToolName(this.toolName, this.toolDefinition?.label);

		if (name === "bash") return "Setup / shell";
		if (name === "read" || name === "ls" || name === "find" || name === "grep") return "Context reads";
		if (name === "write" || name === "edit") return "File changes";
		if (name === "web_search" || displayName === "ToolSearch") return "Discovery";
		if (displayName === "Memory Query" || displayName === "Memory Capture" || displayName === "Gsd Graph") {
			return "Memory lookups";
		}
		if (displayName === "Update Requirement" || displayName === "Save Requirement") return "Requirement writes";
		if (displayName.startsWith("Complete ")) return "Finalization";
		return "Other tool actions";
	}

	private getCompactAction(): string {
		const target = this.getTargetMetadata();
		if (target?.action) return target.action === "list" ? "ls" : target.action;
		return this.normalizedToolName;
	}

	private getTargetMetadata(): ToolTargetMetadata | undefined {
		const target = this.result?.details?.target;
		if (target && typeof target === "object") return target;
		return directDetailsTarget(this.result?.details, this.normalizedToolName);
	}

	private getCompactTarget(): string | undefined {
		const metadata = this.getTargetMetadata();
		const metadataTarget = metadata ? formatToolTarget(metadata) : undefined;
		if (metadataTarget) return metadataTarget;

		const path = firstStringArg(this.args ?? {}, ["file_path", "path", "notebook_path"]);
		if (path === null) return undefined;
		if (this.normalizedToolName === "read" || this.normalizedToolName === "hashline_read") {
			return formatArgsPathTarget(path, this.args);
		}
		if (this.normalizedToolName === "write" || this.normalizedToolName === "edit") {
			return path ? shortenPath(path) : undefined;
		}
		if (this.normalizedToolName === "ls") {
			return path ? shortenPath(path) : undefined;
		}
		if (this.normalizedToolName === "find") {
			const pattern = str(this.args?.pattern);
			if (pattern) return path ? `${pattern} in ${shortenPath(path)}` : pattern;
			return path ? shortenPath(path) : undefined;
		}
		if (this.normalizedToolName === "grep") {
			const pattern = str(this.args?.pattern);
			const glob = str(this.args?.glob);
			const label = pattern ? (path ? `${pattern} in ${shortenPath(path)}` : pattern) : path ? shortenPath(path) : undefined;
			if (!label) return glob || undefined;
			return glob ? `${label} (${glob})` : label;
		}
		return undefined;
	}

	private updateDisplay(): void {
		// Tool body now uses transparent background; status is conveyed in the frame header.
		const bgFn = (text: string) => text;

		const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
		let customRendererHasContent = false;
		this.hideComponent = false;

		// Use built-in rendering for built-in tools (or overrides without custom renderers)
		if (useBuiltInRenderer) {
			if (this.normalizedToolName === "bash") {
				// Bash uses Box with visual line truncation
				this.contentBox.setBgFn(bgFn);
				this.contentBox.clear();
				this.renderBashContent();
			} else {
				// Other built-in tools: use Text directly with caching
				this.contentText.setCustomBgFn(bgFn);
				this.contentText.setText(this.formatToolExecution());
			}
		} else if (this.toolDefinition) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (this.toolDefinition.renderCall) {
				try {
					const callComponent = this.toolDefinition.renderCall(this.args, theme, this.createRenderContext());
					if (callComponent !== undefined) {
						this.contentBox.addChild(callComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(
						new Text(
							theme.fg(
								"toolTitle",
								theme.bold(prettifyToolName(this.toolName, this.toolDefinition?.label)),
							),
							0,
							0,
						),
					);
					customRendererHasContent = true;
				}
			} else {
				// No custom renderCall, show prettified tool name
				this.contentBox.addChild(
					new Text(
						theme.fg(
							"toolTitle",
							theme.bold(prettifyToolName(this.toolName, this.toolDefinition?.label)),
						),
						0,
						0,
					),
				);
				customRendererHasContent = true;
			}

			// Render result component if we have a result
			if (this.result && this.toolDefinition.renderResult) {
				try {
					const rendererResult = {
						content: this.result.content as any,
						details: this.result.details,
						isError: this.result.isError,
					};
					const resultComponent = this.toolDefinition.renderResult(
						rendererResult,
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.createRenderContext(),
					);
					if (resultComponent !== undefined) {
						this.contentBox.addChild(resultComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						customRendererHasContent = true;
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					customRendererHasContent = true;
				}
			}
		} else {
			// Unknown tool with no registered definition - show generic fallback
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
			const caps = getCapabilities();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (caps.images === "kitty" && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					// Pass cached dimensions to avoid re-triggering async parsing
					// when updateDisplay() recreates Image components (#3455).
					const cachedDims = this.resolvedImageDimensions.get(i);
					// Reuse a stable Kitty image id per image index so the recreated
					// component keeps the same placement identity across redraws
					// (otherwise every updateDisplay() stacks a new placement).
					let stableImageId = this.stableImageIds.get(i);
					if (caps.images === "kitty" && stableImageId === undefined) {
						stableImageId = allocateImageId();
						this.stableImageIds.set(i, stableImageId);
					}
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60, imageId: stableImageId },
						cachedDims,
					);
					if (!cachedDims) {
						const imgIdx = i;
						imageComponent.setOnDimensionsResolved(() => {
							// Cache resolved dimensions so future updateDisplay() calls
							// don't re-trigger async parsing → infinite loop (#3455).
							const dims = imageComponent.getDimensions?.();
							if (dims) this.resolvedImageDimensions.set(imgIdx, dims);
							// Just re-render — don't call updateDisplay() which would
							// destroy and recreate all Image components.
							this.ui.requestRender();
						});
					}
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (!useBuiltInRenderer && this.toolDefinition) {
			this.hideComponent = !customRendererHasContent && this.imageComponents.length === 0;
		}
		this.syncRunningRailTimer();
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts)
	 */
	private renderBashContent(): void {
		const command = str(this.args?.command);
		const timeout = this.args?.timeout as number | undefined;

		// Header
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		const commandDisplay =
			command === null ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
		this.contentBox.addChild(
			new Text(theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix, 0, 0),
		);

		if (this.result) {
			const output = this.getTextOutput().trim();

			if (output) {
				// Style each line for the output
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					this.contentBox.addChild(new Text(styledOutput, 0, 0));
				} else {
					// Use visual line truncation when collapsed with width-aware caching
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;
					let cachedSkipped: number | undefined;

					this.contentBox.addChild({
						render: (width: number) => {
							if (cachedLines === undefined || cachedWidth !== width) {
								const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
								cachedLines = result.visualLines;
								cachedSkipped = result.skippedCount;
								cachedWidth = width;
							}
							if (cachedSkipped && cachedSkipped > 0) {
								const hint =
									theme.fg("muted", `... (${cachedSkipped} earlier lines,`) +
									` ${keyHint("expandTools", "to expand")})`;
								return [truncateToWidth(hint, width, "..."), ...cachedLines];
							}
							return cachedLines;
						},
						invalidate: () => {
							cachedWidth = undefined;
							cachedLines = undefined;
							cachedSkipped = undefined;
						},
					});
				}
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			const cwd = this.result.details?.cwd;
			if (this.expanded && typeof cwd === "string" && cwd.length > 0) {
				this.contentBox.addChild(new Text(theme.fg("muted", `cwd ${shortenPath(cwd)}`), 0, 0));
			}
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(theme.fg("warning", `[${warnings.join(". ")}]`), 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const displayReason = this.result.isError ? getDisplayReason(this.result.details) : undefined;
		if (displayReason) {
			return sanitizeBinaryOutput(stripAnsi(displayReason)).replace(/\r/g, "");
		}

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					return imageFallback(img.mimeType);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";
		const invalidArg = theme.fg("error", "[invalid arg]");
		const normalizedToolName = this.normalizedToolName;

		if (normalizedToolName === "read") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;
			const offset = this.args?.offset;
			const limit = this.args?.limit;

			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "read failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const rawOutput = this.getTextOutput();
				// Strip hashline prefixes (e.g. "1#BQ:content") for TUI display
				const output = rawOutput.replace(/^(\s*)\d+#[ZPMQVRWSNKTXJBYH]{2}:/gm, "$1");
				const rawPath = str(this.args?.file_path ?? this.args?.path);
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
				const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

				const maxLines = getReadTuiMaxDisplayLines(this.expanded);
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += this.expanded
						? theme.fg("muted", `\n... (${remaining} more lines hidden from display)`)
						: `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
				}

				const truncation = this.result.details?.truncation;
				if (truncation?.truncated) {
					if (truncation.firstLineExceedsLimit) {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
							);
					} else if (truncation.truncatedBy === "lines") {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
							);
					} else {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
							);
					}
				}
			}
		} else if (normalizedToolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));

			if (fileContent === null) {
				text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
			} else if (fileContent) {
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

				let lines: string[];
				if (lang) {
					const cache = this.writeHighlightCache;
					if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
						lines = cache.highlightedLines;
					} else {
						const displayContent = normalizeDisplayText(fileContent);
						const normalized = replaceTabs(displayContent);
						lines = highlightCode(normalized, lang);
						this.writeHighlightCache = {
							rawPath,
							lang,
							rawContent: fileContent,
							normalizedLines: normalized.split("\n"),
							highlightedLines: lines,
						};
					}
				} else {
					lines = normalizeDisplayText(fileContent).split("\n");
					this.writeHighlightCache = undefined;
				}

				const totalLines = lines.length;
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
						` ${keyHint("expandTools", "to expand")})`;
				}
			}

			// Show error if tool execution failed
			if (this.result?.isError) {
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			}
		} else if (normalizedToolName === "edit") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			// Build path display, appending :line if we have diff info
			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const firstChangedLine =
				(this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
					? this.editDiffPreview.firstChangedLine
					: undefined) ||
				(this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);
			if (firstChangedLine) {
				pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.result?.details?.diff) {
				// Tool executed successfully - use the diff from result
				// This takes priority over editDiffPreview which may have a stale error
				// due to race condition (async preview computed after file was modified)
				text += `\n\n${renderDiff(this.result.details.diff, { filePath: rawPath ?? undefined })}`;
			} else if (this.editDiffPreview) {
				// Use cached diff preview (before tool executes)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					text += `\n\n${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
				}
			}
		} else if (normalizedToolName === "ls") {
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "ls failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const entryLimit = this.result.details?.entryLimitReached;
				const truncation = this.result.details?.truncation;
				if (entryLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (entryLimit) {
						warnings.push(`${entryLimit} entries limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "find") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "find failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const resultLimit = this.result.details?.resultLimitReached;
				const truncation = this.result.details?.truncation;
				if (resultLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (resultLimit) {
						warnings.push(`${resultLimit} results limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "grep") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const glob = str(this.args?.glob);
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "grep failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 15;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const matchLimit = this.result.details?.matchLimitReached;
				const truncation = this.result.details?.truncation;
				const linesTruncated = this.result.details?.linesTruncated;
				if (matchLimit || truncation?.truncated || linesTruncated) {
					const warnings: string[] = [];
					if (matchLimit) {
						warnings.push(`${matchLimit} matches limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					if (linesTruncated) {
						warnings.push("some lines truncated");
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "web_search") {
			// Server-side Anthropic web search
			text = theme.fg("toolTitle", theme.bold("web search"));

			if (process.env.PI_OFFLINE === "1") {
				text += "\n\n" + theme.fg("muted", "\u{1F50C} Offline \u{2014} web search unavailable");
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 10;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}
			}
		} else {
			// Generic tool / MCP tool without a registered renderer.
			// The frame header already contains the tool identity, so the body
			// should show only arguments and output.
			const argsText = formatCompactArgs(this.args, this.expanded);
			if (argsText) {
				if (argsText.includes("\n")) {
					text = theme.fg("toolOutput", argsText);
				} else {
					text = theme.fg("toolOutput", argsText);
				}
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : GENERIC_OUTPUT_PREVIEW_LINES;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;
					const outputText = displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
					text += `${text ? "\n\n" : ""}${outputText}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}
			}
		}

		return text;
	}
}

export class ToolPhaseSummaryComponent extends Container {
	constructor(private readonly phases: ToolExecutionPhase[]) {
		super();
	}

	getPhases(): ToolExecutionPhase[] {
		return this.phases.map((phase) => ({ ...phase, targets: phase.targets ? [...phase.targets] : undefined }));
	}

	override render(width: number): string[] {
		const frameWidth = Math.max(20, width);
		const rows = this.phases.flatMap((phase) => {
			const left = summarizePhaseLabel(phase);
			const right = `success · ${formatElapsed(phase.durationMs)}`;
			const contentWidth = Math.max(1, frameWidth - 2);
			const leftWidth = Math.max(1, contentWidth - visibleWidth(right) - 1);
			const leftText = truncateToWidth(left, leftWidth, "");
			const leftStyled = theme.fg("toolSuccess", leftText);
			const rightStyled = theme.fg("toolSuccess", right);
			const summaryRow = padRight(truncateToWidth(rightAlign(leftStyled, rightStyled, frameWidth), frameWidth, ""), frameWidth);
			const targetRow = summarizePhaseTargets(phase, frameWidth);
			return targetRow
				? [summaryRow, padRight(truncateToWidth(theme.fg("muted", truncateToWidth(targetRow, frameWidth, "…")), frameWidth, ""), frameWidth)]
				: [summaryRow];
		});

		return rows.length > 0 ? ["", ...rows] : [];
	}
}
