// Project/App: gsd-pi
// File Purpose: Shared recommended transcript rendering primitives for assistant, tool, command, footer, and auto-mode TUI surfaces.

import { alignRight, isImageLine, padRight, style, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme, type ThemeBg, type ThemeColor } from "@gsd/pi-coding-agent/theme/theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";

export type StatusTone = "running" | "success" | "error" | "warning" | "muted";
export type TuiTone = "default" | "accent" | "success" | "warning" | "error" | "muted";
export type TuiBreakpoint = "compact" | "regular" | "wide";

/** Conversation/system surfaces that the chat frame distinguishes by color. */
export type FrameTone = "assistant" | "user" | "compaction" | "skill";

export function chatMessageWidth(width: number): number {
	return Math.max(24, Math.min(width, Math.floor(width * 0.72)));
}

/** Outer indent for user turns and tool/work cards in the connected transcript. */
export const TRANSCRIPT_CARD_INDENT = 4;

/** Tool rows in the transcript (Variant A). */
export const TRANSCRIPT_TOOL_MARKER = "▸";

/** System/compaction/skill notices in the transcript (Variant A). */
export const TRANSCRIPT_SYSTEM_MARKER = "◇";
const RUNNING_RAIL_FRAME_MS = 70;
const RUNNING_RAIL_TRAIL = 5;
const HORIZONTAL_RAIL = "─";
const HORIZONTAL_RAIL_HEAD = "━";

// Whether the "running" rail sweeps (animates) or renders as a static rule. User
// setting `terminal.toolRailAnimation` (default on). When off, running cards show
// a static rail and ToolExecutionComponent does not arm its re-render timer, so a
// long-running tool costs zero idle CPU. Module-level (not per-card) because every
// running card shares the one preference; the interactive mode sets it at startup
// and when the setting is toggled.
let railAnimationEnabled = true;
export function setRailAnimationEnabled(enabled: boolean): void {
	railAnimationEnabled = enabled;
}
export function isRailAnimationEnabled(): boolean {
	return railAnimationEnabled;
}

export function headerLabel(text: string): string {
	return text.toUpperCase();
}

function styledHeader(text: string, color: ThemeColor): string {
	return theme.fg(color, theme.bold(headerLabel(text)));
}

function indentSpaces(cols: number): string {
	return cols > 0 ? " ".repeat(cols) : "";
}

function connectedRuleFill(width: number, indent = TRANSCRIPT_CARD_INDENT): string {
	return "─".repeat(Math.max(16, Math.min(40, width - indent - 1)));
}

function runningRailFrame(): number {
	return Math.floor(Date.now() / RUNNING_RAIL_FRAME_MS);
}

function trianglePosition(frame: number, maxPosition: number): number {
	const max = Math.max(0, maxPosition);
	if (max === 0) return 0;
	const period = max * 2;
	const step = frame % period;
	return step <= max ? step : period - step;
}

function renderRailText(text: string, railColor: ThemeColor, sweepFrame?: number): string {
	if (sweepFrame === undefined) return theme.fg(railColor, text);

	const railCells = Array.from(text).filter((char) => char === HORIZONTAL_RAIL).length;
	const head = trianglePosition(sweepFrame, railCells - 1);
	let railIndex = -1;
	let rendered = "";

	for (const char of text) {
		if (char !== HORIZONTAL_RAIL) {
			rendered += theme.fg(railColor, char);
			continue;
		}

		railIndex++;
		const distance = Math.abs(railIndex - head);
		if (distance === 0) {
			rendered += theme.fg(railColor, theme.bold(HORIZONTAL_RAIL_HEAD));
		} else if (distance <= RUNNING_RAIL_TRAIL) {
			rendered += theme.fg(railColor, HORIZONTAL_RAIL_HEAD);
		} else {
			rendered += theme.fg(railColor, HORIZONTAL_RAIL);
		}
	}
	return rendered;
}

export function renderChatTurnBridge(
	width: number,
	fromIndent = TRANSCRIPT_CARD_INDENT,
	railColor: ThemeColor = "borderAccent",
): string[] {
	const bridge = indentSpaces(fromIndent) + "╰──────╮";
	return [padLine(theme.fg(railColor, bridge), width)];
}

/** Bridge from a left-pegged assistant turn down into the next indented user turn. */
export function renderChatTurnBridgeToUser(
	width: number,
	railColor: ThemeColor = "border",
): string[] {
	const bridge = "╰──────╮";
	return [padLine(theme.fg(railColor, bridge), width)];
}

