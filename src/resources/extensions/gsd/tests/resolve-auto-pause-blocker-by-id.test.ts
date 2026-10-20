// Project/App: gsd-pi
// File Purpose: Offline regression for the clear-only `pause.blocker.resolve.by-id`
// Domain Operation (gsd_resolve_blocker, pauseBlockerId): it atomically resolves
// one exact open workflow_blockers row and its bound auto_pauses row, fails
// closed on a wrong/stale/closed/unassociated id, and leaves unrelated rows
// untouched. Uses isolated temporary fixture databases only. Every internal
// actorType:user here is SYNTHETIC domain provenance, NOT proof of human input.
// Controller/host-capability unit assertions live in commands-blocker.test.ts.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { pauseAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
} from "../db/domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import {
  openPauseBlockerRow,
  readAutoPauseBlockerResolution,
  resolveAutoPauseBlockerById,
} from "../pause-blocker-domain-operation.ts";
import { clearPausedSession, PAUSED_SESSION_KV_KEY } from "../interrupted-session.ts";
import { setRuntimeKv } from "../db/runtime-kv.ts";
import { listOpenEscalations } from "../escalation-resolution.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { readOpenAutoPauseByBlockerId } from "../db/writers/auto-pauses.ts";
import { getDbPath } from "../db/engine.ts";
import { inspectAutoPauseBlockerFile } from "../pause-blocker-inspection.ts";
import { handleBlocker } from "../commands-blocker.ts";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

const TS = "2026-10-15T00:00:00.000Z";

function makeProject(t: TestContext): string {
  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-resolve-auto-pause-blocker-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in-progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  seedLifecycleRows();
  autoSession.reset();
  t.after(() => {
    try {
      autoSession.reset();
      try { closeDatabase(); } catch { /* already closed */ }
    } finally {
      process.chdir(originalCwd);
      rmSync(base, { recursive: true, force: true });
    }
  });
  return base;
}

/** Exact milestone, slice, and task lifecycle rows used by pause identities. */
function seedLifecycleRows(): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE project_authority SET revision = 1, updated_at = :ts WHERE singleton = 1`,
  ).run({ ":ts": TS });
  db.prepare(
    `INSERT INTO workflow_operations (
       operation_id, project_id, operation_type, idempotency_key,
       expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
       actor_type, source_transport, request_hash, created_at
     ) VALUES ('op1', (SELECT project_id FROM project_authority WHERE singleton = 1),
               'lifecycle.adopt', 'ik-op1', 0, 1, 0, 0, 'agent', 'internal', 'hash', :ts)`,
  ).run({ ":ts": TS });
  db.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
       lifecycle_status, state_version, created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES
       ('lc-m001', (SELECT project_id FROM project_authority WHERE singleton = 1),
        'milestone', 'M001', NULL, NULL, 'in_progress', 1, :ts, :ts, 'op1', 1, 0),
       ('lc-m001-s01', (SELECT project_id FROM project_authority WHERE singleton = 1),
        'slice', 'M001', 'S01', NULL, 'in_progress', 1, :ts, :ts, 'op1', 1, 0),
       ('lc-m001-s01-t01', (SELECT project_id FROM project_authority WHERE singleton = 1),
        'task', 'M001', 'S01', 'T01', 'ready', 1, :ts, :ts, 'op1', 1, 0)`,
  ).run({ ":ts": TS });
}

function activateSession(
  base: string,
  unit: { type: string; id: string } = { type: "plan-slice", id: "M001/S01" },
): void {
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.currentUnit = { ...unit, startedAt: Date.now() };
  process.chdir(base);
}

function openPauseRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`SELECT * FROM auto_pauses WHERE closed_at IS NULL`).all() as Array<Record<string, unknown>>;
}

function blockerRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`SELECT * FROM workflow_blockers ORDER BY opened_at`).all() as Array<Record<string, unknown>>;
}

function durableCounts(): {
  revision: number;
  operations: number;
  events: number;
  outbox: number;
  projections: number;
} {
  const db = _getAdapter()!;
  return {
    revision: Number(db.prepare(
      `SELECT revision FROM project_authority WHERE singleton = 1`,
    ).get()!["revision"]),
    operations: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_operations`,
    ).get()!["count"]),
    events: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_domain_events`,
    ).get()!["count"]),
    outbox: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_outbox`,
    ).get()!["count"]),
    projections: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_projection_work`,
    ).get()!["count"]),
  };
}

function executionRows() {
  return Object.fromEntries([
    "tasks", "workflow_item_lifecycles", "workflow_execution_attempts",
    "workflow_attempt_results", "workflow_recovery_actions",
  ].map((table) => [table, _getAdapter()!.prepare(`SELECT * FROM ${table}`).all()]));
}

function resolutionInput(
  blockerId: string,
  rationale: string,
  idempotencyKey = `test/${randomUUID()}`,
): {
  blockerId: string;
  rationale: string;
  invocation: ExecutionInvocation;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
} {
  const authority = _getAdapter()!.prepare(
    `SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1`,
  ).get()!;
  return {
    blockerId,
    rationale,
    invocation: {
      idempotencyKey,
      actorType: "user",
      sourceTransport: "internal" as const,
      traceId: `trace/${idempotencyKey}`,
    },
    expectedRevision: Number(authority["revision"]),
    expectedAuthorityEpoch: Number(authority["authority_epoch"]),
  };
}

// Whole-file and schema evidence is confined to tiny fixtures under tmpdir().
function fixtureFiles(base: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        files[`${name}/`] = "directory";
        visit(join(directory, entry.name), `${name}/`);
      } else {
        // WAL shared memory contains transient reader locks, not durable rows.
        // Record its existence, and hash every durable file (including DB/WAL).
        files[name] = name.endsWith("-shm") ? "sqlite reader-lock shared memory" :
          createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex");
      }
    }
  };
  visit(join(base, ".gsd"), "");
  return files;
}

