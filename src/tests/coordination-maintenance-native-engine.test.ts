// Real source-bootstrap + real owned-engine integration; temporary fixtures only.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _getAdapter, closeDatabase, openDatabase } from "../resources/extensions/gsd/gsd-db.ts";
import { databaseMaintenanceIntentPath } from "../resources/extensions/gsd/database-maintenance-fence.ts";
import { MAINTENANCE_LIMITS } from "../coordination-maintenance-limits.ts";

// The fixture watchdog must allow the fixed native supervisor to enforce its own
// lifetime and bounded cleanup. A separate 20s cutoff killed cold, guarded hosts
// before their 60s production budget elapsed and hid the actual terminal result.
const hostWatchdogMs = MAINTENANCE_LIMITS.lifetimeMs + 3 * MAINTENANCE_LIMITS.cleanupMs;

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = packageRoot.endsWith("dist-test") ? dirname(packageRoot) : packageRoot;
const packagedBootstrap = join(repositoryRoot, "dist/bootstrap.js");
const fixtureWorker = "native-integration-fixture-owner";
type OwnedChild = { child: ChildProcessWithoutNullStreams; exited: Promise<number | null>; output: string; errors: string };

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w067-native-engine-")));
  const children: OwnedChild[] = [];
  let raw: DatabaseSync | undefined;
  t.after(async () => {
    for (const owned of children) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
      await owned.exited.catch(() => {});
    }
    raw?.close();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".gsd"));
  const path = join(root, ".gsd", "gsd.db");
  const ended = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(ended.status, 0);
  assert.ok(ended.pid > 0);
  const now = Date.now();
  const witness = {
    ownerPid: ended.pid,
    ownerStartedAt: new Date(now - 4000).toISOString(),
    ownerHeartbeatAt: new Date(now - 3000).toISOString(),
    leaseAcquiredAt: new Date(now - 2000).toISOString(),
    leaseExpiresAt: new Date(now - 1000).toISOString(),
  };
  assert.equal(openDatabase(path), true);
  const db = _getAdapter()!;
  db.prepare("UPDATE project_authority SET project_root_realpath = ? WHERE singleton = 1").run(root);
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES ('M001', 'Unadopted native fixture', 'active', ?)").run(now);
  db.prepare(`INSERT INTO workers (worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath)
    VALUES (?, ?, ?, ?, ?, 'stopping', 'fixture', ?)`).run(fixtureWorker, ended.pid, hostname(), witness.ownerStartedAt, witness.ownerHeartbeatAt, root);
  db.prepare(`INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, status, acquired_at, expires_at)
    VALUES ('M001', ?, 17, 'held', ?, ?)`).run(fixtureWorker, witness.leaseAcquiredAt, witness.leaseExpiresAt);
  const authority = db.prepare("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1").get()!;
  closeDatabase();
  raw = new DatabaseSync(path, { readOnly: true });
  return { root, raw, children, input: { expectedRevision: authority.revision, expectedAuthorityEpoch: authority.authority_epoch, witness } };
}

function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
  const tables: Record<string, unknown[]> = {};
  for (const entry of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()) {
    const name = String(entry.name);
    const quoted = `"${name.replaceAll('"', '""')}"`;
    tables[name] = db.prepare(`SELECT * FROM ${quoted}`).all().map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return { schema, tables };
}