export function renderConnectedCard(
	width: number,
	title: string,
	bodyLines: string[],
	opts: {
		indent?: number;
		titleRight?: string;
		railColor?: ThemeColor;
		titleColor?: ThemeColor;
		bodyBg?: ThemeBg;
		closeBottom?: boolean;
		railSweep?: boolean;
	} = {},
): string[] {
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const prefix = indentSpaces(indent);
	const railColor = opts.railColor ?? "borderAccent";
	const sweepFrame = opts.railSweep && railAnimationEnabled ? runningRailFrame() : undefined;
	const rail = (text: string) => renderRailText(text, railColor, sweepFrame);
	const resolvedTitleColor =
		opts.titleColor ??
		(title.includes("✕") ? "error" : title.includes("✓") ? "success" : railColor);
	const titleStyled = theme.fg(resolvedTitleColor, theme.bold(headerLabel(title)));
	const lead = prefix + rail("╭─ ") + titleStyled;
	let topLine = lead;
	if (opts.titleRight) {
		const available = width - visibleWidth(lead) - 1;
		const rightWidth = visibleWidth(opts.titleRight);
		if (rightWidth + 5 <= available) {
			const fill = Math.max(1, available - rightWidth - 2);
			topLine = lead + rail(" " + "─".repeat(fill) + " ") + opts.titleRight;
		} else {
			const clippedRight = truncateToWidth(opts.titleRight, Math.max(8, available - 5), "");
			const fill = Math.max(1, available - visibleWidth(clippedRight) - 2);
			topLine = lead + rail(" " + "─".repeat(fill) + " ") + clippedRight;
		}
	}
	const paintBody = (line: string) => {
		// Image (Kitty/iTerm2) sequence lines carry raw terminal graphics escapes and
		// rely on exact column/row positioning. Prepend the SAME left offset normal
		// body lines get (card indent + 3 spaces) so the image aligns under the card
		// text rather than hugging column 0, but do NOT padRight/truncate — trailing
		// padding or clipping after the sequence would corrupt the placement. The
		// leading spaces simply advance the cursor before the image draws.
		if (isImageLine(line)) {
			return prefix + "   " + line;
		}
		const innerWidth = Math.max(1, width - indent);
		const inner = padRight("   " + line, innerWidth);
		const painted = opts.bodyBg ? theme.bg(opts.bodyBg, inner) : inner;
		return prefix + painted;
	};
	// When the body contains an inline image, its reserved blank padding rows (the
	// rows the TUI counts so content below the image lands in the right place) must
	// NOT be trimmed/collapsed — trimming them collapses a tall image to one line
	// and the terminal then paints the full image over the chat and footer below.
	const hasImage = bodyLines.some((l) => isImageLine(l));
	const bodySource = hasImage ? bodyLines : trimOuterBlankLines(bodyLines);
	const out = [padLine(topLine, width)];
	for (const line of bodySource) {
		out.push(paintBody(line));
	}
	if (opts.closeBottom !== false) {
		out.push(padLine(prefix + rail("╰" + connectedRuleFill(width, indent)), width));
	}
	return out;
}

function stripAnsiCodes(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isBlankRenderLine(line: string): boolean {
	return stripAnsiCodes(line).trim().length === 0;
}

export function trimOuterBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderLine(lines[start]!)) start++;
	while (end > start && isBlankRenderLine(lines[end - 1]!)) end--;
	return lines.slice(start, end);
}

/** Collapse runs of blank lines to a single blank line (tool output only). */
export function collapseBlankLines(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const blank = isBlankRenderLine(line);
		if (blank && out.length > 0 && isBlankRenderLine(out[out.length - 1]!)) continue;
		out.push(line);
	}
	return trimOuterBlankLines(out);
}

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, ""), width);
}

function toneColor(tone: StatusTone): ThemeColor {
	switch (tone) {
		case "running": return "toolRunning";
		case "success": return "border";
		case "error": return "toolError";
		case "warning": return "warning";
		case "muted":
		default: return "toolMuted";
	}
}

export function breakpoint(width: number): TuiBreakpoint {
	if (width < 72) return "compact";
	if (width < 112) return "regular";
	return "wide";
}

