// Project/App: gsd-pi
// File Purpose: Real-schema, existing-file-only native maintenance contracts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openCoordinationMaintenanceHost } from "../coordination-maintenance.ts";
import { databaseMaintenanceIntentPath } from "../database-maintenance-fence.ts";
import { _getAdapter, closeDatabase, getDb, getDbOrNull, openDatabase, openExistingDatabase } from "../gsd-db.ts";
import { _executeCoordinationMaintenanceDomainOperation, _setDomainOperationFaultForTest, executeDomainOperation } from "../db/domain-operation.ts";
import { immediateTransaction } from "../db/engine.ts";
import { _setStartupSchemaDetectionForTest } from "../db/engine.ts";

function fixture(
  t: TestContext,
  competingAttempt?: "claimed" | "running",
  options: { otherExistingDatabase?: boolean } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w067-maintenance-")));
  mkdirSync(join(root, ".gsd"));
  const path = join(root, ".gsd", "gsd.db");
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(child.status, 0);
  assert.ok(child.pid > 0);
  const now = Date.now();
  const witness = { ownerPid: child.pid, ownerStartedAt: new Date(now - 4000).toISOString(), ownerHeartbeatAt: new Date(now - 3000).toISOString(), leaseAcquiredAt: new Date(now - 2000).toISOString(), leaseExpiresAt: new Date(now - 1000).toISOString() };
  assert.equal(openDatabase(path), true);
  const db = _getAdapter()!;
  db.prepare("UPDATE project_authority SET project_root_realpath = ? WHERE singleton = 1").run(root);
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES ('M001', 'Unadopted', 'active', ?)").run(now);
  db.prepare("INSERT INTO workers (worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("raw-worker-secret", child.pid, hostname(), witness.ownerStartedAt, witness.ownerHeartbeatAt, "stopping", "test", root);
  db.prepare("INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, status, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run("M001", "raw-worker-secret", 3, "held", witness.leaseAcquiredAt, witness.leaseExpiresAt);
  // Negative fixtures may contain a pre-existing canonical Task/Attempt, but
  // the target milestone remains unadopted. This happens before maintenance.
  if (competingAttempt) {
    db.prepare("UPDATE milestone_leases SET expires_at = ?").run(new Date(now + 60000).toISOString());
    db.prepare("INSERT INTO slices (milestone_id, id, title, status, created_at) VALUES ('M001', 'S01', 'Fixture slice', 'active', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO tasks (milestone_id, slice_id, id, title, status) VALUES ('M001', 'S01', 'T01', 'Fixture task', 'in_progress')").run();
    executeDomainOperation({
      operationType: "fixture.competing-attempt", idempotencyKey: "fixture-attempt",
      expectedRevision: 0, expectedAuthorityEpoch: 0, actorType: "system", sourceTransport: "fixture", payload: {},
    }, (context) => {
      const stamp = new Date().toISOString();
      db.prepare(`INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES ('fixture-lifecycle', ?, 'task', 'M001', 'S01', 'T01', 'in_progress', ?, ?, ?, ?, ?)`).run(
        context.projectId, stamp, stamp, context.operationId, context.resultingRevision, context.resultingAuthorityEpoch,
      );
      const dispatch = db.prepare(`INSERT INTO unit_dispatches (
        trace_id, worker_id, milestone_lease_token, milestone_id, slice_id, task_id, unit_type, unit_id, status, started_at
      ) VALUES ('fixture-trace', 'raw-worker-secret', 3, 'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01', 'running', ?) RETURNING id`).get(stamp)!;
      db.prepare(`INSERT INTO workflow_execution_attempts (
        attempt_id, lifecycle_id, project_id, attempt_number,
        worker_id, milestone_lease_token, coordination_dispatch_id, attempt_state, claimed_at, started_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES ('fixture-attempt', 'fixture-lifecycle', ?, 1,
        'raw-worker-secret', 3, ?, ?, ?, ?, ?, ?, ?)`).run(
        context.projectId, dispatch.id, competingAttempt, stamp, competingAttempt === "running" ? stamp : null,
        context.operationId, context.resultingRevision, context.resultingAuthorityEpoch,
      );
      db.prepare("UPDATE unit_dispatches SET status = 'completed' WHERE id = ?").run(dispatch.id);
      return {
        events: [{ eventType: "fixture.attempt.present", entityType: "project", entityId: context.projectId, payload: {}, destinations: ["projection"] }],
        projections: [{ projectionKey: "state", projectionKind: "state", rendererVersion: "1" }],
      };
    });
    db.prepare("UPDATE milestone_leases SET expires_at = ?").run(witness.leaseExpiresAt);
  }
  const authority = db.prepare("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1").get()!;
  closeDatabase();
  const otherPath = join(root, ".gsd", "other.db");
  if (options.otherExistingDatabase) {
    assert.equal(openDatabase(otherPath), true);
    closeDatabase();
  }
  const raw = new DatabaseSync(path);
  const input = { expectedRevision: authority.revision, expectedAuthorityEpoch: authority.authority_epoch, witness };
  const host = openCoordinationMaintenanceHost({ projectDir: root });
  t.after(() => { _setDomainOperationFaultForTest(null); host.close(); closeDatabase(); raw.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, raw, host, input, witness, otherPath: options.otherExistingDatabase ? otherPath : undefined };
}

function prepare(f: ReturnType<typeof fixture>): string {
  const reply = f.host.prepare(f.input);
  assert.equal(reply.status, "prepared", JSON.stringify(reply));
  assert.equal(typeof reply.sealId, "string");
  return String(reply.sealId);
}

function released(f: ReturnType<typeof fixture>): string {
  return String((f.raw.prepare("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").get() as { status: string }).status);
}

test("terminal stopped workers do not block maintenance while their recorded PID is still alive", (t) => {
  const f = fixture(t);
  const stamp = new Date().toISOString();
  f.raw.prepare(`INSERT INTO workers (
    worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("retired-worker", process.pid, hostname(), stamp, stamp, "stopped", "test", f.root);
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
  assert.equal(released(f), "released");
});

test("openExistingDatabase cannot bypass maintenance exclusion for the same or another existing database", (t) => {
  const f = fixture(t, undefined, { otherExistingDatabase: true });
  const otherPath = f.otherPath;
  if (!otherPath) throw new Error("fixture did not create its second database");
  assert.throws(() => openExistingDatabase(f.path), /Generic database access is unavailable during coordination maintenance/);
  assert.throws(() => openExistingDatabase(otherPath), /Generic database access is unavailable during coordination maintenance/);
  f.host.close();
  assert.equal(getDbOrNull(), null);
  assert.equal(_getAdapter(), null);
});

test("real maintenance commits exactly one release plus complete receipt, without admission or lifecycle adoption", (t) => {
  const f = fixture(t);
  assert.throws(() => getDbOrNull());
  assert.deepEqual(Object.keys(f.host).sort(), ["apply", "close", "prepare", "receipt"]);
  const sealId = prepare(f);
  const reply = f.host.apply({ sealId });
  assert.equal(reply.status, "committed", JSON.stringify(reply));
  assert.equal(released(f), "released");
  assert.throws(() => getDbOrNull());
  assert.equal(reply.resultingRevision, Number(f.input.expectedRevision) + 1);
  assert.equal(reply.resultingAuthorityEpoch, f.input.expectedAuthorityEpoch);
  const operation = f.raw.prepare("SELECT created_at FROM workflow_operations").get() as { created_at: string };
  const authority = f.raw.prepare("SELECT revision, authority_epoch, updated_at FROM project_authority").get() as { revision: number; authority_epoch: number; updated_at: string };
  assert.equal(authority.revision, reply.resultingRevision);
  assert.equal(authority.authority_epoch, reply.resultingAuthorityEpoch);
  assert.equal(authority.updated_at, operation.created_at);
  assert.equal((f.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workflow_outbox'").get() as { seq: number }).seq, 1);
  assert.equal((f.raw.prepare("SELECT delivery_state FROM workflow_projection_work").get() as { delivery_state: string }).delivery_state, "pending");
  assert.equal(existsSync(join(f.root, ".gsd", "STATE.md")), false);
  for (const table of ["workflow_operations", "workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) {
    assert.equal((f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1, table);
  }
  for (const table of ["workflow_item_lifecycles", "workflow_execution_attempts", "workflow_authority_cutovers"]) {
    assert.equal((f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  assert.equal((f.raw.prepare("SELECT status FROM workers").get() as { status: string }).status, "stopping");
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM milestone_leases").get() as { n: number }).n, 1);
  assert.equal(f.host.apply({ sealId }).status, "replayed");
  assert.equal(f.host.receipt({ sealId }).status, "replayed");
  const json = JSON.stringify(reply);
  for (const privateValue of [f.root, hostname(), "raw-worker-secret", "raw-fence-secret"]) assert.equal(json.includes(privateValue), false);
  f.host.close();
  assert.equal(f.host.apply({ sealId }).status, "refused");
  f.host.close();
  const reopened = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(reopened.receipt({ sealId }).status, "replayed");
  assert.equal(reopened.apply({ sealId }).status, "refused");
  reopened.close();
});

test("missing and unbound databases refuse without creation or implicit admission", (t) => {
  const root = mkdtempSync(join(tmpdir(), "w067-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = openCoordinationMaintenanceHost({ projectDir: root });
  assert.equal(missing.prepare({}).status, "refused");
  missing.close();
  const f = fixture(t);
  f.host.close();
  f.raw.prepare("UPDATE project_authority SET project_root_realpath = ''").run();
  const host = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(host.prepare(f.input).status, "refused");
  host.close();
  assert.equal(getDbOrNull(), null);
});

for (const [label, sql] of [
  ["empty target", "DELETE FROM milestone_leases"],
  ["changed fencing token", "UPDATE milestone_leases SET fencing_token = fencing_token + 1"],
  ["changed heartbeat", "UPDATE workers SET last_heartbeat_at = '2001-01-01T00:00:00.000Z'"],
  ["live owner", `UPDATE workers SET pid = ${process.pid}`],
  ["foreign owner", "UPDATE workers SET host = 'other-host'"],
  ["unknown PID", "UPDATE workers SET pid = 0"],
  ["non-stopping owner", "UPDATE workers SET status = 'running'"],
  ["future expiry", "UPDATE milestone_leases SET expires_at = '2099-01-01T00:00:00.000Z'"],
  ["revision fence", "UPDATE project_authority SET revision = revision + 1"],
  ["wrong root", "UPDATE project_authority SET project_root_realpath = '/foreign-root'"],
  ["old schema", "DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)"],
  ["new schema", "INSERT INTO schema_version VALUES (999, 1)"],
] as const) {
  test(`apply refuses ${label} after prepare, without receipt`, (t) => {
    const f = fixture(t);
    const sealId = prepare(f);
    f.raw.exec(sql);
    assert.equal(f.host.apply({ sealId }).status, "refused");
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get() as { n: number }).n, 0);
  });
}

test("startup schema hook cannot capture or mutate the private maintenance adapter", (t) => {
  const f = fixture(t);
  t.after(() => _setStartupSchemaDetectionForTest(null));
  let hookCalls = 0;
  let captured = false;
  const registerHook = () => _setStartupSchemaDetectionForTest(() => {
    hookCalls++;
    _setStartupSchemaDetectionForTest(null);
    try {
      const db = getDb();
      captured = true;
      db.prepare("UPDATE milestone_leases SET expires_at = '2099-01-01T00:00:00Z' WHERE milestone_id = 'M001'").run();
    } catch { /* Ordinary access must refuse even in startup callbacks. */ }
  });
  registerHook();
  const prepared = f.host.prepare(f.input);
  assert.equal(captured, false, "startup hook obtained the private writable adapter before receipt transaction");
  assert.equal(prepared.status, "prepared");
  registerHook();
  assert.equal(f.host.apply({ sealId: prepared.sealId }).status, "committed");
  assert.equal(captured, false);
  assert.equal(hookCalls, 0);
  assert.equal(f.raw.prepare("SELECT expires_at FROM milestone_leases WHERE milestone_id = 'M001'").get()?.expires_at, f.witness.leaseExpiresAt);
});

test("two genuinely held leases refuse as target ambiguity", (t) => {
  const f = fixture(t);
  f.raw.exec("INSERT INTO milestones (id, title, status) VALUES ('M002', 'Other', 'active'); INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, status, acquired_at, expires_at) VALUES ('M002', 'raw-worker-secret', 8, 'held', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')");
  assert.equal(f.host.prepare(f.input).status, "refused");
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM milestone_leases WHERE status = 'held'").get()?.n, 2);
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM workflow_operations").get()?.n, 0);
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("dead local stopping and crashed workers do not block maintenance", (t) => {
  const f = fixture(t);
  const stamp = new Date().toISOString();
  for (const [workerId, status] of [["previous-stopping", "stopping"], ["previous-crashed", "crashed"]] as const) {
    f.raw.prepare(`INSERT INTO workers (
      worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workerId, f.witness.ownerPid, hostname(), stamp, stamp, status, "test", f.root);
  }
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
  assert.equal(released(f), "released");
});

test("live local stopping worker still blocks maintenance", (t) => {
  const f = fixture(t);
  const stamp = new Date().toISOString();
  const sealId = prepare(f);
  f.raw.prepare(`INSERT INTO workers (
    worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("live-stopping", process.pid, hostname(), stamp, stamp, "stopping", "test", f.root);
  assert.equal(f.host.apply({ sealId }).status, "refused");
  assert.equal(released(f), "held");
});

test("remote crashed worker remains unprobeable and blocks maintenance", (t) => {
  const f = fixture(t);
  const stamp = new Date().toISOString();
  const sealId = prepare(f);
  f.raw.prepare(`INSERT INTO workers (
    worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("remote-crashed", f.witness.ownerPid, "unprobeable-remote-host", stamp, stamp, "crashed", "test", f.root);
  assert.equal(f.host.apply({ sealId }).status, "refused");
  assert.equal(released(f), "held");
});

test("stale local maintenance intent is recovered before the write fence", (t) => {
  const f = fixture(t);
  const marker = databaseMaintenanceIntentPath(f.path);
  f.host.close();
  fs.writeFileSync(marker, JSON.stringify({
    schemaVersion: 1,
    ownerPid: f.witness.ownerPid,
    ownerProcessStartIdentity: `sha256:${"0".repeat(64)}`,
    ownerNonce: "00000000-0000-4000-8000-000000000001",
  }), { mode: 0o600 });

  const recovered = openCoordinationMaintenanceHost({ projectDir: f.root });
  recovered.close();
  assert.equal(fs.existsSync(marker), false);
});

test("ambiguous leases and other active workers refuse", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  f.raw.exec("INSERT INTO workers (worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath) SELECT 'other-worker', pid, host, started_at, last_heartbeat_at, 'running', 'test', project_root_realpath FROM workers LIMIT 1");
  assert.equal(f.host.apply({ sealId }).status, "refused");
  assert.equal(released(f), "held");
  f.raw.exec("UPDATE workers SET status = 'stopping' WHERE worker_id = 'other-worker'; INSERT INTO milestones (id, title, status, created_at) VALUES ('M002', 'Other', 'active', '2026-01-01'); INSERT INTO milestone_leases SELECT 'M002', 'other-worker', 4, acquired_at, expires_at, 'held' FROM milestone_leases LIMIT 1");
  assert.equal(f.host.apply({ sealId }).status, "refused");
});

for (const status of ["pending", "claimed", "running"]) {
  test(`competing ${status} dispatch refuses the real transaction`, (t) => {
    const f = fixture(t);
    const sealId = prepare(f);
    f.raw.prepare("INSERT INTO unit_dispatches (trace_id, worker_id, milestone_lease_token, milestone_id, unit_type, unit_id, status, started_at) VALUES ('trace', 'raw-worker-secret', 3, 'M001', 'execute-task', 'M001/S01/T01', ?, ?)").run(status, new Date().toISOString());
    assert.equal(f.host.apply({ sealId }).status, "refused");
    assert.equal(released(f), "held");
  });
}

test("lost response reuses only the same private seal; receipt lookup works after host loss", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  // Ignore the first response as if transport delivery was lost after COMMIT.
  f.host.apply({ sealId });
  assert.equal(released(f), "released");
  assert.equal(f.host.apply({ sealId }).status, "replayed");
  f.host.close();
  const next = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(next.receipt({ sealId }).status, "replayed");
  assert.equal(next.apply({ sealId }).status, "refused");
  next.close();
});

test("lost uncommitted seal cannot reconstruct a target", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  f.host.close();
  const next = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(next.receipt({ sealId }).status, "refused");
  assert.equal(next.apply({ sealId }).status, "refused");
  next.close();
  assert.equal(released(f), "held");
});

test("replacement identity refuses, then closes deterministically", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  renameSync(f.path, `${f.path}.old`);
  copyFileSync(`${f.path}.old`, f.path);
  assert.equal(f.host.apply({ sealId }).status, "refused");
  f.host.close();
  f.host.close();
});

test("fixed shapes reject capabilities, raw targets and arbitrary request fields", (t) => {
  const f = fixture(t);
  assert.equal(f.host.prepare({ ...f.input, actorId: "operator" }).status, "refused");
  const sealId = prepare(f);
  assert.equal(f.host.prepare(f.input).status, "refused");
  assert.equal(f.host.apply({ sealId, digest: "sha256:fake" }).status, "refused");
  assert.equal(f.host.receipt({ sealId, sql: "SELECT 1" }).status, "refused");
  assert.equal(f.host.apply({ sealId: "00000000-0000-0000-0000-000000000000" }).status, "refused");
});

test("generic domain executor reserves the fixed maintenance operation", (t) => {
  const f = fixture(t);
  assert.throws(() => executeDomainOperation({ operationType: "coordination.expired-lease.release", idempotencyKey: "fake", expectedRevision: 0, expectedAuthorityEpoch: 0, actorType: "system", sourceTransport: "native", payload: {} }, () => ({ events: [], projections: [] })), /maintenance/);
  assert.equal(released(f), "held");
});

test("rollback preserves private identity and permits exact same-host retry", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  f.raw.exec("CREATE TRIGGER fixture_abort_outbox BEFORE INSERT ON workflow_outbox BEGIN SELECT RAISE(ABORT, 'fixture outbox refusal'); END");
  assert.equal(f.host.apply({ sealId }).status, "refused");
  assert.equal(released(f), "held");
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get() as { n: number }).n, 0);
  f.raw.exec("DROP TRIGGER fixture_abort_outbox");
  assert.equal(f.host.apply({ sealId }).status, "committed");
});

