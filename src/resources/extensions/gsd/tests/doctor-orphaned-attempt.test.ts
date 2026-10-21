// Project/App: gsd-pi
// File Purpose: Doctor surfaces orphaned running Task Attempts and names
// gsd_task_settle as the repair; --fix never settles on its own (#1749).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { claimTaskAttempt } from "../task-execution-domain-operation.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
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

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "test",
    traceId: `trace:${key}`,
  };
}

function seedRunningAttempt(): { basePath: string; attemptId: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-doctor-orphan-attempt-"));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Doctor', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Orphan detection', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Detect orphans', 'pending');
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
  const dispatchId = Number(
    (db().prepare("SELECT id FROM unit_dispatches").get() as { id: number }).id,
  );
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { basePath: dir, attemptId: claim.attemptId };
}

test("doctor detects an orphaned running Attempt and names gsd_task_settle", async () => {
  const { basePath, attemptId } = seedRunningAttempt();
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  const orphan = issues.find((issue) => issue.code === "orphaned_running_attempt");
  assert.ok(orphan, "doctor must detect the orphaned running Attempt");
  assert.equal(orphan.severity, "error");
  assert.equal(orphan.unitId, "M001/S01/T01");
  assert.match(orphan.message, new RegExp(attemptId));
  assert.match(orphan.message, /gsd_task_settle/);
  assert.equal(orphan.fixable, false, "doctor --fix must never auto-settle (#1749)");
});

test("doctor --fix reports but does not settle the orphaned Attempt", async () => {
  const { basePath, attemptId } = seedRunningAttempt();
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(basePath, issues, fixes, { repair: true });

  assert.ok(issues.some((issue) => issue.code === "orphaned_running_attempt"));
  assert.equal(fixes.length, 0);
  const state = db().prepare(
    "SELECT attempt_state AS state FROM workflow_execution_attempts WHERE attempt_id = :id",
  ).get({ ":id": attemptId }) as { state: string };
  assert.equal(state.state, "running", "repair mode must not settle the Attempt");
});

test("a running Attempt with a held lease is not flagged", async () => {
  const { basePath } = seedRunningAttempt();

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "orphaned_running_attempt"),
    false,
    "live Attempts must not be flagged",
  );
});
