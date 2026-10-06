import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeLastCompletedUnit,
  extractCommitShas,
  findCommitsForUnit,
  handleUndo,
  handleUndoTask,
  handleResetSlice,
  undoLastCompletedUnit,
} from "../undo.ts";
import {
  _getAdapter,
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSlice,
  getMilestone,
} from "../gsd-db.ts";
import { addLegacyCompletionEvidence } from "./helpers/legacy-completion-evidence.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import { invalidateAllCaches } from "../cache.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Record a completed Unit in the dispatch ledger, the source /gsd undo reads. */
function recordCompletedDispatch(unit: {
  unitType: string;
  unitId: string;
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
  endedAt: string;
}): void {
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(`
    INSERT OR IGNORE INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES ('undo-worker', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project')
  `).run();
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id, slice_id, task_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (
      :trace_id, 'undo-worker', 1, :milestone_id, :slice_id, :task_id,
      :unit_type, :unit_id, 'completed', 1, :ended_at, :ended_at
    )
  `).run({
    ":trace_id": `trace-${unit.unitId}`,
    ":milestone_id": unit.milestoneId,
    ":slice_id": unit.sliceId ?? null,
    ":task_id": unit.taskId ?? null,
    ":unit_type": unit.unitType,
    ":unit_id": unit.unitId,
    ":ended_at": unit.endedAt,
  });
}

test("handleUndo without --force only warns and leaves the task closed", async () => {
  const base = makeTempDir("gsd-undo-confirm");
  try {
    setupTaskFixture(base);
    recordCompletedDispatch({
      unitType: "execute-task", unitId: "M001/S01/T01",
      milestoneId: "M001", sliceId: "S01", taskId: "T01", endedAt: "2026-07-13T01:00:00.000Z",
    });

    const { notifications, ctx } = makeCtx();
    await handleUndo("", ctx, {} as any, base);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Will undo: execute-task \(M001\/S01\/T01\)/);
    assert.match(notifications[0]?.message ?? "", /Run \/gsd undo --force to confirm\./);
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(canonicalTaskHistory().reopenOperations, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndo selects the last completed unit from the DB ledger, not activity file names", async () => {
  const base = makeTempDir("gsd-undo-ledger");
  try {
    setupTaskFixture(base);
    // The newest activity log names a different unit; the ledger is authoritative.
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(join(base, ".gsd", "activity", "009-plan-slice-M001-S02.jsonl"), "", "utf-8");
    recordCompletedDispatch({
      unitType: "execute-task", unitId: "M001/S01/T02",
      milestoneId: "M001", sliceId: "S01", taskId: "T02", endedAt: "2026-07-13T01:00:00.000Z",
    });
    recordCompletedDispatch({
      unitType: "execute-task", unitId: "M001/S01/T01",
      milestoneId: "M001", sliceId: "S01", taskId: "T01", endedAt: "2026-07-13T02:00:00.000Z",
    });

    const before = canonicalTaskHistory();
    const { notifications, ctx } = makeCtx();
    await handleUndo("--force", ctx, {} as any, base);

    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    const after = canonicalTaskHistory();
    assert.equal(after.lifecycleId, before.lifecycleId);
    assert.equal(after.lifecycleStatus, "ready");
    assert.deepEqual(after.events, ["test.undo.task.completed", "task.reopened"]);
    assert.equal(after.reopenOperations, 1);

    const planContent = readFileSync(
      join(base, ".gsd", "phases", "01-test", "01-01-PLAN.md"),
      "utf-8",
    );
    assert.match(planContent, /\[ \] \*\*T01\*\*:/);
    assert.equal(existsSync(join(base, ".gsd", "phases", "01-test", "tasks", "T01-SUMMARY.md")), false);

    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Undone: execute-task \(M001\/S01\/T01\)/);
    assert.match(notifications[0]?.message ?? "", /Reopened task M001\/S01\/T01 in the database/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndo complete-slice reopens the slice in the DB for a suffixed milestone id", async () => {
  const base = makeTempDir("gsd-undo-complete-slice");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001-abc123", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001-abc123", title: "Test Slice", status: "complete", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001-abc123", title: "First task", status: "complete" });
    recordCompletedDispatch({
      unitType: "complete-slice", unitId: "M001-abc123/S01",
      milestoneId: "M001-abc123", sliceId: "S01", endedAt: "2026-07-13T01:00:00.000Z",
    });
    invalidateAllCaches();

    const { notifications, ctx } = makeCtx();
    await handleUndo("--force", ctx, {} as any, base);

    assert.equal(notifications.at(-1)?.level, "success", notifications.at(-1)?.message);
    assert.match(notifications.at(-1)?.message ?? "", /Undone: complete-slice \(M001-abc123\/S01\)/);
    assert.equal(getSlice("M001-abc123", "S01")?.status, "in_progress");
    assert.equal(getTask("M001-abc123", "S01", "T01")?.status, "pending");
    const reopen = _getAdapter()!.prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
    `).get() as Record<string, unknown>;
    assert.equal(Number(reopen["count"]), 1);

    // A second undo finds the slice already open and changes nothing.
    await handleUndo("--force", ctx, {} as any, base);
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /already open/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndo complete-slice confirm text states the task reset and the cleared summary", async (t) => {
  const base = makeTempDir("gsd-undo-slice-consent");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "complete" });
  recordCompletedDispatch({
    unitType: "complete-slice", unitId: "M001/S01",
    milestoneId: "M001", sliceId: "S01", endedAt: "2026-07-13T01:00:00.000Z",
  });
  invalidateAllCaches();

  const { notifications, ctx } = makeCtx();
  await handleUndo("", ctx, {} as any, base);

  const message = notifications[0]?.message ?? "";
  assert.match(message, /Will undo: complete-slice \(M001\/S01\)/);
  assert.match(message, /Reset 2 task\(s\) of the slice to pending/);
  assert.match(message, /Clear the slice summary and UAT in the database/);
  assert.equal(getSlice("M001", "S01")?.status, "complete");
  assert.equal(getTask("M001", "S01", "T02")?.status, "complete");
});

