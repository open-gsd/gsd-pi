// Project/App: gsd-pi
// File Purpose: Executable contract for lifecycle and Attempt command writers.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  executeDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationResult,
} from "../db/domain-operation.ts";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  type CanonicalLifecycleStatus,
  claimRunningAttempt,
  compareLifecycleShadow,
  isAllowedKernelStageTransition,
  readDomainOperationFence,
  settleAttemptWithResult,
} from "../db/writers/lifecycle-commands.ts";

const tempDirs = new Set<string>();

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lifecycle-commands-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function openFixture(t: TestContext): string {
  const path = databasePath();
  assert.equal(openDatabase(path), true);
  seedHierarchyAndCoordination();
  t.after(closeDatabase);
  return path;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function seedHierarchyAndCoordination(): void {
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Lifecycle commands', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Typed writers', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES
      ('M001', 'S01', 'T01', 'Implement writers', 'pending'),
      ('M001', 'S01', 'T02', 'Sibling task', 'pending'),
      ('M001', 'S01', 'T03', 'Terminal bootstrap task', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch', 'turn-dispatch', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'running', 1, '2026-07-12T00:00:00.000Z'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-sibling', 'turn-sibling', 'worker-1', 7,
      'M001', 'S01', 'T02', 'execute-task', 'M001/S01/T02',
      'running', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
}

function operationMutation(type: string, entityId = "M001/S01/T01"): DomainOperationMutation {
  return {
    events: [{
      eventType: type,
      entityType: "task",
      entityId,
      payload: { entityId },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `status/${entityId.toLowerCase()}`,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

function executeAtFence<T>(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => T,
): { receipt: DomainOperationResult; value: T } {
  const fence = readDomainOperationFence();
  assert.equal(fence.replay, false);
  let value!: T;
  const receipt = executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "test-agent",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    value = write(context);
    return operationMutation(operationType);
  });
  return { receipt, value };
}

function adoptTask(status: CanonicalLifecycleStatus = "pending") {
  return executeAtFence("lifecycle.adopt", `adopt/${status}`, (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: status,
    }));
}

function snapshot(): Record<string, unknown> {
  return {
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    operations: rows("SELECT operation_id FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY result_id"),
    checkpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY sequence"),
    events: rows("SELECT event_id FROM workflow_domain_events ORDER BY project_revision, event_index"),
    projections: rows("SELECT projection_work_id FROM workflow_projection_work ORDER BY source_project_revision"),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("adopts a hierarchy row once and advances its lifecycle with operation provenance", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  assert.equal(adopted.receipt.status, "committed");
  assert.deepEqual(adopted.value, {
    lifecycleId: adopted.value.lifecycleId,
    lifecycleStatus: "pending",
    stateVersion: 0,
    adopted: true,
  });

  const transitioned = executeAtFence("lifecycle.ready", "ready/T01", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    }));
  assert.deepEqual(transitioned.value, {
    lifecycleId: adopted.value.lifecycleId,
    lifecycleStatus: "ready",
    stateVersion: 1,
    adopted: false,
  });
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version, last_operation_id,
           last_project_revision, last_authority_epoch
    FROM workflow_item_lifecycles
  `), {
    lifecycle_status: "ready",
    state_version: 1,
    last_operation_id: transitioned.receipt.operationId,
    last_project_revision: transitioned.receipt.resultingRevision,
    last_authority_epoch: transitioned.receipt.resultingAuthorityEpoch,
  });
});

test("same-status adoption is a lifecycle no-op while the outer operation still commits", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  const original = row(`
    SELECT lifecycle_status, state_version, last_operation_id,
           last_project_revision, last_authority_epoch
    FROM workflow_item_lifecycles
  `);
  const repeated = executeAtFence("lifecycle.observe", "observe/pending", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "pending",
    }));

  assert.equal(repeated.receipt.status, "committed");
  assert.equal(repeated.receipt.resultingRevision, 2);
  assert.deepEqual(repeated.value, {
    lifecycleId: adopted.value.lifecycleId,
    lifecycleStatus: "pending",
    stateVersion: 0,
    adopted: false,
  });
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version, last_operation_id,
           last_project_revision, last_authority_epoch
    FROM workflow_item_lifecycles
  `), original);
});

test("adoptLifecycleIfMissing adopts a missing lifecycle at the requested status", (t) => {
  openFixture(t);
  const adopted = executeAtFence("lifecycle.adopt-if-missing", "adopt-if-missing/new", (context) =>
    adoptLifecycleIfMissing(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    }));

  assert.deepEqual(adopted.value, {
    lifecycleId: adopted.value.lifecycleId,
    lifecycleStatus: "ready",
    stateVersion: 0,
    adopted: true,
  });
  assert.deepEqual(row(`
    SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id,
           last_project_revision, last_authority_epoch
    FROM workflow_item_lifecycles
  `), {
    lifecycle_id: adopted.value.lifecycleId,
    lifecycle_status: "ready",
    state_version: 0,
    last_operation_id: adopted.receipt.operationId,
    last_project_revision: adopted.receipt.resultingRevision,
    last_authority_epoch: adopted.receipt.resultingAuthorityEpoch,
  });
});

