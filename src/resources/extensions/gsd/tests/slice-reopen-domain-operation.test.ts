// Project/App: gsd-pi
// File Purpose: Executable contracts for atomic full-redo Slice reopen Domain Operations.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
  syncSliceDependencies,
} from "../gsd-db.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import * as sliceLifecycle from "../slice-lifecycle-domain-operation.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import {
  targetSliceFile,
  targetTaskFile,
} from "../paths.ts";
import {
  _setReopenSliceCleanupInterleaveForTest,
  handleReopenSlice,
} from "../tools/reopen-slice.ts";
import { handleResetSlice } from "../undo.ts";
import { rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import { renderSliceSummary } from "../markdown-renderer.ts";

const tempDirs = new Set<string>();

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

function compatibilityEventCount(base: string, command: string): number {
  const eventLogPath = join(base, ".gsd", "event-log.jsonl");
  if (!existsSync(eventLogPath)) return 0;
  return readFileSync(eventLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cmd?: string })
    .filter((event) => event.cmd === command)
    .length;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "slice-reopen-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "slice",
        entityId: "M001/S01",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function insertClaimedDispatch(taskId: string): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', 1, '2026-07-14T00:00:00.000Z'
    )
  `).run({
    ":trace_id": `trace/${taskId}`,
    ":turn_id": `turn/${taskId}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function completeTaskWithEvidence(taskId: string): void {
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch(taskId),
  });
  settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle`),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Completed before the Slice was reopened",
    output: { artifact: "immutable-completed-history" },
  });
  recordTaskTechnicalVerdict({
    invocation: invocation(`fixture/${taskId}/verify`),
    attemptId: claim.attemptId,
    testedSourceRevision: "git:fixture-source-revision",
    verdict: "pass",
    rationale: "Fixture verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test fixture",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-14T00:01:00.000Z",
      endedAt: "2026-07-14T00:01:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://fixture/${taskId}/verification`,
      environment: { runner: "node-test", fixture: "slice-reopen" },
    },
  });
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-reopen-domain-"));
  tempDirs.add(base);
  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(
    join(phaseDir, "01-01-PLAN.md"),
    "# S01\n\n- [x] **T01**: Completed\n- [x] **T02**: Cancelled\n",
  );
  writeFileSync(
    join(phaseDir, "M001-ROADMAP.md"),
    "# Roadmap\n\n- [x] **S01: Full redo** `risk:low` `depends:[]`\n",
  );
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function seedTerminalSlice(
  sliceStatus: "complete" | "skipped" = "complete",
  options: { runningChild?: boolean } = {},
): string {
  const base = makeBase();
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Slice lifecycle', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Full redo', 'in_progress', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Completed child', 'pending', 1),
      ('M001', 'S01', 'T02', 'Cancelled child', 'pending', 2);
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
  `);
  if (options.runningChild) {
    db().prepare(`
      INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
      VALUES ('M001', 'S01', 'T03', 'Running child', 'pending', 3)
    `).run();
  }

  executeAtFence("test.slice-reopen.ready", "fixture/slice-reopen/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "in_progress",
    });
    for (const taskId of options.runningChild ? ["T01", "T02", "T03"] : ["T01", "T02"]) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId,
        lifecycleStatus: "ready",
      });
    }
  });

  completeTaskWithEvidence("T01");
  if (options.runningChild) {
    const runningClaim = claimTaskAttempt({
      invocation: invocation("fixture/T03/claim"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T03" },
      workerId: "worker-1",
      milestoneLeaseToken: 7,
      coordinationDispatchId: insertClaimedDispatch("T03"),
    });
    assert.ok(runningClaim.attemptId);
  }

  const canonicalSliceStatus = sliceStatus === "complete" ? "completed" : "cancelled";
  executeAtFence("test.slice-reopen.terminal", "fixture/slice-reopen/terminal", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: canonicalSliceStatus,
    });
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-14T00:02:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    db().prepare(`
      UPDATE tasks SET status = 'skipped', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
    `).run();
    db().prepare(`
      UPDATE slices SET status = :status, completed_at = :completed_at
      WHERE milestone_id = 'M001' AND id = 'S01'
    `).run({
      ":status": sliceStatus,
      ":completed_at": sliceStatus === "complete" ? "2026-07-14T00:02:00.000Z" : null,
    });
  });
  return base;
}

function cleanupFixture(t: TestContext, base: string): void {
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
    tempDirs.delete(base);
  });
}

function seedReachableDownstreamSlice(status: "in_progress" | "complete"): void {
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Pending bridge",
    status: "pending",
    depends: ["S01"],
    sequence: 2,
  });
  insertSlice({
    id: "S03",
    milestoneId: "M001",
    title: "Started downstream work",
    status,
    depends: ["S02"],
    sequence: 3,
  });
  executeAtFence(
    "test.slice-reopen.downstream-state",
    `fixture/slice-reopen/downstream-${status}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S02",
        lifecycleStatus: "ready",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S03",
        lifecycleStatus: status === "complete" ? "completed" : "in_progress",
      });
    },
  );
}