for (const kind of ["missing", "unbound", "legacy-incompatible"]) {
  test(`existing-file inspection of ${kind} creates/migrates/binds/adopts/cutovers nothing`, async (t) => {
    closeDatabase();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-blocker-readonly-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"));
    const path = join(base, ".gsd", "gsd.db");
    if (kind !== "missing") {
      const fixture = new DatabaseSync(path);
      fixture.exec(`CREATE TABLE project_authority (singleton INTEGER PRIMARY KEY, project_id TEXT,
        project_root_realpath TEXT, revision INTEGER, authority_epoch INTEGER);
        CREATE TABLE sentinel (value TEXT);
        INSERT INTO sentinel VALUES ('unchanged');`);
      fixture.prepare("INSERT INTO project_authority VALUES (1, 'fixture-project', ?, 17, 3)")
        .run(kind === "unbound" ? "" : base);
      fixture.close();
    }
    const schemaAndRows = () => {
      if (kind === "missing") return null;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          schema: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
          authority: db.prepare("SELECT * FROM project_authority").all(),
          sentinel: db.prepare("SELECT * FROM sentinel").all(),
        };
      } finally { db.close(); }
    };
    const beforeRows = schemaAndRows();
    const beforeFiles = fixtureFiles(base);
    const beforeBinding = getDbPath();
    assert.throws(() => inspectAutoPauseBlockerFile(path, base, "b1"));
    // Also exercise the actual controller's refusal, with no terminal approval.
    const notices: string[] = [];
    const ctx = { cwd: base, hasUI: true, ui: {
      notify: (message: string) => notices.push(message),
      input: async () => { assert.fail("incompatible inspect must not ask for input"); },
      custom: async () => { assert.fail("incompatible inspect must not request approval"); },
    } } as unknown as ExtensionCommandContext;
    await handleBlocker("inspect b1", ctx, base);
    assert.ok(notices.length);
    assert.equal(getDbPath(), beforeBinding);
    assert.deepEqual(schemaAndRows(), beforeRows);
    assert.deepEqual(fixtureFiles(base), beforeFiles, "schema, fences, rows and files are byte-identical");
  });
}

test("public read-only file inspection and controller cancel/blank evidence never bind a writable connection", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", { message: "Fixture only", category: "unknown" });
  const db = _getAdapter()!;
  // Fixture construction only: no adoption/cutover operation is invoked.
  db.prepare("UPDATE project_authority SET project_root_realpath = :root, authority_epoch = 1 WHERE singleton = 1").run({ ":root": base });
  const blockerId = String(blockerRows()[0]!["blocker_id"]);
  const expected = readAutoPauseBlockerResolution(blockerId);
  assert.equal(expected.eligible, true);
  const beforeState = { counts: durableCounts(), blockers: blockerRows(), pauses: openPauseRows(), execution: executionRows() };
  const beforeBinding = getDbPath();
  const beforeFiles = fixtureFiles(base);
  const path = join(base, ".gsd", "gsd.db");
  const readonly = new DatabaseSync(path, { readOnly: true });
  assert.throws(() => readonly.exec("CREATE TABLE forbidden (id INTEGER)"), /readonly|read-only/i);
  readonly.close();
  assert.deepEqual(inspectAutoPauseBlockerFile(path, base, blockerId), expected);
  for (const input of [undefined, "", "   "]) {
    const notices: string[] = [];
    const ctx = { cwd: base, hasUI: true, ui: {
      notify: (message: string) => notices.push(message), input: async () => input,
      custom: async () => { assert.fail("blank evidence must not request approval"); },
    } } as unknown as ExtensionCommandContext;
    await handleBlocker(`resolve ${blockerId} resolved fixture reason`, ctx, base);
    assert.match(notices.join("\n"), /Cancelled; nonblank evidence/);
    assert.equal(getDbPath(), beforeBinding, "no engine bind or rebind");
    assert.equal(_getAdapter(), db);
    assert.deepEqual(fixtureFiles(base), beforeFiles);
  }
  assert.deepEqual({ counts: durableCounts(), blockers: blockerRows(), pauses: openPauseRows(), execution: executionRows() }, beforeState);
  closeDatabase();
  const unboundFiles = fixtureFiles(base);
  const notices: string[] = [];
  await handleBlocker(`resolve ${blockerId} resolved fixture reason`, { cwd: base, ui: {
    notify: (message: string) => notices.push(message),
    input: async () => { assert.fail("a missing existing host binding must refuse before input"); },
  } } as unknown as ExtensionCommandContext, base);
  assert.match(notices.join("\n"), /No existing writable database binding/);
  assert.equal(getDbPath(), null);
  assert.deepEqual(fixtureFiles(base), unboundFiles);
});

