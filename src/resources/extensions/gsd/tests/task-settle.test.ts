// Project/App: gsd-pi
// File Purpose: Operator contract for gsd_task_settle — dry-run-first,
// idempotent, never-guessing Task Attempt settlement (#1749).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  claimTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  applyBlockerAcceptedDisposition,
  applyTaskSettle,
  planBlockerAcceptedDisposition,
  planTaskSettle,
} from "../task-settle.ts";
import { publishVerifiedTaskCompletion, resolveTaskCompletionAuthority } from "../task-completion-compatibility-adapter.ts";
import { isClosedStatus } from "../status-guards.ts";
import {
  normalizeLegacyLifecycleStatus,
  compareLifecycleShadow,
} from "../db/lifecycle-shadow-comparison.ts";
import { readTaskRecoveryRoute } from "../task-recovery-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "user",
    traceId: `trace:${key}`,
  };
}

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

function seedRunningAttempt(): { attemptId: string; dispatchId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-settle-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Settle', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Settle operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Settle atomically', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'dispatch-trace-1', 'dispatch-turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/task-ready",
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
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { attemptId: claim.attemptId, dispatchId, dir };
}

function orphanClaimedAttempt(dispatchId: number): void {
  // The executor died: its dispatch left ('claimed','running') but the
  // Attempt it claimed is still running (#1749's manual-repair state).
  db().prepare(`
    UPDATE unit_dispatches SET status = 'stuck', ended_at = '2026-07-13T00:10:00.000Z'
    WHERE id = :id
  `).run({ ":id": dispatchId });
}

test("dry-run prints the exact row and mutates nothing", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planTaskSettle(TASK, "operator repair after manual investigation");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].currentStatus, "running");
  assert.equal(plan.rows[0].targetStatus, "interrupted");
  assert.match(plan.rows[0].rationale, /operator repair/);
  assert.equal(plan.rows[0].leaseHeld, true);
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
    "dry-run must not settle the Attempt",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("apply settles the orphaned Attempt and a second apply is a no-op", async () => {
  const { attemptId, dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const applied = await applyTaskSettle({
    invocation: invocation("settle/apply/1"),
    task: TASK,
    reason: "operator repair after manual investigation",
    basePath: dir,
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, false);
  assert.equal(applied.rows[0].attemptId, attemptId);
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "interrupted");
  assert.equal(settled?.resultFailureClass, "operator-settle");
  assert.equal(
    row(`
      SELECT lifecycle_status AS status
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND task_id = 'T01'
    `).status,
    "in_progress",
    "settle without reconcileLifecycle must not adopt canonical status",
  );

  const again = await applyTaskSettle({
    invocation: invocation("settle/apply/2"),
    task: TASK,
    reason: "operator repair after manual investigation",
    basePath: dir,
  });
  assert.equal(again.settled, false);
  assert.equal(again.rows.length, 0, "a second apply reports nothing to do");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the idempotent re-apply writes no second Result",
  );
});

test("a typo'd task id errors without writes", async () => {
  seedRunningAttempt();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  assert.throws(
    () => planTaskSettle({ milestoneId: "M001", sliceId: "S01", taskId: "T99" }, "typo"),
    /unknown Task M001\/S01\/T99/,
  );
  await assert.rejects(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/typo"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T99" },
      reason: "typo",
      basePath: process.cwd(),
    }),
    /unknown Task M001\/S01\/T99/,
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "a typo'd identifier must not write",
  );
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
  );
});