function seedCyclicDownstreamSlice(): void {
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Started cyclic downstream work",
    status: "in_progress",
    depends: ["S01"],
    sequence: 2,
  });
  db().prepare(`
    UPDATE slices SET depends = '["S02"]'
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).run();
  syncSliceDependencies("M001", "S01", ["S02"]);
  syncSliceDependencies("M001", "S02", ["S01"]);
  executeAtFence("test.slice-reopen.cyclic-downstream", "fixture/slice-reopen/cycle", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "in_progress",
    });
  });
}

function taskEvidenceSnapshot(taskId = "T01"): Record<string, unknown> {
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001'
      AND slice_id = 'S01' AND task_id = '${taskId}'
  `).lifecycle_id);
  return {
    attempts: rows(`SELECT * FROM workflow_execution_attempts WHERE lifecycle_id = '${lifecycleId}' ORDER BY attempt_number`),
    results: rows(`SELECT * FROM workflow_attempt_results WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    verdicts: rows(`SELECT * FROM workflow_technical_verdicts WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    evidence: rows(`SELECT * FROM workflow_verification_evidence WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    kernelCheckpoints: rows(`SELECT * FROM workflow_kernel_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY sequence`),
    workCheckpoints: rows(`SELECT * FROM workflow_work_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY project_revision`),
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    kernelCheckpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    workCheckpoints: rows("SELECT * FROM workflow_work_checkpoints ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
  };
}

function assertFullRedoState(): void {
  assert.deepEqual(row(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_status AS canonical_status
    FROM slices slice
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
    WHERE slice.milestone_id = 'M001' AND slice.id = 'S01'
  `), { legacy_status: "in_progress", canonical_status: "ready" });
  assert.deepEqual(rows(`
    SELECT task.id, task.status AS legacy_status,
           lifecycle.lifecycle_status AS canonical_status
    FROM tasks task
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = 'M001' AND task.slice_id = 'S01'
    ORDER BY task.id
  `), [
    { id: "T01", legacy_status: "pending", canonical_status: "ready" },
    { id: "T02", legacy_status: "pending", canonical_status: "ready" },
  ]);
}

