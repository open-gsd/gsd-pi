// Project/App: gsd-pi
// File Purpose: Shared TUI rendering for the gsd_exec / gsd_uat_exec tools (issue #2914 slice 1).
//
// Presentation only: display text is sanitized and normalized here, but call
// arguments, result content, and persisted values are never mutated. All
// accessors are defensive so legacy rows (historical sessions without the
// newer `details` fields) render fail-soft instead of throwing.

import { Text } from "@gsd/pi-tui";
import { stripAnsi } from "../../shared/mod.js";

/** Longest rendered purpose before elision. */
const PURPOSE_MAX_CHARS = 80;
/** Digest preview budget: rows and per-row characters (visual-row budgeting at narrow widths is the host frame's job). */
const DIGEST_PREVIEW_MAX_LINES = 8;
const DIGEST_PREVIEW_LINE_CHARS = 200;
/** Cap for the legacy (details-less) content fallback. */
const LEGACY_FALLBACK_MAX_LINES = 12;
/** Cap for error-content rendering on execution failures (timeouts, nonzero exits). */
const ERROR_CONTENT_MAX_LINES = 20;
const ERROR_CONTENT_COLLAPSED_LINES = 6;
/** Exact historical footer emitted by exec-tool before recording warnings moved to details. */
const LEGACY_RECORDING_FOOTER_MARKER = "\n--- warning ---\n";
const LEGACY_RECORDING_FOOTER = /^--- warning ---\n(The command ran, but the host did not record this run: [\s\S]*?\.\s+This run is not verification or UAT evidence\.\s+Do not run the command again only to get the output\.)$/;

function extractLegacyRecordingFooter(content: string): { body: string; warning: string } | undefined {
  const markerIndex = content.lastIndexOf(LEGACY_RECORDING_FOOTER_MARKER);
  const markerStart = markerIndex >= 0 ? markerIndex : content.startsWith("--- warning ---\n") ? 0 : -1;
  if (markerStart < 0) return undefined;
  const match = LEGACY_RECORDING_FOOTER.exec(content.slice(markerStart).replace(/^\n/, ""));
  if (!match) return undefined;
  return { body: content.slice(0, markerStart).trimEnd(), warning: match[1]! };
}

type ExecRendererContext = { state?: Record<string, unknown> };
const VT_STRING_SEQUENCE = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