function nativeHost(f: ReturnType<typeof fixture>, packaged = false) {
  const home = mkdtempSync(join(f.root, "host-"));
  const loader = join(home, "no-normal-startup.mjs");
  const guard = join(home, "guard.mjs");
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (((context.parentURL?.endsWith('/src/bootstrap.ts') || context.parentURL?.endsWith('/dist/bootstrap.js')) && specifier === './loader.js') || specifier.endsWith('/cli.js') || specifier === './cli.js') {
      process.stderr.write('FORBIDDEN_ORDINARY_STARTUP\\n'); throw new Error('blocked');
    }
    return next(specifier, context);
  }`);
  writeFileSync(guard, `import fs from 'node:fs';
    import { resolve, dirname, basename, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { syncBuiltinESMExports, register } from 'node:module';
    const allowed = ${JSON.stringify(f.root)};
    const writableDescriptors = new Set();
    function check(value) {
      if (typeof value === 'number') {
        if (writableDescriptors.has(value)) return;
        process.stderr.write('FORBIDDEN_UNTRACKED_DESCRIPTOR_WRITE\\n'); throw new Error('untracked descriptor write');
      }
      let path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
      const suffix = [];
      while (!fs.existsSync(path)) { suffix.unshift(basename(path)); const parent = dirname(path); if (parent === path) break; path = parent; }
      path = resolve(fs.realpathSync(path), ...suffix);
      if (path !== allowed && !path.startsWith(allowed + sep)) {
        process.stderr.write('FORBIDDEN_OUTSIDE_FIXTURE_WRITE\\n'); throw new Error('blocked');
      }
    }
    const originalOpen = fs.openSync;
    fs.openSync = (path, flags, ...rest) => {
      const writing = typeof flags === 'string' ? /[wa+]/.test(flags) : Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
      if (writing) check(path);
      const fd = originalOpen(path, flags, ...rest);
      if (writing) writableDescriptors.add(fd);
      return fd;
    };
    const originalClose = fs.closeSync;
    fs.closeSync = fd => { writableDescriptors.delete(fd); return originalClose(fd); };
    for (const [name, indices] of Object.entries({mkdirSync:[0],symlinkSync:[1],cpSync:[1],rmSync:[0],writeFileSync:[0],copyFileSync:[1],renameSync:[0,1],unlinkSync:[0],rmdirSync:[0]})) {
      const original = fs[name]; fs[name] = (...args) => { for (const index of indices) check(args[index]); return original(...args); };
    }
    syncBuiltinESMExports();
    register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const tsx = packaged ? undefined : createRequire(import.meta.url).resolve("tsx");
  const bootstrap = packaged ? packagedBootstrap : join(packageRoot, "src/bootstrap.ts");
  const preloadArgs = packaged ? ["--import", pathToFileURL(guard).href] : ["--import", pathToFileURL(tsx!).href, "--import", pathToFileURL(guard).href];
  const startedAt = Date.now();
  const child = spawn(process.execPath, [...preloadArgs, bootstrap, "coordination-maintenance", "--project", f.root, "--json"], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, GSD_HOME: join(home, "gsd"), GSD_AGENT_DIR: join(home, "agent"), TMPDIR: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const owned: OwnedChild = { child, exited: Promise.resolve(null), output: "", errors: "" };
  owned.exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
  void owned.exited.catch(() => {});
  f.children.push(owned);
  const deadline = setTimeout(() => child.kill("SIGKILL"), hostWatchdogMs);
  void owned.exited.finally(() => clearTimeout(deadline)).catch(() => {});
  child.stdout.on("data", chunk => { owned.output += chunk.toString(); if (Buffer.byteLength(owned.output) > 131_072) child.kill("SIGKILL"); });
  child.stderr.on("data", chunk => { owned.errors += chunk.toString(); if (Buffer.byteLength(owned.errors) > 131_072) child.kill("SIGKILL"); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let request = 0;
  return {
    owned,
    async send(command: "prepare" | "apply" | "receipt", input: unknown) {
      const requestId = `integration-${++request}`;
      const next = iterator.next();
      child.stdin.write(JSON.stringify({ requestId, command, input }) + "\n");
      const line = await next;
      assert.equal(line.done, false, `native protocol closed without a reply: exit=${child.exitCode} signal=${child.signalCode} elapsedMs=${Date.now() - startedAt} stderr=${owned.errors}`);
      const frame = JSON.parse(line.value!);
      assert.equal(frame.requestId, requestId);
      return frame.result as Record<string, unknown>;
    },
    async finish(code = 0) {
      child.stdin.end();
      assert.equal(await owned.exited, code, owned.errors);
      assert.doesNotMatch(owned.errors, /FORBIDDEN_|ERR_MODULE/);
      for (const privateValue of [f.root, fixtureWorker, hostname()]) assert.equal(owned.output.includes(privateValue), false);
      assert.doesNotMatch(owned.output, /fencing_token|fencingToken|worker_id|workerId|project_root_realpath/);
      lines.close();
    },
  };
}

test("real native bootstrap commits one sealed lease with a complete receipt, then only replays", { timeout: 3 * hostWatchdogMs + 10_000 }, async t => {
  const f = fixture(t);
  const before = snapshot(f.raw);
  const host = nativeHost(f);
  const prepared = await host.send("prepare", f.input);
  assert.doesNotMatch(host.owned.errors, /FORBIDDEN_/);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(typeof prepared.sealId, "string");
  const committed = await host.send("apply", { sealId: prepared.sealId });
  assert.equal(committed.status, "committed", JSON.stringify(committed));
  const afterCommit = snapshot(f.raw);
  assert.deepEqual(afterCommit.schema, before.schema);
  const changed = Object.keys(before.tables).filter(name => JSON.stringify(before.tables[name]) !== JSON.stringify(afterCommit.tables[name]));
  assert.deepEqual(changed, ["milestone_leases", "project_authority", "sqlite_sequence", "workflow_domain_events", "workflow_operations", "workflow_outbox", "workflow_projection_work"].sort());
  assert.deepEqual(afterCommit.tables.milestone_leases, before.tables.milestone_leases.map(row => ({ ...row as object, status: "released" })));
  const authority = f.raw.prepare("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1").get()!;
  assert.equal(authority.revision, Number(f.input.expectedRevision) + 1);
  assert.equal(authority.authority_epoch, f.input.expectedAuthorityEpoch);
  const operation = f.raw.prepare("SELECT created_at FROM workflow_operations").get()!;
  assert.deepEqual(afterCommit.tables.project_authority, before.tables.project_authority.map(row => ({
    ...row as object, revision: Number(f.input.expectedRevision) + 1, updated_at: operation.created_at,
  })));
  for (const name of ["workflow_operations", "workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) {
    assert.equal(afterCommit.tables[name].length, before.tables[name].length + 1);
  }
  const projection = f.raw.prepare("SELECT delivery_state, projection_kind, source_project_revision, source_authority_epoch FROM workflow_projection_work").get()!;
  assert.deepEqual({ ...projection }, {
    delivery_state: "pending", projection_kind: "state",
    source_project_revision: Number(f.input.expectedRevision) + 1, source_authority_epoch: f.input.expectedAuthorityEpoch,
  });
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.raw.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  assert.equal((await host.send("apply", { sealId: prepared.sealId })).status, "replayed");
  assert.equal((await host.send("receipt", { sealId: prepared.sealId })).status, "replayed");
  await host.finish();
  assert.deepEqual(snapshot(f.raw), afterCommit);

  const receiptHost = nativeHost(f);
  assert.equal((await receiptHost.send("receipt", { sealId: prepared.sealId })).status, "replayed");
  await receiptHost.finish();
  assert.deepEqual(snapshot(f.raw), afterCommit);

  const lostSealHost = nativeHost(f);
  assert.equal((await lostSealHost.send("apply", { sealId: prepared.sealId })).status, "refused");
  await lostSealHost.finish(1);
  assert.deepEqual(snapshot(f.raw), afterCommit);
});

test("backend closes maintenance ownership after its IPC parent disappears", { timeout: 2 * hostWatchdogMs + 10_000 }, async t => {
  const f = fixture(t);
  const host = nativeHost(f);
  const prepared = await host.send("prepare", f.input);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const marker = databaseMaintenanceIntentPath(join(f.root, ".gsd", "gsd.db"));
  assert.ok(existsSync(marker), "prepare must hold maintenance ownership");
  const ownerPid = Number((JSON.parse(readFileSync(marker, "utf8")) as { ownerPid: number }).ownerPid);
  assert.ok(ownerPid > 0);
  t.after(() => {
    try { process.kill(ownerPid, "SIGKILL"); } catch { /* The cleanup path already reaped it. */ }
  });

  host.owned.child.kill("SIGKILL");
  await host.owned.exited;
  const deadline = Date.now() + MAINTENANCE_LIMITS.cleanupMs * 3 + 1_000;
  while (existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(existsSync(marker), false, "disconnect cleanup must release the maintenance intent");
  let ownerAlive = true;
  const ownerExitDeadline = Date.now() + MAINTENANCE_LIMITS.cleanupMs * 5;
  while (ownerAlive && Date.now() < ownerExitDeadline) {
    try { process.kill(ownerPid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false;
      else throw error;
    }
    if (ownerAlive) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ownerAlive, false, "disconnected backend must exit after cleanup");
});

test("packaged bootstrap loads the copied resource and commits a maintenance receipt", { skip: !existsSync(packagedBootstrap), timeout: 2 * hostWatchdogMs + 10_000 }, async t => {
  const f = fixture(t);
  const host = nativeHost(f, true);
  const prepared = await host.send("prepare", f.input);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(typeof prepared.sealId, "string");
  const applied = await host.send("apply", { sealId: prepared.sealId });
  assert.equal(applied.status, "committed", JSON.stringify(applied));
  assert.equal((await host.send("receipt", { sealId: prepared.sealId })).status, "replayed");
  await host.finish();
  assert.equal((f.raw.prepare("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").get() as { status: string }).status, "released");
});