afterEach(() => {
  _setReopenSliceCleanupInterleaveForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("public reopen performs one full-redo Slice Domain Operation and preserves prior execution evidence", async () => {
  const base = seedTerminalSlice("complete");
  const historyBefore = taskEvidenceSnapshot();
  const revisionBefore = Number(row("SELECT revision FROM project_authority").revision);
  const reopenOperationsBefore = Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count);

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Requirements changed, so the entire Slice must be redone.",
  }, base, invocation("slice-reopen/public/full-redo"));

  assert.equal("error" in result, false, "public reopen must accept canonical terminal history");
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), revisionBefore + 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), reopenOperationsBefore + 1);
  assert.deepEqual(row(`
    SELECT event_type, entity_type, entity_id
    FROM workflow_domain_events
    WHERE operation_id = (
      SELECT operation_id FROM workflow_operations WHERE operation_type = 'slice.reopen'
      ORDER BY resulting_revision DESC LIMIT 1
    )
  `), {
    event_type: "slice.reopened",
    entity_type: "slice",
    entity_id: "M001/S01",
  });
  assertFullRedoState();
  assert.deepEqual(taskEvidenceSnapshot(), historyBefore, "reopen must not rewrite prior evidence history");
  assert.equal(compatibilityEventCount(base, "reopen-slice"), 1);

  await assert.rejects(
    handleReopenSlice({
      milestoneId: "M001",
      sliceId: "S01",
      reason: "Changed reason under the same public invocation.",
    }, base, invocation("slice-reopen/public/full-redo")),
    /idempotency conflict/i,
  );
  assert.equal(compatibilityEventCount(base, "reopen-slice"), 1);
});

test("public reset is a compatibility adapter to the same atomic Slice reopen operation", async () => {
  const base = seedTerminalSlice("skipped");
  const historyBefore = taskEvidenceSnapshot();
  const revisionBefore = Number(row("SELECT revision FROM project_authority").revision);
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);

  assert.equal(notifications.at(-1)?.level, "success", notifications.at(-1)?.message);
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), revisionBefore + 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), 1);
  assertFullRedoState();
  assert.deepEqual(taskEvidenceSnapshot(), historyBefore, "reset must preserve immutable execution evidence");
});

test("reset retries the current reopen identity and repairs projections after a lost response", async () => {
  const base = seedTerminalSlice("skipped");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);
  const phaseDir = join(base, ".gsd", "phases", "01-test");
  const staleSummary = join(phaseDir, "01-01-SUMMARY.md");
  const staleUat = join(phaseDir, "01-01-UAT.md");
  writeFileSync(staleSummary, "# Stale summary\n");
  writeFileSync(staleUat, "# Stale UAT\n");

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);

  assert.equal(notifications.at(-1)?.level, "success", notifications.at(-1)?.message);
  assert.equal(existsSync(staleSummary), false, "retry must repair stale summary projection");
  assert.equal(existsSync(staleUat), false, "retry must repair stale UAT projection");
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), 1, "retry must replay one reopen operation");
  assert.equal(compatibilityEventCount(base, "reopen-slice"), 1, "retry must not duplicate compatibility events");
});

