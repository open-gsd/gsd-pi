// Project/App: gsd-pi
// File Purpose: Behavior proof for the automatic lifecycle backfill and Authority Epoch cutover on project database open.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { registerAutoWorker } from "../db/auto-workers.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { GSD_REVISION_CONFLICT } from "../errors.ts";
import {
  _getAdapter,
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { countUnadoptedHierarchyRows } from "../lifecycle-backfill-domain-operation.ts";
import { normalizeRealPath } from "../paths.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import { _resetLogs, peekLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";

const tempDirs = new Set<string>();
let stderrWasEnabled = true;

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const database = _getAdapter();
  assert.ok(database);
  return database;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT revision, authority_epoch FROM project_authority"),
    operations: rows("SELECT operation_id, operation_type FROM workflow_operations ORDER BY resulting_revision"),
    cutovers: rows("SELECT operation_id, resulting_authority_epoch FROM workflow_authority_cutovers"),
    lifecycles: rows("SELECT lifecycle_id, lifecycle_status FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    milestones: rows("SELECT id, status FROM milestones ORDER BY id"),
    slices: rows("SELECT milestone_id, id, status FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT milestone_id, slice_id, id, status FROM tasks ORDER BY milestone_id, slice_id, id"),
  };
}

function backupFiles(base: string): string[] {
  // Not the -wal/-shm sidecars that reading a backup leaves beside it.
  return readdirSync(join(base, ".gsd")).filter((name) => /^gsd\.db\.backup-v\d+(\.latest(-\d+)?)?$/.test(name));
}

function logged(severity: "warn" | "error"): string[] {
  return peekLogs().filter((entry) => entry.severity === severity).map((entry) => entry.message);
}

/** A project whose database this process created and left open: nothing is cut over yet. */
function createProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-cutover-on-open-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"));
  const created = openWorkflowDatabase(base);
  assert.equal(created.ok, true);
  assert.equal(created.reason, "created-empty");
  return base;
}

beforeEach(() => {
  stderrWasEnabled = setStderrLoggingEnabled(false);
  _resetLogs();
});

afterEach(() => {
  closeDatabase();
  setStderrLoggingEnabled(stderrWasEnabled);
  _resetLogs();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

test("the first open of an old project database backs it up, adopts every row and advances the Authority Epoch once", () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "complete" });
  insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending" });
  const before = durableSnapshot();
  assert.deepEqual(before.authority, [{ revision: 0, authority_epoch: 0 }], "the open that creates a database does not cut it over");
  assert.equal(countUnadoptedHierarchyRows(), 4);
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true);

  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{ revision: 2, authority_epoch: 1 }]);
  assert.deepEqual(
    rows("SELECT operation_type FROM workflow_operations ORDER BY resulting_revision").map((row) => row["operation_type"]),
    ["lifecycle.backfill", "authority.cutover"],
  );
  assert.equal(rows("SELECT 1 FROM workflow_authority_cutovers").length, 1);
  assert.equal(countUnadoptedHierarchyRows(), 0);
  // A legacy completion with no evidence is open work again, and the open says so.
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.match(logged("warn").join("\n"), /task M001\/S01\/T01 was legacy "complete" without completion evidence/);
  assert.deepEqual(logged("error"), []);

  // The verified backup holds the database as it was before the backfill.
  const backups = backupFiles(base);
  assert.equal(backups.length, 1);
  const backup = openSqliteReadOnly(join(base, ".gsd", backups[0]!)).db;
  const backupState = {
    quickCheck: backup.prepare("PRAGMA quick_check").get()?.["quick_check"],
    authority: backup.prepare("SELECT revision, authority_epoch FROM project_authority").all(),
    lifecycles: backup.prepare("SELECT COUNT(*) AS count FROM workflow_item_lifecycles").get()?.["count"],
    taskStatus: backup.prepare("SELECT status FROM tasks WHERE id = 'T01'").get()?.["status"],
  };
  backup.close();
  assert.deepEqual(backupState, {
    quickCheck: "ok",
    authority: [{ revision: 0, authority_epoch: 0 }],
    lifecycles: 0,
    taskStatus: "complete",
  });

  // A writer that still holds the pre-cutover epoch is refused.
  assert.throws(
    () => executeDomainOperation({
      operationType: "milestone.describe",
      idempotencyKey: "cutover-on-open/old-epoch-writer",
      expectedRevision: 2,
      expectedAuthorityEpoch: 0,
      actorType: "agent",
      sourceTransport: "internal",
      payload: {},
    }, () => ({ events: [], projections: [] })),
    (error: unknown) => (error as { code?: unknown }).code === GSD_REVISION_CONFLICT,
  );

  // The second open is a no-op.
  const afterCutover = durableSnapshot();
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(durableSnapshot(), afterCutover);
  assert.deepEqual(backupFiles(base), backups);
});

test("a row with an unmappable status stops the cutover loudly and changes nothing", async () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "wip-custom" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending" });
  const before = durableSnapshot();
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true, "the open itself still succeeds");

  assert.deepEqual(durableSnapshot(), before);
  assert.deepEqual(before.authority, [{ revision: 0, authority_epoch: 0 }]);
  assert.deepEqual(before.lifecycles, []);
  assert.deepEqual(backupFiles(base), []);
  const errors = logged("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Authority cutover stopped: 1 row\(s\)/);
  assert.match(errors[0]!, /Nothing was changed/);
  assert.match(errors[0]!, /slice M001\/S01: "wip-custom"/);

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, []);
  const unmappable = issues.filter((issue) => issue.code === "lifecycle_unmappable_status");
  assert.equal(unmappable.length, 1);
  assert.equal(unmappable[0]!.severity, "error");
  assert.match(unmappable[0]!.message, /slice M001\/S01="wip-custom"/);

  // Once the row is fixed, the next open adopts and cuts over.
  db().prepare("UPDATE slices SET status = 'pending' WHERE milestone_id = 'M001' AND id = 'S01'").run();
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT authority_epoch FROM project_authority"), [{ authority_epoch: 1 }]);
  assert.equal(countUnadoptedHierarchyRows(), 0);
});

test("active coordination defers the backfill and the cutover to a later open", () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const before = durableSnapshot();
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true);

  assert.deepEqual(durableSnapshot(), before);
  assert.deepEqual(backupFiles(base), []);
  assert.match(logged("warn").join("\n"), /Authority cutover deferred to a later open/);
  assert.deepEqual(logged("error"), []);
});