test("prepare rejects an empty candidate set and wrong epoch", (t) => {
  const f = fixture(t);
  assert.equal(f.host.prepare({ ...f.input, expectedAuthorityEpoch: Number(f.input.expectedAuthorityEpoch) + 1 }).status, "refused");
  f.raw.exec("UPDATE milestone_leases SET status = 'released'");
  assert.equal(f.host.prepare(f.input).status, "refused");
});

test("receipt provenance is verified, and a replacement file cannot inherit its binding", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
  const actor = (f.raw.prepare("SELECT actor_id FROM workflow_operations").get() as { actor_id: string }).actor_id;
  f.raw.exec("UPDATE workflow_operations SET actor_id = 'native-maintenance:forged'");
  assert.equal(f.host.receipt({ sealId }).status, "refused");
  f.raw.prepare("UPDATE workflow_operations SET actor_id = ?").run(actor);
  assert.equal(f.host.receipt({ sealId }).status, "replayed");
  f.host.close();
  f.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  renameSync(f.path, `${f.path}.old`);
  copyFileSync(`${f.path}.old`, f.path);
  const next = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(next.receipt({ sealId }).status, "refused");
  assert.equal(next.apply({ sealId }).status, "refused");
  next.close();
});

test("historical lease rows survive the one-target update", (t) => {
  const f = fixture(t);
  f.raw.exec("INSERT INTO milestones (id, title, status, created_at) VALUES ('M002', 'History', 'active', '2026-01-01'); INSERT INTO milestone_leases SELECT 'M002', worker_id, 2, acquired_at, expires_at, 'released' FROM milestone_leases LIMIT 1");
  const before = f.raw.prepare("SELECT * FROM milestone_leases WHERE milestone_id = 'M002'").get();
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
  assert.deepEqual(f.raw.prepare("SELECT * FROM milestone_leases WHERE milestone_id = 'M002'").get(), before);
});

