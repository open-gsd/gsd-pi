// FIXTURE AUTOMATION ONLY: every project root is constructed here under the OS temp directory.
// This does not constitute operator approval and must never target a production project.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { _getAdapter, closeDatabase, openDatabase, getDbOrNull } from "../resources/extensions/gsd/db/engine.ts";
import { attendSameMachineCoordinationMaintenance, openCoordinationMaintenanceHost } from "../resources/extensions/gsd/coordination-maintenance.ts";
import { collectNativeSameMachineFacts, sameNativeMachineFacts, type NativeSameMachineFacts } from "../resources/extensions/gsd/coordination-same-machine-facts.ts";
import { ATTENDED_CAPABILITY_MS, ATTENDED_WRITE_MS, ATTENDED_POLICY, collectMaintenanceReview, maintenanceReviewProof, maintenanceReviewPresentation, maintenanceDigest, maintenanceReviewLine, stableMaintenanceFacts } from "../resources/extensions/gsd/coordination-maintenance-review.ts";
import { createDbAdapter } from "../resources/extensions/gsd/db-adapter.ts";
import { parseCoordinationMaintenanceArgs } from "../coordination-maintenance-cli.ts";

function fixture(t: TestContext, peers = 2) {
  if (NATIVE_SKIP) throw new Error(`native fixture refused: ${NATIVE_SKIP}`);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "w067-attended-FIXTURE-")));
  mkdirSync(join(root, ".gsd"));
  const path = join(root, ".gsd", "gsd.db");
  const boot = collectNativeSameMachineFacts([]).boot;
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(child.status, 0);
  const pid = child.pid;
  const stamp = (offset: number) => new Date(boot.bootLowerBoundMs - offset).toISOString();
  assert.equal(openDatabase(path), true);
  const db = _getAdapter()!;
  db.prepare("UPDATE project_authority SET project_root_realpath = ? WHERE singleton = 1").run(root);
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES ('M001', 'Fixture only', 'active', ?)").run(Date.now());
  const insert = db.prepare("INSERT INTO workers (worker_id, pid, host, started_at, last_heartbeat_at, status, version, project_root_realpath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("selected-fixture-owner", pid, "old-fixture-host", stamp(4000), stamp(1000), "stopping", "fixture", root);
  for (let index = 0; index < peers; index++) insert.run(`peer-${index}`, index % 2 ? process.pid : pid, index % 2 ? "old-fixture-host" : hostname(), stamp(4000), stamp(1000), "crashed", "fixture", root);
  db.prepare("INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, status, acquired_at, expires_at) VALUES ('M001', 'selected-fixture-owner', 3, 'held', ?, ?)").run(stamp(3000), stamp(2000));
  const authority = db.prepare("SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1").get()!;
  closeDatabase();
  const raw = new DatabaseSync(path);
  const adapter = createDbAdapter(raw);
  const file = statSync(path, { bigint: true });
  const schemaVersion = Number(raw.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version);
  // Match the native review's real file binding AND insertion order: maintenanceDigest
  // deliberately seals JSON bytes, not a key-sorted approximation of the snapshot.
  const projectId = String(authority.project_id);
  const binding = maintenanceDigest([root, projectId, schemaVersion, String(file.dev), String(file.ino)]);
  const identity = { root, projectId, binding, schemaVersion, applicationId: Number(raw.prepare("PRAGMA application_id").get()!.application_id) };
  const snapshot = () => collectMaintenanceReview(adapter, identity);
  const workers = () => JSON.stringify(raw.prepare("SELECT * FROM workers ORDER BY worker_id").all());
  const initialWorkers = workers();
  const released = () => raw.prepare("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").get()!.status;
  t.after(() => { raw.close(); closeDatabase(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, raw, snapshot, pid, stamp, workers, initialWorkers, released, authority };
}
function databaseRows(raw: DatabaseSync) {
  const result: Record<string, unknown> = {};
  for (const row of raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()) {
    const name = String(row.name);
    result[name] = raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => ({ ...row }));
  }
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}
function packageCopy(): string {
  const root = realpathSync(process.env.W067_NATIVE_FIXTURE_PACKAGE ?? "missing-isolated-fixture-package");
  assert.ok(root.startsWith(realpathSync(tmpdir()) + "/w067-kernel-package-"), "only isolated package copies are permitted");
  assert.ok(existsSync(join(root, "dist", "bootstrap.js")));
  return root;
}
const ptyDriver = String.raw`
import os,pty,sys,select,time,re,signal,json
node,bootstrap,root,mode,preload,fixturePath=sys.argv[1:]
pid,fd=pty.fork()
if pid==0: os.execv(node,[node]+(['--require',preload] if preload else [])+[bootstrap,'coordination-maintenance','--project',root,'--attended-same-machine'])
output=b''; sent=set(); deadline=time.monotonic()+70; status=None
try:
 while time.monotonic()<deadline:
  readable,_,_=select.select([fd],[],[],0.1)
  if readable:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   output+=data
   if len(output)>3000000: raise RuntimeError('fixture output overflow')
   text=output.decode('utf8','replace')
   for match in re.finditer(r'Type (NEXT [0-9]+) to continue',text):
    value=match.group(1)
    if value not in sent: sent.add(value); os.write(fd,(value+'\n').encode())
   match=re.search(r'type exactly (ATTEST [a-f0-9-]{36} sha256:[a-f0-9]{64})',text)
   if match and 'decision' not in sent:
    sent.add('decision')
    if mode=='disconnect': os.close(fd); fd=-1; break
    if mode=='eof': os.write(fd,b'\x04'); continue
    import sqlite3
    connection=sqlite3.connect(fixturePath,timeout=1)
    connection.execute('BEGIN IMMEDIATE'); connection.rollback()
    if mode=='dirty-heartbeat': connection.execute("UPDATE workers SET last_heartbeat_at = started_at WHERE worker_id = 'peer-0'"); connection.commit()
    if mode=='dirty-revision': connection.execute('UPDATE project_authority SET revision = revision + 1'); connection.commit()
    if mode=='dirty-membership': connection.execute("UPDATE workers SET status = 'stopped' WHERE worker_id = 'peer-0'"); connection.commit()
    connection.close()
    if mode=='dirty-file':
     import shutil
     os.rename(fixturePath,fixturePath+'.old'); shutil.copy2(fixturePath+'.old',fixturePath)
    time.sleep(.15) # Give separate caller tasks a real async review interval in fixtures.
    value='CANCEL' if mode=='cancel' else match.group(1)
    os.write(fd,(value+'\n').encode())
  done,observed=os.waitpid(pid,os.WNOHANG)
  if done: status=observed; break
 else: raise RuntimeError('fixture PTY deadline; bounded fixture tail: '+output[-5000:].decode('utf8','replace'))
finally:
 if fd>=0: os.close(fd)
 if status is None:
  for _ in range(40):
   done,status=os.waitpid(pid,os.WNOHANG)
   if done: break
   status=None; time.sleep(.1)
 if status is None:
  os.killpg(pid,signal.SIGKILL); _,status=os.waitpid(pid,0)
print(json.dumps({'exitCode':os.waitstatus_to_exitcode(status),'output':output.decode('utf8','replace')}))
`;
// No inherited instrumentation, loader flags, NODE_PATH, or credentials in native positives.
// Negative fixtures opt in to precisely one --require argument in the PTY driver.
function fixtureLaunchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TERM: "dumb", NO_COLOR: "1" };
  for (const key of ["TMPDIR", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function attendedFixture(f: ReturnType<typeof fixture>, mode = "confirm", preload = "", entry = join(packageCopy(), "dist", "bootstrap.js")) {
  const child = spawn("python3", ["-c", ptyDriver, process.execPath, entry, f.root, mode, preload, f.path], { stdio: ["ignore", "pipe", "pipe"], env: fixtureLaunchEnv() });
  let output = ""; let errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 0, errors);
  return JSON.parse(output) as { exitCode: number; output: string };
}

// Native PTY/fixture tests need an isolated package copy supplied by the proof runner
// (proof/run-proof.mjs, W067_NATIVE_FIXTURE_PACKAGE). They are skipped in the generic
// runner, where packageCopy() would otherwise refuse. The proof runner executes them.
const NATIVE_SKIP = process.platform !== "darwin"
  ? "native Darwin collector required (fixture drives real native facts)"
  : process.env.W067_NATIVE_FIXTURE_PACKAGE ? false : "isolated fixture package required: run via proof/run-proof.mjs";

test("intent is distinct; flags, JSON, extra callbacks and fabricated grants are not approval", async () => {
  assert.deepEqual(parseCoordinationMaintenanceArgs(["coordination-maintenance", "--project", "/tmp/fixture", "--attended-same-machine"]), { projectDir: "/tmp/fixture", attendedSameMachine: true });
  for (const extra of ["--yes", "--confirmed", "--grant", "--json"]) assert.equal(parseCoordinationMaintenanceArgs(["coordination-maintenance", "--project", "/tmp/fixture", "--attended-same-machine", extra]), null);
  let called = false;
  for (const evidence of [true, { confirmed: true, facts: {} }, () => { called = true; return true; }]) {
    assert.equal((await Reflect.apply(attendSameMachineCoordinationMaintenance, undefined, ["/tmp/fixture", evidence])).status, "refused");
  }
  assert.equal(called, false);
  assert.equal((await Reflect.apply(attendSameMachineCoordinationMaintenance, undefined, [{ get projectDir() { called = true; return "/tmp/fixture"; } }])).status, "refused");
  assert.equal(called, false);
});
test("legacy hostname-mismatch route refuses; complete review includes every peer, including reused PID", { skip: NATIVE_SKIP }, t => {
  const f = fixture(t);
  const host = openCoordinationMaintenanceHost({ projectDir: f.root });
  try {
    assert.equal(host.prepare({ expectedRevision: f.authority.revision, expectedAuthorityEpoch: f.authority.authority_epoch,
      witness: { ownerPid: f.pid, ownerStartedAt: f.stamp(4000), ownerHeartbeatAt: f.stamp(1000), leaseAcquiredAt: f.stamp(3000), leaseExpiresAt: f.stamp(2000) } }).status, "refused");
  } finally { host.close(); }
  const snapshot = f.snapshot();
  const facts = collectNativeSameMachineFacts([f.pid, process.pid]);
  const proof = maintenanceReviewProof(snapshot, facts, facts.boot.observedAtMs);
  assert.equal(snapshot.workers.length, 3);
  assert.deepEqual(proof.counts, { legacyAbsent: 1, attestedAbsent: 1, attestedReused: 1 });
  const presentation = maintenanceReviewPresentation(snapshot, facts, "fixture-seal", facts.boot.observedAtMs).join("\n");
  for (const row of snapshot.workers) assert.ok(presentation.includes(String(row.worker_id)));
  assert.ok(presentation.includes("NOT a clone, VM"));
  assert.equal(f.released(), "held");
});
for (const [name, sql] of [
  ["wrong-root peer", "UPDATE workers SET project_root_realpath = '/different-fixture' WHERE worker_id = 'peer-0'"],
  ["active peer", "UPDATE workers SET status = 'active' WHERE worker_id = 'peer-0'"],
  ["dangling held lease", "PRAGMA foreign_keys = OFF; UPDATE milestone_leases SET worker_id = 'missing-fixture-owner'"],
  ["unexpired lease", "UPDATE milestone_leases SET expires_at = '2999-01-01T00:00:00.000Z'"],
] as const) test(`complete-set collection refuses ${name} without filtering`, { skip: NATIVE_SKIP }, t => {
  const f = fixture(t); f.raw.exec(sql); assert.throws(f.snapshot); assert.equal(f.released(), "held");
});
test("1025 workers refuse rather than truncate", { skip: NATIVE_SKIP }, t => { const f = fixture(t, 1024); assert.throws(f.snapshot); });
for (const name of ["postboot-heartbeat", "malformed-date", "reversed-times", "missing-pid", "coarse-birth-not-elapsed", "boot-race", "process-race"] as const) test(`proof refuses ${name}`, { skip: NATIVE_SKIP }, t => {
  const f = fixture(t); const snapshot = f.snapshot(); const facts = collectNativeSameMachineFacts([f.pid, process.pid]);
  const changed: NativeSameMachineFacts = structuredClone(facts);
  if (name === "postboot-heartbeat") snapshot.workers[0].last_heartbeat_at = new Date().toISOString();
  if (name === "malformed-date") snapshot.workers[0].started_at = "not-a-date";
  if (name === "reversed-times") snapshot.workers[0].started_at = f.stamp(500);
  if (name === "missing-pid") changed.pids.pop();
  if (name === "coarse-birth-not-elapsed") changed.boot.observedAtMs = changed.pids.find(row => row.state === "present")!.startedUpperBoundMs!;
  if (name === "boot-race") { changed.boot.bootSessionHash = maintenanceDigest("different-boot"); assert.equal(sameNativeMachineFacts(facts, changed), false); return; }
  if (name === "process-race") { changed.pids.find(row => row.state === "present")!.processIdentity = maintenanceDigest("different-process"); assert.equal(sameNativeMachineFacts(facts, changed), false); return; }
  assert.throws(() => maintenanceReviewProof(snapshot, changed, changed.boot.observedAtMs));
});
test("presentation escapes control, bidi and non-ASCII bytes", () => {
  const line = maintenanceReviewLine({ host: "host\u001b[2J\u009b\u202e\n\r" });
  assert.match(line, /\\u001b/); assert.match(line, /\\u202e/); assert.doesNotMatch(line, /[^\x20-\x7e]/);
});
test("unattended root-only invocation cannot mutate or retain ordinary-accessor exclusion", { skip: NATIVE_SKIP }, async t => {
  const f = fixture(t); assert.equal((await attendSameMachineCoordinationMaintenance(f.root)).status, "refused");
  assert.equal(f.released(), "held"); assert.equal(getDbOrNull(), null);
});
test("FIXTURE ONLY private PTY complete 324-worker set commits one release; verified receipt replays without new consent", { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t, 323); const before = f.snapshot(); const beforeTables = databaseRows(f.raw);
  const result = await attendedFixture(f);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /"status":"committed"/);
  assert.equal(f.released(), "released"); assert.equal(f.workers(), f.initialWorkers);
  const afterTables = databaseRows(f.raw);
  assertExactReleaseFootprint(beforeTables, afterTables, before);
  t.diagnostic("FIXTURE AUTOMATION, unmocked/no preload: 324 workers unchanged; epoch unchanged; revision +1; selected lease status only; exact bookkeeping rows/columns");
  assert.equal((result.output.match(/"member":/g) ?? []).length, 324);
  for (const table of ["workflow_operations", "workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) assert.equal(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 1, table);
  for (const table of ["workflow_item_lifecycles", "workflow_execution_attempts", "workflow_authority_cutovers"]) assert.equal(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
  const payload = JSON.parse(String(f.raw.prepare("SELECT payload_json FROM workflow_domain_events").get()!.payload_json));
  assert.equal(payload.assurance.version, "native-attended-same-machine-v1");
  assert.equal(payload.assurance.workers, 324); assert.ok(payload.assurance.attestedReused > 0);
  const seal = /"sealId":"([a-f0-9-]{36})"/.exec(result.output)![1];
  f.raw.prepare("UPDATE workers SET host = 'changed-after-commit'").run();
  const host = openCoordinationMaintenanceHost({ projectDir: f.root });
  try {
    assert.equal(host.receipt({ sealId: seal }).status, "replayed");
    payload.assurance.version = "unknown-version";
    assert.throws(() => f.raw.prepare("UPDATE workflow_domain_events SET payload_json = ?").run(JSON.stringify(payload)), /immutable/);
    assert.equal(host.receipt({ sealId: seal }).status, "replayed");
  } finally { host.close(); }
  assert.equal(before.leases[0].status, "held");
});
for (const mode of ["cancel", "disconnect", "eof"]) test(`FIXTURE ONLY private PTY ${mode} leaves lease and ledger untouched`, { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const result = await attendedFixture(f, mode);
  assert.notEqual(result.exitCode, 0); assert.equal(f.released(), "held"); assert.equal(f.workers(), f.initialWorkers);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get()!.n, 0);
});

for (const mode of ["dirty-heartbeat", "dirty-revision", "dirty-membership", "dirty-file"]) test(`FIXTURE ONLY PRE-ATTEST native recheck rejects ${mode} (mutation precedes confirmation)`, { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const result = await attendedFixture(f, mode);
  assert.notEqual(result.exitCode, 0, result.output); assert.equal(f.released(), "held");
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get()!.n, 0);
});

