// Project/App: gsd-pi
// File Purpose: Context-bound coordination dispatch writes for canonical Task Attempts.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface StagedTaskCompletionWriteInput {
  task: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
  };
  oneLiner: string;
  narrative: string;
  verificationResult: string;
  blockerDiscovered: boolean;
  deviations: string;
  knownIssues: string;
  keyFiles: string[];
  keyDecisions: string[];
  fullSummaryMd: string;
  verificationEvidence: Array<{
    command: string;
    exitCode: number;
    verdict: string;
    durationMs: number;
  }>;
}

export function writeStagedTaskCompletion(
  context: Readonly<DomainOperationContext>,
  attempt: Readonly<{ milestoneId: string; sliceId: string; taskId: string }>,
  completion: Readonly<StagedTaskCompletionWriteInput>,
): void {
  if (requireActiveDomainOperationContext(context) !== "attempt.settle") {
    throw new Error("Staged Task completion requires an attempt.settle Domain Operation");
  }
  if (
    completion.task.milestoneId !== attempt.milestoneId ||
    completion.task.sliceId !== attempt.sliceId ||
    completion.task.taskId !== attempt.taskId
  ) {
    throw new Error("Staged Task completion does not match the settlement Attempt");
  }

  const updated = getDb().prepare(`
    UPDATE tasks
    SET status = 'in_progress',
        completed_at = NULL,
        one_liner = :one_liner,
        narrative = :narrative,
        verification_result = :verification_result,
        blocker_discovered = :blocker_discovered,
        deviations = :deviations,
        known_issues = :known_issues,
        key_files = :key_files,
        key_decisions = :key_decisions,
        full_summary_md = :full_summary_md
    WHERE milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND id = :task_id
      AND status NOT IN ('complete', 'done', 'closed')
  `).run({
    ":milestone_id": completion.task.milestoneId,
    ":slice_id": completion.task.sliceId,
    ":task_id": completion.task.taskId,
    ":one_liner": completion.oneLiner,
    ":narrative": completion.narrative,
    ":verification_result": completion.verificationResult,
    ":blocker_discovered": completion.blockerDiscovered ? 1 : 0,
    ":deviations": completion.deviations,
    ":known_issues": completion.knownIssues,
    ":key_files": JSON.stringify(completion.keyFiles),
    ":key_decisions": JSON.stringify(completion.keyDecisions),
    ":full_summary_md": completion.fullSummaryMd,
  });
  if (Number((updated as { changes?: unknown }).changes ?? 0) !== 1) {
    throw new Error("Staged Task completion target is missing or already complete");
  }

  const insertEvidence = getDb().prepare(`
    INSERT OR IGNORE INTO verification_evidence (
      task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
    )
    SELECT :task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict,
           :duration_ms, operation.created_at
    FROM workflow_operations operation
    WHERE operation.operation_id = :operation_id
  `);
  for (const evidence of completion.verificationEvidence) {
    insertEvidence.run({
      ":task_id": completion.task.taskId,
      ":slice_id": completion.task.sliceId,
      ":milestone_id": completion.task.milestoneId,
      ":command": evidence.command,
      ":exit_code": evidence.exitCode,
      ":verdict": evidence.verdict,
      ":duration_ms": evidence.durationMs,
      ":operation_id": context.operationId,
    });
  }
}

export interface TaskDispatchIdentity {
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  unitId: string;
}

export function activateTaskExecutionDispatch(
  context: Readonly<DomainOperationContext>,
  input: TaskDispatchIdentity,
): void {
  if (requireActiveDomainOperationContext(context) !== "attempt.claim") {
    throw new Error("Task dispatch activation requires an attempt.claim Domain Operation");
  }
  const parameters = {
    ":dispatch_id": input.dispatchId,
    ":worker_id": input.workerId,
    ":lease_token": input.milestoneLeaseToken,
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
    ":task_id": input.taskId,
    ":unit_id": input.unitId,
  };
  const activated = getDb().prepare(`
    UPDATE unit_dispatches
    SET status = 'running'
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
      AND unit_type = 'execute-task'
      AND unit_id = :unit_id
      AND status = 'claimed'
  `).run(parameters);
  if (Number((activated as { changes?: number }).changes ?? 0) === 1) return;

  const alreadyRunning = getDb().prepare(`
    SELECT 1 AS present FROM unit_dispatches
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
      AND unit_type = 'execute-task'
      AND unit_id = :unit_id
      AND status = 'running'
  `).get(parameters);
  if (!alreadyRunning) {
    throw new Error("Task Attempt claim must activate exactly one matching coordination dispatch");
  }
}

export function terminalizeTaskExecutionDispatch(
  context: Readonly<DomainOperationContext>,
  input: Pick<TaskDispatchIdentity, "dispatchId" | "workerId" | "milestoneLeaseToken"> & {
    outcome: "succeeded" | "failed" | "interrupted";
    endedAt: string;
    cancellation?: boolean;
  },
): void {
  const operationType = requireActiveDomainOperationContext(context);
  const allowedOperationTypes = input.cancellation
    ? ["task.cancel", "slice.cancel"]
    // attempt.settle may also record an interrupted outcome: the same-session
    // lease guard (#1740) settles its own orphaned Attempt under the worker's
    // own held lease, which cannot use the fenced attempt.interrupt path.
    : input.outcome === "interrupted"
      ? ["attempt.interrupt", "attempt.settle"]
      : ["attempt.settle"];
  if (!allowedOperationTypes.includes(operationType)) {
    throw new Error(`Task dispatch terminalization requires a ${allowedOperationTypes.join(" or ")} Domain Operation`);
  }
  let dispatchStatus = "failed";
  if (input.cancellation) dispatchStatus = "canceled";
  else if (input.outcome === "succeeded") dispatchStatus = "completed";
  const result = getDb().prepare(`
    UPDATE unit_dispatches
    SET status = :status, ended_at = :ended_at
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND status IN ('claimed', 'running')
  `).run({
    ":status": dispatchStatus,
    ":ended_at": input.endedAt,
    ":dispatch_id": input.dispatchId,
    ":worker_id": input.workerId,
    ":lease_token": input.milestoneLeaseToken,
  });
  if (Number((result as { changes?: number }).changes ?? 0) === 1) return;

  if (input.outcome === "interrupted") {
    const alreadyTerminal = getDb().prepare(`
      SELECT 1 AS present FROM unit_dispatches
      WHERE id = :dispatch_id
        AND worker_id = :worker_id
        AND milestone_lease_token = :lease_token
        AND status IN ('canceled', 'failed', 'stuck', 'paused')
    `).get({
      ":dispatch_id": input.dispatchId,
      ":worker_id": input.workerId,
      ":lease_token": input.milestoneLeaseToken,
    });
    if (alreadyTerminal) return;
  }
  throw new Error("Task execution settlement did not terminalize exactly one coordination dispatch");
}