test("SYNTHETIC Project ID pin refuses replacement before replay and inside the final transaction", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", { message: "Fixture only", category: "unknown" });
  const db = _getAdapter()!;
  const blockerId = String(blockerRows()[0]!["blocker_id"]);
  const projectId = String(db.prepare("SELECT project_id FROM project_authority").get()!["project_id"]);
  const state = () => ({ counts: durableCounts(), blockers: blockerRows(), pauses: openPauseRows(), execution: executionRows(),
    authority: db.prepare("SELECT * FROM project_authority").all() });
  const before = state();
  const input = { ...resolutionInput(blockerId, "Synthetic Project pin", "test/project-pin"), expectedProjectId: projectId };
  assert.throws(() => resolveAutoPauseBlockerById({ ...input, expectedProjectId: "replacement-same-numeric-fences" }), /Project ID changed/);
  assert.deepEqual(state(), before);
  // A TEMP-fixture trigger changes identity after the provisional operation
  // insert, i.e. after preflight and BEGIN, before the Domain Operation callback.
  // Deferred FKs let the explicit Project pin (not an FK accident) reject it.
  db.exec(`CREATE TRIGGER replace_fixture_project BEFORE INSERT ON workflow_operations
    WHEN NEW.operation_type = 'pause.blocker.resolve.by-id'
    BEGIN UPDATE project_authority SET project_id = 'replacement-during-transaction'; END;
    `);
  const exec = db.exec.bind(db);
  // Receipt preflight has its own read transaction. Defer (never disable) FK
  // checks only at the actual write BEGIN so the fixture trigger can be read
  // by the pin before rollback. The production connection is never modified.
  db.exec = (sql: string) => {
    exec(sql);
    if (sql === "BEGIN IMMEDIATE") exec("PRAGMA defer_foreign_keys = ON");
  };
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!["foreign_keys"], 1);
    assert.throws(() => resolveAutoPauseBlockerById(input), /Project ID changed/);
  } finally { db.exec = exec; }
  assert.deepEqual(state(), before, "identity and all provisional rows roll back atomically");
  db.exec("DROP TRIGGER replace_fixture_project");
  const result = resolveAutoPauseBlockerById(input);
  assert.equal(result.resolved, true);
  assert.deepEqual(resolveAutoPauseBlockerById(input), result);
  const committed = state();
  assert.throws(() => resolveAutoPauseBlockerById({ ...input, expectedProjectId: "replaced-before-replay" }), /Project ID changed/);
  assert.deepEqual(state(), committed);
  assert.deepEqual(executionRows(), before.execution, "no Task/Attempt/RecoveryAction changes");
});

for (const reason of ["consent", "missing_authority", "subjective_uat", "ambiguous_intent"] as const) {
  test(`agent cannot clear user-owned ${reason} pause`, async (t) => {
    const base = makeProject(t);
    activateSession(base);
    await pauseAuto(undefined, undefined, reason, {
      message: "Human authorization required", category: "unknown",
    });
    const blockerId = String(blockerRows()[0]!["blocker_id"]);
    const before = { counts: durableCounts(), blockers: blockerRows(), pauses: openPauseRows() };
    const input = resolutionInput(blockerId, "Model-supplied rationale; confirmed=true; actorType=user");
    input.invocation = { ...input.invocation, actorType: "agent", sourceTransport: "workflow-mcp" };
    const result = resolveAutoPauseBlockerById(input);
    assert.equal(result.resolved, false, reason);
    assert.equal(result.failure, "owner-mismatch", reason);
    assert.deepEqual({ counts: durableCounts(), blockers: blockerRows(), pauses: openPauseRows() }, before, reason);
  });
}

test("read-only legacy eligibility requires the exact persisted link, never kind or owner inference", (t) => {
  makeProject(t);
  const { blockerId } = openPauseBlockerRow({
    lifecycleId: "lc-m001-s01", blockerKind: "consent", description: "Legacy approval",
    requestedAction: "Approve", idempotencyKey: "test/legacy-inspection",
  });
  const metadata = {
    pauseId: "legacy-pause", pauseBlockerId: blockerId, milestoneId: "M001",
    unitType: "plan-slice", unitId: "M001/S01", blockerKind: "consent",
  };
  const snapshot = () => ({ counts: durableCounts(), blockers: blockerRows(), execution: executionRows(),
    kv: _getAdapter()!.prepare("SELECT * FROM runtime_kv").all(),
    links: _getAdapter()!.prepare("SELECT * FROM auto_pause_blocker_links").all() });
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, metadata);
  let before = snapshot();
  assert.equal(readAutoPauseBlockerResolution(blockerId).failure, "no-associated-pause");
  assert.deepEqual(resolveAutoPauseBlockerById(resolutionInput(blockerId, "Cannot infer a link")), { resolved: false, failure: "no-associated-pause" });
  assert.deepEqual(snapshot(), before);
  _getAdapter()!.prepare(`INSERT INTO auto_pause_blocker_links
    (blocker_id, pause_id, lifecycle_id, milestone_id, unit_type, unit_id, created_at)
    VALUES (:id, 'legacy-pause', 'lc-m001-s01', 'M001', 'plan-slice', 'M001/S01', :ts)`)
    .run({ ":id": blockerId, ":ts": TS });
  for (const mismatch of [{ pauseId: "foreign" }, { pauseBlockerId: "foreign" }, { unitId: "M001/S02" }, { unitType: "execute-task" }]) {
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, { ...metadata, ...mismatch });
    before = snapshot();
    assert.equal(readAutoPauseBlockerResolution(blockerId).failure, "association-mismatch");
    assert.deepEqual(resolveAutoPauseBlockerById(resolutionInput(blockerId, "Wrong legacy link")), { resolved: false, failure: "association-mismatch" });
    assert.deepEqual(snapshot(), before);
  }
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, metadata);
  before = snapshot();
  assert.equal(readAutoPauseBlockerResolution(blockerId).eligible, true);
  assert.deepEqual(snapshot(), before);
  const input = { ...resolutionInput(blockerId, "Synthetic legacy fixture evidence"),
    expectedProjectId: readAutoPauseBlockerResolution(blockerId).projectId };
  const result = resolveAutoPauseBlockerById(input);
  assert.equal(result.resolved, true);
  assert.deepEqual(resolveAutoPauseBlockerById(input), result, "same human intent replays");
  assert.equal(blockerRows()[0]!["blocker_status"], "resolved");
  assert.equal(_getAdapter()!.prepare("SELECT value_json FROM runtime_kv WHERE key = :key").get({ ":key": PAUSED_SESSION_KV_KEY }), undefined);
  assert.deepEqual(executionRows(), before.execution);
});