for (const mode of ["boot-race", "process-race", "eperm", "expired-capability", "transaction-boot-race", "clock-race"]) test(`FIXTURE ONLY SYNTHETIC deadline/OS instrumentation: native apply refuses ${mode}`, { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t);
  const preload = join(f.root, "fixture-instrument.cjs");
  writeFileSync(preload, `
if (process.argv[1]?.endsWith('coordination-maintenance-attended-worker.js')) {
 const fs = require('node:fs'); const cp = require('node:child_process');
 const { syncBuiltinESMExports } = require('node:module');
 let armed = false;
 const wallNow = Date.now.bind(Date);
 if (${JSON.stringify(mode)} === 'clock-race') Date.now = () => wallNow() + (armed ? 60000 : 0);
 let writing = false; let bootReads = 0;
 const phaseSend = process.send.bind(process);
 process.send = function(message, ...rest) { if (message?.type === 'maintenance-attended-writing') writing = true; return phaseSend(message, ...rest); };
 const write = fs.writeSync;
 fs.writeSync = function(fd, value, ...rest) {
  if ((Buffer.isBuffer(value) ? value.toString('utf8') : String(value)).includes('type exactly ATTEST')) armed = true;
  return write.call(this, fd, value, ...rest);
 };
 const spawn = cp.spawnSync;
 cp.spawnSync = function(path, args, ...rest) {
  const result = spawn.call(this, path, args, ...rest);
  if (armed && ${JSON.stringify(mode)} === 'boot-race' && path === '/usr/sbin/sysctl' && args.includes('kern.bootsessionuuid')) result.stdout = '11111111-2222-4333-8444-555555555555\\n';
  if (writing && path === '/usr/sbin/sysctl' && args.includes('kern.bootsessionuuid') && ++bootReads >= 5 && ${JSON.stringify(mode)} === 'transaction-boot-race') result.stdout = '11111111-2222-4333-8444-555555555555\\n';
  if (armed && ${JSON.stringify(mode)} === 'process-race' && path === '/bin/ps' && args.includes('lstart=')) result.stdout = result.stdout.replace(/ [0-5][0-9]:([0-5][0-9]):[0-5][0-9] /g, ' 01:01:01 ');
  return result;
 };
 const kill = process.kill;
 process.kill = function(pid, signal) {
  if (armed && ${JSON.stringify(mode)} === 'eperm' && pid === ${f.pid} && signal === 0) { const error = new Error('fixture EPERM'); error.code = 'EPERM'; throw error; }
  return kill.call(this, pid, signal);
 };
 if (${JSON.stringify(mode)} === 'expired-capability') {
  const { performance } = require('node:perf_hooks'); const now = performance.now.bind(performance); let offset = 0;
  Object.defineProperty(performance, 'now', { value: () => now() + offset });
  const send = process.send.bind(process);
  process.send = function(message, ...rest) { if (message?.type === 'maintenance-attended-writing') offset = 30001; return send(message, ...rest); };
 }
 syncBuiltinESMExports();
}
`);
  const result = await attendedFixture(f, "confirm", preload);
  assert.notEqual(result.exitCode, 0, result.output); assert.equal(f.released(), "held"); assert.equal(f.workers(), f.initialWorkers);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get()!.n, 0);
});

