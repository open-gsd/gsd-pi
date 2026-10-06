// Project/App: gsd-pi
// File Purpose: Applies custom-engine verification outcomes to auto-mode loop side effects.

import type { CustomEngineVerifyRetryOutcome } from "./workflow-custom-engine-retry.js";

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
