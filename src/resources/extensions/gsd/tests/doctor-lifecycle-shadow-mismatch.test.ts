// Project/App: gsd-pi
// File Purpose: Doctor visibility for legacy/canonical lifecycle shadow drift (#2440).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import type { DomainJsonValue } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { reportMilestoneLifecycleShadowDrift } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { repairMilestoneShadowsForReopen } from "../lifecycle-shadow-repair-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function seedLifecycle(
  item: {
    itemKind: "milestone" | "slice" | "task";
    milestoneId: string;
    sliceId?: string;
    taskId?: string;
  },
  status: CanonicalLifecycleStatus,
  idempotencyKey: string,
): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  const payload: DomainJsonValue = {
    itemKind: item.itemKind,
    milestoneId: item.milestoneId,
    sliceId: item.sliceId ?? null,
    taskId: item.taskId ?? null,
    status,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.shadow-doctor.seed",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...item, lifecycleStatus: status });
    return {
      events: [{
        eventType: "test.shadow-doctor.seeded",
        entityType: item.itemKind,
        entityId: id,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: idempotencyKey.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function openDriftFixture(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-doctor-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  // #2440 drift shape: legacy hierarchy went terminal through the legacy path
  // while the canonical lifecycle rows stayed `ready`.
  db().exec(`
    INSERT INTO milestones (id, title, status, completed_at, created_at)
    VALUES ('M001', 'Drifted milestone', 'complete', '2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES (
      'M001', 'S01', 'Drifted slice', 'complete',
      '2026-07-04T00:00:00.000Z', '# S01 summary', 1, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Drifted task', 'complete',
      '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary', 1
    );
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "completed", "shadow-doctor/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "ready", "shadow-doctor/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "shadow-doctor/task",
  );
  t.after(closeDatabase);
}

test("doctor lists drifted hierarchy rows as lifecycle_shadow_mismatch", (t) => {
  openDriftFixture(t);

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);

  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.deepEqual(drifted.map((issue) => issue.unitId).sort(), ["M001/S01", "M001/S01/T01"]);
  const sliceIssue = drifted.find((issue) => issue.unitId === "M001/S01")!;
  assert.equal(sliceIssue.scope, "slice");
  assert.equal(sliceIssue.severity, "error");
  assert.ok(sliceIssue.message.includes('"complete"'), "message names the legacy status");
  assert.ok(sliceIssue.message.includes('"ready"'), "message names the canonical status");
  // The milestone itself has terminal parity — it must not be reported.
  assert.equal(drifted.find((issue) => issue.unitId === "M001"), undefined);
});

test("matched and semantic-match rows are not reported", (t) => {
  openDriftFixture(t);
  // Converge via the real reopen-scoped repair, exactly as the reopen path does.
  const repair = repairMilestoneShadowsForReopen({
    invocation: {
      idempotencyKey: "shadow-doctor/converge",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "shadow-doctor-test",
      traceId: "trace/shadow-doctor",
      turnId: "turn/shadow-doctor",
    },
    milestoneId: "M001",
  });
  assert.deepEqual(repair.unresolved, []);
  assert.ok(repair.repaired.length > 0);

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  assert.equal(issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch").length, 0);
});

test("a foreign-project-only lifecycle row is not reported as drift", (t) => {
  openDriftFixture(t);
  // A stale imported row from another project with no legacy hierarchy row of
  // its own must not surface as a local status_mismatch.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'decoy-foreign', 'decoy-project', 'slice', 'M001', 'S99', NULL,
      'completed', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      'decoy-op', 1, 0
    )
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.deepEqual(drifted.map((issue) => issue.unitId).sort(), ["M001/S01", "M001/S01/T01"]);
});

// ── #2778: canonical-ahead drift on claimed tasks ─────────────────────────
// Task claim transitions the canonical lifecycle to `in_progress` and writes
// nothing to legacy `tasks.status`, so every claimed-but-unclosed task reads
// legacy `pending` vs canonical `in_progress`.

function shadowInvocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "shadow-doctor-agent",
    traceId: `trace/${key}`,
    turnId: `turn/${key}`,
  };
}

function openClaimedTaskFixture(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-shadow-doctor-claim-")));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Canonical ahead', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Canonical ahead slice', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Claimed task', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '${dir.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
  `);
  t.after(closeDatabase);
  return dir;
}

function adoptTaskReady(taskId: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.shadow-doctor.ready",
    idempotencyKey: `shadow-doctor/${taskId}/ready`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.shadow-doctor.ready",
        entityType: "task",
        entityId: `M001/S01/${taskId}`,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `shadow-doctor/${taskId}/ready`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function insertClaimedDispatch(taskId: string, attemptNumber: number): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', :attempt_n, :started_at
    )
  `).run({
    ":trace_id": `shadow-doctor-trace-${taskId}-${attemptNumber}`,
    ":turn_id": `shadow-doctor-turn-${taskId}-${attemptNumber}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
    ":attempt_n": attemptNumber,
    ":started_at": `2026-07-13T02:00:0${attemptNumber}.000Z`,
  });
  const row = db().prepare("SELECT MAX(id) AS id FROM unit_dispatches").get() as Record<string, unknown>;
  return Number(row["id"]);
}

test("an in-flight claimed task (legacy pending, canonical in_progress) is not reported as drift", (t) => {
  openClaimedTaskFixture(t);
  adoptTaskReady("T01");
  const dispatchId = insertClaimedDispatch("T01", 1);
  claimTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  assert.equal(issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch").length, 0);
});

test("an unresumed agent-owned abort on a claimed task is a warning naming /gsd recover", (t) => {
  openClaimedTaskFixture(t);
  adoptTaskReady("T01");
  const dispatchId = insertClaimedDispatch("T01", 1);
  const claim = claimTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/claim-abort"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  const settlement = settleTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/settle-abort"),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: shadowInvocation("shadow-doctor/route-abort"),
    attemptId: claim.attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "verification-abort",
    evidence: { source: "test" },
    rationale: "abort",
  });
  assert.equal(abort.action, "abort");

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.unitId, "M001/S01/T01");
  assert.equal(drifted[0]!.severity, "warning");
  assert.ok(
    drifted[0]!.message.includes(`/gsd recover ${abort.recoveryActionId}`),
    "warning must name the gated /gsd recover path",
  );
  assert.match(drifted[0]!.message, /after.*repair/i);
  assert.match(drifted[0]!.message, /gsd_task_recovery_resume with concrete repair evidence/);
  assert.match(drifted[0]!.message, /rewriting plans.*does not authorize/i);
  assert.doesNotMatch(drifted[0]!.message, /to converge the drift/);
  assert.ok(drifted[0]!.message.includes('"pending"'), "message names the legacy status");
  assert.ok(drifted[0]!.message.includes('"in_progress"'), "message names the canonical status");
});

