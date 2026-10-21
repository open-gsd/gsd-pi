import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { postUnitPreVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function createTaskContext(basePath: string, pauseCalls: string[], notifyCalls: string[] = []): PostUnitContext {
  const session = new AutoSession();
  session.active = true;
  session.basePath = basePath;
  session.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  return {
    s: session,
    ctx: {
      ui: {
        notify: (message: string) => {
          notifyCalls.push(message);
        },
      },
    } as unknown as PostUnitContext["ctx"],
    pi: {} as PostUnitContext["pi"],
    buildSnapshotOpts: () => ({}),
    lockBase: () => basePath,
    stopAuto: async () => {},
    pauseAuto: async () => {
      pauseCalls.push("pause");
    },
    updateProgressWidget: () => {},
  };
}

function scaffoldDbBackedTask(): string {
  closeDatabase();
  const basePath = makeTempRepo("gsd-post-unit-task-authority-");
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Task",
    status: "pending",
  });
  return basePath;
}

test("DB-backed execute-task missing an Attempt Result bypasses generic artifact retries", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls);
  pctx.s.pendingVerificationRetry = {
    unitId: "M001/S01/T01",
    failureContext: "Legacy artifact retry",
    attempt: 3,
  };
  pctx.s.verificationRetryCount.set("execute-task:M001/S01/T01", 3);

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "continue");
  assert.equal(pctx.s.pendingVerificationRetry, null);
  // The host verification gate's auto-fix counter shares this key and must
  // stay attempt-independent — deleting it here reset the retry bound to
  // "attempt 1/2" on every new Attempt (#1971).
  assert.equal(
    pctx.s.verificationRetryCount.get("execute-task:M001/S01/T01"),
    3,
    "host auto-fix retry counter must survive the durable-authority deferral",
  );
  assert.deepEqual(pauseCalls, []);
});

test("DB-backed execute-task deterministic errors cannot write an artifact placeholder", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls);
  pctx.s.lastToolInvocationError =
    "gsd_task_complete: Error saving artifact: context write blocked";

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "continue");
  assert.equal(
    existsSync(
      join(
        basePath,
        ".gsd",
        "milestones",
        "M001",
        "slices",
        "S01",
        "tasks",
        "T01-SUMMARY.md",
      ),
    ),
    false,
  );
  assert.equal(pctx.s.pendingVerificationRetry, null);
  assert.equal(pctx.s.lastToolInvocationError, null);
  assert.deepEqual(pauseCalls, []);
});

// ── #2131: a schema-rejected gsd_task_complete records a deterministic
// invocation error. The durable-authority branch used to clear it before any
// classification could act, so the unit was re-dispatched with unchanged
// inputs, failed host verification with a cause-agnostic throw, and wedged via
// the ADR-047 liveness backstop. The deterministic record must survive the
// durable path so the existing #2883 pause fires with the actual cause.
test("schema-rejected gsd_task_complete pauses with the deterministic cause (#2131)", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const notifyCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls, notifyCalls);
  pctx.s.lastToolInvocationError =
    'gsd_task_complete: Validation failed for tool "gsd_task_complete": sliceId: must have required properties sliceId';

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "dispatched");
  assert.equal(pauseCalls.length, 1, "auto-mode must pause instead of re-dispatching the unit");
  assert.equal(pctx.s.lastToolInvocationError, null);
  assert.deepEqual(notifyCalls, [
    'Tool invocation/runtime failed for execute-task: gsd_task_complete: Validation failed for tool "gsd_task_complete": sliceId: must have required properties sliceId. Retrying cannot resolve this deterministic failure — pausing auto-mode.',
  ]);
});

test("durable execute-task transient tool-unavailable error keeps deferring to durable authority", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const notifyCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls, notifyCalls);
  pctx.s.lastToolInvocationError =
    "No such tool available: mcp__gsd-workflow__gsd_task_complete";

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  // Transient MCP startup race: still cleared for the durable authority's own
  // bounded retry — no pause, no reclassification.
  assert.equal(result, "continue");
  assert.equal(pctx.s.lastToolInvocationError, null);
  assert.deepEqual(pauseCalls, []);
  assert.deepEqual(notifyCalls, []);
});

// ── #1971: a staged Attempt awaiting host verification must not reset the
// host auto-fix retry counter. Artifact readiness ("verify") only proves the
// Attempt staged a Result — the host verification gate has not run yet, so the
// "verification succeeded" clear must skip the shared retry key or every new
// gsd_task_complete resets the bound to "attempt 1/2" and exhaustion is never
// visibly reached.
function stageAwaitingVerificationAttempt(): void {
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.exec(`
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
      'trace-1971', 'turn-1971', 'worker-1', 7, 'M001', 'S01', 'T01',
      'execute-task', 'M001/S01/T01', 'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture-1971/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { taskId: "T01" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test-1971/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchRow = adapter
    .prepare("SELECT MAX(id) AS id FROM unit_dispatches")
    .get() as { id: number };
  const claimed = claimTaskAttempt({
    invocation: { idempotencyKey: "fixture-1971/claim", sourceTransport: "internal", actorType: "agent" },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatchRow.id),
  });
  settleTaskAttempt({
    invocation: { idempotencyKey: "fixture-1971/settle", sourceTransport: "internal", actorType: "agent" },
    attemptId: claimed.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "task work staged",
    output: {},
  });
}

test("staged awaiting-verification Attempt preserves the host auto-fix retry counter (#1971)", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  stageAwaitingVerificationAttempt();
  const pauseCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls);
  // As if the host gate already failed this unit once ("auto-fix attempt 1/2").
  pctx.s.verificationRetryCount.set("execute-task:M001/S01/T01", 1);

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "continue");
  assert.equal(
    pctx.s.verificationRetryCount.get("execute-task:M001/S01/T01"),
    1,
    "a new staged Attempt must not reset the host auto-fix retry counter",
  );
  assert.deepEqual(pauseCalls, []);
});
