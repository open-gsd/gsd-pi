// Project/App: gsd-pi
// File Purpose: Executable proof for local, read-only M003/S07 dossier input collection.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  NO_CUTOVER_BEHAVIORAL_WITNESSES,
} from "../semantic-shadow-no-cutover-gate.mjs";
import { buildDossier, renderDossier } from "../m003-s07-cutover-dossier.mjs";
import {
  collectSemanticShadowCapstoneEvidence,
  normalizeSemanticShadowCapstoneEvidence,
} from "../../src/resources/extensions/gsd/tests/semantic-shadow-capstone-harness.ts";
import { collectM003S07DossierInput, main as runDossierInputCli } from "../m003-s07-dossier-input.ts";

const tempDirs = new Set<string>();
const loaderPath = fileURLToPath(new URL("../../src/resources/extensions/gsd/tests/resolve-ts.mjs", import.meta.url));
const collectorPath = fileURLToPath(new URL("../m003-s07-dossier-input.ts", import.meta.url));
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeFixtureDatabase(
  path: string,
  options: { unrelatedRepair?: boolean; duplicateEvidence?: boolean } = {},
): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE project_authority (singleton INTEGER, project_id TEXT, revision INTEGER, authority_epoch INTEGER);
    CREATE TABLE milestones (id TEXT, status TEXT);
    CREATE TABLE slices (milestone_id TEXT, id TEXT, status TEXT);
    CREATE TABLE tasks (milestone_id TEXT, slice_id TEXT, id TEXT, status TEXT);
    CREATE TABLE workflow_item_lifecycles (
      lifecycle_id TEXT, project_id TEXT, item_kind TEXT, milestone_id TEXT, slice_id TEXT, task_id TEXT, lifecycle_status TEXT
    );
    CREATE TABLE workflow_domain_events (
      event_id TEXT, operation_id TEXT, project_id TEXT, event_index INTEGER, project_revision INTEGER,
      event_type TEXT, payload_json TEXT
    );
    CREATE TABLE workflow_operations (operation_id TEXT, project_id TEXT, operation_type TEXT, idempotency_key TEXT);
    CREATE TABLE workflow_outbox (event_id TEXT);
    CREATE TABLE workflow_projection_work (enqueue_operation_id TEXT);
    CREATE TABLE workflow_execution_attempts (
      attempt_id TEXT, lifecycle_id TEXT, project_id TEXT, attempt_number INTEGER, attempt_state TEXT
    );
    CREATE TABLE workflow_attempt_results (result_id TEXT, attempt_id TEXT, project_id TEXT, outcome TEXT);
    CREATE TABLE workflow_technical_verdicts (
      verdict_id TEXT, attempt_id TEXT, project_id TEXT, tested_source_revision TEXT, verdict TEXT,
      supersedes_verdict_id TEXT, project_revision INTEGER
    );
    CREATE TABLE workflow_verification_evidence (
      evidence_id TEXT, verdict_id TEXT, attempt_id TEXT, project_id TEXT,
      source_revision TEXT, observation TEXT, content_hash TEXT,
      durable_output_ref TEXT, environment_json TEXT
    );
    INSERT INTO project_authority VALUES (1, 'fixture-project', 195, 0);
    INSERT INTO milestones VALUES ('M003', 'active');
    INSERT INTO slices VALUES ('M003', 'S07', 'pending');
    INSERT INTO workflow_item_lifecycles VALUES
      ('life-m003', 'fixture-project', 'milestone', 'M003', NULL, NULL, 'ready'),
      ('life-s07', 'fixture-project', 'slice', 'M003', 'S07', NULL, 'ready');
  `);

  const task = database.prepare("INSERT INTO tasks VALUES ('M003', 'S07', ?, 'complete')");
  const lifecycle = database.prepare(
    "INSERT INTO workflow_item_lifecycles VALUES (?, 'fixture-project', 'task', 'M003', 'S07', ?, 'completed')",
  );
  const attempt = database.prepare(
    "INSERT INTO workflow_execution_attempts VALUES (?, ?, 'fixture-project', ?, 'settled')",
  );
  const result = database.prepare(
    "INSERT INTO workflow_attempt_results VALUES (?, ?, 'fixture-project', 'succeeded')",
  );
  const verdict = database.prepare(
    "INSERT INTO workflow_technical_verdicts VALUES (?, ?, 'fixture-project', ?, ?, NULL, ?)",
  );
  const evidence = database.prepare(
    "INSERT INTO workflow_verification_evidence VALUES (?, ?, ?, 'fixture-project', ?, ?, ?, ?, ?)",
  );
  for (let index = 1; index <= 6; index += 1) {
    const taskId = `T${String(index).padStart(2, "0")}`;
    const lifecycleId = `life-${taskId.toLowerCase()}`;
    const attemptId = `attempt-${taskId.toLowerCase()}`;
    const verdictId = `verdict-${taskId.toLowerCase()}`;
    task.run(taskId);
    lifecycle.run(lifecycleId, taskId);
    attempt.run(attemptId, lifecycleId, 1);
    result.run(`result-${taskId.toLowerCase()}`, attemptId);
    const sourceRevision = `sha256:${String(index).repeat(64)}`;
    const isSupersededT05Attempt = taskId === "T05";
    verdict.run(
      verdictId,
      attemptId,
      sourceRevision,
      isSupersededT05Attempt ? "inconclusive" : "pass",
      100 + index,
    );
    const evidenceHash = `sha256:${String(index + 1).repeat(64)}`;
    evidence.run(
      `evidence-${taskId.toLowerCase()}`,
      verdictId,
      attemptId,
      sourceRevision,
      isSupersededT05Attempt ? "inconclusive" : "passed",
      evidenceHash,
      `db://fixture/${attemptId}${isSupersededT05Attempt ? "/source-drift" : ""}`,
      JSON.stringify({
        taskId,
        attempt: 1,
        ...(isSupersededT05Attempt ? { reason: "source-drift" } : {}),
      }),
    );
    if (options.duplicateEvidence && index === 1) {
      evidence.run(
        "evidence-t01-duplicate",
        verdictId,
        attemptId,
        sourceRevision,
        "passed",
        evidenceHash,
        `db://fixture/${attemptId}/duplicate`,
        JSON.stringify({ taskId, duplicate: true }),
      );
    }
  }

  attempt.run("attempt-t05-retry", "life-t05", 2);
  result.run("result-t05-retry", "attempt-t05-retry");
  const retrySource = `sha256:${"a".repeat(64)}`;
  verdict.run("verdict-t05-retry", "attempt-t05-retry", retrySource, "pass", 150);
  evidence.run(
    "evidence-t05-retry",
    "verdict-t05-retry",
    "attempt-t05-retry",
    retrySource,
    "passed",
    `sha256:${"b".repeat(64)}`,
    "db://fixture/attempt-t05-retry",
    JSON.stringify({ taskId: "T05", attempt: 2 }),
  );

  const operation = database.prepare("INSERT INTO workflow_operations VALUES (?, 'fixture-project', ?, ?)");
  const event = database.prepare(`
    INSERT INTO workflow_domain_events VALUES (?, ?, 'fixture-project', 0, ?, ?, ?)
  `);
  const outbox = database.prepare("INSERT INTO workflow_outbox VALUES (?)");
  const projection = database.prepare("INSERT INTO workflow_projection_work VALUES (?)");
  for (let index = 0; index < 33; index += 1) {
    const advanced = index < 10;
    const missingShadow = index >= 10 && index < 21;
    const eventId = `event-${String(index + 1).padStart(2, "0")}`;
    const operationId = `operation-${String(index + 1).padStart(2, "0")}`;
    const disposition = advanced ? "advanced" : "repaired";
    operation.run(
      operationId,
      "lifecycle.shadow.repair",
      `internal:m003:s07:t02:repair:${String(index + 1).padStart(2, "0")}`,
    );
    event.run(
      eventId,
      operationId,
      138 + index,
      `lifecycle.shadow.${disposition}`,
      JSON.stringify({
        disposition,
        comparison: { kind: missingShadow ? "missing_shadow" : "status_mismatch" },
        evidence: { evidenceDigest: `sha256:${String((index % 23) + 1).padStart(2, "0").repeat(32)}` },
      }),
    );
    outbox.run(eventId);
    projection.run(operationId);
  }
  if (options.unrelatedRepair) {
    operation.run("operation-unrelated", "lifecycle.shadow.repair", "internal:m002:s01:t01:repair:01");
    event.run(
      "event-unrelated",
      "operation-unrelated",
      171,
      "lifecycle.shadow.repaired",
      JSON.stringify({
        disposition: "repaired",
        comparison: { kind: "status_mismatch" },
        evidence: { evidenceDigest: `sha256:${"f".repeat(64)}` },
      }),
    );
    outbox.run("event-unrelated");
    projection.run("operation-unrelated");
  }
  database.close();
}