test("apply reclaims an expired lease and interrupts its orphaned Attempt (#1907)", async () => {
  const { attemptId, dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec(`
    UPDATE milestone_leases
    SET status = 'held', expires_at = '2000-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /orphaned.*apply will reclaim/i);
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK, "completion/orphaned"),
    /orphaned running Attempt.*gsd_task_settle.*reclaimable.*\/gsd auto/s,
  );

  const applied = await applyTaskSettle({
    invocation: invocation("settle/apply/released"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
  });
  assert.equal(applied.settled, true);
  assert.equal(readTaskAttempt(attemptId)?.state, "settled");
  assert.deepEqual(
    row(`
      SELECT recovery_worker_id AS worker, recovery_milestone_lease_token AS token
      FROM workflow_execution_attempts WHERE attempt_id = '${attemptId}'
    `),
    { worker: "worker-1", token: 8 },
  );
  assert.equal(row("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").status, "released");
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK, "completion/no-running"),
    /no running Attempt.*\/gsd auto/s,
  );
});

test("apply reclaims a released lease and interrupts its orphaned Attempt (#1907)", async () => {
  const { attemptId, dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /orphaned.*apply will reclaim/i);

  const applied = await applyTaskSettle({
    invocation: invocation("settle/apply/released"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
  });
  assert.equal(applied.settled, true);
  assert.equal(readTaskAttempt(attemptId)?.state, "settled");
  assert.equal(row("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").status, "released");
});

test("apply refuses an expired lease while its original worker is live (#1907)", async () => {
  const { attemptId, dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().prepare(`
    UPDATE workers
    SET host = :host, pid = :pid, last_heartbeat_at = :heartbeat
    WHERE worker_id = 'worker-1'
  `).run({
    ":host": hostname(),
    ":pid": process.pid,
    ":heartbeat": new Date().toISOString(),
  });
  db().exec(`
    UPDATE milestone_leases
    SET status = 'held', expires_at = '2000-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /apply will refuse/i);
  await assert.rejects(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/live-owner"),
      task: TASK,
      reason: "operator repair",
      basePath: dir,
    }),
    /live worker or replacement lease.*\/gsd auto/s,
  );
  assert.equal(readTaskAttempt(attemptId)?.state, "running");
});

test("apply refuses to steal a live replacement lease (#1907)", async () => {
  const { attemptId, dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-2', 'test-host', 2, '2026-07-13T00:05:00.000Z', 'test',
      '2099-07-13T00:05:00.000Z', 'active', '/tmp/project'
    );
    UPDATE milestone_leases
    SET worker_id = 'worker-2', fencing_token = 8, status = 'held',
        expires_at = '2099-07-13T00:06:00.000Z'
    WHERE milestone_id = 'M001';
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /apply will refuse/i);

  await assert.rejects(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/live-replacement"),
      task: TASK,
      reason: "operator repair",
      basePath: dir,
    }),
    /live worker or replacement lease.*\/gsd auto/s,
  );
  assert.equal(
    readTaskAttempt(attemptId)?.state,
    "running",
    "the live peer's Attempt remains untouched",
  );
});

function taskLifecycleStatus(): string {
  return String(row(`
    SELECT lifecycle_status AS status
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T01'
  `).status);
}

function restoreSummary(dir: string, body: string, status: "pending" | "complete"): string {
  const summaryPath = join(dir, "T01-SUMMARY.md");
  writeFileSync(summaryPath, body);
  db().prepare(`
    UPDATE tasks SET status = :status, full_summary_md = :body
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({ ":status": status, ":body": body });
  return summaryPath;
}

test("reconcileLifecycle adopts ready for pending after interrupt without deleting SUMMARYs", async () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const dryRun = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(dryRun.rows.length, 1);
  assert.deepEqual(
    dryRun.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );
  assert.equal(taskLifecycleStatus(), "in_progress", "dry-run must not adopt lifecycle");

  const settled = await applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/settle"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
  });
  assert.equal(settled.settled, true);
  const summaryPath = restoreSummary(dir, "# Pending repair SUMMARY", "pending");

  const planned = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(planned.rows.length, 0);
  assert.deepEqual(
    planned.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );

  const applied = await applyTaskSettle({
    invocation: invocation("settle/reconcile/pending"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, true);
  assert.equal(taskLifecycleStatus(), "ready");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "pending");
  assert.equal(row("SELECT full_summary_md AS body FROM tasks WHERE id = 'T01'").body, "# Pending repair SUMMARY");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Pending repair SUMMARY");

  const again = await applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/2"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
    reconcileLifecycle: true,
  });
  assert.equal(again.settled, false);
  assert.equal(again.reconciled, false);
  assert.equal(taskLifecycleStatus(), "ready");
});

test("reconcileLifecycle adopts completed for complete after interrupt without deleting SUMMARYs", async () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const summaryPath = restoreSummary(dir, "# Completed repair SUMMARY", "complete");

  const applied = await applyTaskSettle({
    invocation: invocation("settle/reconcile/complete"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, true);
  assert.deepEqual(
    applied.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->completed"],
  );
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Completed repair SUMMARY");
  assert.equal(applied.proof?.attemptId ?? null, null);
  assert.match(
    applied.proof?.note ?? "",
    /no current passing Technical Verdict/,
  );
});

test("reconcileLifecycle adopts completed after an out-of-band succeeded Attempt (#2018)", async () => {
  const { attemptId, dir } = seedRunningAttempt();
  settleTaskAttempt({
    invocation: invocation("fixture/succeed"),
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor completed out of band",
    output: { completed: true },
  });
  assert.equal(readTaskAttempt(attemptId)?.outcome, "succeeded");
  assert.equal(taskLifecycleStatus(), "in_progress");

  // #2417: a succeeded verify-stage Attempt over a legacy pending Task is not
  // a reconcile case — planTaskSettle routes it to the publication pipeline
  // instead of ever adopting ready (#2018's invariant is preserved: no
  // lifecycleRows, so no ready-adopt).
  const stranded = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(stranded.rows.length, 0);
  assert.equal(stranded.lifecycleRows.length, 0);
  assert.equal(stranded.publication?.attemptId, attemptId);
  assert.equal(stranded.publication?.verdict ?? null, null);

  const summaryPath = restoreSummary(dir, "# Out-of-band completion SUMMARY", "complete");
  const planned = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(planned.rows.length, 0);
  assert.deepEqual(
    planned.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->completed"],
  );

  const applied = await applyTaskSettle({
    invocation: invocation("settle/reconcile/succeeded"),
    task: TASK,
    reason: "operator repair",
    basePath: dir,
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, true);
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Out-of-band completion SUMMARY");
});

test("reconcileLifecycle reports when completed repair still lacks passing proof (#1749)", () => {
  const { dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().prepare(`
    UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  const plan = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(plan.proof?.attemptId ?? null, null);
  assert.match(
    plan.proof?.note ?? "",
    /gsd_slice_complete will still refuse/,
  );
});

