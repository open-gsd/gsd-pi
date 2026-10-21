// Project/App: gsd-pi
// File Purpose: Deterministic real-process soak for semantic-shadow read, repair, and token invariants.

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  clearMilestoneStatusObservationTurn,
  resolveMilestoneStatusObservationContext,
} from "../milestone-status-observation-context.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";

interface WorkerError {
  code: string;
  message: string;
}

interface WorkerOutcome {
  action: "status-read" | "repair" | "token-hold";
  pid: number;
  result?: any;
  error?: WorkerError;
}

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

type SoakWorker = ChildProcessByStdio<null, Readable, Readable>;

interface WorkerHandle {
  child: SoakWorker;
  result: Promise<ChildResult>;
}

interface SoakFixture {
  root: string;
  dbPath: string;
}

const tempDirs = new Set<string>();
const activeWorkers = new Set<WorkerHandle>();
const workerPath = join(
  process.cwd(),
  "src/resources/extensions/gsd/tests/fixtures/semantic-shadow-worker.ts",
);
const resolverPath = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");

afterEach(async () => {
  for (const handle of activeWorkers) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
  }
  await Promise.allSettled([...activeWorkers].map((handle) => handle.result));
  activeWorkers.clear();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function createFixture(prefix = "gsd-semantic-shadow-soak-"): SoakFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dbPath = join(root, ".gsd", "gsd.db");
  tempDirs.add(root);
  mkdirSync(join(root, ".gsd"), { recursive: true });
  assert.equal(openDatabase(dbPath), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Semantic shadow soak', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES ('M001', 'S01', 'Soak slice', 'active', 1, '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, sequence, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M001', 'S01', 'T01', 'First repair target', 'complete', 1,
        '2026-07-15T01:00:00.000Z', 'Finished', 'Durable completion', 'passed', '# T01 summary'
      ),
      (
        'M001', 'S01', 'T02', 'Second repair target', 'complete', 2,
        '2026-07-15T02:00:00.000Z', 'Finished', 'Durable completion', 'passed', '# T02 summary'
      );
  `);
  closeDatabase();
  return { root, dbPath };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "semantic-shadow soak database must be open");
  return adapter;
}

function spawnWorker(input: Record<string, unknown>): WorkerHandle {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    "--import",
    resolverPath,
    "--experimental-strip-types",
    workerPath,
    JSON.stringify(input),
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  const handle = { child, result };
  activeWorkers.add(handle);
  child.once("close", () => activeWorkers.delete(handle));
  return handle;
}

async function waitForFiles(
  paths: string[],
  handles: WorkerHandle[],
  description: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!paths.every(existsSync)) {
    const exited = handles.find(({ child }) => child.exitCode !== null || child.signalCode !== null);
    if (exited) {
      const result = await exited.result;
      assert.fail(`worker exited before ${description}: ${JSON.stringify(result)}`);
    }
    assert.ok(Date.now() < deadline, `workers did not reach ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseOutcome(result: ChildResult): WorkerOutcome {
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.signal, null, JSON.stringify(result));
  const prefix = "SEMANTIC_SHADOW_OUTCOME=";
  const line = result.stdout.split("\n").find((entry) => entry.startsWith(prefix));
  assert.ok(line, `worker emitted no semantic-shadow outcome: ${JSON.stringify(result)}`);
  return JSON.parse(line.slice(prefix.length)) as WorkerOutcome;
}

async function outcome(handle: WorkerHandle): Promise<WorkerOutcome> {
  return parseOutcome(await handle.result);
}

function authorityRevision(): number {
  return Number(db().prepare(`
    SELECT revision FROM project_authority WHERE singleton = 1
  `).get()?.["revision"]);
}

function durableCounts(): Record<string, number> {
  const count = (table: string): number => Number(
    db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"],
  );
  return {
    revision: authorityRevision(),
    lifecycles: count("workflow_item_lifecycles"),
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    outbox: count("workflow_outbox"),
    projections: count("workflow_projection_work"),
    attempts: count("workflow_execution_attempts"),
    results: count("workflow_attempt_results"),
  };
}

function authoritySnapshot(): Record<string, unknown> {
  const rows = (sql: string): unknown[] => db().prepare(sql).all();
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY rowid"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY rowid"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY rowid"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY rowid"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY rowid"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY rowid"),
  };
}