test("FIXTURE ONLY failed native transaction rolls back; a new attempt requires a fresh native attestation", { skip: NATIVE_SKIP, timeout: 180_000 }, async t => {
  const f = fixture(t);
  f.raw.exec("CREATE TRIGGER fixture_abort_outbox BEFORE INSERT ON workflow_outbox BEGIN SELECT RAISE(ABORT, 'fixture outbox refusal'); END");
  const first = await attendedFixture(f);
  assert.notEqual(first.exitCode, 0); assert.equal(f.released(), "held"); assert.equal(f.workers(), f.initialWorkers);
  for (const table of ["workflow_operations", "workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) assert.equal(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
  const seal = /"sealId":"([a-f0-9-]{36})"/.exec(first.output)![1];
  const host = openCoordinationMaintenanceHost({ projectDir: f.root });
  try { assert.equal(host.receipt({ sealId: seal }).status, "refused"); assert.equal(host.apply({ sealId: seal }).status, "refused"); } finally { host.close(); }
  f.raw.exec("DROP TRIGGER fixture_abort_outbox");
  const second = await attendedFixture(f);
  assert.equal(second.exitCode, 0, second.output); assert.equal(f.released(), "released");
  assert.notEqual(/"sealId":"([a-f0-9-]{36})"/.exec(second.output)![1], seal);
});
test("FIXTURE ONLY ordinary access refuses throughout async root-only review; no writable review transaction", { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const entry = join(f.root, "direct-native-FIXTURE.mjs");
  writeFileSync(entry, `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(packageCopy(), "package.json"))});
const { createJiti } = require('@mariozechner/jiti');
const jiti = createJiti(import.meta.url, { interopDefault: false, debug: false, fsCache: false });
const engine = await jiti.import(${JSON.stringify(join(packageCopy(), "src/resources/extensions/gsd/db/engine.ts"))});
const pending = engine.attendSameMachineCoordinationMaintenance(process.argv[4]);
let excluded = true; let accessChecks = 0;
const interval = setInterval(() => {
 let genericRefused = false;
 try { engine.getDbOrNull(); } catch { genericRefused = true; }
 let isolatedRefused = false; let snapshotRefused = false;
 try { const isolated = engine.openIsolatedDatabase(process.argv[4] + '/.gsd/gsd.db'); isolated.close(); } catch { isolatedRefused = true; }
 try { engine.snapshotDatabaseFile(process.argv[4] + '/.gsd/gsd.db', process.argv[4] + '/ordinary-snapshot.db'); } catch { snapshotRefused = true; }
 const host = engine.openCoordinationMaintenanceHost({ projectDir: process.argv[4] });
 const ordinaryRefused = host.prepare({}).status === 'refused'; host.close();
 accessChecks++; excluded &&= genericRefused && ordinaryRefused && isolatedRefused && snapshotRefused;
}, 5);
const result = await pending; clearInterval(interval); excluded &&= accessChecks > 0;
console.log(JSON.stringify({ result, fixtureOrdinaryAccessorExcluded: excluded }));
process.exitCode = excluded && result.status === 'committed' ? 0 : 1;
`);
  const result = await attendedFixture(f, "confirm", "", entry);
  assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /"fixtureOrdinaryAccessorExcluded":true/);
  assert.equal(existsSync(join(f.root, "ordinary-snapshot.db")), false);
  assert.equal(f.released(), "released"); assert.equal(f.workers(), f.initialWorkers);
});
for (const status of ["pending", "claimed", "running"]) test(`complete-set collection refuses ${status} dispatch`, { skip: NATIVE_SKIP }, t => {
  const f = fixture(t);
  f.raw.prepare("INSERT INTO unit_dispatches (trace_id, worker_id, milestone_lease_token, milestone_id, unit_type, unit_id, status, started_at) VALUES ('fixture-trace', 'selected-fixture-owner', 3, 'M001', 'execute-task', 'M001/S01/T01', ?, ?)").run(status, f.stamp(1000));
  assert.throws(f.snapshot);
});
test("oversized worker text refuses before row materialization", { skip: NATIVE_SKIP }, t => {
  const f = fixture(t); f.raw.prepare("UPDATE workers SET host = ? WHERE worker_id = 'peer-0'").run("x".repeat(4097)); assert.throws(f.snapshot);
});

test("coarse process birth must have fully elapsed before collection START, not collection end", { skip: NATIVE_SKIP }, t => {
  const f = fixture(t); const facts = collectNativeSameMachineFacts([f.pid, process.pid]);
  const present = facts.pids.find(row => row.state === "present")!;
  const initialObservation = present.startedUpperBoundMs!;
  assert.ok(facts.boot.observedAtMs >= initialObservation);
  assert.throws(() => maintenanceReviewProof(f.snapshot(), facts, initialObservation));
});
test("old public host cannot receive an attended grant or evidence in its options", { skip: NATIVE_SKIP }, t => {
  const f = fixture(t);
  for (const extra of [{ grant: {} }, { attendedSameMachine: true }, { confirmation: true }, { facts: collectNativeSameMachineFacts([f.pid]) }]) {
    const host = Reflect.apply(openCoordinationMaintenanceHost, undefined, [{ projectDir: f.root, ...extra }]);
    try { assert.equal(host.apply({ sealId: "11111111-2222-4333-8444-555555555555" }).status, "refused"); } finally { host.close(); }
  }
  assert.equal(f.released(), "held");
});

test("FIXTURE ONLY lost new commit reply reconciles a committed receipt, never blind retries", { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const preload = join(f.root, "lost-reply-FIXTURE.cjs");
  writeFileSync(preload, `
if (process.argv[1]?.endsWith('coordination-maintenance-attended-worker.js')) {
 const write = process.stdout.write.bind(process.stdout);
 process.stdout.write = function(value, ...rest) { if (String(value).includes('"status":"committed"')) process.exit(76); return write(value, ...rest); };
}
`);
  const result = await attendedFixture(f, "confirm", preload);
  assert.notEqual(result.exitCode, 0); assert.equal(f.released(), "released"); assert.equal(f.workers(), f.initialWorkers);
  const seal = /"sealId":"([a-f0-9-]{36})"/.exec(result.output)![1];
  const host = openCoordinationMaintenanceHost({ projectDir: f.root });
  try { assert.equal(host.receipt({ sealId: seal }).status, "replayed"); assert.equal(host.apply({ sealId: seal }).status, "refused"); } finally { host.close(); }
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM workflow_operations").get()!.n, 1);
});

test("native rechecks reject wall-clock regression and forward drift relative to monotonic time", { skip: NATIVE_SKIP }, t => {
  const f = fixture(t); const facts = collectNativeSameMachineFacts([f.pid]);
  const next = structuredClone(facts);
  next.boot.observedAtMs += 2000;
  assert.equal(stableMaintenanceFacts(facts, next, 10, 2010), true);
  assert.equal(stableMaintenanceFacts(facts, next, 10, 20), false);
  next.boot.observedAtMs = facts.boot.observedAtMs - 1;
  assert.equal(stableMaintenanceFacts(facts, next, 10, 20), false);
});

// Fixture-only native phase interception: no production grant factory, hooks, or fake clock.
// The IPC notification follows terminal confirmation. The narrowly matched host freeze
// follows private selected-request preparation and precedes return to the attended caller.
// Mutate at that fixture-only boundary BEFORE host.apply and any owned BEGIN, never inside it.
function temporalFixtureHook(f: ReturnType<typeof fixture>, phase: "post-confirmation/pre-writer" | "after-prepare/before-owned-apply", mutation: "heartbeat" | "revision" | "membership" | "file" | "real-expiry") {
  const preload = join(f.root, "temporal-FIXTURE.cjs");
  const evidence = join(f.root, "temporal-FIXTURE.json");
  writeFileSync(preload, `
if (process.argv[1]?.endsWith('coordination-maintenance-attended-worker.js')) {
 const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');
 const root = ${JSON.stringify(f.root)}; const path = ${JSON.stringify(f.path)};
 if (!root.startsWith(fs.realpathSync(require('node:os').tmpdir()) + '/w067-attended-')) throw Error('not a generated fixture');
 const originalExec = DatabaseSync.prototype.exec; const originalPrepare = DatabaseSync.prototype.prepare;
 const phase = ${JSON.stringify(phase)}; const mutation = ${JSON.stringify(mutation)};
 let writing = false; let begins = 0; let hostPrepared = false; let selectedReadCompleted = false; let fired = false; let confirmedAt;
 function rows(db) {
  const result = {};
  for (const { name } of originalPrepare.call(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()) {
   result[name] = originalPrepare.call(db, 'SELECT * FROM "' + name.replaceAll('"', '""') + '"').all();
  }
  return result;
 }
 function inject() {
  if (fired) throw Error('duplicate fixture mutation'); fired = true;
  const enteredAt = performance.now();
  if (mutation === 'real-expiry') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 31000);
  else if (mutation === 'file') { fs.renameSync(path, path + '.old'); fs.copyFileSync(path + '.old', path); }
  const db = new DatabaseSync(path);
  if (mutation === 'heartbeat') originalExec.call(db, "UPDATE workers SET last_heartbeat_at = started_at WHERE worker_id = 'peer-0'");
  if (mutation === 'revision') originalExec.call(db, 'UPDATE project_authority SET revision = revision + 1');
  if (mutation === 'membership') originalExec.call(db, "UPDATE workers SET status = 'stopped' WHERE worker_id = 'peer-0'");
  const expected = rows(db); db.close();
  const record = { fixtureAutomation: true, phase, mutation, begins, hostPrepared, selectedReadCompleted,
   confirmedAt, enteredAt, completedAt: performance.now(), expected };
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(record));
  process.stderr.write('FIXTURE-TEMPORAL ' + JSON.stringify({ phase, mutation, begins, hostPrepared, selectedReadCompleted, elapsedMs: record.completedAt - confirmedAt }) + '\\n');
 }
 DatabaseSync.prototype.exec = function(sql, ...args) {
  if (writing && sql === 'BEGIN IMMEDIATE') begins++;
  return originalExec.call(this, sql, ...args);
 };
 DatabaseSync.prototype.prepare = function(sql, ...args) {
  const statement = originalPrepare.call(this, sql, ...args);
  if (writing && sql.includes('SELECT w.worker_id, w.pid AS owner_pid')) {
   const all = statement.all;
   statement.all = function(...values) {
    const result = all.apply(this, values); selectedReadCompleted = result.length === 1; return result;
   };
  }
  return statement;
 };
 const freeze = Object.freeze;
 Object.freeze = function(value) {
  const result = freeze(value);
  if (writing && value && Object.keys(value).sort().join(',') === 'apply,close,prepare,receipt'
   && ['apply', 'close', 'prepare', 'receipt'].every(key => typeof value[key] === 'function')) {
   hostPrepared = true;
   if (phase === 'after-prepare/before-owned-apply') inject();
  }
  return result;
 };
 const send = process.send.bind(process);
 process.send = function(message, ...args) {
  if (message?.type === 'maintenance-attended-writing') {
   confirmedAt = performance.now(); writing = true;
   if (phase === 'post-confirmation/pre-writer') inject();
  }
  return send(message, ...args);
 };
}
`);
  return { preload, evidence };
}
for (const phase of ["post-confirmation/pre-writer", "after-prepare/before-owned-apply"] as const) {
  for (const mutation of ["heartbeat", "revision", "membership", "file"] as const) {
    test(`FIXTURE ONLY POST-ATTEST ${phase} ${mutation}: refusal has zero operation footprint`, { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
      const f = fixture(t); const before = databaseRows(f.raw);
      const hook = temporalFixtureHook(f, phase, mutation);
      const result = await attendedFixture(f, "confirm", hook.preload);
      assert.notEqual(result.exitCode, 0, result.output);
      assert.match(result.output, /FIXTURE-TEMPORAL/);
      assert.match(result.output, /"status":"refused"/, "a typed native refusal, not a generic process crash");
      assert.doesNotMatch(result.output, /"status":"committed"/);
      const record = JSON.parse(readFileSync(hook.evidence, "utf8"));
      assert.equal(record.phase, phase); assert.equal(record.mutation, mutation);
      assert.ok(record.enteredAt >= record.confirmedAt);
      assert.equal(record.begins, 0, "before any owned writer transaction");
      assert.equal(record.hostPrepared, phase === "after-prepare/before-owned-apply");
      assert.equal(record.selectedReadCompleted, phase === "after-prepare/before-owned-apply");
      const current = new DatabaseSync(f.path);
      try {
        assert.deepEqual(databaseRows(current), record.expected, "only the deliberate fixture mutation may persist");
        assert.equal(current.prepare("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").get()!.status, "held");
      } finally { current.close(); }
      if (mutation === "file") assert.deepEqual(databaseRows(f.raw), before, "no writes may land on the replaced inode either");
      for (const name of ["workflow_operations", "workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) {
        assert.deepEqual(record.expected[name], before[name], `${name}: zero writes`);
      }
      t.diagnostic(JSON.stringify({ fixtureAutomation: true, phase, mutation, begins: record.begins, hostPrepared: record.hostPrepared, selectedReadCompleted: record.selectedReadCompleted, elapsedMs: record.completedAt - record.confirmedAt }));
    });
  }
}
test("FIXTURE ONLY REAL 31-second private capability expiry within original writer budget", { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const before = databaseRows(f.raw);
  const hook = temporalFixtureHook(f, "post-confirmation/pre-writer", "real-expiry");
  const result = await attendedFixture(f, "confirm", hook.preload);
  const record = JSON.parse(readFileSync(hook.evidence, "utf8"));
  assert.notEqual(result.exitCode, 0, result.output); assert.match(result.output, /FIXTURE-TEMPORAL/);
  assert.match(result.output, /"status":"refused"/, "real capability expiry is a typed native refusal");
  assert.doesNotMatch(result.output, /"status":"committed"/);
  assert.ok(ATTENDED_CAPABILITY_MS <= 30_000);
  assert.ok(record.completedAt - record.enteredAt >= 31_000, "real monotonic elapsed lifetime, no timer/clock replacement");
  assert.ok(record.completedAt - record.confirmedAt >= ATTENDED_CAPABILITY_MS, "actual private capability lifetime elapsed");
  assert.equal(ATTENDED_WRITE_MS, 60_000);
  assert.ok(record.completedAt - record.confirmedAt < ATTENDED_WRITE_MS, "original writer budget has not expired");
  assert.equal(record.begins, 0); assert.equal(f.released(), "held");
  assert.deepEqual(databaseRows(f.raw), before); assert.deepEqual(record.expected, before);
  t.diagnostic(JSON.stringify({ fixtureAutomation: true, kind: "REAL capability expiry", capabilityLifetimeMs: ATTENDED_CAPABILITY_MS, writerBudgetMs: ATTENDED_WRITE_MS, elapsedMs: record.completedAt - record.enteredAt, writerElapsedMs: record.completedAt - record.confirmedAt, operationWrites: 0 }));
});

function assertExactReleaseFootprint(before: Record<string, unknown>, after: Record<string, unknown>, snapshot: ReturnType<typeof collectMaintenanceReview>) {
  type Row = Record<string, unknown>;
  const rows = (tables: Record<string, unknown>, name: string) => tables[name] as Row[];
  const singleNew = (name: string) => {
    assert.deepEqual(rows(before, name), [], `${name}: new fixture has no prior bookkeeping`);
    assert.equal(rows(after, name).length, 1, `${name}: exactly one row`);
    return rows(after, name)[0];
  };
  const operation = singleNew("workflow_operations"); const event = singleNew("workflow_domain_events");
  const outbox = singleNew("workflow_outbox"); const projection = singleNew("workflow_projection_work");
  const authority = rows(before, "project_authority")[0];
  const revision = Number(authority.revision) + 1; const epoch = authority.authority_epoch;
  const uuid = /^[a-f0-9-]{36}$/; const hash = /^sha256:[a-f0-9]{64}$/;
  for (const id of [operation.operation_id, operation.idempotency_key, event.event_id]) assert.match(String(id), uuid);
  assert.equal(projection.projection_work_id, `${operation.operation_id}:0000`);
  assert.match(String(operation.actor_id), /^native-maintenance:sha256:[a-f0-9]{64}$/);
  assert.match(String(operation.request_hash), hash);
  assert.equal(new Date(String(operation.created_at)).toISOString(), operation.created_at);
  assert.deepEqual(operation, {
    operation_id: operation.operation_id, project_id: authority.project_id,
    operation_type: "coordination.expired-lease.release", idempotency_key: operation.idempotency_key,
    expected_revision: authority.revision, resulting_revision: revision,
    expected_authority_epoch: epoch, resulting_authority_epoch: epoch,
    actor_type: "system", actor_id: operation.actor_id, source_transport: "native-coordination-maintenance",
    trace_id: null, turn_id: null, request_hash: operation.request_hash, created_at: operation.created_at,
  });
  const payload = JSON.parse(String(event.payload_json));
  assert.deepEqual(Object.keys(payload).sort(), ["assurance", "binding", "provenance", "target"]);
  assert.equal(payload.binding, snapshot.binding); assert.match(payload.target, hash); assert.equal(payload.provenance, operation.actor_id);
  const selected = rows(before, "workers").find(row => row.worker_id === "selected-fixture-owner")!;
  const lease = rows(before, "milestone_leases").find(row => row.milestone_id === "M001")!;
  assert.equal(payload.target, maintenanceDigest({ worker_id: selected.worker_id, owner_pid: selected.pid, owner_host: selected.host,
    started_at: selected.started_at, heartbeat_at: selected.last_heartbeat_at, project_root_realpath: selected.project_root_realpath,
    worker_status: selected.status, milestone_id: lease.milestone_id, fencing_token: lease.fencing_token,
    acquired_at: lease.acquired_at, expires_at: lease.expires_at, lease_status: lease.status }));
  assert.match(payload.assurance.facts, hash); assert.match(payload.assurance.confirmation, hash);
  assert.deepEqual(payload.assurance, {
    version: "native-attended-same-machine-v1", policy: ATTENDED_POLICY,
    snapshot: maintenanceDigest(snapshot), workers: 324, hosts: 2,
    legacyAbsent: 162, attestedAbsent: 1, attestedReused: 161,
    facts: payload.assurance.facts, confirmation: payload.assurance.confirmation,
  });
  assert.deepEqual(event, {
    event_id: event.event_id, operation_id: operation.operation_id, event_index: 0,
    project_id: authority.project_id, project_revision: revision, authority_epoch: epoch,
    event_type: "coordination.expired-lease.released", entity_type: "project", entity_id: authority.project_id,
    caused_by_event_id: null, payload_json: event.payload_json, created_at: operation.created_at,
  });
  assert.deepEqual(outbox, { outbox_id: 1, event_id: event.event_id, destination: "projection", available_at: operation.created_at });
  assert.deepEqual(projection, {
    projection_work_id: projection.projection_work_id, project_id: authority.project_id,
    projection_key: "state", projection_kind: "state", supersedes_projection_work_id: null,
    source_project_revision: revision, source_authority_epoch: epoch, renderer_version: "1",
    delivery_state: "pending", state_version: 0, claim_owner: null, claim_fencing_token: 0,
    claimed_at: null, claim_expires_at: null, attempt_count: 0, next_attempt_at: "", last_error: "",
    rendered_content_hash: null, rendered_at: null, enqueue_operation_id: operation.operation_id,
    created_at: operation.created_at, updated_at: operation.created_at,
  });
  // Reconstruct the ENTIRE expected database, not an allowlist of changed tables.
  const expected = structuredClone(before);
  expected.project_authority = [{ ...authority, revision, updated_at: operation.created_at }];
  expected.milestone_leases = rows(before, "milestone_leases").map(row => row.milestone_id === "M001" ? { ...row, status: "released" } : row);
  expected.workflow_operations = [operation]; expected.workflow_domain_events = [event];
  expected.workflow_outbox = [outbox]; expected.workflow_projection_work = [projection];
  const sequences = rows(before, "sqlite_sequence");
  assert.equal(sequences.some(row => row.name === "workflow_outbox"), false);
  expected.sqlite_sequence = [...sequences, { name: "workflow_outbox", seq: 1 }];
  assert.deepEqual(after, expected, "only exact release SQL status column, revision/updated_at, and expected bookkeeping may change; all workers and every other row/column unchanged");
}

test("FIXTURE ONLY preheld isolated accessor denies native review without operation footprint", { skip: NATIVE_SKIP, timeout: 90_000 }, async t => {
  const f = fixture(t); const before = databaseRows(f.raw);
  const entry = join(f.root, "preheld-isolated-FIXTURE.mjs");
  writeFileSync(entry, `
import { createRequire } from 'node:module';

const require = createRequire(${JSON.stringify(join(packageCopy(), "package.json"))});
const { createJiti } = require('@mariozechner/jiti');
const jiti = createJiti(import.meta.url, { interopDefault: false, debug: false, fsCache: false });
const engine = await jiti.import(${JSON.stringify(join(packageCopy(), "src/resources/extensions/gsd/db/engine.ts"))});
const isolated = engine.openIsolatedDatabase(process.argv[4] + '/.gsd/gsd.db');
if (!isolated) throw Error('fixture isolated adapter unavailable');
try {
 const result = await engine.attendSameMachineCoordinationMaintenance(process.argv[4]);
 console.log(JSON.stringify({ fixturePreheldIsolatedRefused: result.status === 'refused', result }));
 process.exitCode = result.status === 'refused' ? 0 : 1;
} finally { isolated.close(); }
`);
  const result = await attendedFixture(f, "confirm", "", entry);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /"fixturePreheldIsolatedRefused":true/);
  assert.doesNotMatch(result.output, /ATTEST /, "preheld ordinary access must refuse before review");
  assert.deepEqual(databaseRows(f.raw), before); assert.equal(f.released(), "held");
});