// ── stranded durable success → publication door (#2417) ─────────────────────

function seedPublicationProjectionArtifacts(dir: string): void {
  const phaseDir = join(dir, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Settle operation",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Settle atomically** `est:30m`",
    "  - Do: recover the stranded completion",
    "  - Verify: node --test",
    "",
  ].join("\n"));
  db().prepare(`
    UPDATE tasks SET full_summary_md = '# Stranded completion SUMMARY'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
}

function gitCommitFixture(dir: string): void {
  // The fixture DB lives at <dir>/gsd.db — untracked and inside the
  // verification-source hash, so every DB write (including the -wal/-shm
  // sidecars) would invalidate a just-recorded verdict. Ignore all of them,
  // mirroring the production .gsd/ exclusion.
  writeFileSync(join(dir, ".gitignore"), "gsd.db*\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "verified\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
}

function recordPassingVerdict(dir: string, attemptId: string): void {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: dir }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: invocation(`fixture/verdict:${attemptId}`),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Host verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: dir,
      startedAt: "2026-07-13T00:02:00.000Z",
      endedAt: "2026-07-13T00:02:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function revertLifecycleToReadyFixture(): void {
  // The #2417 wedge: in_progress → ready is not a canonical transition, so
  // the side-door shadow cannot exist on a single legal edge. Build it the
  // way real databases reached it — a sequence of fenced lifecycle writes
  // (in_progress → paused → ready), each satisfying the transition trigger.
  for (const status of ["paused", "ready"] as const) {
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "test.task.side-door-revert",
      idempotencyKey: `fixture/2417-revert-${status}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { taskId: "T01", to: status },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: status,
      });
      return {
        events: [{
          eventType: "test.task.side-door-revert",
          entityType: "task",
          entityId: "M001/S01/T01",
          payload: { to: status },
          destinations: ["test"],
        }],
        projections: [{
          projectionKey: "test/m001/s01/t01",
          projectionKind: "test",
          rendererVersion: "1",
        }],
      };
    });
  }
}

function seedStrandedSuccess(
  options: { revertLifecycleToReady?: boolean } = {},
): { attemptId: string; dir: string } {
  const { attemptId, dir } = seedRunningAttempt();
  settleTaskAttempt({
    invocation: invocation("fixture/stranded-succeed"),
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor produced the verified result",
    output: { completed: true },
  });
  if (options.revertLifecycleToReady) {
    revertLifecycleToReadyFixture();
  }
  seedPublicationProjectionArtifacts(dir);
  return { attemptId, dir };
}

