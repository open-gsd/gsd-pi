// Project/App: gsd-pi
// File Purpose: /gsd recover <recoveryActionId> — operator CLI bridge for Task recovery resume.

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  ensureDbOpen,
  resolveTaskRecoveryResumeBasePath,
} from "./bootstrap/dynamic-tools.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  readTaskRecoveryResumeEligibility,
  resumeTaskRecovery,
} from "./task-recovery-domain-operation.js";

function cliInvocation(): ExecutionInvocation {
  const id = randomUUID();
  return {
    idempotencyKey: `cli:gsd_task_recovery_resume:${id}`,
    sourceTransport: "internal",
    actorType: "user",
    actorId: "gsd-cli-operator",
    traceId: id,
  };
}

export async function handleTaskRecoveryResume(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<void> {
  const recoveryActionId = args.trim();
  if (!recoveryActionId || /\s/u.test(recoveryActionId) || recoveryActionId.startsWith("--")) {
    ctx.ui.notify(
      "Usage: /gsd recover <recoveryActionId>",
      "warning",
    );
    return;
  }
  const recoveryBasePath = resolveTaskRecoveryResumeBasePath(
    { cwd: basePath },
    recoveryActionId,
  );
  if (!await ensureDbOpen(recoveryBasePath)) {
    ctx.ui.notify("gsd recover: GSD database is not available.", "error");
    return;
  }

  const eligibility = readTaskRecoveryResumeEligibility(recoveryActionId);
  if (!eligibility.eligible) {
    ctx.ui.notify(
      `gsd recover: Task recovery ${recoveryActionId} is not eligible (${eligibility.failedGuard ?? "unknown"}: ${eligibility.detail ?? "not eligible"}).`,
      "error",
    );
    return;
  }

  const repairSummary = (await ctx.ui.input(
    "Task recovery repair",
    "Describe what was repaired and why retry is now safe",
  ))?.trim();
  if (!repairSummary) {
    ctx.ui.notify("gsd recover cancelled: a repair summary is required.", "warning");
    return;
  }
  const evidence = (await ctx.ui.input(
    "Task recovery evidence",
    "Describe the concrete verification evidence for the repair",
  ))?.trim();
  if (!evidence) {
    ctx.ui.notify("gsd recover cancelled: verification evidence is required.", "warning");
    return;
  }

  try {
    const result = resumeTaskRecovery({
      invocation: cliInvocation(),
      recoveryActionId,
      repairSummary,
      evidence: { operatorEvidence: evidence, source: "gsd-cli" },
    });
    ctx.ui.notify(
      `Task recovery ${result.recoveryActionId} resumed — one repaired continuation is authorized for Attempt ${result.attemptId}. Re-run /gsd auto.`,
      "success",
    );
  } catch (error) {
    ctx.ui.notify(
      `gsd recover: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
