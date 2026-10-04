// Project/App: gsd-pi
// File Purpose: Behavior proof for the automatic lifecycle backfill and Authority Epoch cutover on project database open.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { registerAutoWorker } from "../db/auto-workers.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
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
import { applyLifecycleBackfill, countUnadoptedHierarchyRows } from "../lifecycle-backfill-domain-operation.ts";
import { registerMilestones } from "../milestone-registration.ts";
import { normalizeRealPath } from "../paths.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import { _resetLogs, peekLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";
import { setAuthorityCutoverFlag } from "./helpers/authority-cutover-flag.ts";

const CHILD_PATH = fileURLToPath(new URL("./authority-cutover-on-open-child.ts", import.meta.url));
const RESOLVER_PATH = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const tempDirs = new Set<string>();
let stderrWasEnabled = true;
let restoreCutoverFlag = (): void => {};

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

interface ChildOpen {
  ok: boolean;
  logs: Array<{ severity: string; message: string }>;
}

/** A second process that has loaded the engine and opens the project when open() is called. */
async function spawnOpener(base: string): Promise<{ open(): Promise<ChildOpen> }> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--import", RESOLVER_PATH, "--experimental-strip-types", CHILD_PATH, base],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const closed = once(child, "close");
  await Promise.race([
    once(child.stdout, "data"),
    closed.then(() => Promise.reject(new Error("the child exited before it was ready"))),
  ]);
  return {
    open: async () => {
      child.stdin.end("open");
      await closed;
      return JSON.parse(stdout.slice(stdout.indexOf("\n"))) as ChildOpen;
    },
  };
}

beforeEach(() => {
  restoreCutoverFlag = setAuthorityCutoverFlag("1");
  stderrWasEnabled = setStderrLoggingEnabled(false);
  _resetLogs();
});

afterEach(() => {
  restoreCutoverFlag();
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
  db().exec(`
    UPDATE tasks SET completed_at = '2026-01-01T00:00:00.000Z', full_summary_md = 'Done.', verification_result = 'passed'
    WHERE id = 'T01'
  `);
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
  // A legacy completion with evidence stays completed.
  assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
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

test("without GSD_AUTHORITY_CUTOVER the open of an old project database changes nothing", () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending" });
  const before = durableSnapshot();
  assert.deepEqual(before.authority, [{ revision: 0, authority_epoch: 0 }]);
  assert.deepEqual(before.lifecycles, []);

  // Unset is the default. Any value other than 1 is also off.
  for (const value of [undefined, "0", "true"]) {
    setAuthorityCutoverFlag(value);
    closeDatabase();
    assert.equal(openWorkflowDatabase(base).ok, true);

    assert.deepEqual(durableSnapshot(), before);
    assert.deepEqual(backupFiles(base), []);
    assert.deepEqual(peekLogs(), []);
  }

  // The same database is cut over by the next open once the flag is on.
  setAuthorityCutoverFlag("1");
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{ revision: 2, authority_epoch: 1 }]);
  assert.equal(backupFiles(base).length, 1);
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
  assert.match(unmappable[0]!.message, /then run \/gsd db adopt\./);

  // Once the row is fixed, the next open adopts and cuts over.
  db().prepare("UPDATE slices SET status = 'pending' WHERE milestone_id = 'M001' AND id = 'S01'").run();
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT authority_epoch FROM project_authority"), [{ authority_epoch: 1 }]);
  assert.equal(countUnadoptedHierarchyRows(), 0);
});

