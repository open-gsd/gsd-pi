// Project/App: gsd-pi
// File Purpose: Applies custom-engine verification outcomes to auto-mode loop side effects.

import type { CustomEngineVerifyRetryOutcome } from "./workflow-custom-engine-retry.js";
import type { HostVerificationEvidence } from "./custom-task-host-verification.js";
import type { VerificationOutcome } from "../custom-verification.js";

/** One evidence-producing read a verification turn performed, in read order. */
export type VerificationRead =
  | { source: "policy"; evidence: string }
  | { source: "host"; evidence: HostVerificationEvidence };

/**
 * Compose the ADR-047 §3 signature payload for one custom-engine verification
 * turn from every input the turn actually read.
 *
 * WHY compose-and-order instead of first-write-wins: a single verification turn
 * can read more than once. Interactive human review resolves the blocker and the
 * host boundary runs a SECOND time, deciding on the now-resolved blocker with a
 * different outcome; the post-policy paths decide on source revisions captured
 * after the policy ran. Keeping the first write (`??=`) hashed the stale policy
 * evidence, so "the policy failed" and "the policy failed, then human review
 * resolved it" collapsed into one signature and falsely tripped the liveness
 * wedge at occurrence two (#1674).
 *
 * Precedence and ordering: nothing is dropped and nothing is re-keyed — the
 * reads appear in emission order (policy evidence where the policy ran, then
 * each host decision), so the last entry is the decisive one and later evidence
 * always changes the hash, while an identical sequence of identical reads hashes
 * identically and still trips at occurrence two.
 *
 * A turn whose only read is the policy keeps that policy payload verbatim — the
 * shape the engine's own evidence already had — so composition appears only when
 * a turn genuinely read more than once.
 */
export function composeVerificationInputPayload(input: {
  outcome: VerificationOutcome;
  reads: readonly VerificationRead[];
}): string {
  const [first] = input.reads;
  if (input.reads.length === 1 && first?.source === "policy") return first.evidence;
  if (input.reads.length === 0) return JSON.stringify({ outcome: input.outcome });
  return JSON.stringify({ outcome: input.outcome, reads: input.reads });
}

export interface HandleCustomEngineVerifyOutcomeDeps {
  pauseAuto: () => Promise<void>;
  stopAuto: (reason: string) => Promise<void>;
  reportPause: (details: { unitType: string; unitId: string }) => void;
  finishTurn: (
    status: "paused" | "stopped" | "retry",
    failureClass: "manual-attention",
    error: string | undefined,
    guardId: string,
    inputPayload?: string,
  ) => void;
}

export type CustomEngineVerifyFlow = { action: "break" } | { action: "continue" };

export function handleCustomEngineTaskVerifyOutcome(input: {
  outcome: "retry" | "abort";
  inputPayload: string;
  finishTurn: (
    status: "stopped" | "retry",
    failureClass: "verification",
    error: string,
    guardId: string,
    inputPayload?: string,
  ) => void;
}): CustomEngineVerifyFlow {
  if (input.outcome === "abort") {
    input.finishTurn("stopped", "verification", "custom-engine-task-verify-abort", "custom-engine-task-verify", input.inputPayload);
    return { action: "break" };
  }

  input.finishTurn("retry", "verification", "custom-engine-task-verify-retry", "custom-engine-task-verify", input.inputPayload);
  return { action: "continue" };
}

export async function handleCustomEngineVerifyPause(input: {
  unitType: string;
  unitId: string;
  inputPayload: string;
  deps: HandleCustomEngineVerifyOutcomeDeps;
}): Promise<CustomEngineVerifyFlow> {
  await input.deps.pauseAuto();
  input.deps.reportPause({
    unitType: input.unitType,
    unitId: input.unitId,
  });
  input.deps.finishTurn("paused", "manual-attention", "custom-engine-verify-pause", "custom-engine-verify", input.inputPayload);
  return { action: "break" };
}

export async function handleCustomEngineVerifyRetryOutcome(input: {
  outcome: CustomEngineVerifyRetryOutcome;
  inputPayload: string;
  deps: HandleCustomEngineVerifyOutcomeDeps;
}): Promise<CustomEngineVerifyFlow> {
  if (input.outcome.action === "pause") {
    await input.deps.pauseAuto();
    input.deps.finishTurn("paused", "manual-attention", input.outcome.turnError, "custom-engine-verify", input.inputPayload);
    return { action: "break" };
  }
  if (input.outcome.action === "stop") {
    await input.deps.stopAuto(input.outcome.stopMessage);
    input.deps.finishTurn("stopped", "manual-attention", input.outcome.turnError, "custom-engine-verify", input.inputPayload);
    return { action: "break" };
  }

  input.deps.finishTurn("retry", "manual-attention", undefined, "custom-engine-verify", input.inputPayload);
  return { action: "continue" };
}
