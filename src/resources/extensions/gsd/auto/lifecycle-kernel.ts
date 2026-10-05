// Project/App: gsd-pi
// File Purpose: The persisted Lifecycle Kernel (ADR-046, ADR-048): the four
// entry points an auto-mode host calls — start, advance, resume and stop.
//
// advance() selects the next unit from database rows, in this order:
//   1. the dispatch row of a unit that a killed process left in the verify
//      stage: the unit continues at that stage and does not run again;
//   2. the oldest queued row of the sidecar queue;
//   3. the unit the Auto Orchestration module selects. Its dispatch rules read
//      the stored retry rows and the lifecycle rows, and it claims the
//      unit_dispatches row.
// A custom workflow engine selects its step from the step rows of its run. The
// kernel returns `engine` for it when the sidecar queue has no work.
//
// auto/workflow-kernel.ts is the pure policy layer below this module.

import type { AutoSession } from "./session.js";
import type { AutoAdvanceResult, AutoSessionContext, UnitRef } from "./contracts.js";
import { dequeueSidecarItem, type SidecarDequeuePayload } from "./workflow-sidecar-queue.js";
import { shouldUseCustomEnginePath } from "./workflow-kernel.js";
import { listQueuedSidecarItems, type QueuedSidecarItem } from "../db/unit-dispatch-sidecars.js";
import { getInterruptedVerifyDispatch } from "../db/unit-dispatches.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { debugLog } from "../debug-logger.js";
import { logWarning } from "../workflow-logger.js";

export type KernelAdvanceResult =
  | AutoAdvanceResult
  /** A unit that left execution before its process was killed. */
  | { kind: "stage"; stage: "verify"; unit: UnitRef; interruptedDispatchId: number }
  | { kind: "sidecar"; item: QueuedSidecarItem }
  /** The custom engine of the session selects the step. */
  | { kind: "engine" }
  /** The session has no Auto Orchestration module. */
  | { kind: "unavailable" };

export interface KernelAdvanceInput {
  executionGraphEnabled: boolean;
  emitSidecarDequeue: (payload: SidecarDequeuePayload) => void;
}

export async function kernelStart(
  s: AutoSession,
  sessionContext: AutoSessionContext,
): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.start(sessionContext);
}

export async function kernelAdvance(
  s: AutoSession,
  input: KernelAdvanceInput,
): Promise<KernelAdvanceResult> {
  const customEngine = shouldUseCustomEnginePath({
    activeEngineId: s.activeEngineId,
    hasSidecarItem: false,
    engineBypass: process.env.GSD_ENGINE_BYPASS === "1",
  });

  if (!customEngine && s.currentMilestoneId) {
    const interrupted = getInterruptedVerifyDispatch(
      s.currentMilestoneId,
      process.env.GSD_SLICE_LOCK ?? null,
    );
    if (interrupted) {
      return {
        kind: "stage",
        stage: "verify",
        unit: { unitType: interrupted.unit_type, unitId: interrupted.unit_id },
        interruptedDispatchId: interrupted.id,
      };
    }
  }

  const sidecarItem = await dequeueSidecarItem({
    queue: listQueuedSidecarItems(),
    executionGraphEnabled: input.executionGraphEnabled,
    scheduleQueue: scheduleSidecarQueue,
    warnSchedulingFailure: message => logWarning("dispatch", `sidecar queue scheduling failed: ${message}`),
    logDequeue: payload => debugLog("autoLoop", { phase: "sidecar-dequeue", ...payload }),
    emitDequeue: input.emitSidecarDequeue,
  });
  if (sidecarItem) return { kind: "sidecar", item: sidecarItem };

  if (customEngine) return { kind: "engine" };

  const orchestration = s.orchestration;
  if (!orchestration) return { kind: "unavailable" };

  // A unit this process already claimed and did not start yet.
  const pending = s.pendingOrchestrationDispatch;
  if (pending) {
    return {
      kind: "advanced",
      unit: { unitType: pending.unitType, unitId: pending.unitId },
      stateSnapshot: pending.state,
      dispatchId: pending.dispatchId ?? 0,
    };
  }
  return orchestration.advance();
}

export async function kernelResume(s: AutoSession): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.resume();
}

export async function kernelStop(
  s: AutoSession,
  reason: string,
): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.stop(reason);
}