function observationPayloads(): any[] {
  return db().prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observed'
    ORDER BY ts, event_id
  `).all().map((row) => JSON.parse(String(row["payload_json"])));
}

function taskClassification(payload: any, taskId: string): string | undefined {
  return payload.items.find((item: any) => item.itemIdentity.taskId === taskId)?.classification;
}

function publicResult(status: WorkerOutcome): Record<string, unknown> {
  assert.equal(status.error, undefined, JSON.stringify(status));
  assert.ok(status.result, JSON.stringify(status));
  return JSON.parse(status.result.content[0].text) as Record<string, unknown>;
}

function repairReceipt(repair: WorkerOutcome): Record<string, any> {
  assert.equal(repair.error, undefined, JSON.stringify(repair));
  assert.ok(repair.result, JSON.stringify(repair));
  return repair.result as Record<string, any>;
}

test("a status read and its shadow observation stay wholly on the pre-commit snapshot", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const preRevision = authorityRevision();
  closeDatabase();
  const ready = join(fixture.root, "status-read-ready");
  const release = join(fixture.root, "status-read-release");
  const repairCommitted = join(fixture.root, "atomic-repair-committed");
  const repairCloseRelease = join(fixture.root, "atomic-repair-close-release");
  const reader = spawnWorker({
    action: "status-read",
    databasePath: fixture.dbPath,
    basePath: fixture.root,
    milestoneId: "M001",
    ready,
    release,
  });
  await waitForFiles([ready], [reader], "the in-transaction status-read barrier");

  const repairHandle = spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: "semantic-shadow-soak/atomic-read",
    taskId: "T01",
    committed: repairCommitted,
    closeRelease: repairCloseRelease,
  });
  await waitForFiles([repairCommitted], [repairHandle], "the atomic repair commit");
  writeFileSync(release, "go", "utf8");
  const status = await outcome(reader);
  writeFileSync(repairCloseRelease, "close", "utf8");
  const repair = await outcome(repairHandle);
  assert.equal(repairReceipt(repair).status, "committed");

  assert.equal(openDatabase(fixture.dbPath), true);
  const observations = observationPayloads();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].projectRevision, preRevision);
  assert.equal(taskClassification(observations[0], "T01"), "missing_shadow");
  const prePublic = publicResult(status);
  assert.equal(prePublic.status, "active");
  assert.equal((prePublic.slices as any[])[0].taskCounts.done, 2);

  const postStatus = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  const postPublic = JSON.parse(postStatus.content[0].text);
  assert.deepEqual(postPublic, prePublic, "repair evidence must not change the legacy public response");
  const postObservation = observationPayloads().at(-1);
  assert.equal(postObservation.projectRevision, preRevision + 1);
  assert.equal(taskClassification(postObservation, "T01"), "semantic_match_exact_delta");
});

test("same-key repair contenders commit one lineage and replay one equivalent receipt", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const before = durableCounts();
  closeDatabase();
  const release = join(fixture.root, "repair-same-release");
  const ready = [join(fixture.root, "repair-same-ready-1"), join(fixture.root, "repair-same-ready-2")];
  const handles = ready.map((path) => spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: "semantic-shadow-soak/same-key",
    taskId: "T01",
    ready: path,
    release,
  }));
  await waitForFiles(ready, handles, "both same-key repair candidates");
  writeFileSync(release, "go", "utf8");
  const receipts = (await Promise.all(handles.map(outcome))).map(repairReceipt);

  assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ["committed", "replayed"]);
  assert.deepEqual(
    { ...receipts[0], status: "committed" },
    { ...receipts[1], status: "committed" },
  );
  assert.equal(openDatabase(fixture.dbPath), true);
  assert.deepEqual(durableCounts(), {
    ...before,
    revision: before.revision + 1,
    lifecycles: before.lifecycles + 1,
    operations: before.operations + 1,
    events: before.events + 1,
    outbox: before.outbox + 1,
    projections: before.projections + 1,
  });
});

test("different-key repair contenders reject one stale writer without residue", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const before = durableCounts();
  closeDatabase();
  const release = join(fixture.root, "repair-different-release");
  const ready = [join(fixture.root, "repair-different-ready-1"), join(fixture.root, "repair-different-ready-2")];
  const keys = ["semantic-shadow-soak/writer-1", "semantic-shadow-soak/writer-2"];
  const handles = ready.map((path, index) => spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: keys[index],
    taskId: "T01",
    ready: path,
    release,
  }));
  await waitForFiles(ready, handles, "both different-key repair candidates");
  writeFileSync(release, "go", "utf8");
  const outcomes = await Promise.all(handles.map(outcome));
  const winner = outcomes.find((entry) => entry.result !== undefined);
  const loser = outcomes.find((entry) => entry.error !== undefined);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(repairReceipt(winner).status, "committed");
  assert.equal(loser.error?.code, "GSD_REVISION_CONFLICT");

  assert.equal(openDatabase(fixture.dbPath), true);
  assert.deepEqual(durableCounts(), {
    ...before,
    revision: before.revision + 1,
    lifecycles: before.lifecycles + 1,
    operations: before.operations + 1,
    events: before.events + 1,
    outbox: before.outbox + 1,
    projections: before.projections + 1,
  });
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE idempotency_key LIKE 'semantic-shadow-soak/writer-%'
  `).get()?.["count"], 1);
});