test("a fabricated maintenance request is rejected before touching its adapter", (t) => {
  const f = fixture(t);
  let reads = 0;
  const untrusted = new Proxy({}, { get() { reads++; throw new Error("untrusted adapter read"); } });
  assert.throws(() => _executeCoordinationMaintenanceDomainOperation(untrusted as never, untrusted as never, untrusted as never), /maintenance ownership required/);
  assert.equal(reads, 0);
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
});

test("PID and filesystem observers cannot reenter public access or admission", (t) => {
  const f = fixture(t);
  const kill = process.kill;
  const realpath = fs.realpathSync;
  let observations = 0;
  let callbacks = 0;
  const observe = () => {
    observations++;
    for (const getter of [getDb, getDbOrNull, _getAdapter]) assert.throws(getter);
    assert.throws(() => openDatabase(f.path));
    assert.throws(() => immediateTransaction(() => { callbacks++; }));
    assert.throws(() => _executeCoordinationMaintenanceDomainOperation({} as never, {} as never, {} as never), /maintenance ownership required/);
  };
  process.kill = ((...args: Parameters<typeof process.kill>) => { observe(); return kill(...args); }) as typeof process.kill;
  fs.realpathSync = Object.assign(((...args: Parameters<typeof fs.realpathSync>) => { observe(); return realpath(...args); }) as typeof fs.realpathSync, realpath);
  syncBuiltinESMExports();
  try {
    const sealId = prepare(f);
    assert.equal(f.host.apply({ sealId }).status, "committed");
    assert.equal(f.host.receipt({ sealId }).status, "replayed");
  } finally {
    process.kill = kill;
    fs.realpathSync = realpath;
    syncBuiltinESMExports();
  }
  assert.ok(observations > 0);
  assert.equal(callbacks, 0);
});