test("SYNTHETIC internal-user domain resolution pins Project ID and closes only the exact pair", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", { message: "Approval needed", category: "unknown" });
  const blockerId = String(blockerRows()[0]!["blocker_id"]);
  const before = executionRows();
  const projectId = String(_getAdapter()!.prepare("SELECT project_id FROM project_authority").get()!["project_id"]);
  const input = { ...resolutionInput(blockerId, "Synthetic fixture evidence"), expectedProjectId: projectId };
  const result = resolveAutoPauseBlockerById(input);
  assert.equal(result.resolved, true);
  assert.equal(blockerRows()[0]!["blocker_status"], "resolved");
  assert.equal(openPauseRows().length, 0);
  assert.deepEqual(executionRows(), before);
  assert.deepEqual(resolveAutoPauseBlockerById(input), result, "same synthetic intent replays");
});

test("resolves the exact open auto-pause blocker and atomically closes its bound pause", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Two valid routes for the slice scope",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);

  const result = resolveAutoPauseBlockerById(
    resolutionInput(blockerId, "Operator clarified: route B is correct."),
  );

  assert.equal(result.resolved, true);
  assert.ok(result.scope, "the closed pause scope comes back");
  const blockers = blockerRows();
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]["blocker_status"], "resolved");
  assert.equal(blockers[0]["resolution"], "Operator clarified: route B is correct.");
  assert.equal(openPauseRows().length, 0, "the bound pause row is closed");
});

test("pause, resume, and pause again closes each exact blocker without duplicates", async (t) => {
  const base = makeProject(t);
  const unit = { type: "plan-slice", id: "M001/S01" };
  activateSession(base, unit);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Wait for the operator",
    category: "unknown",
  });
  const firstBlockerId = String(blockerRows()[0]!["blocker_id"]);

  clearPausedSession();

  assert.equal(openPauseRows().length, 0);
  assert.equal(blockerRows()[0]!["blocker_status"], "resolved");
  activateSession(base, unit);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Wait for the operator again",
    category: "unknown",
  });
  const secondBlockerId = String(blockerRows().find((row) => row["blocker_status"] === "open")!["blocker_id"]);
  assert.notEqual(secondBlockerId, firstBlockerId);
  assert.equal(blockerRows().length, 2);
  assert.equal(resolveAutoPauseBlockerById(resolutionInput(secondBlockerId, "second pause resolved")).resolved, true);
  assert.equal(blockerRows().find((row) => row["blocker_id"] === firstBlockerId)?.["blocker_status"], "resolved");
  assert.equal(openPauseRows().length, 0);
  clearPausedSession();
  assert.equal(openPauseRows().length, 0);
});

test("pause persistence opens a distinct blocker instead of reusing another lifecycle blocker", async (t) => {
  const base = makeProject(t);
  const { blockerId } = openPauseBlockerRow({
    lifecycleId: "lc-m001-s01",
    blockerKind: "ambiguous_intent",
    description: "Clarify the slice",
    requestedAction: "Choose a route",
    idempotencyKey: "test/existing-slice-blocker",
  });
  activateSession(base, { type: "discuss-slice", id: "M001/S01" });
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Waiting for the same clarification",
    category: "unknown",
  });

  const pauseBlockerId = openPauseRows()[0]!["blocker_id"];
  assert.notEqual(pauseBlockerId, blockerId);
  assert.equal(blockerRows().length, 2);
  assert.equal(blockerRows().find((row) => row["blocker_id"] === blockerId)?.["blocker_status"], "open");
  assert.equal(resolveAutoPauseBlockerById(resolutionInput(String(pauseBlockerId), "Route chosen")).resolved, true);
  assert.equal(blockerRows().find((row) => row["blocker_id"] === blockerId)?.["blocker_status"], "open");
  assert.equal(openPauseRows().length, 0);
});

test("binds task, slice, and milestone pauses to only their exact lifecycle identity", async (t) => {
  const cases = [
    { name: "task", unit: { type: "execute-task", id: "M001/S01/T01" }, lifecycleId: "lc-m001-s01-t01" },
    { name: "slice", unit: { type: "plan-slice", id: "M001/S01" }, lifecycleId: "lc-m001-s01" },
    { name: "milestone", unit: { type: "research-milestone", id: "M001" }, lifecycleId: "lc-m001" },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const base = makeProject(st);
      activateSession(base, item.unit);
      await pauseAuto(undefined, undefined, "ambiguous_intent", {
        message: `${item.name} identity`,
        category: "unknown",
      });
      const blocker = blockerRows()[0]!;
      assert.equal(blocker["lifecycle_id"], item.lifecycleId);
      const result = resolveAutoPauseBlockerById(
        resolutionInput(String(blocker["blocker_id"]), `resolve exact ${item.name}`),
      );
      assert.equal(result.resolved, true);
      assert.equal(openPauseRows().length, 0);
    });
  }
});