test("publication door: dry run reports the stranded success and mutates nothing", () => {
  const { attemptId } = seedStrandedSuccess({ revertLifecycleToReady: true });

  const plan = planTaskSettle(TASK, "publish the stranded durable success");
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.lifecycleRows.length, 0, "a stranded success is not a reconcile case");
  assert.equal(plan.publication?.attemptId, attemptId);
  assert.equal(plan.publication?.lifecycleStatus, "ready");
  assert.equal(plan.publication?.legacyStatus, "pending");
  assert.equal(plan.publication?.verdict ?? null, null);
  assert.match(plan.publication?.rationale ?? "", /verify stage/);
  assert.equal(
    taskLifecycleStatus(),
    "ready",
    "dry-run must not move the lifecycle",
  );
  assert.equal(row("SELECT status AS status FROM tasks WHERE id = 'T01'").status, "pending");
});

test("publication door: apply fails closed without a passing host Technical Verdict", async () => {
  const { dir } = seedStrandedSuccess({ revertLifecycleToReady: true });
  gitCommitFixture(dir);

  await assert.rejects(
    () => applyTaskSettle({
      invocation: invocation("settle/publish/no-verdict"),
      task: TASK,
      reason: "publish the stranded durable success",
      basePath: dir,
    }),
    /passing host Technical Verdict/,
  );
  assert.equal(taskLifecycleStatus(), "ready", "a refused publication must not move the lifecycle");
  assert.equal(row("SELECT status AS status FROM tasks WHERE id = 'T01'").status, "pending");
});

