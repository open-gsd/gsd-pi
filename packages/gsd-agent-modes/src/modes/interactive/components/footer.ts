// Project/App: gsd-pi
// File Purpose: Interactive terminal footer renderer for workspace, model, usage, context, and extension status.

import { type Component, truncateToWidth } from "@gsd/pi-tui";
import type { AgentSession } from "@gsd/agent-core";
import type { ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { providerAuthBadge, providerDisplayName } from "./model-selector.js";
import {
	badge,
	layoutFullWidthMinimalFooter,
	renderMinimalFooterLine,
	renderProgressBar,
} from "./transcript-design.js";
import type { GsdStatusWidgetState } from "./gsd-status-widget.js";
import { isGsdStatusWidgetVisible } from "./gsd-status-widget.js";

const CONTEXT_BAR_WIDTH = 6;

/** Extension status keys shown in the footer center when the GSD strip is visible. */
const PRIMARY_STATUS_KEYS = ["gsd-step", "zz-notifications", "gsd-fast"] as const;

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Abbreviate cwd for the footer — `~` for home and descendants only.
 * @internal Exported for testing only.
 */
export function formatCwdForFooter(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE ?? ""): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	const withForwardSep = home.endsWith("/") ? home : `${home}/`;
	const withBackSep = home.endsWith("\\") ? home : `${home}\\`;
	if (cwd.startsWith(withForwardSep) || cwd.startsWith(withBackSep)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function pickPrimaryExtensionStatus(
	statuses: ReadonlyMap<string, string>,
): { key: string; text: string } | undefined {
	for (const key of PRIMARY_STATUS_KEYS) {
		const raw = statuses.get(key);
		if (!raw) continue;
		const text = sanitizeStatusText(raw);
		if (text) return { key, text };
	}
	return undefined;
}

function formatSecondaryExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	excludedKeys: ReadonlySet<string>,
): string {
	return Array.from(statuses.entries())
		.filter(([key]) => !excludedKeys.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean)
		.join(" ");
}

function formatWorkspaceCenter(cwd: string, sessionName?: string): string {
	const parts = [formatCwdForFooter(cwd)];
	if (sessionName) parts.push(sessionName);
	return parts.join(" · ");
}

/**
 * Format a cost value for compact display.
 * @internal Exported for testing only.
 */
export function formatPromptCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(4)}`;
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Footer component — one minimal status line (branch, model, context, cost).
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
		private readonly getGsdStatus?: () => GsdStatusWidgetState,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {}

	dispose(): void {}

	render(width: number): string[] {
		const state = this.session.state;
		const gsdState = this.getGsdStatus?.();

		// Token fields stay parent-only: the cache percentage is a property of
		// the active parent conversation and child tokens must not distort it
		// (#2821). The cost segment is the session total: parent + reconciled
		// child-session usage.
		const usageTotals = this.session.sessionManager.getUsageTotals();
		const sessionTotals = this.session.sessionManager.getUsageTotals({ includeExternalUsage: true });
		const totalInput = usageTotals.input;
		const totalOutput = usageTotals.output;
		const totalCacheRead = usageTotals.cacheRead;
		const totalCacheWrite = usageTotals.cacheWrite;
		const totalCost = sessionTotals.cost;

		const displayModel = state.activeInferenceModel ?? state.model;
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? displayModel?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(0) : "?";

		const branch = this.footerData.getGitBranch();
		const modelName = displayModel?.id || "no-model";

		const inputSide = totalInput + totalCacheRead + totalCacheWrite;
		let cacheSegment: string | undefined;
		if (totalCacheRead > 0 && inputSide > 0) {
			const cachedPct = Math.round((totalCacheRead / inputSide) * 100);
			cacheSegment = theme.fg("success", `${cachedPct}%↺`);
		}

		let costSegment: string | undefined;
		const usingSubscription = displayModel ? this.session.modelRegistry.isUsingOAuth(displayModel) : false;
		if (totalCost || usingSubscription) {
			const costLabel = usingSubscription ? `$${totalCost.toFixed(2)}*` : `$${totalCost.toFixed(2)}`;
			costSegment = theme.fg("warning", costLabel);
		}

		const gsdWidgetVisible = gsdState ? isGsdStatusWidgetVisible(gsdState, width) : false;
		const gsdSegment = gsdWidgetVisible ? undefined : badge("● GSD", "default");

		const barColor: "error" | "warning" | "success" =
			contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "success";

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const primaryStatus = gsdWidgetVisible ? pickPrimaryExtensionStatus(extensionStatuses) : undefined;
		const secondaryExtText = formatSecondaryExtensionStatuses(
			extensionStatuses,
			primaryStatus ? new Set([primaryStatus.key]) : new Set(),
		);

		let providerSuffix = "";
		if (this.footerData.getAvailableProviderCount() > 1 && displayModel) {
			const authMode = this.session.modelRegistry.getProviderAuthMode(displayModel.provider);
			const authLabel = providerAuthBadge(authMode);
			const providerLabel = providerDisplayName(displayModel.provider);
			providerSuffix = authLabel ? `${providerLabel} ${authLabel}` : providerLabel;
		}

		const pctLabel = theme.fg(barColor, contextPercent === "?" ? "?" : `${contextPercent}%`);
		const contextTokens = contextUsage?.tokens;
		const tokenHint =
			contextPercent === "?" || contextTokens == null
				? ""
				: theme.fg("dim", ` ${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`);
		const pct = contextPercent === "?" ? 0 : contextPercentValue;
		const contextBar = renderProgressBar(pct, 100, CONTEXT_BAR_WIDTH, barColor);
		const autoHint = this.autoCompactEnabled ? theme.fg("dim", " (auto)") : "";
		const contextSegment = `${contextBar} ${pctLabel}${tokenHint}${autoHint}`;

		const leftSegments = [
			gsdSegment,
			branch ? theme.fg("dim", branch) : undefined,
			theme.fg("text", modelName),
		].filter((segment): segment is string => !!segment);

		const rightSegments = [
			contextSegment,
			cacheSegment,
			costSegment,
			providerSuffix ? theme.fg("dim", providerSuffix) : undefined,
			secondaryExtText ? theme.fg("dim", secondaryExtText) : undefined,
		].filter((segment): segment is string => !!segment);

		const cwd = gsdState?.cwd ?? process.cwd();
		const sessionName = this.session.sessionManager.getSessionName() ?? gsdState?.sessionName;
		const centerSource = gsdWidgetVisible
			? primaryStatus?.text
			: formatWorkspaceCenter(cwd, sessionName);

		const line = layoutFullWidthMinimalFooter(leftSegments, rightSegments, width, (budget) => {
			if (!centerSource) return "";
			const styled = gsdWidgetVisible
				? theme.fg("text", centerSource)
				: theme.fg("dim", centerSource);
			return truncateToWidth(styled, budget, "…");
		});

		return renderMinimalFooterLine(line, width);
	}
}
