// Project/App: gsd-pi
// File Purpose: Doctor surfaces held, non-expired milestone leases whose
// holder worker's local process is verifiably dead (#2375). Report only —
// re-running gsd_plan_milestone reclaims the lease via the dead-holder
// reclaim path.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

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

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-doctor-orphan-lease-"));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  return dir;
}

function seedHeldLease(input: {
  basePath: string;
  milestoneId: string;
  workerId: string;
  pid: number;
  host: string;
  status?: string;
  expiresAt?: string;
}): void {
  db().prepare(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES (?, 'Doctor', 'active', '2026-07-13T00:00:00.000Z')
  `).run(input.milestoneId);
  db().prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (?, ?, ?, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', ?, ?)
  `).run(input.workerId, input.host, input.pid, input.status ?? "active", input.basePath);
  db().prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (?, ?, 7, '2026-07-13T00:00:00.000Z', ?, 'held')
  `).run(input.milestoneId, input.workerId, input.expiresAt ?? "2099-07-13T00:00:00.000Z");
}

test("doctor flags a held lease whose local holder process is dead (#2375)", async () => {
  const basePath = makeBase();
  seedHeldLease({ basePath, milestoneId: "M001", workerId: "worker-dead", pid: -1, host: hostname() });

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  const orphan = issues.find((issue) => issue.code === "orphaned_milestone_lease");
  assert.ok(orphan, "doctor must detect the dead holder's held lease");
  assert.equal(orphan!.severity, "error");
  assert.equal(orphan!.scope, "milestone");
  assert.equal(orphan!.unitId, "M001");
  assert.match(orphan!.message, new RegExp("worker-dead"));
  assert.match(orphan!.message, /gsd_plan_milestone/);
  assert.equal(orphan!.fixable, false, "doctor --fix must not reclaim leases on its own");
});

test("doctor does not flag a held lease whose holder process is alive", async () => {
  const basePath = makeBase();
  seedHeldLease({ basePath, milestoneId: "M001", workerId: "worker-live", pid: process.pid, host: hostname() });

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "orphaned_milestone_lease"),
    false,
    "a live holder's held lease must not be flagged",
  );
});

test("doctor flags a held lease held by a dead stopping worker (#2375)", async () => {
  const basePath = makeBase();
  seedHeldLease({
    basePath,
    milestoneId: "M001",
    workerId: "worker-stopping",
    pid: -1,
    host: hostname(),
    status: "stopping",
  });

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  const orphan = issues.find((issue) => issue.code === "orphaned_milestone_lease");
  assert.ok(orphan, "a dead stopping holder must be flagged — re-running planning reclaims it");
  assert.equal(orphan!.unitId, "M001");
  assert.match(orphan!.message, new RegExp("worker-stopping"));
});

test("doctor flags a held lease held by a dead crashed worker (#2375)", async () => {
  const basePath = makeBase();
  seedHeldLease({
    basePath,
    milestoneId: "M001",
    workerId: "worker-crashed",
    pid: -1,
    host: hostname(),
    status: "crashed",
  });

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  const orphan = issues.find((issue) => issue.code === "orphaned_milestone_lease");
  assert.ok(orphan, "a dead crashed holder must be flagged — re-running planning reclaims it");
  assert.equal(orphan!.unitId, "M001");
  assert.match(orphan!.message, new RegExp("worker-crashed"));
});

test("doctor does not flag an expired held lease even when the holder is dead", async () => {
  const basePath = makeBase();
  seedHeldLease({
    basePath,
    milestoneId: "M001",
    workerId: "worker-dead",
    pid: -1,
    host: hostname(),
    expiresAt: "2020-07-13T00:00:00.000Z",
  });

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "orphaned_milestone_lease"),
    false,
    "an expired lease is reclaimable by normal takeover and must not be flagged",
  );
});