function passingReports(databasePath?: string) {
  return {
    ...(databasePath ? { resolveCanonicalDatabasePath: () => databasePath } : {}),
    runNoCutover: () => ({
      verdict: "pass",
      githubMetadataUsed: false,
      structuralChecks: Array.from({ length: 8 }, (_, index) => ({ id: `structural-${index}`, verdict: "pass" })),
      behavioralChecks: NO_CUTOVER_BEHAVIORAL_WITNESSES.map((witness) => ({ ...witness, verdict: "pass" })),
    }),
    runAuthorityBaseline: () => ({
      verdict: "pass",
      invariants: Array.from({ length: 4 }, (_, index) => ({ id: `authority-${index}`, verdict: "pass" })),
    }),
  };
}

test("collector emits one canonical read-only snapshot without relabeling fixture evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-"));
  tempDirs.add(root);
  mkdirSync(join(root, ".gsd"), { recursive: true });
  const databasePath = join(root, ".gsd", "gsd.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");
  const beforeDatabaseHash = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

  const input = await collectM003S07DossierInput(
    { sourceRoot: process.cwd(), databasePath, capstonePath },
    passingReports(databasePath),
  );

  assert.equal(input.observationEvidencePlane, "capstone_fixture");
  assert.equal(input.canonicalHistoryEvidencePlane, "live_project");
  assert.equal(input.publicResponseHash, capstone.evidence.responseHash);
  assert.equal(input.sourceCapstoneEvidenceHash, capstone.evidenceHash);
  assert.equal(input.observations[0].items[0].itemIdentity.milestoneId, "M001");
  assert.equal(input.liveDrift[0].milestoneId, "M003");
  assert.equal(input.repairHistory.length, 33);
  assert.equal(input.authority.projectId, "fixture-project");
  assert.equal(input.taskReceiptHistory.length, 7);
  assert.deepEqual(
    input.taskReceiptHistory.filter((receipt) => receipt.taskId === "T05")
      .map((receipt) => ({
        attempt: receipt.attemptNumber,
        resultId: receipt.resultId,
        current: receipt.current,
      })),
    [
      { attempt: 1, resultId: "result-t05", current: false },
      { attempt: 2, resultId: "result-t05-retry", current: true },
    ],
  );
  assert.deepEqual(input.taskReceiptHeads.map((head) => head.taskId), ["T01", "T02", "T03", "T04", "T05", "T06"]);
  assert.deepEqual(input.compatibilityInventory.map(({ id, file, title }) => ({ id, file, title })),
    NO_CUTOVER_BEHAVIORAL_WITNESSES.map(({ id, file, title }) => ({ id, file, title })));
  assert.equal(buildDossier(input).recommendation, "NO_GO");
  assert.deepEqual(input.commands.map(({ id, stage, verdict }) => ({ id, stage, verdict })), [
    { id: "semantic-shadow-capstone", stage: "post_generation", verdict: "required" },
    { id: "semantic-shadow-no-cutover", stage: "observed", verdict: "pass" },
    { id: "authority-baseline", stage: "observed", verdict: "pass" },
    { id: "dossier-check", stage: "post_generation", verdict: "required" },
    { id: "verify-merge", stage: "post_generation", verdict: "required" },
  ]);
  assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), beforeDatabaseHash);

  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual({ ...readOnly.prepare("SELECT revision, authority_epoch FROM project_authority").get() }, {
    revision: 195,
    authority_epoch: 0,
  });
  readOnly.close();
});

