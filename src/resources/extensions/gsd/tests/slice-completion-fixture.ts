import assert from "node:assert/strict";

import {
  executeDomainOperation,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  completeLegacyTaskForVerifiedAttempt,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  normalizeLegacyLifecycleStatus,
  type CanonicalLifecycleStatus,
} from "../db/lifecycle-shadow-comparison.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { _getAdapter } from "../gsd-db.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";

interface SliceIdentity {
  milestoneId: string;
  sliceId: string;
}

interface SliceCompletionFixtureInput extends SliceIdentity {
  completedTaskIds?: string[];
  runId?: string;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "test database must be open");
  return adapter;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "system",
    actorId: "slice-completion-fixture",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function fixtureLifecycleStatus(
  legacyStatus: unknown,
  entity: string,
): CanonicalLifecycleStatus {
  const normalized = normalizeLegacyLifecycleStatus(String(legacyStatus));
  assert.ok(normalized, `${entity} must have a known legacy lifecycle status`);
  return normalized === "pending" ? "ready" : normalized;
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event: {
    eventType: string;
    entityType: "slice" | "task";
    entityId: string;
    payload: Record<string, string>;
  },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "system",
    sourceTransport: "internal",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{ ...event, destinations: ["test"] }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function insertCoordinationFixture(milestoneId: string): void {
  db().prepare(`
    INSERT OR IGNORE INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'slice-completion-fixture', 'test-host', 1, '2026-07-14T00:00:00.000Z',
      'test', '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    )
  `).run();
  db().prepare(`
    INSERT OR IGNORE INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      :milestone_id, 'slice-completion-fixture', 7,
      '2026-07-14T00:00:00.000Z', '2099-07-14T00:00:00.000Z', 'held'
    )
  `).run({ ":milestone_id": milestoneId });
}

function insertClaimedDispatch(identity: SliceIdentity, taskId: string): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'slice-completion-fixture', 7,
      :milestone_id, :slice_id, :task_id, 'execute-task', :unit_id,
      'claimed', 1, '2026-07-14T00:00:00.000Z'
    )
  `).run({
    ":trace_id": `trace/${taskId}`,
    ":turn_id": `turn/${taskId}`,
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.sliceId,
    ":task_id": taskId,
    ":unit_id": `${identity.milestoneId}/${identity.sliceId}/${taskId}`,
  });
  const row = db().prepare("SELECT MAX(id) AS id FROM unit_dispatches").get();
  return Number(row?.["id"]);
}

function publishCompletedTask(identity: SliceIdentity, taskId: string, runId: string): void {
  const fixtureKey = `fixture/${identity.milestoneId}/${identity.sliceId}/${taskId}/${runId}`;
  const previousAttempt = db().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt ON attempt.lifecycle_id = lifecycle.lifecycle_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  `).get({
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.sliceId,
    ":task_id": taskId,
  });
  const claim = claimTaskAttempt({
    invocation: invocation(`${fixtureKey}/claim`),
    task: { ...identity, taskId },
    workerId: "slice-completion-fixture",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch(identity, taskId),
    ...(previousAttempt ? { retryOfAttemptId: String(previousAttempt["attempt_id"]) } : {}),
  });
  settleTaskAttempt({
    invocation: invocation(`${fixtureKey}/settle`),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Fixture Task completed successfully.",
    output: { fixture: "slice-completion" },
  });
  recordTaskTechnicalVerdict({
    invocation: invocation(`${fixtureKey}/verify`),
    attemptId: claim.attemptId,
    testedSourceRevision: "git:slice-completion-fixture",
    verdict: "pass",
    rationale: "Focused fixture verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-14T00:01:00.000Z",
      endedAt: "2026-07-14T00:01:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://${fixtureKey}/verification`,
      environment: { runner: "node-test", fixture: "slice-completion" },
    },
  });

  executeAtFence(
    "task.completion.publish",
    `${fixtureKey}/publish`,
    (context) => {
      const attempt = db().prepare(`
        SELECT attempt.lifecycle_id, checkpoint.kernel_checkpoint_id
        FROM workflow_execution_attempts attempt
        JOIN workflow_kernel_checkpoints checkpoint
          ON checkpoint.lifecycle_id = attempt.lifecycle_id
         AND checkpoint.attempt_id = attempt.attempt_id
         AND checkpoint.next_stage = 'verify'
        WHERE attempt.attempt_id = :attempt_id
          AND NOT EXISTS (
            SELECT 1 FROM workflow_kernel_checkpoints successor
            WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
          )
      `).get({ ":attempt_id": claim.attemptId });
      assert.ok(attempt, "settled fixture Attempt must have a current verify checkpoint");

      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        ...identity,
        taskId,
        lifecycleStatus: "completed",
      });
      let previousKernelCheckpointId = String(attempt["kernel_checkpoint_id"]);
      for (const nextStage of ["route", "closeout", "settled"] as const) {
        previousKernelCheckpointId = appendKernelCheckpoint(context, {
          lifecycleId: String(attempt["lifecycle_id"]),
          attemptId: claim.attemptId,
          nextStage,
          previousKernelCheckpointId,
        }).kernelCheckpointId;
      }
      completeLegacyTaskForVerifiedAttempt(context, { ...identity, taskId });
    },
    {
      eventType: "task.completion.published",
      entityType: "task",
      entityId: `${identity.milestoneId}/${identity.sliceId}/${taskId}`,
      payload: { attemptId: claim.attemptId },
    },
  );
}