function panelToneColor(tone: TuiTone): ThemeColor {
	switch (tone) {
		case "accent": return "borderAccent";
		case "success": return "success";
		case "warning": return "warning";
		case "error": return "error";
		case "muted": return "borderMuted";
		case "default":
		default: return "border";
	}
}

export function badge(text: string, tone: TuiTone = "default"): string {
	return theme.fg(panelToneColor(tone), text);
}

const ACTIVITY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Compact braille spinner for live auto-mode status chrome. */
export function styledActivitySpinner(tone: TuiTone = "accent"): string {
	const frame = ACTIVITY_SPINNER_FRAMES[Math.floor(Date.now() / 120) % ACTIVITY_SPINNER_FRAMES.length];
	return theme.fg(panelToneColor(tone), frame);
}

export function keyValue(label: string, value: string, valueColor: ThemeColor = "text", labelWidth = 10): string {
	return `${theme.fg("dim", padRight(label, labelWidth))}${theme.fg(valueColor, value)}`;
}

export function roundedPanel(
	lines: string[],
	width: number,
	opts: {
		tone?: TuiTone;
		title?: string;
		rightTitle?: string;
		paddingX?: number;
	} = {},
): string[] {
	const outerWidth = Math.max(1, width);
	const body = lines.length > 0 ? lines : [""];
	if (outerWidth < 3) {
		return body.map((line) => truncateToWidth(line, outerWidth, ""));
	}

	let panel = style()
		.border("rounded")
		.borderColor((text) => theme.fg(panelToneColor(opts.tone ?? "default"), text))
		.paddingX(Math.max(0, opts.paddingX ?? 0));
	if (opts.title) {
		panel = panel.title(theme.fg("borderAccent", opts.title));
	}
	if (opts.rightTitle) {
		panel = panel.titleRight(theme.fg("dim", opts.rightTitle));
	}
	return panel.render(body, outerWidth);
}

export function rightAlign(left: string, right: string, width: number): string {
	return alignRight(left, right, width);
}

/**
 * Render a copy-clean content surface (ADR-019): a titled top rule, body
 * lines emitted with no border column or leading glyph, and a closing rule.
 * Selecting a body line in the terminal copies only its content.
 *
 * This is the target surface for transcript messages, tool output, and
 * summaries. Migration steps 3–5 move existing renderers onto it.
 */
export function openSurface(
	lines: string[],
	width: number,
	opts: { title: string; right?: string; tone: StatusTone; paddingX?: number },
): string[] {
	const tc = toneColor(opts.tone);
	let surface = style()
		.border("open")
		.title(opts.title, (text) => theme.fg("borderAccent", text))
		.borderColor((text) => theme.fg(tc, text));
	if (opts.right) {
		surface = surface.titleRight(opts.right, (text) => theme.fg(tc, text));
	}
	if (opts.paddingX !== undefined) {
		surface = surface.paddingX(opts.paddingX);
	}
	return surface.render(lines, Math.max(20, width));
}

/**
 * Render a system/conversation notice (compaction, skill invocations) as a
 * plain ◇ header plus copy-clean body lines (Variant A — no horizontal rules).
 */