for (const existingStatus of ["ready", "in_progress", "completed", "cancelled"] as const) {
  test(`adoptLifecycleIfMissing preserves an existing ${existingStatus} lifecycle and its provenance`, (t) => {
    openFixture(t);
    const transition = (status: CanonicalLifecycleStatus, key: string) => executeAtFence(
      `lifecycle.${status}`,
      key,
      (context) => adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: status,
      }),
    );

    const adopted = transition(existingStatus === "cancelled" ? "cancelled" : "pending", `${existingStatus}/adopt`);
    if (existingStatus === "ready" || existingStatus === "in_progress" || existingStatus === "completed") {
      transition("ready", `${existingStatus}/ready`);
    }
    if (existingStatus === "in_progress" || existingStatus === "completed") {
      transition("in_progress", `${existingStatus}/in-progress`);
    }
    if (existingStatus === "completed") {
      transition("completed", `${existingStatus}/completed`);
    }

    const before = row(`
      SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id,
             last_project_revision, last_authority_epoch, created_at, updated_at
      FROM workflow_item_lifecycles
    `);
    const observed = executeAtFence(
      "lifecycle.adopt-if-missing",
      `adopt-if-missing/existing-${existingStatus}`,
      (context) => adoptLifecycleIfMissing(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: existingStatus === "ready" ? "pending" : "ready",
      }),
    );

    assert.deepEqual(observed.value, {
      lifecycleId: before["lifecycle_id"],
      lifecycleStatus: existingStatus,
      stateVersion: before["state_version"],
      adopted: false,
    });
    assert.deepEqual(row(`
      SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id,
             last_project_revision, last_authority_epoch, created_at, updated_at
      FROM workflow_item_lifecycles
    `), before);
    assert.notEqual(observed.receipt.operationId, adopted.receipt.operationId);
  });
}

test("adoptLifecycleIfMissing rolls back the outer operation when its hierarchy identity is invalid", (t) => {
  openFixture(t);
  const before = snapshot();

  assert.throws(() => executeAtFence(
    "lifecycle.adopt-if-missing",
    "adopt-if-missing/missing-hierarchy",
    (context) => adoptLifecycleIfMissing(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T99",
      lifecycleStatus: "ready",
    }),
  ), /hierarchy row is missing/i);
  assert.deepEqual(snapshot(), before);
});

test("terminal lifecycles reopen only through ready and reject a direct in-progress jump", (t) => {
  openFixture(t);
  adoptTask();
  const transition = (
    status: CanonicalLifecycleStatus,
    key: string,
    operationType = `lifecycle.${status}`,
  ) => executeAtFence(
    operationType,
    key,
    (context) => adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: status,
    }),
  );

  transition("ready", "chain/ready-1");
  transition("in_progress", "chain/in-progress-1");
  transition("completed", "chain/completed");
  const beforeIllegal = snapshot();
  assert.throws(() => transition("in_progress", "chain/illegal-terminal-jump"), /transition|completed|ready/i);
  assert.deepEqual(snapshot(), beforeIllegal);
  transition("ready", "chain/reopen-completed", "task.reopen");
  transition("in_progress", "chain/in-progress-2");
  transition("cancelled", "chain/cancelled");
  transition("ready", "chain/reopen-cancelled", "task.reopen");

  assert.deepEqual(row("SELECT lifecycle_status, state_version FROM workflow_item_lifecycles"), {
    lifecycle_status: "ready",
    state_version: 7,
  });
});

test("reads the original expected fence for an idempotency replay after revision advances", (t) => {
  openFixture(t);
  const initialFence = readDomainOperationFence();
  assert.equal(initialFence.replay, false);
  let calls = 0;
  const committedRequest = {
    operationType: "lifecycle.adopt",
    idempotencyKey: "replay/adopt",
    expectedRevision: initialFence.revision,
    expectedAuthorityEpoch: initialFence.authorityEpoch,
    actorType: "agent",
    actorId: "test-agent",
    sourceTransport: "test",
    payload: { item: "M001/S01/T01" },
  } as const;
  const committed = executeDomainOperation(committedRequest, (context) => {
    calls += 1;
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "pending",
    });
    return operationMutation("lifecycle.adopt");
  });
  const beforeReplay = snapshot();
  assert.deepEqual(readDomainOperationFence(), {
    projectId: committed.projectId,
    revision: 1,
    authorityEpoch: 0,
    replay: false,
  });

  const replayFence = readDomainOperationFence("replay/adopt");
  assert.deepEqual(replayFence, {
    projectId: committed.projectId,
    revision: initialFence.revision,
    authorityEpoch: initialFence.authorityEpoch,
    replay: true,
  });
  const replayed = executeDomainOperation({
    ...committedRequest,
    expectedRevision: replayFence.revision,
    expectedAuthorityEpoch: replayFence.authorityEpoch,
  }, () => {
    calls += 1;
    throw new Error("replay must not invoke lifecycle writers");
  });
  assert.equal(calls, 1);
  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assert.deepEqual(snapshot(), beforeReplay);
});

