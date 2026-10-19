import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";

/**
 * Turn-abort escalation for the tool-call loop guard (#2877).
 *
 * A loop-guard block is normally returned to the model as an error toolResult.
 * Observed in the field: a model that ignores that signal re-issues the
 * blocked tool 425+ times in one turn (~24 minutes of unbounded cost) because
 * nothing ever ends the turn. When `checkToolCallLoop` flags a block as
 * `escalate` (a repeat block of the same tool after a new model response —
 * see tool-call-loop-guard.ts), this module ends the turn through the
 * sanctioned pause path instead: `pauseAuto(..., "machine_fixable",
 * { abortActiveTurn: true })` aborts the agent turn, closes the unit into the
 * pause/repair state (auto_pauses row + cancelled unit end), and `/gsd auto`
 * resumes it. The guard's reason rides on the pause row via
 * PauseAutoOptions.pauseReason — deliberately NOT via an ErrorContext, so the
 * unit resolves as a bare pause-origin cancellation.
 *
 * Auto-mode only: interactive sessions have no unit to land in a repair
 * state, so they keep the plain block-as-error behavior.
 */

let abortInFlight = false;

/** Reset the one-shot guard. Call at agent turn boundaries. */
export function resetLoopGuardAbortGuard(): void {
  abortInFlight = false;
}

/**
 * Abort the active auto-mode unit turn because the loop guard blocked the
 * same tool again immediately after a block. Returns true when the sanctioned
 * pause ran; false leaves the caller with the plain block-as-error result.
 */
export async function maybeAbortAutoUnitForLoopGuard(
  ctx: ExtensionContext | undefined,
  pi: ExtensionAPI | undefined,
  toolName: string,
  blockReason: string,
  count?: number,
): Promise<boolean> {
  const { isAutoActive } = await import("../auto-runtime-state.js");
  if (!isAutoActive()) return false;
  if (abortInFlight) return false;
  abortInFlight = true;

  // The reason must classify as a deterministic policy failure on the pause
  // row (recovery-classification.ts infers from the message), so the resume
  // route is repair, not an automatic retry of the same unit prompt.
  const reason = [
    `Tool loop guard escalation: "${toolName}" was blocked again immediately after a loop-guard block` +
      (typeof count === "number" ? ` (call ${count} this turn)` : "") +
      " — the model kept re-issuing a blocked tool after an explicit deterministic policy rejection.",
    `Underlying block: ${blockReason}`,
    "Auto-mode paused the unit for repair; /gsd auto resumes it.",
  ].join(" ");

  // The reason rides on options.pauseReason, NOT on an ErrorContext: a
  // contexted cancellation makes the auto loop re-process the unit result
  // (transient-pause or hard stop), while a contextless one is recognized as
  // pause-origin (_isPauseOriginCancelledResult) and leaves the resumable
  // pause this module just created untouched.
  try {
    // Inside the try: a throwing notify must not strand abortInFlight with
    // neither a pause nor a log (#2877 — never silent).
    ctx?.ui?.notify?.(reason, "warning");
    const { pauseAuto } = await import("../auto.js");
    await pauseAuto(ctx, pi, "machine_fixable", undefined, {
      abortActiveTurn: true,
      pauseReason: reason,
    });
  } catch (err) {
    abortInFlight = false;
    logWarning(
      "engine",
      `loop-guard turn abort failed: ${err instanceof Error ? err.message : String(err)}`,
      { file: "bootstrap/loop-guard-abort.ts" },
    );
    // Fall back to the plain block-as-error result; the turn keeps today's
    // behavior instead of dying on a failed pause.
    return false;
  }
  return true;
}
