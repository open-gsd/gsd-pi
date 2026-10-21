import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { getPendingGate } from "./write-gate.js";

let pauseScheduledForTurn = false;

export function resetPendingGatePauseGuard(): void {
	pauseScheduledForTurn = false;
}

/**
 * Pause auto-mode once per agent turn when a depth-verification gate is waiting
 * for user confirmation. Prevents HARD BLOCK retry loops and blocker placeholders.
 */
export async function maybePauseAutoForApprovalGate(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	gateBlocking: boolean,
	notifyMessage: string,
): Promise<boolean> {
	if (!gateBlocking) return false;

	const { isAutoActive } = await import("../auto-runtime-state.js");
	if (!isAutoActive()) return false;
	if (pauseScheduledForTurn) return true;

	pauseScheduledForTurn = true;
	ctx.ui.notify(notifyMessage, "info");
	const { pauseAuto } = await import("../auto.js");
	await pauseAuto(ctx, pi);
	return true;
}

/** @deprecated use maybePauseAutoForApprovalGate */
export async function maybePauseAutoForPendingDiscussionGate(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	basePath: string,
	notifyMessage: string,
): Promise<boolean> {
	return maybePauseAutoForApprovalGate(ctx, pi, Boolean(getPendingGate(basePath)), notifyMessage);
}