test("fence lookup rejects blank keys and a replay fence cannot excuse changed semantics", (t) => {
  openFixture(t);
  const initial = snapshot();
  assert.throws(() => readDomainOperationFence("   "), /idempotency|blank|key/i);
  assert.deepEqual(snapshot(), initial);

  const fence = readDomainOperationFence();
  const baseRequest = {
    operationType: "lifecycle.adopt",
    idempotencyKey: "replay/semantic-conflict",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "test-agent",
    sourceTransport: "test",
    payload: { status: "pending" },
  } as const;
  executeDomainOperation(baseRequest, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "pending",
    });
    return operationMutation("lifecycle.adopt");
  });
  const replayFence = readDomainOperationFence(baseRequest.idempotencyKey);
  assert.equal(replayFence.replay, true);
  const beforeConflict = snapshot();
  assert.throws(() => executeDomainOperation({
    ...baseRequest,
    expectedRevision: replayFence.revision,
    expectedAuthorityEpoch: replayFence.authorityEpoch,
    payload: { status: "completed" },
  }, () => {
    throw new Error("semantic conflict must be detected before mutation");
  }), /idempotency conflict/i);
  assert.deepEqual(snapshot(), beforeConflict);
});

test("claims running Attempts, settles immutable Results, and claims a running retry", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "ready/attempts", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));

  const claim = executeAtFence("attempt.claim", "attempt/1/claim", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    });
  });
  assert.equal(claim.value.attemptNumber, 1);
  assert.equal(claim.value.retryOfAttemptId, null);
  assert.equal(claim.value.attemptState, "running");
  assert.match(claim.value.attemptId, /\S/);
  assert.match(claim.value.kernelCheckpointId, /\S/);

  const beforeWrongSettlement = snapshot();
  assert.throws(() => executeAtFence("kernel.checkpoint", "attempt/1/wrong-settle", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "failed",
      failureClass: "test_failure",
      summary: "wrong operation type",
      output: {},
    })), /attempt\.settle/i);
  assert.deepEqual(snapshot(), beforeWrongSettlement);

  const failed = executeAtFence("attempt.settle", "attempt/1/settle", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "failed",
      failureClass: "test_failure",
      summary: "verification failed",
      output: { a: 1, Z: 2, nested: { é: 3, b: 4 } },
    }));
  assert.equal(failed.value.attemptState, "settled");
  assert.equal(failed.value.outcome, "failed");
  assert.match(failed.value.resultId, /\S/);

  const retry = executeAtFence("attempt.claim", "attempt/2/claim", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      retryOfAttemptId: claim.value.attemptId,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    }));
  assert.equal(retry.value.attemptNumber, 2);
  assert.equal(retry.value.retryOfAttemptId, claim.value.attemptId);
  assert.equal(retry.value.attemptState, "running");

  assert.deepEqual(rows(`
    SELECT attempt_id, attempt_number, retry_of_attempt_id, attempt_state,
           claim_operation_id, settle_operation_id
    FROM workflow_execution_attempts ORDER BY attempt_number
  `), [
    {
      attempt_id: claim.value.attemptId,
      attempt_number: 1,
      retry_of_attempt_id: null,
      attempt_state: "settled",
      claim_operation_id: claim.receipt.operationId,
      settle_operation_id: failed.receipt.operationId,
    },
    {
      attempt_id: retry.value.attemptId,
      attempt_number: 2,
      retry_of_attempt_id: claim.value.attemptId,
      attempt_state: "running",
      claim_operation_id: retry.receipt.operationId,
      settle_operation_id: null,
    },
  ]);
  assert.deepEqual(rows(`
    SELECT sequence, attempt_id, next_stage, operation_id, project_revision
    FROM workflow_kernel_checkpoints ORDER BY sequence
  `), [
    { sequence: 1, attempt_id: claim.value.attemptId, next_stage: "execute", operation_id: claim.receipt.operationId, project_revision: claim.receipt.resultingRevision },
    { sequence: 2, attempt_id: retry.value.attemptId, next_stage: "execute", operation_id: retry.receipt.operationId, project_revision: retry.receipt.resultingRevision },
  ]);
  assert.deepEqual(row(`
    SELECT attempt_id, outcome, failure_class, summary, output_json,
           operation_id, project_revision, authority_epoch
    FROM workflow_attempt_results
  `), {
    attempt_id: claim.value.attemptId,
    outcome: "failed",
    failure_class: "test_failure",
    summary: "verification failed",
    output_json: '{"Z":2,"a":1,"nested":{"b":4,"é":3}}',
    operation_id: failed.receipt.operationId,
    project_revision: failed.receipt.resultingRevision,
    authority_epoch: failed.receipt.resultingAuthorityEpoch,
  });
  const settledTuple = row(`
    SELECT attempt_state, ended_at, settle_operation_id,
           settle_project_revision, settle_authority_epoch
    FROM workflow_execution_attempts WHERE attempt_id = '${claim.value.attemptId}'
  `);
  assert.equal(settledTuple.attempt_state, "settled");
  assert.match(String(settledTuple.ended_at), /\S/);
  assert.deepEqual({
    operationId: settledTuple.settle_operation_id,
    revision: settledTuple.settle_project_revision,
    epoch: settledTuple.settle_authority_epoch,
  }, {
    operationId: failed.receipt.operationId,
    revision: failed.receipt.resultingRevision,
    epoch: failed.receipt.resultingAuthorityEpoch,
  });

  const beforeDoubleSettle = snapshot();
  assert.throws(() => executeAtFence("attempt.settle", "attempt/1/settle-again", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "must not replace the first result",
      output: {},
    })), /settled|result|terminal/i);
  assert.deepEqual(snapshot(), beforeDoubleSettle);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 1);
});