export function seedSliceCompletionAuthority(
  input: SliceCompletionFixtureInput,
): void {
  const completedTaskIds = input.completedTaskIds ?? [];
  const runId = input.runId ?? "initial";
  db().prepare(`
    INSERT OR IGNORE INTO quality_gates (
      milestone_id, slice_id, gate_id, scope, task_id, status
    ) VALUES (
      :milestone_id, :slice_id, 'Q8', 'slice', '', 'pending'
    )
  `).run({
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
  });
  const taskRows = db().prepare(`
    SELECT id FROM tasks
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
    ORDER BY sequence, id
  `).all({
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
  });
  const taskIds = taskRows.map((row) => String(row["id"]));
  for (const taskId of completedTaskIds) {
    assert.ok(taskIds.includes(taskId), `completed fixture Task ${taskId} must exist`);
    db().prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
    `).run({
      ":milestone_id": input.milestoneId,
      ":slice_id": input.sliceId,
      ":task_id": taskId,
    });
  }

  const milestone = db().prepare("SELECT status FROM milestones WHERE id = :milestone_id")
    .get({ ":milestone_id": input.milestoneId });
  assert.ok(milestone, `fixture Milestone ${input.milestoneId} must exist`);
  const slice = db().prepare(`
    SELECT status FROM slices WHERE milestone_id = :milestone_id AND id = :slice_id
  `).get({
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
  });
  assert.ok(slice, `fixture Slice ${input.milestoneId}/${input.sliceId} must exist`);
  const taskStatuses = new Map(
    db().prepare(`
      SELECT id, status FROM tasks
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id
    `).all({
      ":milestone_id": input.milestoneId,
      ":slice_id": input.sliceId,
    }).map((row) => [String(row["id"]), row["status"]]),
  );

  const entityId = `${input.milestoneId}/${input.sliceId}`;
  executeAtFence(
    "test.slice-completion.fixture.ready",
    `fixture/${entityId}/ready/${runId}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone",
        milestoneId: input.milestoneId,
        lifecycleStatus: fixtureLifecycleStatus(milestone["status"], `Milestone ${input.milestoneId}`),
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: input.milestoneId,
        sliceId: input.sliceId,
        lifecycleStatus: fixtureLifecycleStatus(slice["status"], `Slice ${entityId}`),
      });
      for (const taskId of taskIds) {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: input.milestoneId,
          sliceId: input.sliceId,
          taskId,
          lifecycleStatus: fixtureLifecycleStatus(
            taskStatuses.get(taskId),
            `Task ${entityId}/${taskId}`,
          ),
        });
      }
    },
    {
      eventType: "test.slice-completion.fixture.ready",
      entityType: "slice",
      entityId,
      payload: { taskCount: String(taskIds.length) },
    },
  );

  if (completedTaskIds.length === 0) return;
  insertCoordinationFixture(input.milestoneId);
  for (const taskId of completedTaskIds) publishCompletedTask(input, taskId, runId);
}