test("provider close failure retains refusal until cleanup succeeds", (t) => {
  const f = fixture(t);
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { throw new Error("fixture close failure"); };
  try {
    assert.throws(() => f.host.close(), /fixture close failure/);
    assert.throws(() => getDbOrNull());
    assert.equal(f.host.prepare(f.input).status, "refused");
  } finally { DatabaseSync.prototype.close = close; }
  f.host.close();
  assert.equal(getDbOrNull(), null);
});

test("rollback breakage is surfaced and poisons the host, without partial writes", (t) => {
  const f = fixture(t);
  const sealId = prepare(f);
  f.raw.exec("CREATE TRIGGER fixture_abort_outbox BEFORE INSERT ON workflow_outbox BEGIN SELECT RAISE(ABORT, 'fixture outbox refusal'); END");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql === "ROLLBACK") throw new Error("fixture rollback failure");
    return exec.call(this, sql);
  };
  try {
    assert.throws(() => f.host.apply({ sealId }), AggregateError);
    assert.equal(f.host.apply({ sealId }).status, "refused");
    assert.throws(() => getDbOrNull());
  } finally { DatabaseSync.prototype.exec = exec; }
  f.host.close();
  assert.equal(released(f), "held");
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM workflow_operations").get()?.n, 0);
});