// C0 controls except \n and \t, plus CR, DEL, and C1 — safe Unicode survives.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\u0080-\u009F]/g;
// OSC sequences (hyperlinks, window titles) including their payload text.
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// CSI sequences (SGR, cursor moves, screen clears like ESC[2J).
const CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function detailString(record: Record<string, unknown> | null, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detailNumber(record: Record<string, unknown> | null, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailBoolean(record: Record<string, unknown> | null, key: string): boolean {
	return record?.[key] === true;
}

// Presentation only, kept local to the extension boundary (the native host has
// its own predicate). Do not promote this derived status into stored isError.
function execDisplayFailure(record: Record<string, unknown> | null, details: Record<string, unknown> | null, isPartial: boolean): boolean {
	if (record?.isError === true) return true;
	if (isPartial) return false;
	const exitCode = detailNumber(details, "exit_code");
	return detailBoolean(details, "timed_out") || detailBoolean(details, "aborted") || detailBoolean(details, "force_resolved") ||
		(exitCode !== undefined && exitCode !== 0) || detailString(details, "signal") !== undefined;
}

/** Strip terminal escapes (OSC/CSI/SGR) and control sequences; keep safe Unicode, \n and \t. */
export function sanitizeExecDisplayText(text: string): string {
	return stripAnsi(text.replace(VT_STRING_SEQUENCE, "").replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, ""))
		.replace(CONTROL_CHARS, "").replace(BIDI_CONTROLS, "");
}

/**
 * Display-normalized purpose: whitespace collapsed, control-free, length
 * bounded. Never mutates the original argument or persisted value. Returns
 * undefined for omitted, blank, or non-string values.
 */
export function normalizeExecPurpose(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = sanitizeExecDisplayText(value).replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length <= PURPOSE_MAX_CHARS ? collapsed : `${collapsed.slice(0, PURPOSE_MAX_CHARS - 1)}…`;
}

const RUNTIME_LABELS: Record<string, string> = {
	bash: "Bash",
	sh: "Bash",
	shell: "Bash",
	node: "Node",
	nodejs: "Node",
	js: "Node",
	javascript: "Node",
	python: "Python",
	python3: "Python",
	py: "Python",
};

/**
 * English runtime label mirroring the executor's alias handling: omitted,
 * empty, or whitespace-only means the bash default; unknown values get a
 * neutral script label. Own-property lookup so exotic strings cannot reach
 * inherited Object properties.
 */
export function execRuntimeLabel(runtime: unknown): string {
	if (typeof runtime !== "string") {
		return runtime === undefined || runtime === null ? "Bash" : "Script";
	}
	const normalized = runtime.trim().toLowerCase();
	if (normalized === "") return "Bash";
	return Object.hasOwn(RUNTIME_LABELS, normalized) ? RUNTIME_LABELS[normalized] : "Script";
}

function italicize(theme: ThemeLike, text: string): string {
	return typeof theme.italic === "function" ? theme.italic(text) : text;
}

/** The purpose the UAT executor synthesizes when none was passed (display only). */
function uatSynthesizedPurpose(record: Record<string, unknown> | null): string | undefined {
	const [milestoneId, sliceId, checkId, intent] = ["milestoneId", "sliceId", "checkId", "intent"]
		.map(key => normalizeExecPurpose(detailString(record, key)));
	if (!milestoneId || !sliceId || !checkId || !intent) return undefined;
	return `UAT ${milestoneId}/${sliceId}/${checkId} (${intent})`;
}

function buildCallText(label: string, purpose: string | undefined, runtime: unknown, theme: ThemeLike, context?: ExecRendererContext): Text {
	// Only this native host opts in; standalone/older hosts retain the call card.
	if (context?.state?.gsdExecPurposeInFrame === true) return new Text("", 0, 0);
	const runtimeLabel = execRuntimeLabel(runtime);
	const fallback = runtimeLabel === "Script" ? "script" : `${runtimeLabel} script`;
	const detail = purpose ?? fallback;
	const text = `${theme.fg("toolTitle", theme.bold(label))}\n${theme.fg("muted", italicize(theme, detail))}`;
	return new Text(text, 0, 0);
}

/** Compact call card for gsd_exec: label plus the explicit purpose (or runtime label). */
export function renderExecCall(label: string, args: unknown, theme: ThemeLike, context?: ExecRendererContext): Text {
	const record = asRecord(args);
	return buildCallText(label, normalizeExecPurpose(record?.purpose), record?.runtime, theme, context);
}

/** Compact call card for gsd_uat_exec: derives the running purpose from UAT metadata when streaming. */
export function renderUatExecCall(args: unknown, theme: ThemeLike, context?: ExecRendererContext): Text {
	const record = asRecord(args);
	const purpose = normalizeExecPurpose(record?.purpose) ?? normalizeExecPurpose(uatSynthesizedPurpose(record));
	return buildCallText("UAT Exec", purpose, record?.runtime, theme, context);
}

function resultContentText(result: Record<string, unknown> | null): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.map((block) => {
			const record = asRecord(block);
			return record && typeof record.text === "string" ? record.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function boundedLines(text: string, maxLines: number, lineChars = Number.POSITIVE_INFINITY): string {
	const lines = text.split("\n");
	const kept = lines.slice(0, maxLines).map((line) => (line.length > lineChars ? `${line.slice(0, lineChars - 1)}…` : line));
	const suffix = lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines hidden)` : "";
	return kept.join("\n") + suffix;
}

/**
 * Caps a preview block by its WRAPPED visual rows at the render width. Line-based
 * bounders cannot see wrapping: one long line can still occupy hundreds of rows.
 * keepTail keeps the final rows (stderr cause side); otherwise the head is kept.
 * Elided rows are reported with an explicit marker that is itself counted in the budget.
 */
function cappedVisualRows(text: string, theme: ThemeLike, width: number, maxRows: number, keepTail: boolean, color: "toolOutput" | "error"): string[] {
	// A line-elision marker (from the line budget) is kept outside the visual budget.
	const lineMarker = /^… \(\d+ more lines hidden\)$/;
	const textLines = text.split("\n");
	const markerLine = textLines.find((line) => lineMarker.test(line));
	const contentLines = textLines.filter((line) => !lineMarker.test(line));
	const rows = new Text(contentLines.join("\n"), 0, 0).render(Math.max(1, width));
	const markerRows = markerLine ? new Text(theme.fg("muted", markerLine), 0, 0).render(Math.max(1, width)) : [];
	if (rows.length <= maxRows) {
		const plain = rows.map((row: string) => theme.fg(color, row));
		return keepTail ? [...markerRows, ...plain] : [...plain, ...markerRows];
	}
	const marker = 1;
	const keep = Math.max(1, maxRows - marker);
	const hidden = rows.length - keep;
	const shown = keepTail ? rows.slice(rows.length - keep) : rows.slice(0, keep);
	const note = new Text(theme.fg("muted", `… (${hidden} more visual rows hidden)`), 0, 0).render(Math.max(1, width));
	return keepTail
		? [...markerRows, ...note, ...shown.map((row: string) => theme.fg(color, row))]
		: [...shown.map((row: string) => theme.fg(color, row)), ...note, ...markerRows];
}

/**
 * Structured failure card: status/labels/warnings are unbounded (they are short
 * and must stay visible); the stdout digest and the stderr tail are each capped
 * by wrapped visual rows at the render width, independently of each other.
 */
function structuredCard(
	before: string[],
	digestText: string,
	stderrText: string,
	theme: ThemeLike,
	expanded: boolean,
	digestKeepsTail = false,
	stderrHeading?: string,
	notRecordedRow?: string,
): Text {
	const card = new Text("", 0, 0);
	card.render = (width: number): string[] => {
		const limit = expanded ? 20 : 6;
		const columns = Math.max(1, width);
		// Order: status/labels, then stdout block, then the stderr heading with its block,
		// then the recording warning. Each heading stays adjacent to the block it labels.
		const out: string[] = [...new Text(before.join("\n"), 0, 0).render(columns)];
		if (digestText) out.push(...cappedVisualRows(digestText, theme, width, limit, digestKeepsTail, "toolOutput"));
		if (stderrText) {
			if (stderrHeading) out.push(...new Text(stderrHeading, 0, 0).render(columns));
			out.push(...cappedVisualRows(stderrText, theme, width, limit, true, "error"));
		}
		if (notRecordedRow) out.push(...new Text(notRecordedRow, 0, 0).render(columns));
		return out;
	};
	return card;
}

function previewCard(before: string[], preview: string, warnings: string[], theme: ThemeLike, expanded: boolean, keepTail = false): Text {
	const card = new Text("", 0, 0);
	card.render = (width: number): string[] => {
		const columns = Math.max(1, width);
		const rows = preview ? new Text(preview, 0, 0).render(columns) : [];
		const limit = expanded ? 20 : 6;
		// Error previews keep their visual tail: wrapped head context must not push the cause out of view.
		const shown = keepTail && rows.length > limit ? [...rows.slice(0, 1), ...rows.slice(rows.length - (limit - 1))] : rows.slice(0, limit);
		return [
			...(before.length ? new Text(before.join("\n"), 0, 0).render(columns) : []),
			...shown,
			...(rows.length > limit ? new Text(theme.fg("muted", "(preview rows hidden; open the full logs)"), 0, 0).render(columns) : []),
			...(warnings.length ? new Text(warnings.join("\n"), 0, 0).render(columns) : []),
		];
	};
	return card;
}

/**
 * Keeps the first and last lines of an error body. The head carries the context,
 * the tail usually carries the cause, so an elided middle must not hide either.
 */
function boundedHeadTailLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	// Tail gets the larger share: the cause sits at the end. Head keeps context.
	const head = Math.floor(maxLines / 3);
	const tail = maxLines - head - 1;
	const hidden = lines.length - head - tail;
	return [...lines.slice(0, head), `… (${hidden} more lines hidden)`, ...lines.slice(lines.length - tail)].join("\n");
}

/**
 * Like boundedLines, but keeps the LAST lines: the stderr preview is a tail,
 * so its final lines carry the actual failure cause and must survive elision.
 */
function boundedTailLines(text: string, maxLines: number, lineChars = Number.POSITIVE_INFINITY): string {
	const lines = text.split("\n");
	// A long line keeps its END: the failure cause is the last characters of a single-line tail.
	const kept = lines.slice(-maxLines).map((line) => (line.length > lineChars ? `…${line.slice(line.length - (lineChars - 1))}` : line));
	const hidden = lines.length - maxLines;
	const prefix = hidden > 0 ? `… (${hidden} more lines hidden)\n` : "";
	return prefix + kept.join("\n");
}

function legacyFallback(result: Record<string, unknown> | null, theme: ThemeLike): Text {
	const content = sanitizeExecDisplayText(resultContentText(result)).trim();
	if (content.length === 0) return new Text(theme.fg("muted", "gsd_exec run"), 0, 0);
	return new Text(theme.fg("toolOutput", boundedLines(content, LEGACY_FALLBACK_MAX_LINES)), 0, 0);
}

/** Execution status text mirroring the executor's formatExit semantics; undefined when details carry none. */
function execStatusText(details: Record<string, unknown> | null): string | undefined {
	const hasStatusFields =
		detailNumber(details, "exit_code") !== undefined ||
		detailNumber(details, "duration_ms") !== undefined ||
		detailString(details, "signal") !== undefined ||
		detailBoolean(details, "timed_out") ||
		detailBoolean(details, "aborted") ||
		detailBoolean(details, "force_resolved");
	if (!hasStatusFields) return undefined;

	const forceResolved = detailBoolean(details, "force_resolved");
	const aborted = detailBoolean(details, "aborted");
	const timedOut = detailBoolean(details, "timed_out");
	const signal = detailString(details, "signal");

	let exit: string;
	if (aborted && forceResolved) exit = "aborted(force-killed)";
	else if (aborted) exit = "aborted";
	else if (forceResolved) exit = "timeout(force-killed)";
	else if (timedOut) exit = "timeout";
	else if (signal) exit = `signal:${sanitizeExecDisplayText(signal)}`;
	else {
		const exitCode = detailNumber(details, "exit_code");
		exit = exitCode === undefined ? "exit unknown" : `exit ${exitCode}`;
	}
	const duration = detailNumber(details, "duration_ms");
	return duration === undefined ? exit : `${exit} · ${duration}ms`;
}

/** One `stdout`/`stderr` row; omitted entirely when the row's metadata is absent (missing ≠ 0B). */
function outputRow(kind: "stdout" | "stderr", details: Record<string, unknown> | null): string | undefined {
	const bytes = detailNumber(details, `${kind}_bytes`);
	const path = detailString(details, `${kind}_path`);
	if (bytes === undefined && path === undefined) return undefined;
	const parts = [`${kind} ${bytes ?? "?"}B`];
	if (detailBoolean(details, `${kind}_truncated`)) parts.push("(truncated)");
	// Full original path, verbatim modulo display sanitization — no shortening or rewriting.
	if (path) parts.push(`→ ${sanitizeExecDisplayText(path)}`);
	return parts.join(" ");
}

/**
 * Expanded result card for gsd_exec / gsd_uat_exec. Structured `details` drive
 * everything (recording state included) — content text is never scanned for
 * warning markers. Historical rows keep their output visible: results without
 * `details` fall back to bounded content text, and results with pre-slice
 * details (status/paths but no `digest` key) keep their content below the
 * structured rows. Error results render as a structured failure card when the
 * run carries preview fields (bounded stdout digest and stderr diagnostics
 * previews rebuilt from details, recording warning pinned last) and fall back
 * to the bounded original content plus the structured recording warning
 * otherwise, so a long digest cannot push either out of view.
 */
export function renderExecResult(result: unknown, options: unknown, theme: ThemeLike, context?: ExecRendererContext): Text {
	const record = asRecord(result);
	const details = asRecord(record?.details);
	const content = sanitizeExecDisplayText(resultContentText(record)).trim();

	const notRecorded = typeof details?.run_not_recorded === "string" ? details.run_not_recorded : undefined;
	// An explicit native owner renders the canonical warning outside every body cap.
	// Older/standalone contexts retain this renderer's structured warning row.
	const notRecordedRow = notRecorded !== undefined && context?.state?.gsdExecRecordingWarningInFrame !== true
		? theme.fg("warning", `not recorded (${sanitizeExecDisplayText(notRecorded) || "reason unavailable"}) — not verification or UAT evidence`)
		: undefined;
	// Any present details field is structured state, even when empty: never
	// infer a warning from command output or a digest when structured metadata
	// is available. The details-less fallback accepts only the complete
	// historical footer, anchored at the end of the content.
	const hasStructuredDetails = record?.details !== undefined;
	const legacy = !hasStructuredDetails ? extractLegacyRecordingFooter(content) : undefined;
	const body = legacy?.body ?? content;
	const legacyWarning = legacy?.warning;
	const warnings = [notRecordedRow, legacyWarning ? theme.fg("warning", legacyWarning) : undefined]
		.filter((row): row is string => row !== undefined);
	const expanded = asRecord(options)?.expanded === true;

	if (execDisplayFailure(record, details, asRecord(options)?.isPartial === true)) {
		// Original errors remain authoritative; warnings never fall inside preview caps.
		// Structured failure card (issue #2927): previews are rebuilt from
		// details so a long stdout digest cannot push the stderr diagnostics —
		// or the structured recording warning — out of the fixed error budget
		// (both previews get the digest-preview row budget; the total stays at
		// the historical error-card size). Historical rows and non-execution
		// failures (validation, policy, spawn) without these fields keep the
		// bounded original-content fallback below.
		const structuredDigest = detailString(details, "digest");
		const stderrExcerpt = detailString(details, "stderr_excerpt");
		if (structuredDigest !== undefined || stderrExcerpt !== undefined) {
			const before: string[] = [];
			const id = detailString(details, "id");
			const status = execStatusText(details);
			if (id !== undefined || status !== undefined) {
				before.push(theme.fg("muted", `gsd_exec${id ? ` [${sanitizeExecDisplayText(id)}]` : ""}${status ? ` — ${status}` : ""}`));
			}
			const stdoutRow = outputRow("stdout", details);
			if (stdoutRow) before.push(theme.fg("toolOutput", stdoutRow));
			const stderrRow = outputRow("stderr", details);
			if (stderrRow) before.push(theme.fg("toolOutput", stderrRow));
			before.push(theme.fg("muted", "output preview — tail of the run's captured output, not the full log:"));
			// Digest: a stderr-only digest keeps its marker line unbounded and its
			// stderr tail as the visual tail; a stdout digest keeps the head.
			const rawDigest = structuredDigest ?? "";
			let digestBody = "";
			if (rawDigest.startsWith("[no stdout —")) {
				const newlineIndex = rawDigest.indexOf("\n");
				const marker = newlineIndex === -1 ? rawDigest : rawDigest.slice(0, newlineIndex);
				const stderrTail = newlineIndex === -1 ? "" : rawDigest.slice(newlineIndex + 1);
				before.push(theme.fg("muted", sanitizeExecDisplayText(marker)));
				// Line budget first (keeps the tail and the line-elision marker), then the visual-row cap in structuredCard.
				digestBody = boundedTailLines(sanitizeExecDisplayText(stderrTail).trim(), DIGEST_PREVIEW_MAX_LINES, DIGEST_PREVIEW_LINE_CHARS);
			} else {
				digestBody = boundedLines(sanitizeExecDisplayText(rawDigest).trim(), DIGEST_PREVIEW_MAX_LINES, DIGEST_PREVIEW_LINE_CHARS);
			}
			// Whitespace- or escape-only stderr has no visible diagnostic (issue #2927).
			const visibleStderr = stderrExcerpt !== undefined ? sanitizeExecDisplayText(stderrExcerpt).trim() : "";
			// Stderr excerpt: same line budget (tail + line-elision marker) before the visual cap.
			const stderrBody = visibleStderr ? boundedTailLines(visibleStderr, DIGEST_PREVIEW_MAX_LINES, DIGEST_PREVIEW_LINE_CHARS) : "";
			const stderrHeading = visibleStderr ? theme.fg("error", "stderr (tail) — failure diagnostics:") : undefined;
			// A stderr-only digest is a failure tail: its final lines carry the cause, so keep the tail.
			return structuredCard(before, digestBody, stderrBody, theme, expanded, rawDigest.startsWith("[no stdout —"), stderrHeading, notRecordedRow);
		}

		// Content is the authoritative error text (validation, policy block,
		// execution failure): show it bounded, then retain recording warnings
		// outside that preview budget.
		const errorText = body.length > 0 ? boundedHeadTailLines(body, expanded ? ERROR_CONTENT_MAX_LINES : ERROR_CONTENT_COLLAPSED_LINES) : "gsd_exec failed";
		const status = execStatusText(details);
		const lines = status ? [theme.fg("error", `Status: ${status}`)] : [];
		const failureWarnings: string[] = [];
		if (legacyWarning && context?.state?.gsdExecRecordingWarningInFrame !== true) {
			failureWarnings.push(theme.fg("warning", legacyWarning));
		}
		if (notRecordedRow) failureWarnings.push(notRecordedRow);
		return previewCard(lines, theme.fg("error", errorText), failureWarnings, theme, expanded, true);
	}

	const lines: string[] = [];
	const status = execStatusText(details);
	if (status) lines.push(theme.fg("muted", status));
	const stdoutRow = outputRow("stdout", details);
	if (stdoutRow) lines.push(theme.fg("toolOutput", stdoutRow));
	const stderrRow = outputRow("stderr", details);
	if (stderrRow) lines.push(theme.fg("toolOutput", stderrRow));
	const digest = detailString(details, "digest");
	if (digest) {
		// Stream-neutral: a digest can be a stderr tail when stdout was empty.
		lines.push(theme.fg("muted", "output preview — tail of the run's captured output, not the full log:"));
	}
	const preview = digest
		? boundedLines(sanitizeExecDisplayText(digest), DIGEST_PREVIEW_MAX_LINES, DIGEST_PREVIEW_LINE_CHARS)
		: boundedLines(body, LEGACY_FALLBACK_MAX_LINES);
	if (lines.length === 0 && !preview && warnings.length === 0) return legacyFallback(record, theme);
	return previewCard(lines, theme.fg("toolOutput", preview), warnings, theme, expanded);
}