test("collector rejects a database outside the source project's canonical identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-foreign-db-"));
  tempDirs.add(root);
  const canonicalDatabasePath = join(root, "canonical.db");
  const foreignDatabasePath = join(root, "foreign.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(canonicalDatabasePath);
  makeFixtureDatabase(foreignDatabasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  await assert.rejects(
    collectM003S07DossierInput(
      { sourceRoot: process.cwd(), databasePath: foreignDatabasePath, capstonePath },
      passingReports(canonicalDatabasePath),
    ),
    /canonical database identity/i,
  );
});

test("collector fails closed when source changes during collection", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-source-change-"));
  tempDirs.add(root);
  const databasePath = join(root, "gsd.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  const revisions = [
    capstone.evidence.sourceRevision,
    `sha256:${"f".repeat(64)}`,
  ];
  let captureCount = 0;
  const dependencies = {
    ...passingReports(databasePath),
    captureSourceRevision: () => ({
      ok: true as const,
      sourceRevision: revisions[captureCount++]!,
    }),
  };

  await assert.rejects(
    collectM003S07DossierInput(
      { sourceRoot: process.cwd(), databasePath, capstonePath },
      dependencies,
    ),
    /dossier source changed during collection/i,
  );
  assert.equal(captureCount, 2);
});

