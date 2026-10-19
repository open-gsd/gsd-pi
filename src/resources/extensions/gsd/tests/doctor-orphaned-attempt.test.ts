// Project/App: gsd-pi
// File Purpose: Doctor surfaces orphaned running Task Attempts and settles
// them under --fix through the gsd_task_settle writer (#2889); without --fix
// it reports the orphan and names both remedies (#1749).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
import { resolveMilestoneFile } from "../paths.ts";
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

function seedRunningAttempt(options?: { liveWorker?: boolean }): { basePath: string; attemptId: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-doctor-orphan-attempt-"));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  // A live worker keeps a fresh heartbeat, its own OS process, and the
  // project's realpath; the default fixture is a dead 2026-07 worker.
  const heartbeatAt = options?.liveWorker
    ? new Date(Date.now() - 1_000).toISOString()
    : "2026-07-13T00:00:00.000Z";
  const workerPid = options?.liveWorker ? process.pid : 1;
  const workerRoot = options?.liveWorker ? realpathSync(dir) : "/tmp/project";
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
      'worker-1', '${options?.liveWorker ? hostname() : "test-host"}', ${workerPid},
      '2026-07-13T00:00:00.000Z', 'test',
      '${heartbeatAt}', 'active', '${workerRoot.replaceAll("'", "''")}'
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

function readAttemptState(attemptId: string): { state: string; outcome: string | null } {
  return db().prepare(`
    SELECT attempt.attempt_state AS state, result.outcome AS outcome
    FROM workflow_execution_attempts attempt
    LEFT JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
    WHERE attempt.attempt_id = :id
  `).get({ ":id": attemptId }) as { state: string; outcome: string | null };
}

test("doctor detects an orphaned running Attempt and names both remedies", async () => {
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
  assert.match(orphan.message, /--fix/);
  assert.equal(orphan.fixable, true, "doctor --fix settles the orphan (#2889)");
  assert.equal(readAttemptState(attemptId).state, "running", "detection alone must not settle");
});

test("doctor --fix settles the orphaned Attempt as interrupted", async () => {
  const { basePath, attemptId } = seedRunningAttempt();
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(basePath, issues, fixes, { repair: true });

  const settled = readAttemptState(attemptId);
  assert.equal(settled.state, "settled", "repair mode must settle the orphaned Attempt");
  assert.equal(settled.outcome, "interrupted");
  assert.equal(
    issues.some((issue) => issue.code === "orphaned_running_attempt"),
    false,
    "a settled orphan is no longer an issue",
  );
  assert.ok(
    fixes.some((entry) => entry.includes(attemptId) && entry.includes("interrupted")),
    `fixesApplied must record the settle; got ${JSON.stringify(fixes)}`,
  );
  // The dead worker's lease is reclaimed only for the settle, then released.
  const lease = db().prepare(
    "SELECT status FROM milestone_leases WHERE milestone_id = 'M001'",
  ).get() as { status: string };
  assert.equal(lease.status, "released", "the recovery lease must be released after the settle");
  // Repair also renders the missing M001 ROADMAP through Projection Work.
  const roadmapPath = resolveMilestoneFile(basePath, "M001", "ROADMAP");
  assert.ok(roadmapPath && existsSync(roadmapPath), "the reported re-render wrote the ROADMAP");
});

test("doctor --fix refuses to settle while the Attempt's worker is still live", async () => {
  const { basePath, attemptId } = seedRunningAttempt({ liveWorker: true });
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(basePath, issues, fixes, { repair: true });

  const orphan = issues.find((issue) => issue.code === "orphaned_running_attempt");
  assert.ok(orphan, "a refused settle must keep the issue visible");
  assert.match(orphan.message, /Automatic settle refused/);
  assert.match(orphan.message, /live worker/);
  assert.equal(readAttemptState(attemptId).state, "running", "a live worker's Attempt is untouched");
  assert.equal(
    fixes.some((entry) => entry.includes(attemptId)),
    false,
    "a refused settle must not be reported as applied",
  );
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
