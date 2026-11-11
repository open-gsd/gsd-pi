// Temporary fixtures only. Never opens a project database or workflow engine.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createDbAdapter } from "../db-adapter.ts";
import { createCoordinationTablesV24 } from "../db-coordination-schema.ts";
import { inspectCutoverCoordination, type CoordinationObservations } from "../cutover-coordination-inspection.ts";
import { readCutoverCoordination, observeLocalPid, registerCutoverCoordinationRead } from "../cutover-coordination-runtime-read.ts";
import { inspectSqliteReadOnlySnapshot, _setSqliteReadOnlyOpenBoundaryForTest } from "../sqlite-readonly.ts";

const now = "2026-11-11T12:00:00.000Z";
const observations: CoordinationObservations = {
  now, localHost: "private-host", selfPid: 101, aliasScope: "response-one",
  observePid: () => "absent-at-probe", pidObservationTime: () => now,
};
function fixture(t: test.TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "w067-observer-")));
  mkdirSync(join(cwd, ".gsd"));
  const path = join(cwd, ".gsd", "gsd.db");
  const db = createDbAdapter(new DatabaseSync(path));
  t.after(() => { db.close(); rmSync(cwd, { recursive: true, force: true }); });
  // Coordination DDL references milestones; orphan rows are deliberate diagnostic fixtures.
  db.exec("PRAGMA foreign_keys=OFF");
  createCoordinationTablesV24(db);
  db.exec(`CREATE TABLE project_authority (singleton INTEGER PRIMARY KEY, project_id TEXT,
    project_root_realpath TEXT, revision INTEGER, authority_epoch INTEGER);
    CREATE TABLE workflow_execution_attempts (attempt_id TEXT PRIMARY KEY, worker_id TEXT, attempt_state TEXT);`);
  db.prepare("INSERT INTO project_authority VALUES (1, 'private-project', ?, 7, 3)").run(cwd);
  function worker(id: string, status = "active", root = cwd, host = "private-host", pid = 123) {
    db.prepare("INSERT INTO workers VALUES (?, ?, ?, ?, 'test', ?, ?, ?)").run(id, host, pid, now, now, status, root);
  }
  function lease(id: string, owner: string, status = "held", expiry = "2000-01-01T00:00:00Z") {
    db.prepare("INSERT INTO milestone_leases VALUES (?, ?, 1, ?, ?, ?)").run(id, owner, now, expiry, status);
  }
  function dispatch(id: number, status: string) {
    db.prepare(`INSERT INTO unit_dispatches (id, trace_id, worker_id, milestone_lease_token,
      milestone_id, unit_type, unit_id, status, started_at) VALUES (?, 'private-trace', 'owner', 1,
      'private-milestone', 'task', ?, ?, ?)`).run(id, `private-task-${id}`, status, now);
  }
  const inspect = (limit = 10, obs = observations) => inspectSqliteReadOnlySnapshot(path,
    (read) => inspectCutoverCoordination(read, cwd, limit, obs));
  return { cwd, path, db, worker, lease, dispatch, inspect };
}
function rows(result: ReturnType<ReturnType<typeof fixture>["inspect"]>, category: string) {
  return result.samples[category]!.rows as Record<string, any>[];
}

test("index registers the bounded observer independently of full bootstrap", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const registration = source.indexOf("registerCutoverCoordinationRead(pi)");
  assert.ok(registration > 0, "missing explicit observer registration");
  assert.ok(registration < source.indexOf('import("./bootstrap/register-extension.js")'));
});

test("guard predicates match every current boundary, including expired held leases", (t) => {
  const f = fixture(t);
  for (const status of ["active", "stopping", "stopped", "crashed", "unknown"]) f.worker(status, status);
  f.worker("other-root", "active", "/not-this-checkout");
  f.lease("expired", "stopping");
  f.lease("future", "stopped", "held", "2099-01-01T00:00:00Z");
  f.lease("released", "active", "released");
  f.lease("revoked", "active", "revoked");
  for (const [i, state] of ["claimed", "running", "dispatched", "queued", "ready", "completed", "succeeded", "settled", "failed", "cancelled", "interrupted", "unknown"].entries()) {
    f.dispatch(i + 1, state);
    f.db.prepare("INSERT INTO workflow_execution_attempts VALUES (?, 'stopping', ?)").run(String(i), state);
  }
  const result = f.inspect();
  assert.deepEqual(result.counts, { activeWorkers: 1, heldLeases: 2, activeDispatches: 2, activeAttempts: 2 });
  assert.equal(result.guardBlocked, true);
  assert.deepEqual(rows(result, "heldLeases").map((row) => row.expiry), ["expired", "unexpired"]);
  assert.equal(rows(result, "heldLeases")[0]!.owner.status, "stopping");
  assert.equal(rows(result, "heldLeases")[0]!.owner.pidObservation.observedAt, now);
  const text = JSON.stringify(result);
  for (const secret of [f.cwd, "private-host", "private-project", "private-trace", "private-task", "other-root"]) assert.ok(!text.includes(secret));
});

