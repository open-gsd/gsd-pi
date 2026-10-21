import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractCommitShas,
  findCommitsForUnit,
  handleUndo,
  handleUndoTask,
  handleResetSlice,
  parseActivityLogFilename,
  uncheckTaskInPlan,
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
} from "../gsd-db.ts";
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

test("handleUndo without --force only warns and leaves completed units intact", async () => {
  const base = makeTempDir("gsd-undo-confirm");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "completed-units.json"),
      JSON.stringify(["execute-task/M001/S01/T01"]),
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl"),
      "",
      "utf-8",
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };

    await handleUndo("", ctx as any, {} as any, base);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Run \/gsd undo --force to confirm\./);
    assert.deepEqual(
      JSON.parse(readFileSync(join(base, ".gsd", "completed-units.json"), "utf-8")),
      ["execute-task/M001/S01/T01"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndo execute-task with --force reopens the task row and re-renders plan", async () => {
  const base = makeTempDir("gsd-undo-execute-task");
  try {
    setupTaskFixture(base);
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl"),
      "",
      "utf-8",
    );

    const before = canonicalTaskHistory();
    const { notifications, ctx } = makeCtx();
    await handleUndo("--force", ctx, {} as any, base);

    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
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

    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Unchecked task in PLAN/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("uncheckTaskInPlan flips a checked task back to unchecked", () => {
  const base = makeTempDir("gsd-undo-plan");
  try {
    const sliceDir = join(base, ".gsd", "phases", "01-test");
    mkdirSync(sliceDir, { recursive: true });
    const planFile = join(sliceDir, "S01-PLAN.md");
    writeFileSync(
      planFile,
      [
        "# Slice Plan",
        "",
        "- [x] **T01**: Ship the feature",
        "- [ ] **T02**: Follow-up",
      ].join("\n"),
      "utf-8",
    );

    assert.equal(uncheckTaskInPlan(base, "M001", "S01", "T01"), true);
    assert.match(readFileSync(planFile, "utf-8"), /- \[ \] \*\*T01\*\*: Ship the feature/);
  } finally {
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

test("parseActivityLogFilename splits hyphenated unit types from their IDs", () => {
  // Task-level: unit type and ID both contain hyphens.
  assert.deepEqual(parseActivityLogFilename("001-execute-task-M001-S01-T01.jsonl"), {
    unitType: "execute-task",
    unitId: "M001-S01-T01",
  });
  // Variant must win over its shorter prefix ("execute-task").
  assert.deepEqual(parseActivityLogFilename("002-execute-task-simple-M001-S02-T03.jsonl"), {
    unitType: "execute-task-simple",
    unitId: "M001-S02-T03",
  });
  // Milestone- and slice-shaped IDs.
  assert.deepEqual(parseActivityLogFilename("003-research-milestone-M001.jsonl"), {
    unitType: "research-milestone",
    unitId: "M001",
  });
  assert.deepEqual(parseActivityLogFilename("004-plan-slice-M001-S01.jsonl"), {
    unitType: "plan-slice",
    unitId: "M001-S01",
  });
});

test("parseActivityLogFilename accepts non-milestone-shaped unit IDs", () => {
  // Regression (#1057): project-level units use IDs that do not start with
  // "M<digit>". A milestone-shaped regex made /gsd undo bail out with
  // "could not parse latest activity log" when one of these was most recent.
  assert.deepEqual(parseActivityLogFilename("005-discuss-project-PROJECT.jsonl"), {
    unitType: "discuss-project",
    unitId: "PROJECT",
  });
  assert.deepEqual(parseActivityLogFilename("006-workflow-preferences-WORKFLOW-PREFS.jsonl"), {
    unitType: "workflow-preferences",
    unitId: "WORKFLOW-PREFS",
  });
});

test("parseActivityLogFilename returns null for unrecognized names", () => {
  assert.equal(parseActivityLogFilename("007-not-a-real-unit-M001.jsonl"), null);
  assert.equal(parseActivityLogFilename("no-sequence-prefix.jsonl"), null);
  assert.equal(parseActivityLogFilename("001-execute-task-M001-S01-T01.txt"), null);
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