test("fresh processes replay a committed lost response and reject changed key reuse", { concurrency: false }, async () => {
  const fixture = createFixture();
  const key = "semantic-shadow-soak/restart";
  const lost = await outcome(spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: key,
    taskId: "T01",
    faultPoint: "after-commit",
  }));
  assert.equal(lost.error?.code, "UNKNOWN");
  assert.match(lost.error?.message ?? "", /domain operation fault: after-commit/i);

  assert.equal(openDatabase(fixture.dbPath), true);
  const afterCommit = authoritySnapshot();
  closeDatabase();
  const replay = repairReceipt(await outcome(spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: key,
    taskId: "T01",
  })));
  assert.equal(replay.status, "replayed");
  const changed = await outcome(spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: key,
    taskId: "T02",
  }));
  assert.equal(changed.error?.code, "GSD_IDEMPOTENCY_CONFLICT");

  assert.equal(openDatabase(fixture.dbPath), true);
  assert.deepEqual(authoritySnapshot(), afterCommit);
});

test("a fresh-process pre-commit fault rolls back exactly and the same key then commits once", { concurrency: false }, async () => {
  const fixture = createFixture();
  const key = "semantic-shadow-soak/precommit-restart";
  assert.equal(openDatabase(fixture.dbPath), true);
  const before = authoritySnapshot();
  const beforeCounts = durableCounts();
  closeDatabase();

  const faulted = await outcome(spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: key,
    taskId: "T01",
    faultPoint: "after-events",
  }));
  assert.equal(faulted.error?.code, "UNKNOWN");
  assert.match(faulted.error?.message ?? "", /domain operation fault: after-events/i);
  assert.equal(openDatabase(fixture.dbPath), true);
  assert.deepEqual(authoritySnapshot(), before);
  closeDatabase();

  const retried = repairReceipt(await outcome(spawnWorker({
    action: "repair",
    databasePath: fixture.dbPath,
    idempotencyKey: key,
    taskId: "T01",
  })));
  assert.equal(retried.status, "committed");
  assert.equal(openDatabase(fixture.dbPath), true);
  assert.deepEqual(durableCounts(), {
    ...beforeCounts,
    revision: beforeCounts.revision + 1,
    lifecycles: beforeCounts.lifecycles + 1,
    operations: beforeCounts.operations + 1,
    events: beforeCounts.events + 1,
    outbox: beforeCounts.outbox + 1,
    projections: beforeCounts.projections + 1,
  });
});