test("appends a later same-Attempt kernel head and rejects a stale branch", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "checkpoint/ready", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  const claim = executeAtFence("attempt.claim", "checkpoint/claim", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1, workerId: "worker-1", milestoneLeaseToken: 7,
    });
  });
  const verify = executeAtFence("attempt.settle", "checkpoint/verify", (context) => {
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "execution succeeded",
      output: {},
    });
    return appendKernelCheckpoint(context, {
      lifecycleId: adopted.value.lifecycleId,
      attemptId: claim.value.attemptId,
      nextStage: "verify",
      previousKernelCheckpointId: claim.value.kernelCheckpointId,
    });
  });
  assert.deepEqual(verify.value, {
    kernelCheckpointId: verify.value.kernelCheckpointId,
    sequence: 2,
    attemptId: claim.value.attemptId,
    nextStage: "verify",
    previousKernelCheckpointId: claim.value.kernelCheckpointId,
  });

  const beforeStale = snapshot();
  assert.throws(() => executeAtFence("kernel.checkpoint", "checkpoint/stale-route", (context) =>
    appendKernelCheckpoint(context, {
      lifecycleId: adopted.value.lifecycleId,
      attemptId: claim.value.attemptId,
      nextStage: "route",
      previousKernelCheckpointId: claim.value.kernelCheckpointId,
    })), /checkpoint|current|head|stale/i);
  assert.deepEqual(snapshot(), beforeStale);
});

test("rejects invalid same-Attempt Kernel stage transitions without residue", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "stage/ready", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  const claim = executeAtFence("attempt.claim", "stage/claim", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1, workerId: "worker-1", milestoneLeaseToken: 7,
    });
  });
  const before = snapshot();

  assert.equal(isAllowedKernelStageTransition("execute", "verify"), true);
  assert.equal(isAllowedKernelStageTransition("execute", "route"), true);
  assert.equal(isAllowedKernelStageTransition("verify", "route"), true);
  assert.equal(isAllowedKernelStageTransition("route", "closeout"), true);
  assert.equal(isAllowedKernelStageTransition("closeout", "settled"), true);
  assert.equal(isAllowedKernelStageTransition("verify", "closeout"), false);
  assert.equal(isAllowedKernelStageTransition("route", "settled"), false);

  for (const nextStage of ["verify", "route"] as const) {
    assert.throws(() => executeAtFence("kernel.checkpoint", `stage/missing-result/${nextStage}`, (context) =>
      appendKernelCheckpoint(context, {
        lifecycleId: adopted.value.lifecycleId,
        attemptId: claim.value.attemptId,
        nextStage,
        previousKernelCheckpointId: claim.value.kernelCheckpointId,
      })), /matching Attempt Result/i);
    assert.deepEqual(snapshot(), before);
  }

  assert.throws(() => executeAtFence("kernel.checkpoint", "stage/skip-verify", (context) =>
    appendKernelCheckpoint(context, {
      lifecycleId: adopted.value.lifecycleId,
      attemptId: claim.value.attemptId,
      nextStage: "closeout",
      previousKernelCheckpointId: claim.value.kernelCheckpointId,
    })), /invalid Kernel stage transition/i);
  assert.deepEqual(snapshot(), before);
});