test("observed timestamps supply a fresh native prepare witness without authorizing repair", (t) => {
  const f = fixture(t);
  f.worker("private-owner", "stopping"); f.lease("private-lease", "private-owner");
  const startedAt = "2025-01-01T00:00:00Z";
  const heartbeatAt = "2025-01-01T00:01:00Z";
  const acquiredAt = "2025-01-01T00:00:30Z";
  const expiresAt = "2025-01-01T00:02:00Z";
  f.db.prepare("UPDATE workers SET started_at = ?, last_heartbeat_at = ?").run(startedAt, heartbeatAt);
  f.db.prepare("UPDATE milestone_leases SET acquired_at = ?, expires_at = ?").run(acquiredAt, expiresAt);
  const result = f.inspect();
  const row = rows(result, "heldLeases")[0]!;
  assert.deepEqual({
    ownerPid: row.owner.pid,
    ownerStartedAt: row.owner.startedAt,
    ownerHeartbeatAt: row.owner.lastHeartbeatAt,
    leaseAcquiredAt: row.acquiredAt,
    leaseExpiresAt: row.expiresAt,
  }, { ownerPid: 123, ownerStartedAt: startedAt, ownerHeartbeatAt: heartbeatAt, leaseAcquiredAt: acquiredAt, leaseExpiresAt: expiresAt });
  assert.equal(result.guardBlocked, true);
  const text = JSON.stringify(result);
  assert.ok(!text.includes("private-owner"));
  assert.ok(!text.includes("private-lease"));
  assert.equal("eligible" in row, false);
  assert.equal("approval" in row, false);

  f.db.prepare("UPDATE workers SET started_at = ?").run("malformed-start");
  f.db.prepare("UPDATE milestone_leases SET acquired_at = ?").run("malformed-acquisition");
  const malformed = rows(f.inspect(), "heldLeases")[0]!;
  assert.equal(malformed.owner.startedAt, null);
  assert.equal(malformed.acquiredAt, null);
  assert.equal(f.inspect().counts.heldLeases, 1);
});

test("a stopping held-only owner blocks, without being counted as an active worker", (t) => {
  const f = fixture(t);
  f.worker("owner", "stopping"); f.lease("expired", "owner");
  assert.deepEqual(f.inspect().counts, { activeWorkers: 0, heldLeases: 1, activeDispatches: 0, activeAttempts: 0 });
  assert.equal(f.inspect().guardBlocked, true);
  f.db.exec("UPDATE milestone_leases SET status = 'released'");
  assert.equal(f.inspect().guardBlocked, false);
});

test("bounded samples retain exact totals and response-local aliases", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    f.worker(`private-worker-${i}`); f.lease(`private-lease-${i}`, `private-worker-${i}`);
    f.dispatch(i + 1, "running");
    f.db.prepare("INSERT INTO workflow_execution_attempts VALUES (?, ?, 'running')").run(String(i), `private-worker-${i}`);
  }
  const result = f.inspect(2);
  for (const sample of Object.values(result.samples)) {
    assert.equal(sample.total, 30); assert.equal(sample.returned, 2);
    assert.equal(sample.omitted, 28); assert.equal(sample.truncated, true);
  }
  const second = f.inspect(2, { ...observations, aliasScope: "response-two" });
  assert.notEqual(rows(result, "activeWorkers")[0]!.worker, rows(second, "activeWorkers")[0]!.worker);
  assert.equal(rows(result, "heldLeases")[0]!.owner.worker, rows(result, "activeWorkers")[0]!.worker);
  assert.ok(JSON.stringify(result).length < 12000);
  assert.equal(f.inspect(25).samples.activeWorkers!.returned, 25);
});