test("full DB-to-Markdown rebuild cannot resurrect completion projections after reopen", async (t) => {
  const base = seedTerminalSlice("complete");
  cleanupFixture(t, base);
  const taskSummaryPath = targetTaskFile(base, "M001", "S01", "T01", "SUMMARY");
  const sliceSummaryPath = targetSliceFile(base, "M001", "S01", "SUMMARY");
  const sliceUatPath = targetSliceFile(base, "M001", "S01", "UAT");
  db().prepare(`
    UPDATE tasks SET full_summary_md = '# Completed Task summary'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db().prepare(`
    UPDATE slices
    SET full_summary_md = '# Completed Slice summary', full_uat_md = '# Completed Slice UAT'
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).run();
  writeFileSync(taskSummaryPath, "# Completed Task summary\n");
  assert.equal(await renderSliceSummary(base, "M001", "S01"), true);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM artifacts
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND task_id IS NULL
      AND artifact_type IN ('SUMMARY', 'UAT')
  `).count), 2, "completion projections must be persisted before reopen");

  const reopened = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Redo the Slice without restoring its previous completion projections.",
  }, base, invocation("slice-reopen/public/rebuild-no-resurrection"));
  assert.equal("error" in reopened, false);
  assert.equal(existsSync(taskSummaryPath), false);
  assert.equal(existsSync(sliceSummaryPath), false);
  assert.equal(existsSync(sliceUatPath), false);

  const rebuilt = await rebuildMarkdownProjectionsFromDb(base);

  assert.deepEqual(rebuilt.errors, []);
  assert.deepEqual({
    taskSummary: existsSync(taskSummaryPath),
    sliceSummary: existsSync(sliceSummaryPath),
    sliceUat: existsSync(sliceUatPath),
  }, {
    taskSummary: false,
    sliceSummary: false,
    sliceUat: false,
  }, "ready/pending hierarchy must not regain prior completion projections");
});

test("reset does not replay an old reopen after a descendant Task starts", async () => {
  const base = seedTerminalSlice("skipped");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);
  const running = claimTaskAttempt({
    invocation: invocation("slice-reset/descendant-started"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch("T01"),
    retryOfAttemptId: String(row(`
      SELECT attempt_id FROM workflow_execution_attempts
      WHERE lifecycle_id = (
        SELECT lifecycle_id FROM workflow_item_lifecycles
        WHERE item_kind = 'task' AND milestone_id = 'M001'
          AND slice_id = 'S01' AND task_id = 'T01'
      )
      ORDER BY attempt_number DESC LIMIT 1
    `).attempt_id),
  });

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);

  assert.equal(notifications.at(-1)?.level, "error");
  assert.match(notifications.at(-1)?.message ?? "", /running attempt|not terminal/i);
  assert.equal(row(`
    SELECT attempt_state FROM workflow_execution_attempts WHERE attempt_id = '${running.attemptId}'
  `).attempt_state, "running");
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), 1, "descendant progress must prevent replaying the original reset operation");
});

test("a delayed reopen replay cannot delete projections from a newer Slice completion", async () => {
  const base = seedTerminalSlice("complete");
  const oldInvocation = invocation("slice-reopen/public/delayed-replay");
  const reason = "Redo the Slice before a newer completion.";
  const first = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason,
  }, base, oldInvocation);
  assert.equal("error" in first, false);

  executeAtFence("test.slice-reopen.newer-running", "fixture/slice-reopen/newer-running", (context) => {
    for (const taskId of ["T01", "T02"]) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId,
        lifecycleStatus: "in_progress",
      });
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "in_progress",
    });
  });
  executeAtFence("test.slice-reopen.newer-completion", "fixture/slice-reopen/newer-completion", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    db().prepare("UPDATE tasks SET status = 'complete' WHERE id = 'T01'").run();
    db().prepare("UPDATE tasks SET status = 'skipped' WHERE id = 'T02'").run();
    db().prepare("UPDATE slices SET status = 'complete' WHERE id = 'S01'").run();
  });
  const phaseDir = join(base, ".gsd", "phases", "01-test");
  const summaryPath = join(phaseDir, "S01-SUMMARY.md");
  const uatPath = join(phaseDir, "S01-UAT.md");
  writeFileSync(summaryPath, "# Newer summary\n");
  writeFileSync(uatPath, "# Newer UAT\n");

  const replay = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason,
  }, base, oldInvocation);

  assert.deepEqual(replay, { ...first, duplicate: true, superseded: true });
  assert.equal(readFileSync(summaryPath, "utf8"), "# Newer summary\n");
  assert.equal(readFileSync(uatPath, "utf8"), "# Newer UAT\n");
});

test("reopen cleanup cannot delete a Slice projection that becomes newer after its currentness check", async () => {
  const base = seedTerminalSlice("complete");
  const phaseDir = join(base, ".gsd", "phases", "01-test");
  const summaryPath = join(phaseDir, "S01-SUMMARY.md");
  const uatPath = join(phaseDir, "S01-UAT.md");
  const newerSummary = "# Completion committed during reopen cleanup\n";
  const newerUat = "# UAT committed during reopen cleanup\n";
  let interleaveCompleted = false;
  let interleaveError: unknown;
  writeFileSync(summaryPath, "# Older summary awaiting cleanup\n");
  writeFileSync(uatPath, "# Older UAT awaiting cleanup\n");

  _setReopenSliceCleanupInterleaveForTest(() => {
    try {
      executeAtFence("test.slice-reopen.cleanup-race-claim", "fixture/slice-reopen/cleanup-race-claim", (context) => {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T01",
          lifecycleStatus: "in_progress",
        });
      });
      executeAtFence("test.slice-reopen.cleanup-race", "fixture/slice-reopen/cleanup-race", (context) => {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T01",
          lifecycleStatus: "completed",
        });
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T02",
          lifecycleStatus: "cancelled",
        });
        adoptOrTransitionLifecycle(context, {
          itemKind: "slice",
          milestoneId: "M001",
          sliceId: "S01",
          lifecycleStatus: "completed",
        });
        db().prepare("UPDATE tasks SET status = 'complete' WHERE id = 'T01'").run();
        db().prepare("UPDATE tasks SET status = 'skipped' WHERE id = 'T02'").run();
        db().prepare(`
          UPDATE slices
          SET status = 'complete', full_summary_md = :summary, full_uat_md = :uat
          WHERE milestone_id = 'M001' AND id = 'S01'
        `).run({ ":summary": newerSummary, ":uat": newerUat });
      });
      const reopenOperationId = String(row(`
        SELECT operation_id FROM workflow_operations
        WHERE operation_type = 'slice.reopen'
      `).operation_id);
      assert.equal(sliceLifecycle.isCurrentSliceReopenOperation(reopenOperationId, {
        milestoneId: "M001",
        sliceId: "S01",
      }), false, "the competing completion must supersede the reopen before cleanup resumes");
      writeFileSync(summaryPath, newerSummary);
      writeFileSync(uatPath, newerUat);
      interleaveCompleted = true;
    } catch (error) {
      interleaveError = error;
      throw error;
    }
  });

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Exercise the cleanup delivery fence.",
  }, base, invocation("slice-reopen/public/cleanup-race"));

  assert.equal("error" in result, false);
  assert.ifError(interleaveError);
  assert.equal(interleaveCompleted, true, "the competing completion fixture must finish before cleanup resumes");
  assert.equal(existsSync(summaryPath), true, "cleanup must preserve the newer Slice summary");
  assert.equal(existsSync(uatPath), true, "cleanup must preserve the newer Slice UAT");
  assert.equal(readFileSync(summaryPath, "utf8"), newerSummary);
  assert.equal(readFileSync(uatPath, "utf8"), newerUat);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), 1);
  assert.equal(compatibilityEventCount(base, "reopen-slice"), 1);
});

test("a delayed reopen replay cannot delete a newer descendant Task summary", async () => {
  const base = seedTerminalSlice("complete");
  const oldInvocation = invocation("slice-reopen/public/task-only-replay");
  const reason = "Redo the Slice before newer Task work starts.";
  const first = await handleReopenSlice({ milestoneId: "M001", sliceId: "S01", reason }, base, oldInvocation);
  assert.equal("error" in first, false);

  executeAtFence("test.slice-reopen.newer-task", "fixture/slice-reopen/newer-task", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    db().prepare(`
      UPDATE tasks SET status = 'in_progress', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
  });
  const summaryPath = join(base, ".gsd", "phases", "01-test", "S01-T01-SUMMARY.md");
  writeFileSync(summaryPath, "# Newer Task summary\n");

  const replay = await handleReopenSlice({ milestoneId: "M001", sliceId: "S01", reason }, base, oldInvocation);

  assert.deepEqual(replay, { ...first, duplicate: true, superseded: true });
  assert.equal(readFileSync(summaryPath, "utf8"), "# Newer Task summary\n");
});