test("overlapping exact tokens remain isolated and a new turn scavenges expired crash residue", { concurrency: false }, async () => {
  const fixture = createFixture();
  const other = createFixture("gsd-semantic-shadow-other-");
  const release = join(fixture.root, "tokens-release");
  const ready = [join(fixture.root, "token-ready-1"), join(fixture.root, "token-ready-2")];
  const tokenPaths = [join(fixture.root, "token-1"), join(fixture.root, "token-2")];
  const tokens = ["semantic-shadow-token-a", "semantic-shadow-token-b"];
  const handles = tokens.map((token, index) => spawnWorker({
    action: "token-hold",
    basePath: fixture.root,
    tokenPath: tokenPaths[index],
    token,
    mode: index === 0 ? "guided" : "uok",
    traceId: `trace/${token}`,
    turnId: `turn/${token}`,
    ready: ready[index],
    release,
  }));
  await waitForFiles([...ready, ...tokenPaths], handles, "both exact token contexts");

  const first = resolveMilestoneStatusObservationContext(fixture.root, "workflow_mcp", tokens[0]);
  const second = resolveMilestoneStatusObservationContext(fixture.root, "workflow_mcp", tokens[1]);
  assert.deepEqual(
    [first.mode, first.traceId, first.turnId],
    ["guided", `trace/${tokens[0]}`, `turn/${tokens[0]}`],
  );
  assert.deepEqual(
    [second.mode, second.traceId, second.turnId],
    ["uok", `trace/${tokens[1]}`, `turn/${tokens[1]}`],
  );
  assert.deepEqual(resolveMilestoneStatusObservationContext(other.root, "workflow_mcp", tokens[0]), {
    mode: "legacy",
    transport: "workflow_mcp",
    sourceRevision: "unavailable",
    contextError: "unavailable",
  });
  writeFileSync(release, "go", "utf8");
  await Promise.all(handles.map(outcome));
  assert.equal(clearMilestoneStatusObservationTurn(fixture.root, tokens[0]), true);
  assert.equal(clearMilestoneStatusObservationTurn(fixture.root, tokens[1]), true);

  const expiredToken = "semantic-shadow-expired-crash-token";
  const expired = await outcome(spawnWorker({
    action: "token-hold",
    basePath: fixture.root,
    tokenPath: join(fixture.root, "expired-token"),
    token: expiredToken,
    mode: "legacy",
    traceId: "trace/expired",
    turnId: "turn/expired",
    now: Date.now() - 10_000,
    ttlMs: 1_000,
  }));
  assert.equal(expired.error, undefined);
  const replacementToken = "semantic-shadow-replacement-token";
  const replacement = await outcome(spawnWorker({
    action: "token-hold",
    basePath: fixture.root,
    tokenPath: join(fixture.root, "replacement-token"),
    token: replacementToken,
    mode: "interactive",
    traceId: "trace/replacement",
    turnId: "turn/replacement",
  }));
  assert.equal(replacement.error, undefined);

  assert.equal(openDatabase(fixture.dbPath), true);
  const keys = db().prepare(`
    SELECT key FROM runtime_kv
    WHERE key LIKE 'milestone-status-observation-turn:%'
    ORDER BY key
  `).all().map((row) => String(row["key"]));
  assert.deepEqual(keys, [`milestone-status-observation-turn:${replacementToken}`]);
});

test("repeated status reads mutate observation telemetry but no workflow authority", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const before = authoritySnapshot();
  for (let index = 0; index < 12; index += 1) {
    const result = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(authoritySnapshot(), before);
  assert.equal(observationPayloads().length, 12);
  assert.equal(db().prepare("PRAGMA quick_check").get()?.["quick_check"], "ok");
});

test("observation sink faults preserve the exact public response and remain visibly loss-accounted", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const baseline = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  const auditPath = join(fixture.root, ".gsd", "audit");

  db().exec(`
    CREATE TEMP TRIGGER fail_semantic_shadow_audit
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'semantic shadow primary sink fault');
    END;
  `);
  const primaryFailure = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  assert.deepEqual(primaryFailure, baseline);
  const projectedEvents = readFileSync(join(auditPath, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const primaryLoss = projectedEvents.at(-1);
  assert.equal(primaryLoss.type, "lifecycle-shadow-observation-loss");
  assert.equal(primaryLoss.payload.observationLossAccounting.reason, "primary_sink_failed");
  assert.equal(primaryLoss.payload.observationLossAccounting.persistedCount, 0);
  db().exec("DROP TRIGGER fail_semantic_shadow_audit");

  rmSync(auditPath, { recursive: true, force: true });
  writeFileSync(auditPath, "obstructed", "utf8");
  const projectionFailure = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  assert.deepEqual(projectionFailure, baseline);
  const projectionLoss = db().prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observation-loss'
    ORDER BY ts DESC, event_id DESC LIMIT 1
  `).get();
  assert.ok(projectionLoss);
  const projectionPayload = JSON.parse(String(projectionLoss["payload_json"]));
  assert.equal(projectionPayload.observationLossAccounting.reason, "projection_sink_failed");
  assert.equal(projectionPayload.observationLossAccounting.persistedCount, 1);
});

test("contradictory and obstructed Markdown projections cannot change DB-derived classification", { concurrency: false }, async () => {
  const fixture = createFixture();
  assert.equal(openDatabase(fixture.dbPath), true);
  const baseline = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  const baselineItems = observationPayloads().at(-1).items;
  const roadmapPath = join(fixture.root, ".gsd", "ROADMAP.md");

  writeFileSync(roadmapPath, "# Contradictory projection\n\n- [x] M001 says complete\n", "utf8");
  const contradicted = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  assert.deepEqual(contradicted, baseline);
  assert.deepEqual(observationPayloads().at(-1).items, baselineItems);

  rmSync(roadmapPath, { force: true });
  mkdirSync(roadmapPath);
  const obstructed = await executeMilestoneStatus({ milestoneId: "M001" }, fixture.root);
  assert.deepEqual(obstructed, baseline);
  assert.deepEqual(observationPayloads().at(-1).items, baselineItems);
});