test("native release observations retain stricter competing-worker and pending-dispatch checks", (t) => {
  const f = fixture(t);
  f.worker("owner", "stopping"); f.lease("expired", "owner");
  f.worker("other-stopping", "stopping");
  f.worker("other-remote", "stopping", f.cwd, "remote-host");
  f.worker("other-root", "active", "another-root");
  f.worker("already-stopped", "stopped");
  f.dispatch(1, "pending");
  const report = f.inspect();
  assert.deepEqual(report.counts, { activeWorkers: 0, heldLeases: 1, activeDispatches: 0, activeAttempts: 0 });
  const extra = report.nativeMaintenanceObservations;
  assert.equal(extra.targetOwnerSelection, "one-held-lease");
  assert.equal(extra.otherNonStoppedWorkers.total, 3);
  assert.equal(extra.otherNonStoppedWorkers.staticUnprovableCount, 2);
  assert.equal(extra.otherNonStoppedWorkers.rows.length, 3);
  assert.ok(extra.otherNonStoppedWorkers.rows.some((row) => row.hostRelation === "remote" && row.pidObservation.state === "unknown"));
  assert.ok(extra.otherNonStoppedWorkers.rows.some((row) => row.status === "active" && row.boundRoot === false));
  assert.equal(extra.pendingDispatchCount, 1);
  const bounded = f.inspect(1).nativeMaintenanceObservations.otherNonStoppedWorkers;
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.staticUnprovableCount, 2);
  assert.ok(bounded.rows[0]!.hostRelation === "remote" || bounded.rows[0]!.boundRoot === false);
  assert.equal("eligible" in extra, false);
  f.db.exec("UPDATE milestone_leases SET status = 'released'");
  assert.equal(f.inspect().guardBlocked, false);
  assert.equal(f.inspect().nativeMaintenanceObservations.pendingDispatchCount, 1);
  assert.equal(f.inspect().nativeMaintenanceObservations.targetOwnerSelection, "not-selected");
});

test("PID probes are timestamped observations, not original-owner death conclusions", (t) => {
  const f = fixture(t);
  f.worker("remote", "active", f.cwd, "remote-host");
  f.worker("local"); f.worker("same-pid");
  f.worker("self", "active", f.cwd, "private-host", 101);
  f.worker("bad-pid", "active", f.cwd, "private-host", -1);
  let probes = 0;
  const result = f.inspect(10, { ...observations, observePid: () => { probes++; return "present"; } });
  assert.equal(probes, 1);
  const inventory = rows(result, "activeWorkers");
  assert.equal(inventory.find((row) => row.hostRelation === "remote")!.pidObservation.state, "unknown");
  assert.equal(inventory.find((row) => row.pid === 101)!.pidObservation.state, "self");
  assert.equal(inventory.find((row) => row.pid === null)!.pidObservation.state, "unknown");
  assert.match(result.caveat, /never establish original-owner identity or death/);
  assert.ok(!JSON.stringify(result).includes('"dead"'));
  assert.equal(observeLocalPid(1, () => { throw Object.assign(new Error("private-path"), { code: "ESRCH" }); }), "absent-at-probe");
  assert.equal(observeLocalPid(1, () => { throw Object.assign(new Error(), { code: "EPERM" }); }), "permission-denied");
  assert.equal(observeLocalPid(1, () => { throw new Error("private-path"); }), "unknown");
  assert.equal(observeLocalPid(1, (_pid, signal) => assert.equal(signal, 0)), "present");
  const failed = f.inspect(10, { ...observations, observePid: () => { throw new Error("private-path"); } });
  assert.equal(rows(failed, "activeWorkers").find((row) => row.pid === 123 && row.hostRelation === "local")!.pidObservation.state, "unknown");
});

test("expiry boundaries, stale heartbeats and missing owners never remove held blockers", (t) => {
  const f = fixture(t);
  f.worker("stale");
  f.db.exec("UPDATE workers SET last_heartbeat_at = '2000-01-01T00:00:00Z'");
  f.lease("boundary", "stale", "held", now);
  f.lease("malformed", "missing-owner", "held", "not-a-date");
  const result = f.inspect();
  assert.equal(result.counts.activeWorkers, 1);
  assert.equal(result.counts.heldLeases, 2);
  assert.equal(rows(result, "heldLeases")[0]!.expiry, "expired");
  assert.equal(rows(result, "heldLeases")[1]!.expiry, "unknown");
  assert.equal(rows(result, "heldLeases")[1]!.owner.found, false);
  assert.throws(() => inspectCutoverCoordination(f.db, f.cwd, 10, observations), /query_only_required/);
  const untimed = f.inspect(10, { ...observations, pidObservationTime: () => "not-a-date" });
  assert.deepEqual(rows(untimed, "activeWorkers")[0]!.pidObservation, { state: "unknown", observedAt: null });
});