test("collector fails closed when relevant database evidence changes during collection", async (t) => {
  const mutations = [
    {
      name: "legacy lifecycle status",
      mutate(database: DatabaseSync): void {
        database.prepare("UPDATE tasks SET status = 'active' WHERE id = 'T01'").run();
      },
    },
    {
      name: "canonical receipt evidence",
      mutate(database: DatabaseSync): void {
        database.prepare(`
          UPDATE workflow_verification_evidence
          SET observation = 'changed during collection'
          WHERE evidence_id = 'evidence-t01'
        `).run();
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-db-change-"));
      tempDirs.add(root);
      const databasePath = join(root, "gsd.db");
      const capstonePath = join(root, "capstone.json");
      makeFixtureDatabase(databasePath);
      const capstone = normalizeSemanticShadowCapstoneEvidence(
        await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
      );
      writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

      const dependencies = passingReports(databasePath);
      const runNoCutover = dependencies.runNoCutover;
      dependencies.runNoCutover = () => {
        const database = new DatabaseSync(databasePath);
        mutation.mutate(database);
        database.close();
        return runNoCutover();
      };

      await assert.rejects(
        collectM003S07DossierInput(
          { sourceRoot: process.cwd(), databasePath, capstonePath },
          dependencies,
        ),
        /database evidence changed during collection/i,
      );
    });
  }
});

test("collector fail-closes when a local report regresses", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-cli-"));
  tempDirs.add(root);
  mkdirSync(join(root, ".gsd"), { recursive: true });
  const databasePath = join(root, ".gsd", "gsd.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  const reports = passingReports(databasePath);
  reports.runNoCutover = () => ({
    ...passingReports(databasePath).runNoCutover(),
    verdict: "fail",
  });

  await assert.rejects(
    collectM003S07DossierInput(
      { sourceRoot: process.cwd(), databasePath, capstonePath },
      reports,
    ),
    /no-cutover report must pass/i,
  );
});

test("collector excludes repair events outside the M003/S07/T02 lineage", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-lineage-"));
  tempDirs.add(root);
  const databasePath = join(root, "gsd.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath, { unrelatedRepair: true });
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  const input = await collectM003S07DossierInput(
    { sourceRoot: process.cwd(), databasePath, capstonePath },
    passingReports(databasePath),
  );
  assert.equal(input.repairHistory.length, 33);
  assert.equal(input.repairHistory.some((row) => row.eventId === "event-unrelated"), false);
});

test("collector rejects duplicate evidence rows even when their hashes match", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-evidence-"));
  tempDirs.add(root);
  const databasePath = join(root, "gsd.db");
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath, { duplicateEvidence: true });
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  await assert.rejects(
    collectM003S07DossierInput(
      { sourceRoot: process.cwd(), databasePath, capstonePath },
      passingReports(databasePath),
    ),
    /receipt history.*seven Attempts/i,
  );
});

