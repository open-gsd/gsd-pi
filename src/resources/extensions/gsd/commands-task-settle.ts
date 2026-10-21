// Project/App: gsd-pi
// File Purpose: /gsd task settle — operator CLI surface for gsd_task_settle (#1749),
// including the `blocker-accepted` closeout disposition (#2202).

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  applyBlockerAcceptedDisposition,
  applyTaskSettle,
  planBlockerAcceptedDisposition,
  planTaskSettle,
  type TaskSettleTask,
} from "./task-settle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

function parseTaskSettleArgs(args: string): {
  task: TaskSettleTask;
  reason: string;
  apply: boolean;
  reconcileLifecycle: boolean;
  blockerAccepted: boolean;
} | null {
  const apply = /(?:^|\s)--apply(?:\s|$)/.test(args);
  const reconcileLifecycle = /(?:^|\s)--reconcile-lifecycle(?:\s|$)/.test(args);
  const blockerAccepted = /(?:^|\s)--blocker-accepted(?:\s|$)/.test(args);
  const reasonMatch = args.match(/--reason\s+"([^"]+)"|--reason\s+'([^']+)'|--reason\s+(\S+)/);
  const positional = args
    .replace(/--apply/g, "")
    .replace(/--reconcile-lifecycle/g, "")
    .replace(/--blocker-accepted/g, "")
    .replace(/--reason\s+"[^"]*"|\s--reason\s+'[^']*'|--reason\s+\S+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const unit = (positional[0] ?? "").replace(/^execute-task\//, "");
  const parts = unit.split("/");
  const reason = reasonMatch?.[1] ?? reasonMatch?.[2] ?? reasonMatch?.[3] ?? "";
  if (parts.length !== 3 || parts.some((part) => part.length === 0) || reason.length === 0) return null;
  return {
    task: { milestoneId: parts[0], sliceId: parts[1], taskId: parts[2] },
    reason,
    apply,
    reconcileLifecycle,
    blockerAccepted,
  };
}

function cliInvocation(): ExecutionInvocation {
  const id = randomUUID();
  return {
    idempotencyKey: `cli:gsd_task_settle:${id}`,
    sourceTransport: "internal",
    actorType: "user",
    traceId: id,
  };
}

export async function handleTaskSettle(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<void> {
  const parsed = parseTaskSettleArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      'Usage: /gsd task settle <M001/S01/T01> --reason "why" [--apply] [--reconcile-lifecycle] [--blocker-accepted]\n' +
      "Dry-run by default: prints the exact Attempt, lifecycle, or blocker-accepted rows it would change. " +
      "--apply performs the settle. --blocker-accepted closes a Task whose latest Attempt failed as " +
      "blocker-discovered at the route stage (no rerun; then replan the slice).",
      "warning",
    );
    return;
  }
  if (parsed.blockerAccepted && parsed.reconcileLifecycle) {
    ctx.ui.notify(
      "gsd task settle: --blocker-accepted and --reconcile-lifecycle are mutually exclusive.",
      "error",
    );
    return;
  }
  if (!await ensureDbOpen(basePath)) {
    ctx.ui.notify("gsd task settle: GSD database is not available.", "error");
    return;
  }
  const unit = `${parsed.task.milestoneId}/${parsed.task.sliceId}/${parsed.task.taskId}`;
  try {
    if (parsed.blockerAccepted) {
      if (!parsed.apply) {
        const plan = planBlockerAcceptedDisposition(parsed.task, parsed.reason);
        if (plan.alreadyAccepted) {
          ctx.ui.notify(`gsd task settle (dry run): ${unit} is already closed as blocker-accepted — nothing to do.`, "info");
          return;
        }
        const row = plan.rows[0];
        ctx.ui.notify(
          `gsd task settle (dry run) — blocker-accepted disposition, no changes made:\n` +
          `  lifecycle ${row.lifecycleFrom} → blocker-accepted (legacy tasks.status ${row.currentStatus} → blocker-accepted)\n` +
          `  attempt ${row.attemptId} Result ${row.resultId} preserved; route Kernel head consumed with a closeout decision\n` +
          `  provenance: ${row.blockerSummary || "(failed Result carries no summary)"}` +
          `${row.supersededRecoveryActionId ? `; supersedes Recovery Action ${row.supersededRecoveryActionId}` : ""}\n` +
          `  next: gsd_replan_slice with blockerTaskId ${parsed.task.taskId}\n` +
          "Re-run with --apply to accept the blocker.",
          "info",
        );
        return;
      }
      const result = applyBlockerAcceptedDisposition({
        invocation: cliInvocation(),
        task: parsed.task,
        reason: parsed.reason,
      });
      if (result.alreadyAccepted) {
        ctx.ui.notify(`gsd task settle: ${unit} is already closed as blocker-accepted — nothing to do.`, "info");
        return;
      }
      ctx.ui.notify(
        `Accepted blocker for ${unit}: Task closed as blocker-accepted; Attempt ${result.attemptId} and its ` +
        `failed Result remain history and the route head is consumed (no re-route). ` +
        `Replan with gsd_replan_slice (blockerTaskId ${parsed.task.taskId}) — the Task will not execute again.`,
        "info",
      );
      return;
    }
    const settleOptions = { reconcileLifecycle: parsed.reconcileLifecycle };
    if (!parsed.apply) {
      const plan = planTaskSettle(parsed.task, parsed.reason, settleOptions);
      if (plan.rows.length === 0 && plan.lifecycleRows.length === 0) {
        ctx.ui.notify(`gsd task settle (dry run): ${unit} has no running Attempt — nothing to do.`, "info");
        return;
      }
      const lines = [
        ...plan.rows.map(
          (row) => `  attempt ${row.attemptId}: ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...plan.lifecycleRows.map(
          (row) => `  lifecycle ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...(plan.proof ? [`  proof: ${plan.proof.note}`] : []),
      ];
      ctx.ui.notify(
        `gsd task settle (dry run) — no changes made:\n${lines.join("\n")}\nRe-run with --apply to settle.`,
        "info",
      );
      return;
    }
    const result = applyTaskSettle({
      invocation: cliInvocation(),
      task: parsed.task,
      reason: parsed.reason,
      ...settleOptions,
    });
    if (!result.settled && !result.reconciled) {
      ctx.ui.notify(`gsd task settle: ${unit} has no running Attempt — nothing to do.`, "info");
      return;
    }
    const parts: string[] = [];
    if (result.settled) {
      parts.push(`Settled Attempt ${result.rows[0].attemptId} as interrupted (${unit}).`);
    }
    if (result.reconciled) {
      const target = result.lifecycleRows[result.lifecycleRows.length - 1]?.targetStatus;
      parts.push(`Reconciled lifecycle to ${target} (${unit}) without deleting SUMMARYs.`);
    }
    ctx.ui.notify(parts.join(" "), "info");
  } catch (error) {
    ctx.ui.notify(`gsd task settle: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