test("requires an existing project and matching canonical checkout binding", async (t) => {
  const f = fixture(t);
  for (const root of ["", "/another-checkout"]) {
    f.db.prepare("UPDATE project_authority SET project_root_realpath = ?").run(root);
    const result = await readCutoverCoordination({ cwd: f.cwd }, observations);
    assert.deepEqual(result, { operation: "authority_cutover_coordination", error: "database_unavailable_or_incompatible" });
    assert.ok(!JSON.stringify(result).includes(f.cwd));
  }
  f.db.prepare("UPDATE project_authority SET project_root_realpath = ?, project_id = ''").run(f.cwd);
  assert.ok("error" in await readCutoverCoordination({ cwd: f.cwd }, observations));
});

test("absent database is never created and invalid inputs never open SQLite", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "w067-missing-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.ok("error" in await readCutoverCoordination({ cwd }));
  assert.deepEqual(readdirSync(cwd), []);
  mkdirSync(join(cwd, ".gsd"));
  assert.deepEqual(await readCutoverCoordination({ cwd }), { operation: "authority_cutover_coordination", error: "database_missing" });
  assert.deepEqual(readdirSync(join(cwd, ".gsd")), []);
  for (const input of [null, [], {}, { cwd: "." }, { cwd, limit: 0 }, { cwd, limit: 26 }, { cwd, limit: 1.5 }, { cwd, limit: "2" }]) {
    assert.deepEqual(await readCutoverCoordination(input), { operation: "authority_cutover_coordination", error: "invalid_request" });
  }
});

test("existing-file read preserves bytes, directory inventory and authority", async (t) => {
  const f = fixture(t); f.worker("owner"); f.lease("lease", "owner");
  const hash = () => createHash("sha256").update(readFileSync(f.path)).digest("hex");
  const before = hash(); const files = readdirSync(join(f.cwd, ".gsd"));
  const authority = f.db.prepare("SELECT * FROM project_authority").all();
  const result = await readCutoverCoordination({ cwd: f.cwd }, observations);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(hash(), before); assert.deepEqual(readdirSync(join(f.cwd, ".gsd")), files);
  assert.deepEqual(f.db.prepare("SELECT * FROM project_authority").all(), authority);
  assert.throws(() => inspectSqliteReadOnlySnapshot(f.path, (db) => db.exec("DELETE FROM workers")), /readonly|read.only/i);
  assert.equal(hash(), before);
});