test("public reopen rejects a running descendant and leaves exact zero durable residue", async () => {
  const base = seedTerminalSlice("complete", { runningChild: true });
  const before = durableSnapshot();

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "A running child makes full redo unsafe.",
  }, base, invocation("slice-reopen/public/running-reject"));

  assert.equal("error" in result, true);
  assert.match("error" in result ? result.error : "", /running attempt|running descendant/i);
  assert.deepEqual(durableSnapshot(), before, "running-descendant rejection must leave zero residue");
});

test("public reopen rejects dependency-reachable downstream work without residue", async (t) => {
  for (const downstreamStatus of ["in_progress", "complete"] as const) {
    await t.test(downstreamStatus, async (t) => {
      const base = seedTerminalSlice("complete");
      cleanupFixture(t, base);
      seedReachableDownstreamSlice(downstreamStatus);
      const before = durableSnapshot();

      const result = await handleReopenSlice({
        milestoneId: "M001",
        sliceId: "S01",
        reason: "Downstream work must be reset explicitly before reopening its prerequisite.",
      }, base, invocation(`slice-reopen/public/downstream-${downstreamStatus}-reject`));

      assert.equal("error" in result, true);
      assert.match("error" in result ? result.error : "", /depend|downstream|S03/i);
      assert.deepEqual({
        durable: durableSnapshot(),
        compatibilityEvents: compatibilityEventCount(base, "reopen-slice"),
      }, {
        durable: before,
        compatibilityEvents: 0,
      }, "dependency rejection must leave exact zero durable or compatibility residue");
    });
  }
});