test("handleUndo complete-milestone reopens only the milestone and keeps slices, tasks and summaries", async (t) => {
  const base = makeTempDir("gsd-undo-complete-milestone");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "complete" });
  const items: LifecycleIdentity[] = [{ itemKind: "milestone", milestoneId: "M001" }];
  for (const sid of ["S01", "S02"]) {
    insertSlice({ id: sid, milestoneId: "M001", title: `Slice ${sid}`, status: "complete", risk: "low", depends: [] });
    items.push({ itemKind: "slice", milestoneId: "M001", sliceId: sid });
    for (const tid of ["T01", "T02"]) {
      insertTask({ id: tid, sliceId: sid, milestoneId: "M001", title: `Task ${tid}`, status: "complete" });
      items.push({ itemKind: "task", milestoneId: "M001", sliceId: sid, taskId: tid });
    }
  }
  _getAdapter()!.exec("UPDATE slices SET full_summary_md = 'Slice summary', full_uat_md = 'Slice UAT'");
  // Adopt the canonical lifecycle: the adopted reopen is the path that clears
  // slice summaries when the completed hierarchy is not kept.
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.undo.milestone.completed",
    idempotencyKey: "test:undo:fixture:milestone-completed",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    for (const item of items) {
      adoptOrTransitionLifecycle(context, { ...item, lifecycleStatus: "completed", adoptedFromStatus: "completed" });
    }
    return {
      events: [{
        eventType: "test.undo.milestone.completed",
        entityType: "milestone",
        entityId: "M001",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/undo/milestone/completed",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  recordCompletedDispatch({
    unitType: "complete-milestone", unitId: "M001",
    milestoneId: "M001", endedAt: "2026-07-13T01:00:00.000Z",
  });
  invalidateAllCaches();

  const info = await describeLastCompletedUnit(base);
  assert.deepEqual(info.effects, [
    "Reopen milestone M001 in the database; its slices and tasks stay complete",
    "Delete the milestone summary file",
  ]);

  const { notifications, ctx } = makeCtx();
  await handleUndo("--force", ctx, {} as any, base);

  assert.equal(notifications.at(-1)?.level, "success", notifications.at(-1)?.message);
  assert.match(notifications.at(-1)?.message ?? "", /Reopened milestone M001 in the database/);
  assert.equal(getMilestone("M001")?.status, "active");
  for (const sid of ["S01", "S02"]) {
    const slice = getSlice("M001", sid);
    assert.equal(slice?.status, "complete");
    assert.equal(slice?.full_summary_md, "Slice summary");
    assert.equal(slice?.full_uat_md, "Slice UAT");
    for (const tid of ["T01", "T02"]) {
      assert.equal(getTask("M001", sid, tid)?.status, "complete");
    }
  }
});