test("request accessors are rejected and Proxy traps never see the private adapter", (t) => {
  const f = fixture(t);
  let getterCalls = 0;
  const accessor = { ...f.input };
  Object.defineProperty(accessor, "expectedRevision", { enumerable: true, get() { getterCalls++; return f.input.expectedRevision; } });
  assert.equal(f.host.prepare(accessor).status, "refused");
  assert.equal(getterCalls, 0);
  let traps = 0;
  const proxy = new Proxy(f.input, {
    ownKeys(target) { traps++; assert.throws(() => getDbOrNull()); assert.throws(() => getDb()); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { traps++; assert.throws(() => getDbOrNull()); assert.throws(() => getDb()); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const prepared = f.host.prepare(proxy);
  assert.equal(prepared.status, "prepared");
  assert.ok(traps > 0);
  assert.equal(f.host.apply({ sealId: prepared.sealId }).status, "committed");
});

test("maintenance fence excludes a competing host and never replaces an admitted adapter", (t) => {
  const f = fixture(t);
  const competing = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(competing.prepare(f.input).status, "refused");
  competing.close();
  const sealId = prepare(f);
  assert.equal(f.host.apply({ sealId }).status, "committed");
  f.host.close();
  assert.equal(openDatabase(f.path), true);
  const admitted = _getAdapter();
  const late = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(late.prepare(f.input).status, "refused");
  assert.equal(_getAdapter(), admitted);
  late.close();
});

for (const state of ["claimed", "running"] as const) {
  test(`pre-existing ${state} Attempt refuses even with a terminal dispatch`, (t) => {
    const f = fixture(t, state);
    const sealId = prepare(f);
    const before = f.raw.prepare("SELECT * FROM workflow_execution_attempts").all();
    assert.equal(f.raw.prepare("SELECT 1 FROM unit_dispatches WHERE status IN ('pending', 'claimed', 'running')").get(), undefined);
    assert.equal(f.host.apply({ sealId }).status, "refused");
    assert.equal(released(f), "held");
    assert.deepEqual(f.raw.prepare("SELECT * FROM workflow_execution_attempts").all(), before);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get() as { n: number }).n, 1);
    assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("foreign application identity and wrong exact witness fail closed", (t) => {
  const f = fixture(t);
  assert.equal(f.host.prepare({ ...f.input, witness: { ...f.witness, ownerHeartbeatAt: "invalid" } }).status, "refused");
  assert.equal(f.host.prepare({ ...f.input, witness: { ...f.witness, ownerPid: process.pid } }).status, "refused");
  f.host.close();
  f.raw.exec("PRAGMA application_id = 1");
  const foreign = openCoordinationMaintenanceHost({ projectDir: f.root });
  assert.equal(foreign.prepare(f.input).status, "refused");
  foreign.close();
});




test("maintenance schema assessment cannot expose or mutate its private adapter", (t) => {
  const f = fixture(t);
  let called = false;
  let captured: unknown;
  _setStartupSchemaDetectionForTest(() => {
    called = true;
    _setStartupSchemaDetectionForTest(null);
    captured = getDb();
    (captured as ReturnType<typeof getDb>).prepare("UPDATE milestone_leases SET status = 'released' WHERE id = 'lease-a'").run();
  });
  try {
    const prepared = f.host.prepare(f.input) as { status: string };
    assert.equal(prepared.status, "prepared");
    assert.equal(called, false);
    assert.equal(captured, undefined);
  } finally { _setStartupSchemaDetectionForTest(null); }
});
