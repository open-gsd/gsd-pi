/**
 * Timeout recovery logic for auto-mode units.
 * Handles idle and hard timeout recovery with escalation, steering messages,
 * and blocker placeholder generation.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import {
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
} from "./unit-runtime.js";
import {
  diagnoseExpectedArtifact,
  verifyExpectedArtifact,
  writeBlockerPlaceholder,
} from "./auto-recovery.js";

import { bumpAndResolveSynthetic } from "./auto/resolve.js";
import { finalizeProjectResearchTimeout } from "./project-research-policy.js";
import { applySupervisorModelIfConfigured } from "./auto-model-selection.js";
import { getInFlightToolCount } from "./auto-tool-tracking.js";
import { parseUnitId } from "./unit-id.js";
import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";
import { isDbAvailable } from "./gsd-db.js";

export interface RecoveryContext {
  basePath: string;
  verbose: boolean;
  currentUnitStartedAt: number;
  unitRecoveryCount: Map<string, number>;
}

export async function recoverTimedOutUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  reason: "idle" | "hard",
  rctx: RecoveryContext,
): Promise<"recovered" | "paused"> {
  // Note on turn epoch: the bump is intentionally NOT unconditional at
  // function entry. Two branches below (the "steering retry" paths) keep
  // the same LLM turn alive and let it try again — they must NOT bump,
  // otherwise the retry's legitimate writes get marked stale and drop.
  // Each advance branch calls `bumpAndResolveSynthetic` to bump+resolve
  // atomically. Search for that helper to find all supersede sites.

  const { basePath, verbose, currentUnitStartedAt, unitRecoveryCount } = rctx;

  const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
  const recoveryAttempts = runtime?.recoveryAttempts ?? 0;
  const maxRecoveryAttempts = reason === "idle" ? 2 : 1;

  const recoveryKey = `${unitType}/${unitId}`;
  const attemptNumber = (unitRecoveryCount.get(recoveryKey) ?? 0) + 1;
  unitRecoveryCount.set(recoveryKey, attemptNumber);

  if (attemptNumber > 1) {
    // Exponential backoff: 2^(n-1) seconds, capped at 30s
    const backoffMs = Math.min(1000 * Math.pow(2, attemptNumber - 2), 30000);
    ctx.ui.notify(
      `Recovery attempt ${attemptNumber} for ${unitType} ${unitId}. Waiting ${backoffMs / 1000}s before retry.`,
      "info",
    );
    await new Promise(r => setTimeout(r, backoffMs));
  }

  if (unitType === "execute-task") {
    const status = await inspectExecuteTaskDurability(basePath, unitId);
    if (!status) return "paused";

    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      recovery: status,
    });

    const { milestone, slice, task } = parseUnitId(unitId);
    const latestAttempt = isDbAvailable() && milestone && slice && task
      ? readLatestTaskAttempt({ milestoneId: milestone, sliceId: slice, taskId: task })
      : null;
    const durableComplete = latestAttempt?.state === "settled" && latestAttempt.outcome === "succeeded";
    if (durableComplete) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
        phase: "finalized",
        recovery: status,
      });
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} already completed. Continuing auto-mode. (attempt ${attemptNumber})`,
        "info",
      );
      unitRecoveryCount.delete(recoveryKey);
      bumpAndResolveSynthetic(`timeout-recovery:${reason}:${unitType}/${unitId}`);
      return "recovered";
    }

    if (recoveryAttempts < maxRecoveryAttempts) {
      const isEscalation = recoveryAttempts > 0;
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
        phase: "recovered",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
        lastProgressAt: Date.now(),
        progressCount: (runtime?.progressCount ?? 0) + 1,
        lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
        // This steering retry is a fresh chance for the same unit to save a valid result.
        harnessAbort: undefined,
      });

      const steeringLines = isEscalation
        ? [
            `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before this task is skipped.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "You MUST finish the durable output NOW, even if incomplete.",
            "Write the task summary with whatever you have accomplished so far.",
            "Mark the task [x] in the plan. Commit your work.",
            "A partial summary is infinitely better than no summary.",
          ]
        : [
            `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — do not stop.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "Do not keep exploring.",
            "Immediately finish the required durable output for this unit.",
            "If full completion is impossible, write the partial artifact/state needed for recovery and make the blocker explicit.",
          ];

      const recoveryTrigger = getInFlightToolCount() === 0;
      if (recoveryTrigger) {
        await applySupervisorModelIfConfigured(ctx, pi, basePath);
      }
      pi.sendMessage(
        {
          customType: "gsd-auto-timeout-recovery",
          display: verbose,
          content: steeringLines.join("\n"),
        },
        { triggerTurn: recoveryTrigger, deliverAs: "steer" },
      );
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to finish durable output (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
        "warning",
      );
      return "recovered";
    }

    // Retries exhausted — write a blocker placeholder and advance.
    const diagnostic = formatExecuteTaskRecoveryStatus(status);
    const placeholder = writeBlockerPlaceholder(
      unitType, unitId, basePath,
      `${reason} recovery exhausted ${maxRecoveryAttempts} attempts. Status: ${diagnostic}`,
    );

    if (placeholder) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
        phase: "recovered",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
        lastProgressKind: `${reason}-recovery-durable-handoff`,
      });
      ctx.ui.notify(
        `${unitType} ${unitId} ended after ${maxRecoveryAttempts} recovery attempts (${diagnostic}). Diagnostic artifacts were written; durable Task recovery will decide the next action. (attempt ${attemptNumber})`,
        "warning",
      );
      unitRecoveryCount.delete(recoveryKey);
      bumpAndResolveSynthetic(`timeout-recovery:${reason}:${unitType}/${unitId}`);
      return "recovered";
    }

    // Fallback: couldn't write skip artifacts — pause as before.
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: "paused",
      recovery: status,
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery check for ${unitType} ${unitId}: ${diagnostic}`,
      "warning",
    );
    return "paused";
  }

  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath) ?? "required durable artifact";

  if (unitType === "research-project") {
    const outcome = finalizeProjectResearchTimeout(
      basePath,
      `${reason} timeout recovery finalized project research before all dimensions completed.`,
    );
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: outcome.kind === "global-blocker" ? "skipped" : "finalized",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    const message = outcome.kind === "completed"
      ? `Project research ${reason} timeout: research artifacts are already terminal; advancing.`
      : outcome.kind === "partial-blockers"
        ? `Project research ${reason} timeout: wrote blocker files for missing dimensions and advancing with partial research.`
        : `Project research ${reason} timeout: wrote PROJECT-RESEARCH-BLOCKER.md and stopping fail-closed.`;
    ctx.ui.notify(message, outcome.kind === "global-blocker" ? "error" : "warning");
    unitRecoveryCount.delete(recoveryKey);
    bumpAndResolveSynthetic(`timeout-recovery:${reason}:${unitType}/${unitId}`);
    return "recovered";
  }

  if (verifyExpectedArtifact(unitType, unitId, basePath)) {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: "finalized",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} durable outcome verified. Advancing. (attempt ${attemptNumber})`,
      "info",
    );
    unitRecoveryCount.delete(recoveryKey);
    bumpAndResolveSynthetic(`timeout-recovery:${reason}:${unitType}/${unitId}`);
    return "recovered";
  }

  if (recoveryAttempts < maxRecoveryAttempts) {
    const isEscalation = recoveryAttempts > 0;
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: "recovered",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
      lastProgressAt: Date.now(),
      progressCount: (runtime?.progressCount ?? 0) + 1,
      lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
      // This steering retry is a fresh chance for the same unit to save a valid result.
      harnessAbort: undefined,
    });

    const steeringLines = unitType === "validate-milestone"
      ? [
          `**${isEscalation ? "FINAL " : ""}${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — persist the canonical validation now.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
          "Finish reviewer aggregation and synthesize the verdict from the reviewers' findings.",
          "Call `gsd_validate_milestone` with the complete validation result.",
          "Do not manually write VALIDATION.md; it is a projection rendered by the canonical persistence operation.",
          "If canonical persistence cannot be completed, stop and leave the unit fail-closed.",
        ]
      : isEscalation
        ? [
            `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before skip.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts} — next failure skips this unit.`,
            `Expected durable output: ${expected}.`,
            "You MUST write the artifact file NOW, even if incomplete.",
            "Write whatever you have — partial research, preliminary findings, best-effort analysis.",
            "A partial artifact is infinitely better than no artifact.",
            "If you are truly blocked, write the file with a BLOCKER section explaining why.",
          ]
        : [
            `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — stay in auto-mode.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Expected durable output: ${expected}.`,
            "Stop broad exploration.",
            "Write the required artifact now.",
            "If blocked, write the partial artifact and explicitly record the blocker instead of going silent.",
          ];

    const recoveryTrigger = getInFlightToolCount() === 0;
    if (recoveryTrigger) {
      await applySupervisorModelIfConfigured(ctx, pi, basePath);
    }
    pi.sendMessage(
      {
        customType: "gsd-auto-timeout-recovery",
        display: verbose,
        content: steeringLines.join("\n"),
      },
      { triggerTurn: recoveryTrigger, deliverAs: "steer" },
    );
    const recoveryTarget = unitType === "validate-milestone"
      ? "finish reviewer aggregation and call gsd_validate_milestone"
      : `produce ${expected}`;
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to ${recoveryTarget} (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
      "warning",
    );
    return "recovered";
  }

  // #4175/#1995: Never replace canonical lifecycle projections with blocker
  // placeholders. They cannot update the required DB state, so finalization
  // rejects them and retries unchanged input indefinitely. Pause fail-closed.
  if (unitType === "complete-milestone" || unitType === "plan-slice" || unitType === "validate-milestone") {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: "paused",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    const message = unitType === "complete-milestone"
      ? `Milestone ${unitId} ${reason}-recovery exhausted ${maxRecoveryAttempts} attempt(s) — worktree branch preserved. Re-run /gsd auto once blockers are resolved.`
      : unitType === "validate-milestone"
        ? `Milestone validation ${unitId} ${reason}-recovery exhausted ${maxRecoveryAttempts} attempt(s) — no canonical validation result was persisted; canonical VALIDATION preserved. Re-run /gsd auto once blockers are resolved.`
        : `Slice plan ${unitId} ${reason}-recovery exhausted ${maxRecoveryAttempts} attempt(s) — canonical PLAN preserved. Re-run /gsd auto once blockers are resolved.`;
    ctx.ui.notify(
      message,
      "error",
    );
    return "paused";
  }

  // Retries exhausted — surface a blocker instead of silently stalling.
  // Milestone planning pauses fail-closed; legacy units retain their existing
  // placeholder-and-advance behavior.
  const placeholder = writeBlockerPlaceholder(
    unitType, unitId, basePath,
    `${reason} recovery exhausted ${maxRecoveryAttempts} attempts without producing the artifact.`,
  );

  if (placeholder) {
    const planningBlocked = unitType === "plan-milestone";
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
      phase: planningBlocked ? "paused" : "skipped",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    if (planningBlocked) {
      ctx.ui.notify(
        `${unitType} ${unitId} blocked after ${maxRecoveryAttempts} recovery attempts. Diagnostic written to ${placeholder}; no milestone work was marked complete. Pausing for repair. (attempt ${attemptNumber})`,
        "error",
      );
    } else {
      ctx.ui.notify(
        `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts. Blocker placeholder written to ${placeholder}. Advancing pipeline. (attempt ${attemptNumber})`,
        "warning",
      );
    }
    unitRecoveryCount.delete(recoveryKey);
    bumpAndResolveSynthetic(`timeout-recovery:${reason}:${unitType}/${unitId}`);
    return planningBlocked ? "paused" : "recovered";
  }

  // Fallback: couldn't resolve artifact path — pause as before.
  writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnitStartedAt, {
    phase: "paused",
    recoveryAttempts: recoveryAttempts + 1,
    lastRecoveryReason: reason,
  });
  return "paused";
}