test("public reopen terminates on a cyclic dependency graph and rejects progressed downstream work", async (t) => {
  const base = seedTerminalSlice("complete");
  cleanupFixture(t, base);
  seedCyclicDownstreamSlice();
  const before = durableSnapshot();

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "A dependency cycle must terminate safely without ignoring progressed work.",
  }, base, invocation("slice-reopen/public/downstream-cycle-reject"));

  assert.equal("error" in result, true);
  assert.match("error" in result ? result.error : "", /depend|downstream|S02/i);
  assert.deepEqual(durableSnapshot(), before, "cyclic dependency rejection must leave zero durable residue");
});

test("public reopen rejects a deep legacy/canonical mismatch with exact zero durable residue", async () => {
  const base = seedTerminalSlice("complete");
  db().prepare(`
    UPDATE tasks SET status = 'pending', completed_at = NULL
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
  `).run();
  const before = durableSnapshot();

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Contradictory authority must not be repaired by guessing.",
  }, base, invocation("slice-reopen/public/mismatch-reject"));

  assert.equal("error" in result, true);
  assert.match("error" in result ? result.error : "", /canonical|legacy|shadow|mismatch/i);
  assert.deepEqual(durableSnapshot(), before, "deep mismatch rejection must leave zero residue");
});

test("direct Slice reopen replays its durable receipt and rejects changed idempotency reuse", () => {
  seedTerminalSlice("complete");
  const reopen = (sliceLifecycle as unknown as {
    reopenSlice?: (input: {
      invocation: ExecutionInvocation;
      slice: { milestoneId: string; sliceId: string };
      reason: string;
      audit?: { actorName?: string; triggerReason?: string };
    }) => Record<string, unknown>;
  }).reopenSlice;
  assert.equal(typeof reopen, "function", "Slice lifecycle module must expose the reopen Domain Operation");
  const input = {
    invocation: invocation("slice-reopen/direct/replay"),
    slice: { milestoneId: "M001", sliceId: "S01" },
    reason: "Repeat this exact full-redo request safely.",
    audit: { actorName: "reopen-test", triggerReason: "verified regression" },
  };

  const committed = reopen!(input);
  const afterCommit = durableSnapshot();
  const replayed = reopen!(input);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(durableSnapshot(), afterCommit, "exact replay must not duplicate durable lineage");
  const eventPayload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = '${String(committed.operationId)}' AND event_type = 'slice.reopened'
  `).payload_json)) as Record<string, unknown>;
  assert.deepEqual(eventPayload.audit, {
    actorName: "reopen-test",
    triggerReason: "verified regression",
  });

  assert.throws(() => reopen!({
    ...input,
    reason: "A changed reason under the same invocation identity.",
  }), /idempotency conflict/i);
  assert.throws(() => reopen!({
    ...input,
    audit: { ...input.audit, triggerReason: "changed audit provenance" },
  }), /idempotency conflict/i);
  assert.deepEqual(durableSnapshot(), afterCommit, "changed idempotency reuse must leave zero residue");
});