test("refuses malformed, parent-only, and mismatched pause lifecycle identities without durable mutation", async (t) => {
  const cases: Array<{
    name: string;
    corrupt(db: NonNullable<ReturnType<typeof _getAdapter>>): void;
  }> = [
    {
      name: "task lifecycle missing while slice and milestone parents exist",
      corrupt(db) {
        // This temp database is disposed after the subtest. Drop only the
        // database fences needed to model a row written by an older/corrupt
        // store; production lifecycle identity remains immutable.
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec(`
          DROP TRIGGER trg_workflow_lifecycle_identity_immutable;
          DROP TRIGGER trg_workflow_lifecycle_transition;
        `);
        db.prepare(
          `UPDATE workflow_item_lifecycles SET task_id = 'T99' WHERE lifecycle_id = 'lc-m001-s01-t01'`,
        ).run();
      },
    },
    {
      name: "milestone id disagrees with unit id",
      corrupt(db) {
        db.prepare(`UPDATE auto_pauses SET milestone_id = 'M002' WHERE closed_at IS NULL`).run();
      },
    },
    {
      name: "unit id names another milestone",
      corrupt(db) {
        db.prepare(`UPDATE auto_pauses SET unit_id = 'M002/S01/T01' WHERE closed_at IS NULL`).run();
      },
    },
    {
      name: "task unit has slice-shaped id",
      corrupt(db) {
        db.prepare(`UPDATE auto_pauses SET unit_id = 'M001/S01' WHERE closed_at IS NULL`).run();
      },
    },
    {
      name: "task unit has malformed id segments",
      corrupt(db) {
        db.prepare(`UPDATE auto_pauses SET unit_id = 'M001/slice/T01' WHERE closed_at IS NULL`).run();
      },
    },
    {
      name: "slice unit type has task-shaped id",
      corrupt(db) {
        db.prepare(`UPDATE auto_pauses SET unit_type = 'plan-slice' WHERE closed_at IS NULL`).run();
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const base = makeProject(st);
      activateSession(base, { type: "execute-task", id: "M001/S01/T01" });
      await pauseAuto(undefined, undefined, "ambiguous_intent", {
        message: item.name,
        category: "unknown",
      });
      const blockerId = String(blockerRows()[0]!["blocker_id"]);
      item.corrupt(_getAdapter()!);
      const before = { blocker: blockerRows(), pauses: openPauseRows(), durable: durableCounts() };
      const input = resolutionInput(
        blockerId,
        `refuse ${item.name}`,
        `test/exact-identity/${item.name.replaceAll(" ", "-")}`,
      );

      const result = resolveAutoPauseBlockerById(input);
      assert.deepEqual(result, { resolved: false, failure: "association-mismatch" });
      assert.deepEqual(resolveAutoPauseBlockerById(input), result, "the same invalid selection is refused again");
      assert.deepEqual(blockerRows(), before.blocker, "the blocker remains open and unchanged");
      assert.deepEqual(openPauseRows(), before.pauses, "the pause remains open and unchanged");
      assert.deepEqual(durableCounts(), before.durable, "refusal creates no operation, event, outbox, or projection work");
    });
  }
});

test("refuses duplicate open pause associations without any durable mutation", async (t) => {
  const base = makeProject(t);
  activateSession(base, { type: "execute-task", id: "M001/S01/T01" });
  await pauseAuto(undefined, undefined, "consent", {
    message: "duplicate association fixture",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]!["blocker_id"]);
  assert.equal(readOpenAutoPauseByBlockerId("missing-blocker"), null);
  assert.equal(readOpenAutoPauseByBlockerId(blockerId)?.scope, openPauseRows()[0]!["scope"]);
  const insertDuplicate = _getAdapter()!.prepare(`
    INSERT INTO auto_pauses (
      scope, blocker_kind, dispatch_id, milestone_id, unit_type, unit_id,
      worktree_path, original_base_path, step_mode, session_file,
      active_engine_id, active_run_dir, auto_start_time, milestone_lock,
      pause_reason, paused_at, closed_at, blocker_id
    )
    SELECT
      :scope, blocker_kind, dispatch_id, milestone_id, unit_type, unit_id,
      worktree_path, original_base_path, step_mode, session_file,
      active_engine_id, active_run_dir, auto_start_time, milestone_lock,
      pause_reason, paused_at, NULL, blocker_id
    FROM auto_pauses WHERE blocker_id = :blocker_id AND closed_at IS NULL LIMIT 1
  `);
  insertDuplicate.run({ ":blocker_id": blockerId, ":scope": "duplicate-worker-scope" });
  assert.equal(readOpenAutoPauseByBlockerId(blockerId), null, "two associations are ambiguous");
  insertDuplicate.run({ ":blocker_id": blockerId, ":scope": "third-worker-scope" });
  assert.equal(readOpenAutoPauseByBlockerId(blockerId), null, "more than two remain ambiguous");
  const before = { blocker: blockerRows(), pauses: openPauseRows(), durable: durableCounts() };
  assert.equal(before.pauses.length, 3);
  const input = resolutionInput(
    blockerId,
    "duplicates cannot identify one exact pause",
    "test/refusal/duplicate-association",
  );

  const result = resolveAutoPauseBlockerById(input);
  assert.deepEqual(result, { resolved: false, failure: "association-mismatch" });
  assert.deepEqual(resolveAutoPauseBlockerById(input), result, "the duplicate association is refused again");
  assert.deepEqual(blockerRows(), before.blocker);
  assert.deepEqual(openPauseRows(), before.pauses);
  assert.deepEqual(durableCounts(), before.durable);
});

test("same-key success replays before closed-state validation and returns the stable scope", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Replay this exact resolution",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const input = resolutionInput(blockerId, "same request", "test/replay-success");

  const first = resolveAutoPauseBlockerById(input);
  const replay = resolveAutoPauseBlockerById(input);

  assert.equal(first.resolved, true);
  assert.deepEqual(replay, first);
  assert.ok(replay.scope, "replay reads the durable closed pause scope");
  assert.equal(blockerRows().length, 1);
  assert.equal(openPauseRows().length, 0);
});

test("model transports cannot acquire human ownership; internal human provenance is preserved", async (t) => {
  const stableInput = "shared-caller-retry-identity";
  const transports = ["workflow-mcp", "pi-tool", "internal"] as const;
  const keys: string[] = [];

  for (const sourceTransport of transports) {
    await t.test(sourceTransport, async (st) => {
      const base = makeProject(st);
      activateSession(base);
      await pauseAuto(undefined, undefined, "consent", {
        message: `Resolve from ${sourceTransport}`,
        category: "unknown",
      });
      const blocker = blockerRows().find((row) => row["blocker_status"] === "open");
      assert.ok(blocker);
      const input = resolutionInput(
        String(blocker["blocker_id"]),
        `approved through ${sourceTransport}`,
        stableInput,
      );
      input.invocation.sourceTransport = sourceTransport;
      if (sourceTransport !== "internal") {
        input.invocation.actorType = "agent";
        const before = durableCounts();
        assert.deepEqual(resolveAutoPauseBlockerById(input), { resolved: false, failure: "owner-mismatch" });
        assert.deepEqual(durableCounts(), before);
        return;
      }
      assert.equal(resolveAutoPauseBlockerById(input).resolved, true);
      const row = _getAdapter()!.prepare(`
        SELECT idempotency_key FROM workflow_operations
        WHERE operation_type = 'pause.blocker.resolve.by-id'
      `).get();
      keys.push(String(row?.["idempotency_key"]));
    });
  }

  assert.equal(keys.length, 1);
  assert.equal(new Set(keys).size, 1, "only the permitted synthetic internal operation has a key; denied transports have no receipts");
  for (const key of keys) {
    assert.match(key, /^resolve-auto-pause-blocker:v1:sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /shared-caller-retry-identity/);
  }
});