test("canonical-ahead drift with no attempt behind it stays an error", (t) => {
  openClaimedTaskFixture(t);
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "in_progress",
    "shadow-doctor/claim-no-attempt",
  );

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.unitId, "M001/S01/T01");
  assert.equal(drifted[0]!.severity, "error");
});

test("a settled attempt with an actionable route or verify head is a warning, not an error", (t) => {
  openClaimedTaskFixture(t);
  adoptTaskReady("T01");
  const dispatchId = insertClaimedDispatch("T01", 1);
  const claim = claimTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/claim-settled"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/settle-settled"),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.severity, "warning");
  assert.ok(
    drifted[0]!.message.includes("recovery route"),
    "warning must name the converging recovery-route step",
  );
});

test("a settled succeeded attempt awaiting verification publication is a warning", (t) => {
  openClaimedTaskFixture(t);
  adoptTaskReady("T01");
  const dispatchId = insertClaimedDispatch("T01", 1);
  const claim = claimTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/claim-verify"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/settle-verify"),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "attempt succeeded",
    output: {},
  });

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.severity, "warning");
  assert.ok(
    drifted[0]!.message.includes("verification publication"),
    "warning must name the converging verification step",
  );
});

test("an unrecognized legacy status is not suppressed by attempt evidence", (t) => {
  openClaimedTaskFixture(t);
  adoptTaskReady("T01");
  const dispatchId = insertClaimedDispatch("T01", 1);
  claimTaskAttempt({
    invocation: shadowInvocation("shadow-doctor/claim-unknown"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  db().prepare("UPDATE tasks SET status = 'mystery' WHERE id = 'T01'").run();

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.severity, "error");
});

test("a foreign project's attempt evidence does not suppress local canonical-ahead drift", (t) => {
  openClaimedTaskFixture(t);
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "in_progress",
    "shadow-doctor/claim-decoy-attempt",
  );
  // Same-identity foreign rows: a running attempt on a foreign project's
  // lifecycle must not read as local attempt evidence.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'decoy-lc', 'decoy-project', 'task', 'M001', 'S01', 'T01',
      'in_progress', 1, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z',
      'decoy-op', 1, 0
    )
  `).run();
  db().prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
      worker_id, milestone_lease_token, claimed_at, started_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES (
      'decoy-attempt', 'decoy-project', 'decoy-lc', 1, 'running',
      'worker-1', 7, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z',
      'decoy-op', 1, 0
    )
  `).run();
  db().prepare(`
    INSERT INTO workflow_kernel_checkpoints (
      kernel_checkpoint_id, project_id, lifecycle_id, attempt_id,
      next_stage, sequence, created_at, operation_id,
      project_revision, authority_epoch
    ) VALUES (
      'decoy-kc', 'decoy-project', 'decoy-lc', 'decoy-attempt',
      'execute', 1, '2026-07-13T00:00:00.000Z', 'decoy-op', 1, 0
    )
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.severity, "error");
});
