// Project/App: gsd-pi
// File Purpose: Replay, conflict, and cancelled-identity contracts for slice replanning.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _getAdapter,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  projectCanonicalStatusToLegacy,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { PlanningInvocation } from "../planning-invocation.ts";
import { claimTaskAttempt } from "../task-execution-domain-operation.ts";
import { handlePlanSlice } from "../tools/plan-slice.ts";
import { handleReplanSlice, type ReplanSliceParams } from "../tools/replan-slice.ts";

function invocation(idempotencyKey: string): PlanningInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: idempotencyKey,
  };
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-replan-slice-domain-"));
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "input.ts"), "export const input = true;\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function rows(sql: string): Array<Record<string, unknown>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter.prepare(sql).all();
}

function claimRunningTask(taskId: string): void {
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'replan-worker', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'replan-worker', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-running-replan', 'turn-running-replan', 'replan-worker', 7,
      'M001', 'S01', '${taskId}', 'execute-task', 'M001/S01/${taskId}',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const dispatch = adapter.prepare(
    "SELECT id FROM unit_dispatches WHERE trace_id = 'trace-running-replan'",
  ).get();
  claimTaskAttempt({
    invocation: invocation("replan-slice/running-task-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "replan-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch?.["id"]),
  });
}

async function seedPlannedSlice(base: string, completeBlocker = true): Promise<void> {
  insertMilestone({ id: "M001", title: "Replan", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  const task = (taskId: string, title: string) => ({
    taskId,
    title,
    description: `${title} description`,
    estimate: "30m",
    files: ["src/input.ts"],
    verify: "node --test",
    inputs: ["src/input.ts"],
    expectedOutput: ["src/input.ts"],
  });
  const planned = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Seed canonical planning state.",
    tasks: [task("T01", "Completed blocker"), task("T02", "Cancelled work")],
  }, base, invocation("seed-plan-slice"));
  assert.ok(!("error" in planned), "slice planning fixture must succeed");
  if (!completeBlocker) return;
  for (const [lifecycleStatus, legacyStatus] of [
    ["in_progress", "active"],
    ["completed", "complete"],
  ] as const) {
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: `test.blocker.${lifecycleStatus}`,
      idempotencyKey: `test:blocker:${lifecycleStatus}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { taskId: "T01", lifecycleStatus },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus,
      });
      projectCanonicalStatusToLegacy(context, {
        entity: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        status: legacyStatus,
        ...(lifecycleStatus === "completed" ? { completedAt: "2026-07-12T00:00:00.000Z" } : {}),
      });
      return {
        events: [{ eventType: `test.blocker.${lifecycleStatus}`, entityType: "task", entityId: "T01", payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: `test:blocker:${lifecycleStatus}`, projectionKind: "test", rendererVersion: "1" }],
      };
    });
  }
}

function replanParams(): ReplanSliceParams {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    blockerTaskId: "T01",
    blockerDescription: "The original approach is blocked.",
    whatChanged: "Cancel T02 and replace it with T03.",
    updatedTasks: [{
      taskId: "T03",
      title: "Replacement",
      description: "Implement the replacement approach.",
      estimate: "45m",
      files: ["src/input.ts"],
      verify: "node --test",
      inputs: ["src/input.ts"],
      expectedOutput: ["src/input.ts"],
    }],
    removedTaskIds: ["T02"],
  };
}

test("slice replan exact retry replays once and changed reuse conflicts without residue", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base);
    const envelope = invocation("replan-slice/retry-1");
    const first = await handleReplanSlice(replanParams(), base, envelope);
    assert.ok(!("error" in first), `unexpected error: ${"error" in first ? first.error : ""}`);

    const snapshot = () => ({
      tasks: rows("SELECT id, status, title FROM tasks ORDER BY id"),
      history: rows("SELECT task_id, summary FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_type, idempotency_key, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: rows("SELECT item_kind, task_id, lifecycle_status, state_version, last_operation_id FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    });
    const afterCommit = snapshot();

    const replay = await handleReplanSlice(replanParams(), base, envelope);
    assert.deepEqual(replay, first, "lost-response retry must preserve the public response exactly");
    assert.deepEqual(snapshot(), afterCommit, "exact retry must not duplicate durable or compatibility state");

    const conflict = await handleReplanSlice(
      { ...replanParams(), whatChanged: "Conflicting semantic payload" },
      base,
      envelope,
    );
    assert.ok("error" in conflict);
    assert.match(conflict.error, /idempotency conflict/i);
    assert.deepEqual(snapshot(), afterCommit, "conflicting reuse must leave no residue");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice replan restores its pending Q8 companion gate", async (t) => {
  const base = makeBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  await seedPlannedSlice(base);
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.prepare(`
    DELETE FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01'
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `).run();

  const result = await handleReplanSlice(
    replanParams(),
    base,
    invocation("replan-slice/restore-q8"),
  );

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(rows(`
    SELECT gate_id, scope, status
    FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01'
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `), [{ gate_id: "Q8", scope: "slice", status: "pending" }]);
});

test("slice replan retry preserves a newer durable replan projection", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base);
    const originalInvocation = invocation("replan-slice/stale-retry");
    const first = await handleReplanSlice(replanParams(), base, originalInvocation);
    assert.ok(!("error" in first));

    const newerParams: ReplanSliceParams = {
      ...replanParams(),
      blockerDescription: "A newer blocker description.",
      whatChanged: "Keep T03 with a newer implementation plan.",
      updatedTasks: [{
        ...replanParams().updatedTasks[0]!,
        description: "Implement the newer replacement approach.",
      }],
      removedTaskIds: [],
    };
    const newer = await handleReplanSlice(newerParams, base, invocation("replan-slice/newer"));
    assert.ok(!("error" in newer));
    const newerContent = readFileSync(newer.replanPath, "utf8");

    const replay = await handleReplanSlice(replanParams(), base, originalInvocation);
    assert.deepEqual(replay, first);
    assert.equal(
      readFileSync(newer.replanPath, "utf8"),
      newerContent,
      "an older exact retry must render the latest durable replan without changing its creation time",
    );
    assert.match(newerContent, /A newer blocker description/);
    assert.match(newerContent, /Keep T03 with a newer implementation plan/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice replan requires explicit reopen before reusing cancelled task identity", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base);
    const first = await handleReplanSlice(replanParams(), base, invocation("replan-slice/cancel"));
    assert.ok(!("error" in first));
    const before = rows("SELECT id, status, title FROM tasks ORDER BY id");

    const cancelled = getTask("M001", "S01", "T02");
    assert.equal(cancelled?.status, "skipped");
    const reuse = await handleReplanSlice({
      ...replanParams(),
      updatedTasks: [{ ...replanParams().updatedTasks[0]!, taskId: "T02" }],
      removedTaskIds: [],
    }, base, invocation("replan-slice/reuse-cancelled"));
    assert.ok("error" in reuse);
    assert.match(reuse.error, /explicitly reopen/i);
    assert.deepEqual(rows("SELECT id, status, title FROM tasks ORDER BY id"), before);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice replan rejects removal of a Task with a running Attempt without residue", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base);
    claimRunningTask("T02");
    const snapshot = () => ({
      tasks: rows("SELECT id, status FROM tasks ORDER BY id"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
      attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_number"),
      results: rows("SELECT * FROM workflow_attempt_results ORDER BY created_at"),
    });
    const before = snapshot();

    const result = await handleReplanSlice(
      replanParams(),
      base,
      invocation("replan-slice/reject-running-removal"),
    );

    assert.ok("error" in result);
    assert.match(result.error, /running Attempt/i);
    assert.deepEqual(snapshot(), before, "rejected replan must leave exact zero residue");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice replan preserves pending lifecycle provenance for existing tasks", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base);
    insertTask({ id: "T03", milestoneId: "M001", sliceId: "S01", title: "Reserved replacement", status: "pending" });
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "test.reserve-task",
      idempotencyKey: "test:reserve-task",
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { taskId: "T03" },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T03",
        lifecycleStatus: "pending",
      });
      return {
        events: [{ eventType: "test.task.reserved", entityType: "task", entityId: "M001/S01/T03", payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: "test:t03", projectionKind: "test", rendererVersion: "1" }],
      };
    });
    const before = rows("SELECT lifecycle_status, state_version, last_operation_id FROM workflow_item_lifecycles WHERE task_id = 'T03'");

    const result = await handleReplanSlice(replanParams(), base, invocation("replan-slice/preserve-pending"));
    assert.ok(!("error" in result));
    assert.deepEqual(
      rows("SELECT lifecycle_status, state_version, last_operation_id FROM workflow_item_lifecycles WHERE task_id = 'T03'"),
      before,
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice replan rejects canonically cancelled blocker despite legacy complete drift without residue", async () => {
  const base = makeBase();
  try {
    await seedPlannedSlice(base, false);
    const adapter = _getAdapter();
    assert.ok(adapter);
    adapter.prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-12T00:00:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    for (const lifecycleStatus of ["ready", "cancelled"] as const) {
      const fence = readDomainOperationFence();
      executeDomainOperation({
        operationType: `test.blocker.${lifecycleStatus}`,
        idempotencyKey: `test:blocker:${lifecycleStatus}`,
        expectedRevision: fence.revision,
        expectedAuthorityEpoch: fence.authorityEpoch,
        actorType: "test",
        sourceTransport: "test",
        payload: { taskId: "T01", lifecycleStatus },
      }, (context) => {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T01",
          lifecycleStatus,
        });
        return {
          events: [{
            eventType: `test.blocker.${lifecycleStatus}`,
            entityType: "task",
            entityId: "M001/S01/T01",
            payload: { taskId: "T01", lifecycleStatus },
            destinations: ["test"],
          }],
          projections: [{ projectionKey: `test:blocker:${lifecycleStatus}`, projectionKind: "test", rendererVersion: "1" }],
        };
      });
    }

    const snapshot = () => ({
      tasks: rows("SELECT id, status, title FROM tasks ORDER BY id"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: rows("SELECT task_id, lifecycle_status, state_version, last_operation_id FROM workflow_item_lifecycles ORDER BY task_id"),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    });
    const before = snapshot();

    const result = await handleReplanSlice(
      { ...replanParams(), blockerDescription: "Legacy says complete, canonical says cancelled." },
      base,
      invocation("replan-slice/cancelled-blocker"),
    );
    assert.ok("error" in result);
    assert.match(result.error, /canonically cancelled.*explicitly reopen/i);
    assert.deepEqual(snapshot(), before, "cancelled blocker rejection must leave no residue");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