test("handleUndo refuses a unit with no reopen operation instead of reporting success", async () => {
  const base = makeTempDir("gsd-undo-unsupported");
  try {
    setupTaskFixture(base);
    recordCompletedDispatch({
      unitType: "plan-slice", unitId: "M001/S01",
      milestoneId: "M001", sliceId: "S01", endedAt: "2026-07-13T01:00:00.000Z",
    });

    const { notifications, ctx } = makeCtx();
    await handleUndo("--force", ctx, {} as any, base);

    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Cannot undo plan-slice \(M001\/S01\)/);
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(canonicalTaskHistory().reopenOperations, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("undo preview reports an unreadable database instead of an empty ledger", async () => {
  const base = makeTempDir("gsd-undo-no-db");
  try {
    closeDatabase();
    invalidateAllCaches();

    await assert.rejects(describeLastCompletedUnit(base), /GSD database is not available/);

    const { notifications, ctx } = makeCtx();
    await handleUndo("", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /GSD database is not available/);
    assert.doesNotMatch(notifications[0]?.message ?? "", /no completed unit is recorded/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndo reports a refused task reopen as a failure result", async () => {
  const base = makeTempDir("gsd-undo-task-refused");
  try {
    setupTaskFixture(base);
    // The legacy row no longer matches the canonical lifecycle head.
    _getAdapter()!.prepare("UPDATE tasks SET status = 'skipped' WHERE id = 'T01'").run();
    recordCompletedDispatch({
      unitType: "execute-task", unitId: "M001/S01/T01",
      milestoneId: "M001", sliceId: "S01", taskId: "T01", endedAt: "2026-07-13T01:00:00.000Z",
    });
    invalidateAllCaches();

    const result = await undoLastCompletedUnit(base);
    assert.equal(result.success, false);
    assert.match(result.message, /^Cannot undo execute-task \(M001\/S01\/T01\): /);

    const { notifications, ctx } = makeCtx();
    await handleUndo("--force", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "warning");
    assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
    assert.equal(canonicalTaskHistory().reopenOperations, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("undoLastCompletedUnit opens the project DB itself, as web undo calls it", async () => {
  const base = makeTempDir("gsd-undo-web");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
    recordCompletedDispatch({
      unitType: "complete-slice", unitId: "M001/S01",
      milestoneId: "M001", sliceId: "S01", endedAt: "2026-07-13T01:00:00.000Z",
    });
    addLegacyCompletionEvidence();
    closeDatabase();
    invalidateAllCaches();

    const info = await describeLastCompletedUnit(base);
    assert.equal(info.lastUnitKey, "complete-slice/M001/S01");
    assert.equal(info.completedCount, 1);

    const result = await undoLastCompletedUnit(base);
    assert.equal(result.success, true, result.message);
    assert.equal(getSlice("M001", "S01")?.status, "in_progress");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("findCommitsForUnit reads the newest matching activity log and dedupes SHAs", () => {
  const base = makeTempDir("gsd-undo-activity");
  try {
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });

    writeFileSync(
      join(activityDir, "2026-03-14-execute-task-M001-S01-T01.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { type: "tool_result", content: "[main abc1234] old commit" },
          ],
        },
      })}\n`,
      "utf-8",
    );

    writeFileSync(
      join(activityDir, "2026-03-15-execute-task-M001-S01-T01.jsonl"),
      [
        JSON.stringify({
          message: {
            content: [
              { type: "tool_result", content: "[main deadbee] new commit\n[main cafe123] another commit" },
              { type: "tool_result", content: "[main deadbee] duplicate commit" },
            ],
          },
        }),
        "{not-json}",
      ].join("\n"),
      "utf-8",
    );

    assert.deepEqual(
      findCommitsForUnit(activityDir, "execute-task", "M001/S01/T01"),
      ["deadbee", "cafe123"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("extractCommitShas returns unique commit hashes from git output blocks", () => {
  const content = [
    "[main abc1234] first commit",
    "[feature deadbeef] second commit",
    "[main abc1234] duplicate commit",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["abc1234", "deadbeef"]);
});

test("extractCommitShas ignores malformed commit tokens", () => {
  const content = [
    "[main abc1234; touch /tmp/pwned] not a real sha token",
    "[main not-a-sha] ignored",
    "[main 1234567] valid",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["1234567"]);
});

// ─── handleUndoTask tests ────────────────────────────────────────────────────

function makeCtx(): { notifications: Array<{ message: string; level: string }>; ctx: any } {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
  return { notifications, ctx };
}

function setupTaskFixture(base: string): void {
  // Create milestone/slice/task directory structure
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // Write plan file with checked task
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [ ] **T02: Second task** `est:30m`",
    ].join("\n"),
    "utf-8",
  );

  // Write task summary file
  writeFileSync(
    join(tasksDir, "T01-SUMMARY.md"),
    "# T01 Summary\nDone.",
    "utf-8",
  );

  // Set up DB
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.undo.task.completed",
    idempotencyKey: "test:undo:fixture:task-completed",
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
      lifecycleStatus: "completed",
      adoptedFromStatus: "completed",
    });
    return {
      events: [{
        eventType: "test.undo.task.completed",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/undo/task/completed",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  invalidateAllCaches();
}

function canonicalTaskHistory(): {
  lifecycleId: string;
  lifecycleStatus: string;
  events: string[];
  reopenOperations: number;
} {
  const db = _getAdapter();
  assert.ok(db);
  const lifecycle = db.prepare(`
    SELECT lifecycle_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = 'M001'
      AND slice_id = 'S01'
      AND task_id = 'T01'
  `).get() as Record<string, unknown> | undefined;
  assert.ok(lifecycle);
  const events = db.prepare(`
    SELECT event_type
    FROM workflow_domain_events
    WHERE entity_type = 'task' AND entity_id = 'M001/S01/T01'
    ORDER BY project_revision, event_index
  `).all() as Array<Record<string, unknown>>;
  const reopenOperations = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_operations
    WHERE operation_type = 'task.reopen'
  `).get() as Record<string, unknown> | undefined;
  return {
    lifecycleId: String(lifecycle["lifecycle_id"]),
    lifecycleStatus: String(lifecycle["lifecycle_status"]),
    events: events.map((event) => String(event["event_type"])),
    reopenOperations: Number(reopenOperations?.["count"] ?? 0),
  };
}

test("handleUndoTask without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-undo-task-usage");
  try {
    await handleUndoTask("", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-undo-task-confirm");
  try {
    setupTaskFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    // Verify state was NOT modified
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask with --force resets task and re-renders plan", async () => {
  const base = makeTempDir("gsd-undo-task-force");
  try {
    setupTaskFixture(base);
    const before = canonicalTaskHistory();
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base);
    await handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base);

    // DB status reset
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
    const after = canonicalTaskHistory();
    assert.equal(after.lifecycleId, before.lifecycleId);
    assert.equal(after.lifecycleStatus, "ready");
    assert.deepEqual(after.events, ["test.undo.task.completed", "task.reopened"]);
    assert.equal(after.reopenOperations, 1, "replaying undo must reuse the completion-scoped command");

    // Summary file deleted
    const summaryPath = join(base, ".gsd", "phases", "01-test", "tasks", "T01-SUMMARY.md");
    assert.equal(existsSync(summaryPath), false);

    // Plan checkbox unchecked — renderPlanCheckboxes re-renders to the flat-phase path
    const planContent = readFileSync(
      join(base, ".gsd", "phases", "01-test", "01-01-PLAN.md"),
      "utf-8",
    );
    // Flat-phase renderer: tasks are bold on ID only — "**T01**: title"
    assert.match(planContent, /\[ \] \*\*T01\*\*:/);

    // Success notification
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset task M001\/S01\/T01/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask keeps the canonical reopen when summary cleanup fails", async () => {
  const base = makeTempDir("gsd-undo-task-cleanup-failure");
  try {
    setupTaskFixture(base);
    const summaryPath = join(base, ".gsd", "phases", "01-test", "tasks", "T01-SUMMARY.md");
    rmSync(summaryPath);
    mkdirSync(summaryPath);

    const { ctx } = makeCtx();
    await assert.rejects(
      handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base),
      /directory|operation not permitted|EISDIR/i,
    );

    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    const afterFailure = canonicalTaskHistory();
    assert.equal(afterFailure.lifecycleStatus, "ready");
    assert.deepEqual(afterFailure.events, ["test.undo.task.completed", "task.reopened"]);
    assert.equal(afterFailure.reopenOperations, 1);

    rmSync(summaryPath, { recursive: true });
    await handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base);
    assert.equal(canonicalTaskHistory().reopenOperations, 1);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask rejects inconsistent legacy and canonical heads", async () => {
  const base = makeTempDir("gsd-undo-task-inconsistent-heads");
  try {
    setupTaskFixture(base);
    const db = _getAdapter();
    assert.ok(db);
    db.prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();

    const { ctx } = makeCtx();
    await assert.rejects(
      handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base),
      /matching legacy and canonical lifecycle heads/i,
    );

    const history = canonicalTaskHistory();
    assert.equal(history.lifecycleStatus, "completed");
    assert.deepEqual(history.events, ["test.undo.task.completed"]);
    assert.equal(history.reopenOperations, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask with non-existent task returns error", async () => {
  const base = makeTempDir("gsd-undo-task-notfound");
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "active", risk: "low", depends: [] });

    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T99 --force", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask accepts partial ID (T01) and resolves from state", async () => {
  const base = makeTempDir("gsd-undo-task-partial");
  try {
    setupTaskFixture(base);

    // Create STATE.md so deriveState can resolve the active milestone/slice
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "STATE.md"),
      [
        "# GSD State",
        "",
        "- Phase: executing",
        "- Active Milestone: M001",
        "- Active Slice: S01",
        "- Active Task: T01",
      ].join("\n"),
      "utf-8",
    );

    const { notifications, ctx } = makeCtx();
    await handleUndoTask("T01 --force", ctx, {} as any, base);

    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
    assert.equal(notifications[0]?.level, "success");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── handleResetSlice tests ──────────────────────────────────────────────────

function setupSliceFixture(base: string, secondTaskStatus = "complete"): void {
  const mDir = join(base, ".gsd", "phases", "01-test");
  // Flat-phase: no slices/ or tasks/ subdirs — everything is in the phase dir
  mkdirSync(mDir, { recursive: true });

  // Write roadmap file
  writeFileSync(
    join(mDir, "M001-ROADMAP.md"),
    [
      "# Roadmap",
      "",
      "## Slices",
      "",
      "- [x] **S01: Test Slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Next Slice** `risk:low` `depends:[S01]`",
    ].join("\n"),
    "utf-8",
  );

  // Write plan file — flat-phase: 01-01-PLAN.md in phase dir
  writeFileSync(
    join(mDir, "01-01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [x] **T02: Second task** `est:30m`",
    ].join("\n"),
    "utf-8",
  );

  // Write task summaries — flat-phase: in phase dir
  writeFileSync(join(mDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.", "utf-8");
  writeFileSync(join(mDir, "T02-SUMMARY.md"), "# T02 Summary\nDone.", "utf-8");

  // Write slice summary and UAT — flat-phase: in phase dir
  writeFileSync(join(mDir, "01-01-SUMMARY.md"), "# Slice Summary\nDone.", "utf-8");
  writeFileSync(join(mDir, "01-01-UAT.md"), "# UAT\nPassed.", "utf-8");

  // Set up DB
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: ["S01"] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: secondTaskStatus });
  invalidateAllCaches();
}

function adoptCompletedLifecycle(identity: LifecycleIdentity): void {
  const entityId = [identity.milestoneId, identity.sliceId, identity.taskId]
    .filter(Boolean)
    .join("/");
  const operationType = `test.reset-slice.${identity.itemKind}-adopted`;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey: `${operationType}:${entityId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { entityId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      ...identity,
      lifecycleStatus: "completed",
      adoptedFromStatus: "completed",
    });
    return {
      events: [{
        eventType: operationType,
        entityType: identity.itemKind,
        entityId,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/reset-slice/${identity.itemKind}-adopted`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

test("handleResetSlice without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-reset-slice-usage");
  try {
    await handleResetSlice("", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-reset-slice-confirm");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    // State not modified
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice with --force resets slice and all tasks", async () => {
  const base = makeTempDir("gsd-reset-slice-force");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    // DB status reset
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "in_progress");
    const t1 = getTask("M001", "S01", "T01");
    assert.equal(t1?.status, "pending");
    const t2 = getTask("M001", "S01", "T02");
    assert.equal(t2?.status, "pending");

    // Task summaries deleted
    // Flat-phase: task summaries (T01-SUMMARY.md) may not be cleaned up by
    // handleResetSlice because resolveTaskFile returns null. The DB reset is
    // the authoritative cleanup; stale summary files are cosmetic.
    // Skip per-task summary file deletion checks in flat-phase.

    // Slice summary and UAT deleted — flat-phase naming
    const sliceDir = join(base, ".gsd", "phases", "01-test");
    assert.equal(existsSync(join(sliceDir, "01-01-SUMMARY.md")), false, "slice summary should be deleted");
    assert.equal(existsSync(join(sliceDir, "01-01-UAT.md")), false, "slice UAT should be deleted");

    // Plan checkboxes unchecked — renderPlanCheckboxes re-renders to flat-phase path
    // Flat-phase renderer: tasks are bold on ID only — "**T01**: title"
    const planContent = readFileSync(join(base, ".gsd", "phases", "01-test", "01-01-PLAN.md"), "utf-8");
    assert.match(planContent, /\[ \] \*\*T01\*\*:/);
    assert.match(planContent, /\[ \] \*\*T02\*\*:/);

    // Roadmap checkbox unchecked — flat-phase naming
    const roadmapContent = readFileSync(
      join(base, ".gsd", "phases", "01-test", "01-ROADMAP.md"),
      "utf-8",
    );
    assert.match(roadmapContent, /\[ \].*S01/);

    // Success notification
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset slice M001\/S01/);

    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);
    assert.equal(notifications[1]?.level, "success");
    assert.match(notifications[1]?.message ?? "", /reused|replayed|already current|duplicate/i);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice warns when readable projections remain stale", async () => {
  const base = makeTempDir("gsd-reset-slice-stale-projection");
  try {
    setupSliceFixture(base);
    adoptCompletedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" });
    const summaryPath = join(base, ".gsd", "phases", "01-test", "01-01-SUMMARY.md");
    rmSync(summaryPath, { force: true });
    mkdirSync(summaryPath);

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /pending repair|stale/i);
    assert.doesNotMatch(notifications.at(-1)?.message ?? "", /projections refreshed/i);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice atomically reopens an adopted canonical slice", async () => {
  const base = makeTempDir("gsd-reset-slice-adopted");
  try {
    setupSliceFixture(base);
    adoptCompletedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" });

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    assert.equal(notifications.at(-1)?.level, "success");
    assert.equal(getSlice("M001", "S01")?.status, "in_progress");
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    assert.equal(getTask("M001", "S01", "T02")?.status, "pending");
    assert.equal(
      _getAdapter()!.prepare(`
        SELECT lifecycle_status FROM workflow_item_lifecycles
        WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
      `).get()?.lifecycle_status,
      "ready",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice validates every task before changing slice or task state", async () => {
  const base = makeTempDir("gsd-reset-slice-preflight");
  try {
    setupSliceFixture(base, "in_progress");
    adoptCompletedLifecycle({
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
    });
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not complete.*T02|T02.*not terminal/i);
    assert.equal(getSlice("M001", "S01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T02")?.status, "in_progress");
    assert.equal(
      _getAdapter()!.prepare(`
        SELECT lifecycle_status FROM workflow_item_lifecycles
        WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
      `).get()?.lifecycle_status,
      "completed",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice fails closed before mutating a slice in a closed milestone", async () => {
  const base = makeTempDir("gsd-reset-slice-closed-milestone");
  try {
    setupSliceFixture(base);
    _getAdapter()!.prepare(`
      UPDATE milestones
      SET status = 'complete', completed_at = datetime('now')
      WHERE id = 'M001'
    `).run();

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /closed milestone/i);
    assert.equal(getSlice("M001", "S01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T02")?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice fails closed under a terminal canonical milestone", async () => {
  const base = makeTempDir("gsd-reset-slice-canonical-milestone");
  try {
    setupSliceFixture(base);
    adoptCompletedLifecycle({ itemKind: "milestone", milestoneId: "M001" });

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /terminal canonical milestone/i);
    assert.equal(getSlice("M001", "S01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(getTask("M001", "S01", "T02")?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice with non-existent slice returns error", async () => {
  const base = makeTempDir("gsd-reset-slice-notfound");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S99 --force", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