test("publication door: apply publishes the stranded success from a reverted ready shadow (#2417)", async () => {
  const { attemptId, dir } = seedStrandedSuccess({ revertLifecycleToReady: true });
  gitCommitFixture(dir);
  recordPassingVerdict(dir, attemptId);

  const applied = await applyTaskSettle({
    invocation: invocation("settle/publish/ready"),
    task: TASK,
    reason: "publish the stranded durable success",
    basePath: dir,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, false);
  assert.equal(applied.published?.attemptId, attemptId);
  assert.equal(applied.published?.status, "committed");
  assert.equal(taskLifecycleStatus(), "completed", "publication re-adopts the reverted shadow to completed");
  assert.equal(row("SELECT status AS status FROM tasks WHERE id = 'T01'").status, "complete");

  const replay = await publishVerifiedTaskCompletion({
    invocation: internalExecutionInvocation(`internal:auto:task.publish:${attemptId}`),
    basePath: dir,
    task: TASK,
    attemptId,
  });
  assert.equal(replay.status, "replayed", "auto publication reuses the manual settlement operation");

  const again = planTaskSettle(TASK, "operator repair");
  assert.equal(again.rows.length, 0);
  assert.equal(again.publication ?? null, null, "a terminal Task is no publication candidate");
});

test("publication door: covers the in_progress lifecycle a loop crash leaves behind", async () => {
  const { attemptId, dir } = seedStrandedSuccess();
  gitCommitFixture(dir);
  recordPassingVerdict(dir, attemptId);

  const applied = await applyTaskSettle({
    invocation: invocation("settle/publish/in-progress"),
    task: TASK,
    reason: "publish after the loop died between settlement and publication",
    basePath: dir,
  });
  assert.equal(applied.published?.attemptId, attemptId);
  assert.equal(applied.published?.status, "committed");
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(row("SELECT status AS status FROM tasks WHERE id = 'T01'").status, "complete");
});

// ── blocker-accepted closeout disposition (#2202) ───────────────────────────

function seedBlockerDiscoveredResidue(): { attemptId: string; resultId: string } {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/blocker-settle"),
    attemptId,
    outcome: "failed",
    failureClass: "blocker-discovered",
    summary: "API contract invalidates the slice plan; no SUMMARY produced",
    output: { blocker: "plan-invalidating" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  return { attemptId, resultId: settlement.resultId };
}

test("blocker-accepted dry-run reports the exact transitions and mutates nothing", () => {
  const { attemptId, resultId } = seedBlockerDiscoveredResidue();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planBlockerAcceptedDisposition(TASK, "accept the discovered plan blocker");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.alreadyAccepted, false);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].resultId, resultId);
  assert.equal(plan.rows[0].currentStatus, "in_progress");
  assert.equal(plan.rows[0].targetStatus, "blocker-accepted");
  assert.equal(plan.rows[0].lifecycleFrom, "in_progress");
  assert.equal(plan.rows[0].routeConsumed, true);
  assert.match(plan.rows[0].blockerSummary, /plan blocker|API contract/);
  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "in_progress",
    "dry-run must not move the canonical lifecycle",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "dry-run must not close the legacy Task",
  );
  assert.equal(
    readTaskRecoveryRoute(attemptId),
    null,
    "dry-run must not consume the route head",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("blocker-accepted apply closes both vocabularies, records provenance, consumes the route head, and is idempotent", () => {
  const { attemptId, resultId } = seedBlockerDiscoveredResidue();

  const applied = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/1"),
    task: TASK,
    reason: "accept the discovered plan blocker",
  });
  assert.equal(applied.accepted, true);
  assert.equal(applied.alreadyAccepted, false);
  assert.equal(applied.attemptId, attemptId);
  assert.equal(applied.resultId, resultId);
  assert.equal(applied.routeConsumed, true);

  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "blocker-accepted",
    "canonical lifecycle must move to terminal blocker-accepted",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "blocker-accepted",
    "the replan gate reads legacy tasks.status",
  );
  assert.equal(isClosedStatus("blocker-accepted"), true);
  assert.equal(normalizeLegacyLifecycleStatus("blocker-accepted"), "blocker-accepted");
  assert.equal(
    compareLifecycleShadow("blocker-accepted", "blocker-accepted").kind,
    "match",
    "both vocabularies must agree so closeout reads no shadow drift",
  );
  assert.equal(readLatestTaskAttemptSnapshotStage(), "closeout", "the route head must be consumed");

  const provenance = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'task.blocker.accepted'
  `);
  assert.ok(provenance.payload_json, "the disposition must record its provenance event");
  const payload = JSON.parse(String(provenance.payload_json)) as Record<string, unknown>;
  assert.equal(payload["disposition"], "blocker-accepted");
  assert.equal(payload["attemptId"], attemptId);
  assert.equal(payload["resultId"], resultId);
  assert.equal(payload["rationale"], "accept the discovered plan blocker");
  assert.equal(
    payload["blockerSummary"],
    "API contract invalidates the slice plan; no SUMMARY produced",
  );

  // The failed Attempt/Result remain immutable history.
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "failed");
  assert.equal(settled?.resultId, resultId);
  assert.equal(settled?.resultFailureClass, "blocker-discovered");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the disposition must not fabricate a second Result",
  );

  const again = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/2"),
    task: TASK,
    reason: "accept the discovered plan blocker",
  });
  assert.equal(again.accepted, false);
  assert.equal(again.alreadyAccepted, true);
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'task.blocker.accepted'").count,
    1,
    "a repeated applied run is a no-op",
  );
});

test("blocker-accepted refuses a running Attempt with the exact prerequisite", () => {
  seedRunningAttempt();
  assert.throws(
    () => planBlockerAcceptedDisposition(TASK, "accept"),
    /blocker-accepted requires no running Attempt.*settle the running Attempt first \(gsd_task_settle without settleDisposition\)/s,
  );
});

test("blocker-accepted refuses when the latest Attempt is not a discovered blocker at route", () => {
  const { attemptId } = seedRunningAttempt();
  settleTaskAttempt({
    invocation: invocation("fixture/plain-failure"),
    attemptId,
    outcome: "failed",
    failureClass: "executor-error",
    summary: "plain executor failure",
    output: {},
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  assert.throws(
    () => planBlockerAcceptedDisposition(TASK, "accept"),
    /failed\/blocker-discovered at the route stage.*Repair-and-retry is the separate successor-Attempt path \(gsd_task_recovery_resume\)/s,
  );
});

test("blocker-accepted preserves a completed sibling Task and refuses after other closure", () => {
  seedBlockerDiscoveredResidue();
  db().exec(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T02', 'Completed sibling', 'complete');
  `);

  const applied = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/sibling"),
    task: TASK,
    reason: "accept",
  });
  assert.equal(applied.accepted, true);
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T02'").status,
    "complete",
    "completed sibling tasks remain intact",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "blocker-accepted",
  );

  // A task closed some other way is not a disposition candidate.
  const other = { milestoneId: "M001", sliceId: "S01", taskId: "T02" };
  assert.throws(
    () => applyBlockerAcceptedDisposition({
      invocation: invocation("blocker-accepted/apply/wrong-lifecycle"),
      task: other,
      reason: "accept",
    }),
    /blocker-accepted requires the Task lifecycle in_progress; found none/,
  );
});

function readLatestTaskAttemptSnapshotStage(): string | null {
  const head = row(`
    SELECT head.next_stage AS stage
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = head.lifecycle_id
    WHERE lifecycle.task_id = 'T01'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `);
  return head.stage ? String(head.stage) : null;
}