test("rejects symlinked database/directories, hardlinks and file identity substitution", async (t) => {
  const f = fixture(t);
  const other = mkdtempSync(join(tmpdir(), "w067-links-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  symlinkSync(join(f.cwd, ".gsd"), join(other, ".gsd"));
  assert.ok("error" in await readCutoverCoordination({ cwd: other }, observations));
  rmSync(join(other, ".gsd")); mkdirSync(join(other, ".gsd"));
  symlinkSync(f.path, join(other, ".gsd", "gsd.db"));
  assert.ok("error" in await readCutoverCoordination({ cwd: other }, observations));
  rmSync(join(other, ".gsd", "gsd.db")); linkSync(f.path, join(other, ".gsd", "gsd.db"));
  assert.ok("error" in await readCutoverCoordination({ cwd: f.cwd }, observations));
  rmSync(join(other, ".gsd", "gsd.db"));
  const backup = join(f.cwd, ".gsd", "original.db");
  _setSqliteReadOnlyOpenBoundaryForTest({ afterRaw: () => {
    renameSync(f.path, backup);
    writeFileSync(f.path, "replacement: private SQL/path");
  } });
  try {
    assert.deepEqual(await readCutoverCoordination({ cwd: f.cwd }, observations), { operation: "authority_cutover_coordination", error: "database_unavailable_or_incompatible" });
  } finally {
    _setSqliteReadOnlyOpenBoundaryForTest(null);
    rmSync(f.path); renameSync(backup, f.path);
  }
});

test("controlled schema/corrupt failures do not invent counts or disclose errors", async (t) => {
  const f = fixture(t);
  f.db.exec("DROP TABLE workflow_execution_attempts");
  assert.deepEqual(await readCutoverCoordination({ cwd: f.cwd }, observations), { operation: "authority_cutover_coordination", error: "database_unavailable_or_incompatible" });
  const cwd = mkdtempSync(join(tmpdir(), "w067-corrupt-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".gsd")); writeFileSync(join(cwd, ".gsd", "gsd.db"), "not sqlite: private data");
  assert.deepEqual(await readCutoverCoordination({ cwd }, observations), { operation: "authority_cutover_coordination", error: "database_unavailable_or_incompatible" });
});

test("registered tool and runtime read use the same bounded existing-file route", async (t) => {
  const f = fixture(t); f.worker("owner");
  const tools: any[] = [];
  const reads = new Map<string, (input: unknown) => Promise<unknown>>();
  registerCutoverCoordinationRead({
    registerTool: (tool: unknown) => tools.push(tool),
    registerRuntimeRead: (name: string, handler: (input: unknown) => Promise<unknown>) => reads.set(name, handler),
  } as any);
  const toolResult = await tools[0].execute("test", { limit: 1 }, undefined, undefined, { cwd: f.cwd });
  const runtimeResult = await reads.get("authority_cutover_coordination")!({ cwd: f.cwd, limit: 1 }) as { counts: unknown };
  assert.deepEqual(toolResult.details.counts, runtimeResult.counts);
  assert.equal(toolResult.details.counts.activeWorkers, 1);
  assert.deepEqual(JSON.parse(toolResult.content[0].text), toolResult.details);
  assert.deepEqual(Object.keys(toolResult.details.counts), ["activeWorkers", "heldLeases", "activeDispatches", "activeAttempts"]);
  assert.ok(!JSON.stringify(toolResult).includes(f.cwd));
});

test("real index keeps the observer registered when full bootstrap fails, without loading writers", () => {
  const indexUrl = new URL("../index.ts", import.meta.url).href;
  const script = `import { registerHooks } from 'node:module';
    const stub = source => ({url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true});
    registerHooks({ resolve(specifier, context, next) {
      // Existing bootstrap seams are isolated; only the new observer graph is real.
      if (specifier === './bootstrap/write-gate.js') return stub('export const ' +
        ['isDepthConfirmationAnswer', 'isDepthVerified', 'isGateQuestionId', 'isQueuePhaseActive', 'setQueuePhaseActive', 'shouldBlockContextWrite', 'shouldBlockPendingGate', 'shouldBlockPendingGateBash', 'shouldBlockQueueExecution', 'setPendingGate', 'clearPendingGate', 'getPendingGate'].map(name => name + ' = () => {}').join(', ') + ';');
      if (specifier === './commands/index.js') return stub('export const registerGSDCommand = pi => pi.registerCommand("gsd", {});');
      if (specifier === './mcp-bridge.js') return stub('export const readProjectBindingFromDbAsync = () => {}; export const readProjectProgressFromDb = () => {}; export const readProjectSnapshotFromDb = () => {};');
      if (specifier === './bootstrap/register-extension.js') throw Error('deliberately unavailable bootstrap');
      if (specifier === './workflow-logger.js') return stub('export const logWarning = () => {};');
      if (/sqlite-readonly|cutover-coordination-inspection|workflow-engine|workflow-command|db-workspace|authority-cutover/.test(specifier)) throw Error('forbidden import: ' + specifier);
      return next(specifier, context);
    }});
    const { default: register } = await import(${JSON.stringify(indexUrl)});
    const tools = []; const reads = []; const commands = [];
    await register({registerCommand: n => commands.push(n), registerTool: t => tools.push(t.name), registerRuntimeRead: n => reads.push(n)});
    if (!commands.includes('gsd') || !tools.includes('gsd_cutover_coordination_inspect') || !reads.includes('authority_cutover_coordination')) process.exit(1);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

test("registration imports neither SQLite nor engine/writers and exposes no adapter", () => {
  const moduleUrl = new URL("../cutover-coordination-runtime-read.ts", import.meta.url).href;
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/sqlite-readonly|cutover-coordination-inspection|workflow-engine|db-workspace|authority-cutover/.test(specifier)) throw Error('forbidden import: ' + specifier);
      return next(specifier, context);
    }});
    const { registerCutoverCoordinationRead } = await import(${JSON.stringify(moduleUrl)});
    const tools = []; const reads = [];
    registerCutoverCoordinationRead({registerTool: t => tools.push(t.name), registerRuntimeRead: n => reads.push(n)});
    if (JSON.stringify(tools) !== '["gsd_cutover_coordination_inspect"]' || JSON.stringify(reads) !== '["authority_cutover_coordination"]') process.exit(1);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const tools: any[] = []; const reads = new Map<string, (input: unknown) => Promise<unknown>>();
  registerCutoverCoordinationRead({ registerTool: (tool: unknown) => tools.push(tool), registerRuntimeRead: (name: string, handler: (input: unknown) => Promise<unknown>) => reads.set(name, handler) } as any);
  assert.equal(tools[0].parameters.additionalProperties, false);
  assert.equal(tools[0].parameters.properties.limit.maximum, 25);
  assert.equal(reads.size, 1);
});