test("same idempotency key with a changed payload conflicts", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", {
    message: "Resolve once",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const input = resolutionInput(blockerId, "original rationale", "test/replay-conflict");
  assert.equal(resolveAutoPauseBlockerById(input).resolved, true);

  assert.throws(
    () => resolveAutoPauseBlockerById({ ...input, rationale: "changed rationale" }),
    /idempotency|different request/i,
  );
  assert.equal(blockerRows()[0]["resolution"], "original rationale");
});

test("records caller provenance on the resolve operation", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "missing_access", {
    message: "Need operator access",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const input = resolutionInput(blockerId, "Access was granted", "test/provenance");
  input.invocation.traceId = "trace-from-terminal";

  assert.equal(resolveAutoPauseBlockerById(input).resolved, true);
  const operation = _getAdapter()!.prepare(`
    SELECT actor_type, source_transport, trace_id, idempotency_key
    FROM workflow_operations WHERE operation_type = 'pause.blocker.resolve.by-id'
  `).get()!;
  assert.deepEqual({ ...operation }, {
    actor_type: "user",
    source_transport: "internal",
    trace_id: "trace-from-terminal",
    idempotency_key: operation["idempotency_key"],
  });
  assert.match(
    String(operation["idempotency_key"]),
    /^resolve-auto-pause-blocker:v1:sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(String(operation["idempotency_key"]), /test\/provenance|trace-from-mcp/);
});

test("rejects a stale caller-observed revision without mutation", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Selected at a revision",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const input = resolutionInput(blockerId, "stale selection", "test/stale-revision");
  executeDomainOperation({
    operationType: "test.unrelated",
    idempotencyKey: "test/unrelated-revision",
    expectedRevision: input.expectedRevision,
    expectedAuthorityEpoch: input.expectedAuthorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, () => ({
    events: [{
      eventType: "test.unrelated", entityType: "test", entityId: "unrelated",
      payload: {}, destinations: ["test"],
    }],
    projections: [{ projectionKey: "test/unrelated", projectionKind: "test", rendererVersion: "1" }],
  }));
  const beforeRefusal = durableCounts();

  assert.throws(() => resolveAutoPauseBlockerById(input), /stale|revision/i);
  assert.equal(blockerRows()[0]["blocker_status"], "open");
  assert.equal(openPauseRows().length, 1);
  assert.deepEqual(
    durableCounts(),
    beforeRefusal,
    "a stale revision records no operation, event, or revision",
  );
  assert.equal(_getAdapter()!.prepare(
    `SELECT COUNT(*) AS count FROM workflow_operations
     WHERE operation_type = 'pause.blocker.resolve.by-id'`,
  ).get()!["count"], 0);
});

test("rejects an Authority Epoch change without mutation", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", {
    message: "Selected before authority replacement",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const input = resolutionInput(blockerId, "stale epoch", "test/stale-epoch");
  _getAdapter()!.prepare(
    `UPDATE project_authority SET authority_epoch = authority_epoch + 1 WHERE singleton = 1`,
  ).run();
  const before = durableCounts();

  assert.throws(() => resolveAutoPauseBlockerById(input), /authority epoch|stale/i);
  assert.equal(blockerRows()[0]["blocker_status"], "open");
  assert.equal(openPauseRows().length, 1);
  assert.deepEqual(durableCounts(), before, "a stale fence records no operation, event, or revision");
});

test("transaction fault rolls back both blocker and pause changes", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "subjective_uat", {
    message: "Needs atomic rollback",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const db = _getAdapter()!;
  const durableState = () => ({
    authority: db.prepare(`SELECT * FROM project_authority`).all(),
    blockers: db.prepare(`SELECT * FROM workflow_blockers`).all(),
    pauses: db.prepare(`SELECT * FROM auto_pauses`).all(),
    attempts: db.prepare(`SELECT * FROM workflow_execution_attempts`).all(),
    recoveryActions: db.prepare(`SELECT * FROM workflow_recovery_actions`).all(),
    dispatches: db.prepare(`SELECT * FROM unit_dispatches`).all(),
  });
  const sessionState = () => ({
    active: autoSession.active,
    basePath: autoSession.basePath,
    currentMilestoneId: autoSession.currentMilestoneId,
    currentUnit: autoSession.currentUnit && { ...autoSession.currentUnit },
  });
  const before = durableState();
  const sessionBefore = sessionState();
  try {
    _setDomainOperationFaultForTest("before-cas", "pause.blocker.resolve.by-id");
    assert.throws(
      () => resolveAutoPauseBlockerById(
        resolutionInput(blockerId, "must roll back", "test/fault-rollback"),
      ),
      /domain operation fault: before-cas/,
    );
  } finally {
    _setDomainOperationFaultForTest(null);
  }
  assert.deepEqual(durableState(), before, "unexpected faults roll back every durable workflow row");
  assert.deepEqual(sessionState(), sessionBefore, "the clear-only operation never changes live session state");
  assert.equal(blockerRows()[0]["blocker_status"], "open");
  assert.equal(openPauseRows().length, 1);
  assert.equal(_getAdapter()!.prepare(
    `SELECT COUNT(*) AS count FROM workflow_operations
     WHERE operation_type = 'pause.blocker.resolve.by-id'`,
  ).get()!["count"], 0);
});