test("only a replacement lease can interrupt an orphaned running Attempt", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "recovery/ready", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  const claim = executeAtFence("attempt.claim", "recovery/claim", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1, workerId: "worker-1", milestoneLeaseToken: 7,
    });
  });
  const liveLease = snapshot();
  assert.throws(() => executeAtFence("attempt.interrupt", "recovery/live", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "interrupted",
      failureClass: "stale-worker",
      summary: "must not fence a live claimant",
      output: {},
      recovery: { workerId: "worker-1", milestoneLeaseToken: 7 },
    })), /lease|orphan|current|replacement/i);
  assert.deepEqual(snapshot(), liveLease);

  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-2', 'test-host', 2, '2026-07-12T00:01:00.000Z', 'test',
      '2026-07-12T00:01:00.000Z', 'active', '/tmp/project'
    );
    UPDATE milestone_leases
    SET worker_id = 'worker-2', fencing_token = 8,
        acquired_at = '2026-07-12T00:01:00.000Z',
        expires_at = '2099-07-12T00:00:00.000Z', status = 'held'
    WHERE milestone_id = 'M001';
  `);
  const replacedLease = snapshot();
  assert.throws(() => executeAtFence("attempt.interrupt", "recovery/schema-stale-success", (context) => {
    db().prepare(`
      UPDATE workflow_execution_attempts
      SET attempt_state = 'settled', ended_at = '2026-07-12T00:02:00.000Z',
          settle_outcome = 'succeeded', recovery_worker_id = 'worker-2',
          recovery_milestone_lease_token = 8,
          settle_operation_id = :operation_id,
          settle_project_revision = :revision,
          settle_authority_epoch = :epoch
      WHERE attempt_id = :attempt_id
    `).run({
      ":operation_id": context.operationId,
      ":revision": context.resultingRevision,
      ":epoch": context.resultingAuthorityEpoch,
      ":attempt_id": claim.value.attemptId,
    });
  }), /interrupted|outcome|recovery/i);
  assert.deepEqual(snapshot(), replacedLease);
  assert.throws(() => executeAtFence("attempt.settle", "recovery/wrong-operation", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "interrupted",
      failureClass: "stale-worker",
      summary: "the recovery path must be explicit",
      output: {},
      recovery: { workerId: "worker-2", milestoneLeaseToken: 8 },
    })), /attempt\.interrupt/i);
  assert.deepEqual(snapshot(), replacedLease);
  assert.throws(() => executeAtFence("attempt.recover", "recovery/stale-success", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "a replacement cannot report the stale worker's success",
      output: {},
      recovery: { workerId: "worker-2", milestoneLeaseToken: 8 },
    })), /interrupted|outcome|recovery/i);
  assert.deepEqual(snapshot(), replacedLease);

  const recovered = executeAtFence("attempt.interrupt", "recovery/interrupted", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "interrupted",
      failureClass: "stale-worker",
      summary: "replacement fenced the orphan",
      output: {},
      recovery: { workerId: "worker-2", milestoneLeaseToken: 8 },
    }));
  assert.equal(recovered.value.outcome, "interrupted");
  assert.deepEqual(row(`
    SELECT worker_id, milestone_lease_token, settle_outcome,
           recovery_worker_id, recovery_milestone_lease_token
    FROM workflow_execution_attempts WHERE attempt_id = '${claim.value.attemptId}'
  `), {
    worker_id: "worker-1",
    milestone_lease_token: 7,
    settle_outcome: "interrupted",
    recovery_worker_id: "worker-2",
    recovery_milestone_lease_token: 8,
  });
  assert.equal(row("SELECT outcome FROM workflow_attempt_results").outcome, "interrupted");
});

test("writer failures roll back lifecycle facts and the surrounding Domain Operation", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  const before = snapshot();
  assert.throws(() => executeAtFence("test", "attempt/wrong-operation", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    })), /attempt\.claim/i);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => executeAtFence("attempt.claim", "attempt/invalid", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      retryOfAttemptId: "missing-attempt",
      coordinationDispatchId: 1,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    })), /retry|attempt/i);
  assert.deepEqual(snapshot(), before);
});

test("adoption rejects missing hierarchy and invalid identity shapes but permits explicit terminal bootstrap", (t) => {
  openFixture(t);
  const initial = snapshot();
  assert.throws(() => executeAtFence("lifecycle.adopt", "adopt/missing", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T99",
      lifecycleStatus: "pending",
    })), /task|hierarchy|missing/i);
  assert.deepEqual(snapshot(), initial);
  assert.throws(() => executeAtFence("lifecycle.adopt", "adopt/bad-shape", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", sliceId: "S01",
      lifecycleStatus: "pending",
    })), /identity|shape|slice/i);
  assert.deepEqual(snapshot(), initial);

  const terminal = executeAtFence("lifecycle.bootstrap", "adopt/terminal", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T03",
      lifecycleStatus: "completed",
    }));
  assert.equal(terminal.value.lifecycleStatus, "completed");
  assert.equal(terminal.value.stateVersion, 0);
  assert.equal(terminal.value.adopted, true);
});

test("paused and terminal lifecycles cannot claim an Attempt and leave no residue", (t) => {
  openFixture(t);
  const paused = adoptTask();
  executeAtFence("lifecycle.ready", "claim-guard/ready", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  executeAtFence("lifecycle.pause", "claim-guard/paused", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "paused",
    }));
  let before = snapshot();
  assert.throws(() => executeAtFence("attempt.claim", "claim-guard/paused-attempt", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: paused.value.lifecycleId,
      coordinationDispatchId: 1, workerId: "worker-1", milestoneLeaseToken: 7,
    })), /paused|ready|in.progress|claim/i);
  assert.deepEqual(snapshot(), before);

  const terminal = executeAtFence("lifecycle.bootstrap", "claim-guard/terminal", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T03",
      lifecycleStatus: "completed",
    }));
  before = snapshot();
  assert.throws(() => executeAtFence("attempt.claim", "claim-guard/terminal-attempt", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: terminal.value.lifecycleId,
      workerId: "worker-1", milestoneLeaseToken: 7,
    })), /completed|ready|in.progress|claim/i);
  assert.deepEqual(snapshot(), before);
});

test("Attempt claims reject bad lease, dispatch, active duplication, and retry predecessor without residue", (t) => {
  openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "negative/ready", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  executeAtFence("lifecycle.in-progress", "negative/in-progress", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    }));

  const rejectWithoutResidue = (key: string, input: Parameters<typeof claimRunningAttempt>[1], message: RegExp) => {
    const before = snapshot();
    assert.throws(() => executeAtFence("attempt.claim", key, (context) =>
      claimRunningAttempt(context, input)), message);
    assert.deepEqual(snapshot(), before, `${key} left residue`);
  };
  rejectWithoutResidue("negative/lease", {
    lifecycleId: adopted.value.lifecycleId,
    workerId: "worker-1", milestoneLeaseToken: 8,
  }, /lease|fencing/i);
  rejectWithoutResidue("negative/dispatch", {
    lifecycleId: adopted.value.lifecycleId,
    coordinationDispatchId: 2, workerId: "worker-1", milestoneLeaseToken: 7,
  }, /dispatch|scope/i);

  const claim = executeAtFence("attempt.claim", "negative/valid", (context) =>
    claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1, workerId: "worker-1", milestoneLeaseToken: 7,
    }));
  rejectWithoutResidue("negative/active", {
    lifecycleId: adopted.value.lifecycleId,
    workerId: "worker-1", milestoneLeaseToken: 7,
  }, /active|running|attempt/i);

  executeAtFence("attempt.settle", "negative/settle", (context) =>
    settleAttemptWithResult(context, {
      attemptId: claim.value.attemptId,
      outcome: "failed", failureClass: "test", summary: "failed", output: {},
    }));
  rejectWithoutResidue("negative/retry-predecessor", {
    lifecycleId: adopted.value.lifecycleId,
    retryOfAttemptId: "not-the-predecessor",
    workerId: "worker-1", milestoneLeaseToken: 7,
  }, /retry|predecessor|attempt/i);
});

test("writers reject caller-spoofed provenance outside a committed Domain Operation", (t) => {
  openFixture(t);
  const before = snapshot();
  assert.throws(() => adoptOrTransitionLifecycle({
    operationId: "forged-operation",
    projectId: String(row("SELECT project_id FROM project_authority").project_id),
    resultingRevision: 1,
    resultingAuthorityEpoch: 0,
  }, {
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "pending",
  }), /foreign key|operation|provenance/i);
  assert.deepEqual(snapshot(), before);

  let committedContext!: Readonly<DomainOperationContext>;
  executeAtFence("lifecycle.adopt", "provenance/real-context", (context) => {
    committedContext = context;
    return adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "pending",
    });
  });
  const afterCommit = snapshot();
  assert.throws(() => adoptOrTransitionLifecycle(committedContext, {
    itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
    lifecycleStatus: "ready",
  }), /active domain operation|context|provenance|revision/i);
  assert.deepEqual(snapshot(), afterCommit);
});

test("restart preserves the fence, lifecycle head, and Attempt sequence", (t) => {
  const path = openFixture(t);
  const adopted = adoptTask();
  executeAtFence("lifecycle.ready", "ready/restart", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    }));
  const before = readDomainOperationFence();
  closeDatabase();
  assert.equal(openDatabase(path), true);
  assert.deepEqual(readDomainOperationFence(), before);
  assert.equal(row("SELECT lifecycle_id FROM workflow_item_lifecycles").lifecycle_id, adopted.value.lifecycleId);

  const claim = executeAtFence("attempt.claim", "attempt/restart", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return claimRunningAttempt(context, {
      lifecycleId: adopted.value.lifecycleId,
      coordinationDispatchId: 1,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    });
  });
  assert.equal(claim.value.attemptNumber, 1);
});

test("semantic comparison reports normalized parity without hiding exact legacy values", () => {
  const cases = [
    ["pending", "pending", "match", "pending", "pending"],
    ["ready", "ready", "status_mismatch", null, "ready"],
    ["in_progress", "in_progress", "match", "in_progress", "in_progress"],
    ["complete", "completed", "semantic_match_exact_delta", "completed", "completed"],
    ["done", "completed", "semantic_match_exact_delta", "completed", "completed"],
    ["planned", "pending", "semantic_match_exact_delta", "pending", "pending"],
    ["queued", "ready", "semantic_match_exact_delta", "pending", "ready"],
    ["pending", "ready", "semantic_match_exact_delta", "pending", "ready"],
    ["active", "ready", "semantic_match_exact_delta", "in_progress", "ready"],
    ["skipped", "cancelled", "semantic_match_exact_delta", "cancelled", "cancelled"],
    ["deferred", "cancelled", "semantic_match_exact_delta", "cancelled", "cancelled"],
    ["blocked", "paused", "semantic_match_exact_delta", "paused", "paused"],
    ["parked", "paused", "semantic_match_exact_delta", "paused", "paused"],
    ["completed", "completed", "status_mismatch", null, "completed"],
    ["mystery", "ready", "status_mismatch", null, "ready"],
    ["active", "completed", "status_mismatch", "in_progress", "completed"],
    ["pending", null, "missing_shadow", "pending", null],
    [null, "pending", "extra_shadow", null, "pending"],
  ] as const;

  for (const [legacyStatus, canonicalStatus, kind, normalizedLegacyStatus, normalizedCanonicalStatus] of cases) {
    assert.deepEqual(compareLifecycleShadow(legacyStatus, canonicalStatus), {
      kind,
      legacyStatus,
      canonicalStatus,
      normalizedLegacyStatus,
      normalizedCanonicalStatus,
    });
  }
});

test("rejects malformed timestamps and prevents lifecycle audit time from moving backward", (t) => {
  openFixture(t);
  const adopted = executeAtFence("lifecycle.adopt", "timestamp/adopt", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "pending",
      occurredAt: "2026-07-12T12:00:00.000Z",
    }));

  assert.throws(() => executeAtFence("lifecycle.ready", "timestamp/malformed", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
      occurredAt: "not-a-date",
    })), /timestamp|occurredAt|date/i);
  assert.throws(() => executeAtFence("lifecycle.ready", "timestamp/backward", (context) =>
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
      occurredAt: "2026-07-12T11:59:59.999Z",
    })), /after|monotonic|occurredAt/i);

  assert.deepEqual(row(`
    SELECT lifecycle_id, lifecycle_status, state_version, updated_at
    FROM workflow_item_lifecycles
  `), {
    lifecycle_id: adopted.value.lifecycleId,
    lifecycle_status: "pending",
    state_version: 0,
    updated_at: "2026-07-12T12:00:00.000Z",
  });
});

interface ConcurrentWriter {
  ready: Promise<void>;
  result: Promise<Record<string, unknown>>;
  start: () => void;
}

function runConcurrentWriter(
  path: string,
  id: string,
  writerHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/db/writers/lifecycle-commands.ts"),
  ).href,
): ConcurrentWriter {
  const dbHref = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const domainHref = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/db/domain-operation.ts")).href;
  const script = `
    import { openDatabase, closeDatabase } from ${JSON.stringify(dbHref)};
    import { executeDomainOperation } from ${JSON.stringify(domainHref)};
    import { adoptOrTransitionLifecycle, readDomainOperationFence } from ${JSON.stringify(writerHref)};
    const [path, id] = process.argv.slice(1);
    if (!openDatabase(path)) throw new Error('open failed');
    const fence = readDomainOperationFence();
    console.log('READY');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    try {
      const receipt = executeDomainOperation({
        operationType: 'lifecycle.ready', idempotencyKey: 'race/' + id,
        expectedRevision: fence.revision, expectedAuthorityEpoch: fence.authorityEpoch,
        actorType: 'agent', actorId: id, sourceTransport: 'process', payload: { id },
      }, (context) => {
        adoptOrTransitionLifecycle(context, {
          itemKind: 'task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', lifecycleStatus: 'ready',
        });
        return {
          events: [{ eventType: 'lifecycle.ready', entityType: 'task', entityId: 'M001/S01/T01', payload: { id }, destinations: ['projection'] }],
          projections: [{ projectionKey: 'status/m001/s01/t01', projectionKind: 'markdown', rendererVersion: 'v1' }],
        };
      });
      console.log(JSON.stringify({ kind: 'committed', revision: receipt.resultingRevision }));
    } catch (error) {
      console.log(JSON.stringify({ kind: 'error', code: error?.code ?? null, message: String(error?.message ?? error) }));
    } finally { closeDatabase(); }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let isReady = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const child = spawn(process.execPath, [
    "--import", "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
    "--experimental-strip-types", "--input-type=module", "-e", script,
    path, id,
  ], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("READY\n")) {
      isReady = true;
      readyResolve();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once("error", (error) => {
      readyReject(error);
      reject(error);
    });
    child.once("close", (code) => {
      const error = new Error(stderr || stdout || `child exited ${code}`);
      if (!isReady) readyReject(error);
      if (code !== 0) return reject(error);
      const payload = stdout.split("\n").find((line) => line.startsWith("{"));
      try { resolve(JSON.parse(payload ?? "") as Record<string, unknown>); }
      catch { reject(new Error(`invalid child output: ${stdout}\n${stderr}`)); }
    });
  });
  return {
    ready,
    result,
    start: () => child.stdin?.end("go\n"),
  };
}