test("a legacy completion with no evidence stops the cutover loudly and changes nothing", async () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Shipped", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "complete" });
  const before = durableSnapshot();
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true, "the open itself still succeeds");

  assert.deepEqual(durableSnapshot(), before, "shipped work is not reopened");
  assert.deepEqual(before.authority, [{ revision: 0, authority_epoch: 0 }]);
  assert.deepEqual(before.lifecycles, []);
  assert.deepEqual(backupFiles(base), []);
  const errors = logged("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Authority cutover stopped: the lifecycle backfill would change the status of 3 row\(s\)/);
  assert.match(errors[0]!, /Nothing was changed/);
  assert.match(errors[0]!, /\/gsd db adopt --apply/);
  assert.match(errors[0]!, /milestone M001: "complete" -> "active" \(legacy-complete-unproven\)/);
  assert.match(errors[0]!, /task M001\/S01\/T01: "complete" -> "pending" \(legacy-complete-unproven\)/);

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, []);
  const unadopted = issues.filter((issue) => issue.code === "lifecycle_missing_shadow");
  assert.equal(unadopted.length, 1);
  assert.match(unadopted[0]!.message, /3 milestone, slice or task row\(s\) have no canonical lifecycle row/);
  assert.match(unadopted[0]!.message, /\/gsd db adopt --apply/);

  // The explicit backfill is the route; the next open cuts over.
  applyLifecycleBackfill(base);
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{ revision: 2, authority_epoch: 1 }]);
});

test("open work under a completed parent stops the cutover and is not cancelled", () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });
  // Only the Milestone was adopted, as completed.
  executeDomainOperation({
    operationType: "test.partial-adoption",
    idempotencyKey: "cutover-on-open/completed-parent",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" });
    return {
      events: [{ eventType: "test.adopted", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/completed-parent", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  const before = durableSnapshot();
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true);

  assert.deepEqual(durableSnapshot(), before);
  assert.deepEqual(backupFiles(base), []);
  assert.match(logged("error").join("\n"), /slice M001\/S01: "pending" -> "skipped" \(cancelled-under-completed-parent\)/);
});

test("open work under a cancelled parent stops the cutover and is not cancelled", () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "skipped" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending" });
  const before = durableSnapshot();
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true, "the open itself still succeeds");

  assert.deepEqual(durableSnapshot(), before);
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.deepEqual(before.authority, [{ revision: 0, authority_epoch: 0 }]);
  assert.deepEqual(before.lifecycles, []);
  assert.deepEqual(backupFiles(base), []);
  const errors = logged("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Authority cutover stopped: the lifecycle backfill would change the status of 1 row\(s\)/);
  assert.match(errors[0]!, /Nothing was changed/);
  assert.match(errors[0]!, /\/gsd db adopt --apply/);
  assert.match(errors[0]!, /task M001\/S01\/T01: "pending" -> "skipped" \(cancelled-with-parent\)/);

  // The explicit backfill is the route; the next open cuts over.
  applyLifecycleBackfill(base);
  assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{ revision: 2, authority_epoch: 1 }]);
});

/**
 * A project that an earlier build cut over. That build had no coverage fence,
 * so `insert` leaves hierarchy rows with no lifecycle row after the cutover.
 */
function cutOverProjectOfEarlierBuild(insert: () => void): string {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending" });
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(rows("SELECT authority_epoch FROM project_authority"), [{ authority_epoch: 1 }]);
  db().exec(`
    DROP TRIGGER trg_tasks_lifecycle_coverage;
    DROP TRIGGER trg_project_authority_lifecycle_coverage;
  `);
  insert();
  closeDatabase();
  _resetLogs();
  // The repair of a project that is already cut over does not need the flag.
  setAuthorityCutoverFlag(undefined);
  return base;
}