test("CLI runs local reports and emits canonical validator-ready JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-cli-"));
  tempDirs.add(root);
  const stateDir = join(root, "state");
  const databasePath = join(stateDir, "projects", "fixture-project", "gsd.db");
  mkdirSync(join(stateDir, "projects", "fixture-project"), { recursive: true });
  const capstonePath = join(root, "capstone.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  const environment = {
    ...process.env,
    GSD_PROJECT_ID: "fixture-project",
    GSD_STATE_DIR: stateDir,
  };
  delete environment.NODE_TEST_CONTEXT;
  const stdout = execFileSync(process.execPath, [
    "--import",
    loaderPath,
    "--experimental-strip-types",
    collectorPath,
    "--source-root",
    process.cwd(),
    "--database",
    databasePath,
    "--capstone",
    capstonePath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 240_000,
  });
  const input = JSON.parse(stdout);
  assert.equal(stdout.trimStart()[0], "{");
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(buildDossier(input).recommendation, "NO_GO");
  assert.deepEqual(input.noCutover, {
    structural: { passed: 8, total: 8 },
    behavioral: { passed: 15, total: 15 },
  });
  assert.deepEqual(input.authorityBaseline, { passed: 4, total: 4 });
});

test("CLI writes canonical validator-ready JSON to an explicit local output", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-input-output-"));
  tempDirs.add(root);
  const databasePath = join(root, "gsd.db");
  const capstonePath = join(root, "capstone.json");
  const outputPath = join(root, "dossier-input.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");

  await runDossierInputCli([
    "--source-root",
    process.cwd(),
    "--database",
    databasePath,
    "--capstone",
    capstonePath,
    "--output",
    outputPath,
  ], passingReports(databasePath));
  const written = readFileSync(outputPath, "utf8");
  const writtenInput = JSON.parse(written);
  assert.equal(written, `${JSON.stringify(writtenInput, null, 2)}\n`);
  assert.equal(buildDossier(writtenInput).recommendation, "NO_GO");
});

test("live dossier check recollects the database instead of trusting a saved input", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-dossier-live-check-"));
  tempDirs.add(root);
  const databasePath = join(root, "gsd.db");
  const capstonePath = join(root, "capstone.json");
  const dossierPath = join(root, "dossier.json");
  makeFixtureDatabase(databasePath);
  const capstone = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot: process.cwd() }),
  );
  writeFileSync(capstonePath, `${JSON.stringify(capstone)}\n`, "utf8");
  const dependencies = passingReports(databasePath);
  const input = await collectM003S07DossierInput(
    { sourceRoot: process.cwd(), databasePath, capstonePath },
    dependencies,
  );
  writeFileSync(dossierPath, renderDossier(buildDossier(input)), "utf8");
  const args = [
    "--source-root", process.cwd(),
    "--database", databasePath,
    "--capstone", capstonePath,
    "--check-dossier", dossierPath,
  ];

  await assert.doesNotReject(runDossierInputCli(args, dependencies));

  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE project_authority SET revision = revision + 1").run();
  database.close();
  await assert.rejects(
    runDossierInputCli(args, dependencies),
    /stale relative to freshly collected local evidence/i,
  );
});

test("CLI rejects remote, duplicate, and unknown arguments before collection", () => {
  const base = [
    "--import",
    loaderPath,
    "--experimental-strip-types",
    collectorPath,
  ];
  const invalidArguments = [
    ["--source-root", "https://example.com/repo", "--database", "db", "--capstone", "capstone"],
    ["--source-root", process.cwd(), "--database", "db", "--capstone", "capstone", "--output", "https://example.com/input"],
    ["--source-root", process.cwd(), "--source-root", process.cwd(), "--database", "db", "--capstone", "capstone"],
    ["--source-root", process.cwd(), "--database", "db", "--capstone", "capstone", "--extra", "value"],
  ];
  for (const args of invalidArguments) {
    const result = spawnSync(process.execPath, [...base, ...args], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.notEqual(result.stderr, "", args.join(" "));
  }
});