test("concurrent writer readiness rejects when the child exits during startup", { timeout: 5_000 }, async () => {
  const missingWriterHref = pathToFileURL(join(process.cwd(), "missing-lifecycle-writer.ts")).href;
  const writer = runConcurrentWriter(databasePath(), "startup-failure", missingWriterHref);

  await Promise.all([
    assert.rejects(writer.ready, /cannot find|module not found|ERR_MODULE_NOT_FOUND/i),
    assert.rejects(writer.result, /cannot find|module not found|ERR_MODULE_NOT_FOUND/i),
  ]);
});

test("two processes cannot advance one lifecycle from the same fence", async (t) => {
  const path = openFixture(t);
  adoptTask();
  closeDatabase();
  const writers = [runConcurrentWriter(path, "a"), runConcurrentWriter(path, "b")];
  await Promise.all(writers.map((writer) => writer.ready));
  for (const writer of writers) writer.start();
  const outcomes = await Promise.all(writers.map((writer) => writer.result));
  assert.equal(outcomes.filter((outcome) => outcome.kind === "committed").length, 1, JSON.stringify(outcomes));
  const rejected = outcomes.filter((outcome) => outcome.kind === "error");
  assert.equal(rejected.length, 1, JSON.stringify(outcomes));
  assert.match(String(rejected[0]?.message), /stale project revision|writer contention/i);

  assert.equal(openDatabase(path), true);
  assert.deepEqual(row("SELECT lifecycle_status, state_version FROM workflow_item_lifecycles"), {
    lifecycle_status: "ready",
    state_version: 1,
  });
  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: row("SELECT COUNT(*) AS count FROM workflow_operations").count,
    lifecycles: row("SELECT COUNT(*) AS count FROM workflow_item_lifecycles").count,
    events: row("SELECT COUNT(*) AS count FROM workflow_domain_events").count,
    projections: row("SELECT COUNT(*) AS count FROM workflow_projection_work").count,
  }, {
    revision: 2,
    operations: 2,
    lifecycles: 1,
    events: 2,
    projections: 2,
  });
});

function importSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function tsFilesBelow(path: string): string[] {
  if (!statSync(path).isDirectory()) return extname(path) === ".ts" ? [path] : [];
  return readdirSync(path).flatMap((entry) => tsFilesBelow(join(path, entry)));
}

test("lifecycle writers and pure comparison remain below handlers and orchestration", () => {
  const gsdRoot = resolve("src/resources/extensions/gsd");
  const writerPath = join(gsdRoot, "db/writers/lifecycle-commands.ts");
  const comparisonPath = join(gsdRoot, "db/lifecycle-shadow-comparison.ts");
  const writerLeafAllowlist = new Set([
    "node:crypto",
    "../engine.js",
    "../domain-operation.js",
    "../sql-constants.js",
    "../kernel-stage-policy.js",
    "../lifecycle-shadow-comparison.js",
  ]);
  const writerImports = importSpecifiers(writerPath);
  assert.deepEqual(
    writerImports.filter((specifier) => !writerLeafAllowlist.has(specifier)),
    [],
    `lifecycle writer crossed its leaf boundary: ${writerImports.join(", ")}`,
  );
  assert.deepEqual(
    importSpecifiers(comparisonPath),
    [],
    "the semantic comparator must remain a pure import-free leaf",
  );

  const handlerFiles = [
    ...tsFilesBelow(join(gsdRoot, "tools")),
    ...tsFilesBelow(join(gsdRoot, "bootstrap")),
    ...readdirSync(gsdRoot)
      .filter((name) => /^commands.*\.ts$/.test(name))
      .map((name) => join(gsdRoot, name)),
  ];
  const reverseImports = handlerFiles.flatMap((path) =>
    importSpecifiers(path)
      .filter((specifier) => specifier.includes("lifecycle-shadow-comparison"))
      .map((specifier) => ({ path, specifier })));
  assert.deepEqual(reverseImports, [], "handlers must not import the pure shadow comparator during S01");
});
