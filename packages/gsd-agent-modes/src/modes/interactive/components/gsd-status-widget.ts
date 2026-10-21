// Project/App: gsd-pi
// File Purpose: Collapsible GSD auto-mode status widget above the editor (Grok-style minimal chrome).

import { alignRight, type Component, padRight, truncateToWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { AdaptiveLayoutState } from "./adaptive-layout.js";
import type { GsdProgressState } from "./gsd-progress-state.js";
import { resolveTuiMode } from "../tui-mode.js";
import { badge, formatStepProgress, layoutMinimalFooter, styledActivitySpinner } from "./transcript-design.js";

export interface GsdStatusWidgetState extends AdaptiveLayoutState {
	/**
	 * `undefined` — not yet toggled, use widgetMode default.
	 * `true`  — user explicitly expanded (overrides widgetMode: "min").
	 * `false` — user explicitly collapsed (overrides widgetMode: "full").
	 */
	manuallyExpanded: boolean | undefined;
	gsdProgress?: GsdProgressState;
	/** True while the agent turn is in flight (model thinking, tools, etc.). */
	isStreaming?: boolean;
}

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, "…"), width);
}

function basename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	if (!trimmed) return cwd.includes("\\") ? "\\" : "/";
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function isWidgetActive(state: GsdStatusWidgetState, width: number): boolean {
	if (state.gsdProgress) return true;
	if (state.lastError) return true;
	if ((state.activeToolCount ?? 0) > 0) return true;
	if (state.gsdPhase) return true;
	if (state.override !== "auto" && state.override !== "chat") return true;
	const mode = resolveTuiMode({
		terminalWidth: width,
		override: state.override,
		gsdPhase: state.gsdPhase,
		activeToolCount: state.activeToolCount,
		hasBlockingError: !!state.lastError,
	});
	return mode !== "chat";
}

export function isGsdStatusWidgetVisible(state: GsdStatusWidgetState, width: number): boolean {
	return isWidgetActive(state, width);
}

function gsdAutoBadge(isStreaming: boolean): string {
	if (isStreaming) {
		return `${styledActivitySpinner("accent")} ${theme.fg("accent", theme.bold("GSD AUTO"))}`;
	}
	return badge("● GSD AUTO", "accent");
}

function buildTaskProgressSegments(progress: GsdProgressState): string[] {
	const taskProgress = progress.taskProgress;
	if (!taskProgress || taskProgress.total <= 0) return [];

	const segments: string[] = [];
	const sliceProgress = progress.sliceProgress;
	if (sliceProgress && sliceProgress.total > 0) {
		segments.push(formatStepProgress("slices", sliceProgress.done, sliceProgress.total, { mode: "completed" }));
	}
	segments.push(
		formatStepProgress("tasks", taskProgress.done, taskProgress.total, {
			mode: "position",
			countColor: "accent",
		}),
	);
	if (progress.sliceLabel) {
		segments.push(theme.fg("dim", progress.sliceLabel));
	}
	if (progress.taskLabel) {
		segments.push(theme.fg("dim", progress.taskLabel));
	}
	if (progress.unitLabel) {
		segments.push(theme.fg("text", progress.unitLabel));
	}
	return segments;
}

function renderProgressHeadRight(progress: GsdProgressState): string {
	const sep = theme.fg("dim", " · ");
	const progressSegments = buildTaskProgressSegments(progress);
	const dimParts = [progress.model, progress.elapsed, progress.eta].filter(
		(part): part is string => Boolean(part),
	);

	if (progressSegments.length > 0) {
		const rightParts = [
			...dimParts.map((part) => theme.fg("dim", part)),
			...progressSegments,
		];
		return rightParts.join(sep);
	}
	if (dimParts.length > 0) {
		return theme.fg("dim", dimParts.join(" · "));
	}
	return "";
}