test("rejects invalid selectors and fences at the exported domain boundary without mutation", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", {
    message: "Needs a reason",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const before = {
    blockers: blockerRows(),
    pauses: openPauseRows(),
    durable: durableCounts(),
  };
  const valid = resolutionInput(blockerId, "valid rationale");
  const cases: Array<{ input: typeof valid; error: RegExp }> = [
    { input: { ...valid, blockerId: "   " }, error: /blockerId must not be blank/ },
    { input: { ...valid, rationale: "   " }, error: /rationale must not be blank/ },
    { input: { ...valid, expectedRevision: -1 }, error: /expectedRevision/ },
    { input: { ...valid, expectedAuthorityEpoch: -1 }, error: /expectedAuthorityEpoch/ },
    {
      input: { ...valid, invocation: { ...valid.invocation, idempotencyKey: "   " } },
      error: /idempotencyKey must not be blank/,
    },
  ];
  for (const item of cases) {
    assert.throws(() => resolveAutoPauseBlockerById(item.input), item.error);
    assert.deepEqual(blockerRows(), before.blockers);
    assert.deepEqual(openPauseRows(), before.pauses);
    assert.deepEqual(durableCounts(), before.durable, "selector validation fails before durable mutation");
  }
});

test("refuses an unknown blocker without reserving the operation key", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Unrelated pause",
    category: "unknown",
  });
  const before = { blockers: blockerRows(), pauses: openPauseRows(), durable: durableCounts() };
  const input = resolutionInput(
    "not-a-real-blocker-id",
    "should not apply",
    "test/refusal/not-found",
  );

  const result = resolveAutoPauseBlockerById(input);
  const retry = resolveAutoPauseBlockerById({ ...input, rationale: "changed refusal payload" });

  assert.equal(result.resolved, false);
  assert.equal(result.failure, "blocker-not-found");
  assert.deepEqual(retry, result);
  assert.deepEqual(blockerRows(), before.blockers, "unrelated blocker rows are untouched");
  assert.deepEqual(openPauseRows(), before.pauses, "unrelated pause rows are untouched");
  assert.deepEqual(durableCounts(), before.durable);
});

test("missing-pause refusal leaves no durable mutation and its key may succeed after repair", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "The bound pause was closed separately",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  // Corrupt only this isolated fixture to model an independently closed pause.
  // The real resolver must not infer permission to clear the orphaned blocker.
  _getAdapter()!.prepare(
    `UPDATE auto_pauses SET closed_at = :ts WHERE blocker_id = :blocker_id`,
  ).run({ ":ts": new Date().toISOString(), ":blocker_id": blockerId });
  const rows = () => ({
    blockers: blockerRows(),
    pauses: openPauseRows(),
  });
  const before = { ...rows(), durable: durableCounts() };
  assert.equal(before.blockers[0]["blocker_status"], "open");
  assert.equal(before.pauses.length, 0);
  const input = resolutionInput(
    blockerId,
    "An absent pause association cannot authorize resolution",
    "test/refusal/no-pause",
  );

  const result = resolveAutoPauseBlockerById(input);

  assert.equal(result.resolved, false);
  assert.equal(result.failure, "no-associated-pause");
  assert.deepEqual(rows(), { blockers: before.blockers, pauses: before.pauses });
  assert.deepEqual(durableCounts(), before.durable, "refusal does not reserve the operation key");

  _getAdapter()!.prepare(
    `UPDATE auto_pauses SET closed_at = NULL WHERE blocker_id = :blocker_id`,
  ).run({ ":blocker_id": blockerId });
  const repaired = resolveAutoPauseBlockerById({ ...input, rationale: "association repaired" });
  assert.equal(repaired.resolved, true, "the same key can commit after state repair");
  assert.equal(blockerRows()[0]["resolution"], "association repaired");
});

test("competing resolution is refused without additional durable mutation", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Pause to resolve twice",
    category: "unknown",
  });
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const first = resolveAutoPauseBlockerById(resolutionInput(blockerId, "first resolution"));
  assert.equal(first.resolved, true);

  const secondInput = resolutionInput(blockerId, "stale retry", "test/refusal/not-open");
  const beforeRefusal = durableCounts();
  const second = resolveAutoPauseBlockerById(secondInput);

  assert.equal(second.resolved, false);
  assert.equal(second.failure, "blocker-not-open");
  assert.deepEqual(
    resolveAutoPauseBlockerById({ ...secondInput, rationale: "changed stale retry" }),
    second,
  );
  assert.deepEqual(durableCounts(), beforeRefusal);
  const blockers = blockerRows();
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]["resolution"], "first resolution", "the first resolution is not overwritten");
});