test("the open of a cut-over project adopts the rows an earlier build left without a lifecycle row", () => {
  const base = cutOverProjectOfEarlierBuild(() => {
    insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending" });
    // A completion with no evidence: adoption reopens it.
    insertTask({ id: "T03", milestoneId: "M001", sliceId: "S01", status: "complete" });
  });
  const backupsBefore = backupFiles(base).length;

  assert.equal(openWorkflowDatabase(base).ok, true);

  assert.equal(countUnadoptedHierarchyRows(), 0);
  assert.equal(getTask("M001", "S01", "T03")?.status, "pending");
  assert.deepEqual(
    rows("SELECT operation_type FROM workflow_operations ORDER BY resulting_revision").map((row) => row["operation_type"]),
    ["lifecycle.backfill", "authority.cutover", "lifecycle.backfill"],
  );
  assert.equal(backupFiles(base).length, backupsBefore + 1);
  assert.deepEqual(logged("error"), []);
  const warnings = logged("warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /adopted 2 row\(s\)/);
  assert.match(warnings[0]!, /task M001\/S01\/T03: "complete" -> "pending" \(legacy-complete-unproven\)/);

  // The project is not write-locked: the next Domain Operation commits.
  assert.deepEqual(registerMilestones([{ id: "M002", title: "Next" }], "test"), ["M002"]);
});

test("a row that cannot be adopted after the cutover gives an error that names it, on open, on write and in doctor", async () => {
  const base = cutOverProjectOfEarlierBuild(() => {
    insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "wip-custom" });
  });
  const backupsBefore = backupFiles(base).length;

  assert.equal(openWorkflowDatabase(base).ok, true, "the open itself still succeeds");

  assert.equal(getTask("M001", "S01", "T02")?.status, "wip-custom");
  assert.equal(backupFiles(base).length, backupsBefore);
  const errors = logged("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Lifecycle backfill stopped: 1 row\(s\)/);
  assert.match(errors[0]!, /task M001\/S01\/T02: "wip-custom"/);
  assert.match(errors[0]!, /\/gsd db adopt/);

  assert.throws(
    () => registerMilestones([{ id: "M002", title: "Next" }], "test"),
    /a hierarchy row has no lifecycle row: task M001\/S01\/T02="wip-custom"\. .*\/gsd db adopt/,
  );

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, []);
  const unmappable = issues.filter((issue) => issue.code === "lifecycle_unmappable_status");
  assert.equal(unmappable.length, 1);
  assert.match(unmappable[0]!.message, /task M001\/S01\/T02="wip-custom"/);
  assert.match(unmappable[0]!.message, /\/gsd db adopt/);

  // Once the row is fixed, the next open adopts it and writes work again.
  db().exec(`
    DROP TRIGGER trg_tasks_lifecycle_coverage;
    UPDATE tasks SET status = 'pending' WHERE id = 'T02';
  `);
  closeDatabase();
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.equal(countUnadoptedHierarchyRows(), 0);
  assert.deepEqual(registerMilestones([{ id: "M002", title: "Next" }], "test"), ["M002"]);
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

test("two processes that open an old project database at the same time cut it over exactly once", async () => {
  const base = createProject();
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  for (let task = 1; task <= 40; task++) {
    insertTask({ id: `T${String(task).padStart(2, "0")}`, milestoneId: "M001", sliceId: "S01", status: "pending" });
  }
  closeDatabase();

  const openers = await Promise.all([spawnOpener(base), spawnOpener(base)]);
  const opens = await Promise.all(openers.map((opener) => opener.open()));

  for (const opened of opens) {
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.logs.filter((entry) => entry.severity === "error"), []);
  }
  // Read-only: an open by this process would run the cutover itself.
  const database = openSqliteReadOnly(join(base, ".gsd", "gsd.db")).db;
  const state = {
    authority: database.prepare("SELECT revision, authority_epoch FROM project_authority").all(),
    operations: database.prepare("SELECT operation_type FROM workflow_operations ORDER BY resulting_revision").all()
      .map((row) => row["operation_type"]),
    cutovers: database.prepare("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").get()?.["count"],
  };
  database.close();
  assert.deepEqual(state, {
    authority: [{ revision: 2, authority_epoch: 1 }],
    operations: ["lifecycle.backfill", "authority.cutover"],
    cutovers: 1,
  });
  assert.equal(backupFiles(base).length, 1);
});