function renderProgressDrivenStrip(state: GsdStatusWidgetState, width: number): string[] {
	const progress = state.gsdProgress!;
	const autoExpand = !!state.lastError;
	// Errors always force expansion so the user can read them.
	// When the user has explicitly set expansion via ctrl+shift+d, honour it.
	// Otherwise fall back to the widgetMode preference from GSD settings.
	const defaultExpanded = progress.widgetMode !== "min";
	const expanded =
		autoExpand ||
		(state.manuallyExpanded !== undefined ? state.manuallyExpanded : defaultExpanded);

	const phase = progress.phase || state.gsdPhase || "Ready";
	const modeTag =
		progress.modeTag === "NEXT" ? theme.fg("success", progress.modeTag) : undefined;
	const headLeft = [
		gsdAutoBadge(!!state.isStreaming),
		modeTag,
		theme.fg("text", truncateToWidth(phase, Math.max(12, width - 36), "…")),
	]
		.filter(Boolean)
		.join(" ");
	const headRight = renderProgressHeadRight(progress);
	const headLine = padLine(alignRight(headLeft, headRight, width), width);

	if (!expanded) {
		return [headLine];
	}

	const lines = [headLine];

	// "small" mode: compact — task progress only, no health summary or workflow details.
	// "full" mode (or unspecified): full detail with health summary, task progress, and workflow line.
	const isSmall = progress.widgetMode === "small";

	if (!isSmall && progress.healthSummary) {
		lines.push(padLine(theme.fg("dim", truncateToWidth(progress.healthSummary, width, "…")), width));
	}

	if (!isSmall) {
		const toolCount = state.activeToolCount ?? 0;
		const workflowSegments = [
			theme.fg("dim", "tools ") +
				theme.fg(toolCount > 0 ? "toolRunning" : "text", toolCount > 0 ? `${toolCount} running` : "idle"),
			theme.fg("dim", "path ") + theme.fg("text", truncateToWidth(progress.path ?? basename(state.cwd), width - 20, "…")),
			theme.fg("dim", "ctrl+shift+d collapse"),
		];
		lines.push(padLine(workflowSegments.join(theme.fg("dim", " │ ")), width));
	}

	return lines;
}

export class GsdStatusWidget implements Component {
	constructor(private readonly getState: () => GsdStatusWidgetState) {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		if (!isWidgetActive(state, width)) {
			return [];
		}

		if (state.gsdProgress) {
			return renderProgressDrivenStrip(state, width);
		}

		const expanded = state.manuallyExpanded ?? false;
		const phase = state.gsdPhase ?? (state.lastError ? "Recovery" : "Ready");
		const tools =
			(state.activeToolCount ?? 0) > 0 ? `${state.activeToolCount} running` : "idle";
		const blockedTag = state.lastError ? theme.fg("error", "blocked") : undefined;

		if (!expanded) {
			const phaseText = theme.fg("text", truncateToWidth(phase, Math.max(12, width - 28), "…"));
			const toolsText = theme.fg("dim", tools);
			const line = layoutMinimalFooter(
				[gsdAutoBadge(!!state.isStreaming), phaseText, blockedTag, toolsText].filter(
					(segment): segment is string => !!segment,
				),
				width,
			);
			return [padLine(line, width)];
		}

		const headLeft = `${gsdAutoBadge(!!state.isStreaming)} ${theme.fg("accent", truncateToWidth(phase, Math.max(12, width - 20), "…"))}`;
		const headRight = state.lastError
			? theme.fg("warning", "blocked")
			: theme.fg("dim", tools);

		const toolCount = state.activeToolCount ?? 0;
		const progressSegments = [
			theme.fg("accent", toolCount > 0 ? `${toolCount} running` : "idle"),
			blockedTag ?? theme.fg("dim", "path ") + theme.fg("text", basename(state.cwd)),
			theme.fg("dim", "ctrl+shift+d collapse"),
		];
		const progressLine = layoutMinimalFooter(progressSegments, width);

		const hint = state.lastError
			? theme.fg("dim", "see error above · retry when ready")
			: theme.fg("dim", "watch live output below");

		return [
			padLine(alignRight(headLeft, headRight, width), width),
			padLine(progressLine, width),
			padLine(hint, width),
		];
	}
}

export function gsdStatusCollapsedLine(state: GsdStatusWidgetState, width: number): string | undefined {
	if (!isWidgetActive(state, width)) return undefined;
	const phase = state.gsdProgress?.phase ?? state.gsdPhase ?? "Ready";
	return truncateToWidth(`● GSD AUTO · ${phase}`, Math.max(12, width), "…");
}