export function renderChatFrame(
	contentLines: readonly string[],
	width: number,
	opts: {
		label: string;
		tone: FrameTone;
		timestamp?: number;
		timestampFormat: TimestampFormat;
		showTimestamp?: boolean;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const isPurple = opts.tone === "compaction" || opts.tone === "skill";
	const frameColor: ThemeColor = opts.tone === "user" ? "border" : isPurple ? "customMessageLabel" : "borderAccent";
	const bodyColor: ThemeColor =
		opts.tone === "user" ? "userMessageText" : isPurple ? "customMessageText" : "assistantMessageText";

	// A label may carry a " - " splitting a bold name from a dim detail.
	const dashIdx = opts.label.indexOf(" - ");
	const labelStyled =
		dashIdx >= 0
			? theme.fg(frameColor, theme.bold(opts.label.slice(0, dashIdx))) + theme.fg("dim", opts.label.slice(dashIdx))
			: theme.fg(frameColor, theme.bold(opts.label));
	const rightRaw =
		opts.showTimestamp === false || !opts.timestamp ? "" : formatTimestamp(opts.timestamp, opts.timestampFormat);
	const metaStyled = rightRaw ? theme.fg("dim", ` · ${rightRaw}`) : "";
	const header = padLine(
		truncateToWidth(
			`${theme.fg(frameColor, TRANSCRIPT_SYSTEM_MARKER)} ${labelStyled}${metaStyled}`,
			outerWidth,
			"…",
		),
		outerWidth,
	);

	const source = trimOuterBlankLines(contentLines);
	const body = (source.length > 0 ? source : [""]).map((line) => padLine(theme.fg(bodyColor, line), outerWidth));
	return [header, ...body, ""];
}

/** Chat/dialog corner glyph — top-left opener on speaker headers. */
export const CHAT_CORNER_TOP_LEFT = "╭─ ";

function speakerCornerColor(tone: "user" | "assistant"): ThemeColor {
	return tone === "user" ? "border" : "borderAccent";
}

function renderCornerSpeakerHeader(
	label: string,
	meta: string | undefined,
	width: number,
	tone: "user" | "assistant",
): string {
	const cornerColor = speakerCornerColor(tone);
	const labelStyled =
		tone === "user" ? theme.fg("border", theme.bold(label)) : theme.fg("accent", theme.bold(label));
	const metaStyled = meta ? theme.fg("dim", ` · ${meta}`) : "";
	const topLeft = theme.fg(cornerColor, CHAT_CORNER_TOP_LEFT) + labelStyled + metaStyled;
	return padLine(truncateToWidth(topLeft, width, "…"), width);
}

/** @deprecated Prefer renderCornerSpeakerHeader via renderPlainSpeakerMessage. */
export function renderPlainSpeakerHeader(
	label: string,
	meta: string | undefined,
	width: number,
	tone: "user" | "assistant",
): string {
	return renderCornerSpeakerHeader(label, meta, width, tone);
}

export function renderPlainSpeakerBody(
	lines: readonly string[],
	width: number,
	bodyColor: "userMessageText" | "assistantMessageText",
): string[] {
	const source = trimOuterBlankLines(lines);
	return source.map((line) => padLine(theme.fg(bodyColor, line), width));
}

export function renderPlainSpeakerMessage(
	lines: readonly string[],
	width: number,
	opts: { label: string; meta?: string; tone: "user" | "assistant"; trailingBlank?: boolean },
): string[] {
	const outerWidth = Math.max(20, width);
	const bodyColor = opts.tone === "user" ? "userMessageText" : "assistantMessageText";
	const body = renderPlainSpeakerBody(lines, outerWidth, bodyColor);
	const out = [renderCornerSpeakerHeader(opts.label, opts.meta, outerWidth, opts.tone), ...body];
	if (opts.trailingBlank !== false) {
		out.push("");
	}
	return out;
}

/** @deprecated Connected rails — Variant B. Prefer renderPlainSpeakerMessage. */
export function renderAssistantRail(
	lines: string[],
	width: number,
	opts: {
		label?: string;
		meta?: string;
		railColor?: ThemeColor;
		connected?: boolean;
		continuesToUser?: boolean;
	} = {},
): string[] {
	const railColor = opts.railColor ?? "borderAccent";
	const source = trimOuterBlankLines(lines);
	const body = (source.length > 0 ? source : [""]).map((line) => theme.fg("assistantMessageText", line));
	const titleRight = opts.meta ? theme.fg("dim", opts.meta) : undefined;
	const card = renderConnectedCard(width, opts.label ?? "GSD", body, {
		indent: 0,
		titleRight,
		railColor,
		closeBottom: !opts.continuesToUser,
	});
	let result = card;
	if (opts.connected) {
		result = [...renderChatTurnBridge(width, TRANSCRIPT_CARD_INDENT), ...result];
	}
	if (opts.continuesToUser) {
		result = [...result, ...renderChatTurnBridgeToUser(width)];
	}
	return result;
}

/** @deprecated Connected rails — Variant B. Prefer renderPlainSpeakerMessage. */
export function renderUserRail(
	lines: string[],
	width: number,
	opts: { label?: string; meta?: string; continuesToAssistant?: boolean },
): string[] {
	const source = trimOuterBlankLines(lines);
	const body = (source.length > 0 ? source : [""]).map((line) => theme.fg("userMessageText", line));
	const titleRight = opts.meta ? theme.fg("dim", opts.meta) : undefined;
	return renderConnectedCard(width, opts.label ?? "YOU", body, {
		indent: TRANSCRIPT_CARD_INDENT,
		titleRight,
		railColor: "border",
		titleColor: "border",
		closeBottom: !opts.continuesToAssistant,
	});
}

/**
 * Render a single titled rule line — the collapsed form of a tool/command
 * card on the "open" surface. `title` and `right` must be pre-styled.
 */
function openRuleLine(title: string, right: string, width: number, tone: ThemeColor, sweep = false): string {
	const w = Math.max(20, width);
	if (!right) {
		const clippedTitle = truncateToWidth(title, Math.max(0, w - 6), "");
		const fill = Math.max(1, w - 5 - visibleWidth(clippedTitle));
		return padLine(renderRailText("─── ", tone) + clippedTitle + renderRailText(` ${"─".repeat(fill)}`, tone), w);
	}

	const titleBudget = Math.max(0, w - 11);
	const rightReserve = titleBudget > 1 && visibleWidth(right) > 0 ? 1 : 0;
	const leftBudget = Math.min(visibleWidth(title), Math.max(0, titleBudget - rightReserve));
	const rightBudget = Math.max(0, titleBudget - leftBudget);
	const clippedTitle = truncateToWidth(title, leftBudget, "");
	const clippedRight = truncateToWidth(right, rightBudget, "");
	const fixed = 4 + visibleWidth(clippedTitle) + 2 + visibleWidth(clippedRight) + 4;
	const fill = Math.max(1, w - fixed);
	const sweepFrame = sweep && railAnimationEnabled ? runningRailFrame() : undefined;

	return padLine(
		renderRailText("─── ", tone) +
			clippedTitle +
			renderRailText(` ${"─".repeat(fill)} `, tone, sweepFrame) +
			clippedRight +
			renderRailText(" ───", tone),
		w,
	);
}

function indentRenderedLines(lines: string[], indent: number, width: number): string[] {
	if (indent <= 0) return lines;
	const prefix = indentSpaces(indent);
	return lines.map((line) => padLine(prefix + truncateToWidth(line, Math.max(1, width - indent), ""), width));
}

export function renderTranscriptCard(
	lines: string[],
	width: number,
	opts: {
		title: string;
		right?: string;
		tone: StatusTone;
		footerLeft?: string;
		footerRight?: string;
		indent?: number;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const tone = toneColor(opts.tone);
	// Preserve image padding rows (see renderConnectedCard) — trimming them would
	// collapse a tall inline image and make it overflow the card.
	const body = lines.some((l) => isImageLine(l)) ? lines : trimOuterBlankLines(lines);
	let titleRight = opts.right ? theme.fg(tone, opts.right) : undefined;
	if (opts.footerLeft || opts.footerRight) {
		const hint = [opts.footerLeft, opts.footerRight].filter(Boolean).join(" · ");
		const hintStyled = theme.fg("dim", hint);
		titleRight = titleRight ? `${titleRight} · ${hintStyled}` : hintStyled;
	}
	return renderConnectedCard(outerWidth, opts.title, body, {
		indent,
		titleRight,
		railColor: tone,
		railSweep: opts.tone === "running",
	});
}

function statusColorForTone(tone: StatusTone): ThemeColor {
	if (tone === "error") return "error";
	if (tone === "running") return "accent";
	if (tone === "warning") return "warning";
	return "success";
}

export function renderCompactToolStrip(
	title: string,
	target: string | undefined,
	width: number,
	opts: { status: string; tone: StatusTone; hidden?: boolean },
): string[] {
	const titleText = target
		? `${styledHeader(title, "borderAccent")} ${theme.fg("text", target)}`
		: styledHeader(title, "borderAccent");
	const left = `${theme.fg("borderAccent", TRANSCRIPT_TOOL_MARKER)} ${titleText}`;
	const statusText = opts.hidden ? `${opts.status} · output hidden · ctrl+o expand` : opts.status;
	const right = theme.fg(statusColorForTone(opts.tone), statusText);
	return [padLine(alignRight(left, right, width), width)];
}

export function renderPlainToolMessage(
	bodyLines: readonly string[],
	width: number,
	opts: { title: string; target?: string; meta?: string; tone: StatusTone },
): string[] {
	const outerWidth = Math.max(20, width);
	const indent = TRANSCRIPT_CARD_INDENT;
	const prefix = indentSpaces(indent);
	const innerWidth = Math.max(1, outerWidth - indent);

	const titleText = opts.target
		? `${styledHeader(opts.title, "borderAccent")} ${theme.fg("text", opts.target)}`
		: styledHeader(opts.title, "borderAccent");
	const left = `${theme.fg("borderAccent", TRANSCRIPT_TOOL_MARKER)} ${titleText}`;
	const right = opts.meta ? theme.fg(statusColorForTone(opts.tone), opts.meta) : "";
	const header = padLine(alignRight(left, right, outerWidth), outerWidth);

	const hasImage = bodyLines.some((line) => isImageLine(line));
	const bodySource = hasImage ? bodyLines : collapseBlankLines(bodyLines);

	const paintBody = (line: string): string => {
		if (isImageLine(line)) {
			return prefix + "   " + line;
		}
		if (hasImage && isBlankRenderLine(line)) {
			return padLine(prefix + padRight("", innerWidth), outerWidth);
		}
		return padLine(truncateToWidth(line, outerWidth, ""), outerWidth);
	};

	return [header, ...bodySource.map(paintBody), ""];
}

/** @deprecated Prefer renderCompactToolStrip (Variant A). */
export function renderToolLineCard(
	title: string,
	target: string | undefined,
	width: number,
	opts: { status: string; tone: StatusTone; hidden?: boolean; titlePrefix?: string; bg?: ThemeBg; indent?: number },
): string[] {
	return renderCompactToolStrip(title, target, width, {
		status: opts.status,
		tone: opts.tone,
		hidden: opts.hidden,
	});
}

export function renderCommandCard(
	command: string,
	width: number,
	opts: { status: string; tone: StatusTone; progress?: string; indent?: number },
): string[] {
	const left = `${theme.fg("accent", "$")} ${theme.fg("text", command)}`;
	const statusText = opts.progress
		? `${opts.progress} ${opts.status}`
		: `${opts.status} · output hidden · ctrl+o expand`;
	const statusColor = opts.tone === "error" ? "error" : opts.tone === "running" ? "accent" : "success";
	const right = theme.fg(statusColor, statusText);
	return [padLine(alignRight(left, right, width), width)];
}

export function renderProgressBar(done: number, total: number, width: number, tone: StatusTone = "success"): string {
	const clampedWidth = Math.max(0, width);
	const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
	const filled = Math.round(pct * clampedWidth);
	return (
		theme.fg(toneColor(tone), "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(clampedWidth - filled))
	);
}

export type StepDotMode = "position" | "completed";

const STEP_DOT_MAX = 12;

/**
 * Discrete step indicator — ● for reached steps, ○ for pending.
 * `position`: done is the active step index (1-based, includes current).
 * `completed`: done is the count of fully finished steps.
 */
export function renderStepDots(
	done: number,
	total: number,
	opts: { maxDots?: number; mode?: StepDotMode } = {},
): string {
	if (total <= 0) return "";

	const maxDots = opts.maxDots ?? STEP_DOT_MAX;
	const mode = opts.mode ?? "position";
	const complete = done >= total;

	let displayTotal = total;
	let displayDone = Math.max(0, Math.min(done, total));
	let overflowSuffix = "";

	if (total > maxDots) {
		displayTotal = maxDots;
		displayDone = Math.max(0, Math.min(displayTotal, Math.round((done / total) * displayTotal)));
		overflowSuffix = theme.fg("dim", `+${total - maxDots}`);
	}

	let dots = "";
	for (let i = 0; i < displayTotal; i++) {
		const reached = i < displayDone;
		if (reached) {
			const isCurrent = !complete && mode === "position" && i === displayDone - 1;
			const color: ThemeColor = complete ? "success" : isCurrent ? "accent" : "text";
			dots += theme.fg(color, "●");
		} else {
			dots += theme.fg("dim", "○");
		}
	}
	return dots + overflowSuffix;
}

/** Label + step dots + numeric count, e.g. `tasks ●●●○○ 3/5`. */
export function formatStepProgress(
	label: string,
	done: number,
	total: number,
	opts: { maxDots?: number; mode?: StepDotMode; countColor?: ThemeColor } = {},
): string {
	const dots = renderStepDots(done, total, opts);
	const countColor = opts.countColor ?? "dim";
	return `${theme.fg("dim", label)} ${dots}${theme.fg(countColor, ` ${done}/${total}`)}`;
}

export function renderFooterStrip(leftSegments: string[], right: string, width: number): string[] {
	const outerWidth = Math.max(20, width);
	const innerWidth = Math.max(1, outerWidth - 2);
	const sep = theme.fg("dim", "  │  ");
	const rightStyled = theme.fg("dim", right);
	const rightWidth = visibleWidth(rightStyled);
	const leftBudget = right ? Math.max(1, innerWidth - rightWidth - 3) : innerWidth;
	const left = truncateToWidth(leftSegments.filter(Boolean).join(sep), leftBudget, "");
	const content = rightAlign(left, rightStyled, innerWidth);
	return roundedPanel([content], outerWidth);
}

const footerSegmentSep = () => theme.fg("dim", " │ ");

/**
 * Full-width footer: fixed segments plus one flex segment (typically context + bar).
 * The flex segment receives all remaining horizontal space.
 */
export function layoutFullWidthFooter(
	segments: string[],
	width: number,
	flexAt: number,
	flexRender: (segmentBudget: number) => string,
): string {
	const sep = footerSegmentSep();
	const sepWidth = visibleWidth(sep);
	const slotCount = segments.length + 1;
	const separators = Math.max(0, slotCount - 1) * sepWidth;

	let fixedWidth = 0;
	for (const segment of segments) {
		fixedWidth += visibleWidth(segment);
	}

	const flexBudget = Math.max(12, width - fixedWidth - separators);
	const flexSegment = flexRender(flexBudget);

	const parts = [...segments.slice(0, flexAt), flexSegment, ...segments.slice(flexAt)];
	const line = parts.join(sep);
	return truncateToWidth(line, width, "…");
}

export function renderFullWidthFooterStrip(
	segments: string[],
	width: number,
	flex?: { at: number; render: (segmentBudget: number) => string },
): string[] {
	const outerWidth = Math.max(20, width);
	const innerWidth = Math.max(1, outerWidth - 2);
	const content = flex
		? layoutFullWidthFooter(segments, innerWidth, flex.at, flex.render)
		: truncateToWidth(segments.filter(Boolean).join(footerSegmentSep()), innerWidth, "…");
	return roundedPanel([content], outerWidth);
}

/** Single-line footer — no box, ` · ` separators. */
export function layoutMinimalFooter(
	segments: string[],
	width: number,
	flex?: { at: number; render: (segmentBudget: number) => string },
): string {
	const sep = theme.fg("dim", " · ");
	const sepWidth = visibleWidth(sep);
	if (flex) {
		const slotCount = segments.length + 1;
		const separators = Math.max(0, slotCount - 1) * sepWidth;
		let fixedWidth = 0;
		for (const segment of segments) {
			fixedWidth += visibleWidth(segment);
		}
		const flexBudget = Math.max(8, width - fixedWidth - separators);
		const flexSegment = flex.render(flexBudget);
		const parts = [...segments.slice(0, flex.at), flexSegment, ...segments.slice(flex.at)];
		return truncateToWidth(parts.join(sep), width, "…");
	}
	return truncateToWidth(segments.filter(Boolean).join(sep), width, "…");
}

/**
 * Full-width minimal footer: left + center (flex) flush left, stats flush right.
 */
export function layoutFullWidthMinimalFooter(
	leftSegments: string[],
	rightSegments: string[],
	width: number,
	flexRender: (segmentBudget: number) => string,
): string {
	const sep = theme.fg("dim", " · ");
	const left = leftSegments.filter(Boolean).join(sep);
	const right = rightSegments.filter(Boolean).join(sep);
	const leftWidth = left ? visibleWidth(left) : 0;
	const rightWidth = right ? visibleWidth(right) : 0;
	const sepWidth = visibleWidth(sep);

	if (!right) {
		const flexBudget = Math.max(8, width - leftWidth - (left ? sepWidth : 0));
		const center = flexRender(flexBudget);
		const line = [left, center].filter(Boolean).join(sep);
		return truncateToWidth(line, width, "…");
	}

	const flexBudget = Math.max(8, width - leftWidth - rightWidth - sepWidth - 1);
	const center = flexRender(flexBudget);
	const leftBlock = center ? (left ? `${left}${sep}${center}` : center) : left;
	return alignRight(leftBlock, right, width);
}

/** Single-line footer output — no rounded panel. */
export function renderMinimalFooterLine(line: string, width: number): string[] {
	const outerWidth = Math.max(20, width);
	return [padRight(truncateToWidth(line, outerWidth, "…"), outerWidth)];
}