test("rejects wrong-project, lifecycle, kind, owner, and non-human pause associations", async (t) => {
  const cases: Array<{
    name: string;
    expected: "blocker-not-found" | "association-mismatch" | "unsupported-blocker-kind" | "owner-mismatch";
    corrupt(db: NonNullable<ReturnType<typeof _getAdapter>>, blockerId: string): void;
  }> = [
    {
      name: "wrong project",
      expected: "blocker-not-found",
      corrupt(db, blockerId) {
        db.exec(`PRAGMA foreign_keys = OFF`);
        db.exec(`
          DROP TRIGGER trg_workflow_blocker_opening_immutable;
          DROP TRIGGER trg_workflow_blocker_transition;
        `);
        db.prepare(`UPDATE workflow_blockers SET project_id = 'crafted-other-project' WHERE blocker_id = :id`)
          .run({ ":id": blockerId });
      },
    },
    {
      name: "wrong lifecycle",
      expected: "association-mismatch",
      corrupt(db, blockerId) {
        db.exec(`PRAGMA foreign_keys = OFF`);
        db.exec(`
          DROP TRIGGER trg_workflow_blocker_opening_immutable;
          DROP TRIGGER trg_workflow_blocker_transition;
        `);
        db.prepare(`UPDATE workflow_blockers SET lifecycle_id = 'crafted-other-lifecycle' WHERE blocker_id = :id`)
          .run({ ":id": blockerId });
      },
    },
    {
      name: "kind mismatch",
      expected: "association-mismatch",
      corrupt(db, blockerId) {
        db.prepare(`UPDATE auto_pauses SET blocker_kind = 'consent' WHERE blocker_id = :id`)
          .run({ ":id": blockerId });
      },
    },
    {
      name: "external owner",
      expected: "owner-mismatch",
      corrupt(db, blockerId) {
        // The fixture database is isolated and disposed by makeProject(); only
        // these named opening-identity/transition fences are relaxed for the
        // corrupt row.
        db.exec(`
          DROP TRIGGER trg_workflow_blocker_opening_immutable;
          DROP TRIGGER trg_workflow_blocker_transition;
        `);
        db.prepare(`UPDATE workflow_blockers SET resolution_owner = 'external' WHERE blocker_id = :id`)
          .run({ ":id": blockerId });
      },
    },
    ...(["user_request", "machine_fixable", "recovery"] as const).map((kind) => ({
      name: `${kind} association`,
      expected: "unsupported-blocker-kind" as const,
      corrupt(db: NonNullable<ReturnType<typeof _getAdapter>>, blockerId: string) {
        if (kind === "recovery") db.exec(`PRAGMA ignore_check_constraints = ON`);
        db.prepare(`UPDATE auto_pauses SET blocker_kind = :kind WHERE blocker_id = :id`)
          .run({ ":kind": kind, ":id": blockerId });
      },
    })),
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const base = makeProject(st);
      activateSession(base);
      await pauseAuto(undefined, undefined, "ambiguous_intent", {
        message: `Craft ${item.name}`,
        category: "unknown",
      });
      const blockerId = String(blockerRows()[0]["blocker_id"]);
      item.corrupt(_getAdapter()!, blockerId);
      const input = resolutionInput(
        blockerId,
        `refuse ${item.name}`,
        `test/refusal/${item.name.replaceAll(" ", "-")}`,
      );
      const before = {
        blocker: blockerRows(),
        pauses: openPauseRows(),
        durable: durableCounts(),
      };

      const first = resolveAutoPauseBlockerById(input);
      const retry = resolveAutoPauseBlockerById({ ...input, rationale: `${input.rationale} changed` });
      assert.deepEqual(first, { resolved: false, failure: item.expected });
      assert.deepEqual(retry, first);
      assert.deepEqual(blockerRows(), before.blocker);
      assert.deepEqual(openPauseRows(), before.pauses);
      assert.deepEqual(durableCounts(), before.durable);
    });
  }
});

test("leaves an unrelated open blocker/pause untouched when resolving one exact id", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", { message: "First pause", category: "unknown" });
  const firstBlockerId = String(blockerRows()[0]["blocker_id"]);

  const lifecycleId = String(_getAdapter()!.prepare(
    `SELECT lifecycle_id FROM workflow_item_lifecycles
     WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'`,
  ).get()!["lifecycle_id"]);
  const { blockerId: secondBlockerId } = openPauseBlockerRow({
    lifecycleId,
    blockerKind: "missing_access",
    description: "Independent sidecar worker pause",
    requestedAction: "Grant access",
    idempotencyKey: "test/open-independent-pause-blocker",
  });
  _getAdapter()!.prepare(`
    INSERT INTO auto_pauses (
      scope, blocker_kind, dispatch_id, milestone_id, unit_type, unit_id,
      worktree_path, original_base_path, step_mode, session_file,
      active_engine_id, active_run_dir, auto_start_time, milestone_lock,
      pause_reason, paused_at, closed_at, blocker_id
    )
    SELECT
      'parallel-worker-scope', 'missing_access', dispatch_id, milestone_id, unit_type, unit_id,
      worktree_path, original_base_path, step_mode, session_file,
      active_engine_id, active_run_dir, auto_start_time, milestone_lock,
      'Independent sidecar worker pause', paused_at, NULL, :blocker_id
    FROM auto_pauses WHERE blocker_id = :first_blocker_id
  `).run({ ":blocker_id": secondBlockerId, ":first_blocker_id": firstBlockerId });
  assert.equal(openPauseRows().length, 2, "two genuinely parallel worker scopes are open");

  const result = resolveAutoPauseBlockerById(
    resolutionInput(secondBlockerId, "resolve only the second one"),
  );

  assert.equal(result.resolved, true);
  const after = blockerRows();
  const first = after.find((row) => row["blocker_id"] === firstBlockerId);
  const second = after.find((row) => row["blocker_id"] === secondBlockerId);
  assert.equal(first?.["blocker_status"], "open", "the unrelated parallel blocker remains open");
  assert.equal(second?.["blocker_status"], "resolved");
  assert.equal(second?.["resolution"], "resolve only the second one");
  assert.deepEqual(
    openPauseRows().map((row) => row["blocker_id"]),
    [firstBlockerId],
    "only the selected parallel scope closes",
  );
});

test("preserves existing task-escalation resolution behavior (no interaction with pause blockers)", async (t) => {
  const base = makeProject(t);
  activateSession(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "A pause blocker exists",
    category: "unknown",
  });
  // No task escalation was opened; the escalation reader must still see none,
  // confirming the new pause-blocker path does not fabricate or interact with
  // escalation rows.
  assert.equal(listOpenEscalations().length, 0);
  const blockerId = String(blockerRows()[0]["blocker_id"]);
  const result = resolveAutoPauseBlockerById(
    resolutionInput(blockerId, "clear pause blocker"),
  );
  assert.equal(result.resolved, true);
  assert.equal(listOpenEscalations().length, 0, "escalation rows remain unaffected");
});
