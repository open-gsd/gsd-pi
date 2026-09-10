// Project/App: gsd-pi
// File Purpose: Executable safety contracts for legacy SQLite target Preview interpretation.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createDbAdapter } from "../db-adapter.ts";
import type {
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
} from "../legacy-import-contract.ts";
import {
  inspectLegacyImportGsdDatabaseEvidence,
  inspectLegacyImportDatabaseTarget,
  LegacyImportDatabaseTargetInspectionError,
  type LegacyImportDatabaseTargetInspectorDeps,
} from "../legacy-import-database-target-inspector.ts";
import {
  collectLegacyImportDatabaseTargetEvidence,
  contributeLegacyImportDatabaseTargets,
  interpretLegacyImportDatabaseTargets,
  LegacyImportDatabaseTargetError,
  type LegacyImportDatabaseTargetInspectionEvidence,
  type LegacyImportDatabaseTargetInspectionRequest,
} from "../legacy-import-preview-database-target.ts";
import { interpretLegacyGsdCapture } from "../legacy-import-preview-gsd.ts";
import {
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportPendingDiagnosis,
} from "../legacy-import-preview-interpretation.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "../legacy-import-preview.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const DATABASE_MATRIX_SCENARIOS = [
  "corrupt",
  "current-v49",
  "future-v50",
  "historical-v30",
  "historical-v34",
  "historical-v43",
  "historical-v45",
  "historical-v46",
  "historical-v47",
  "historical-v48",
  "unversioned-populated",
  "wal-present",
] as const;

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-database-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function createDatabase(path: string, version: number | null, populated = false): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE milestones (id TEXT PRIMARY KEY);
      CREATE TABLE decisions (id TEXT PRIMARY KEY);
      CREATE TABLE memories (id TEXT PRIMARY KEY);
      CREATE TABLE trigger_anchor (id INTEGER);
    `);
    if (version !== null) {
      database.prepare("INSERT INTO schema_version VALUES (?, '2026-01-01T00:00:00Z')").run(version);
    }
    if (version !== null && version >= 31) database.exec("CREATE TABLE project_authority (singleton INTEGER)");
    if (version !== null && version >= 35) database.exec("CREATE TABLE workflow_import_applications (id TEXT)");
    if (version !== null && version >= 44) {
      database.exec(`
        CREATE TRIGGER trg_workflow_lifecycle_reopen_authorization
        AFTER INSERT ON trigger_anchor BEGIN SELECT 1; END
      `);
    }
    if (version !== null && version >= 45) {
      database.exec(`
        CREATE TABLE workflow_authority_cutovers (operation_id TEXT PRIMARY KEY);
        CREATE TABLE workflow_import_restores (operation_id TEXT PRIMARY KEY);
        CREATE TABLE workflow_import_forward_repairs (operation_id TEXT PRIMARY KEY);
      `);
    }
    if (populated) {
      database.exec(`
        INSERT INTO milestones VALUES ('M001');
        INSERT INTO decisions VALUES ('D001');
        INSERT INTO memories VALUES ('MEM001');
      `);
    }
  } finally {
    database.close();
  }
}

function createLifecycleEvidenceDatabase(
  path: string,
  options: { encoding?: "UTF-16le"; duplicateDependency?: boolean } = {},
): void {
  const database = new DatabaseSync(path);
  try {
    if (options.encoding !== undefined) database.exec(`PRAGMA encoding='${options.encoding}'`);
    database.exec(`
      CREATE TABLE slices (
        milestone_id TEXT NOT NULL,
        id TEXT NOT NULL,
        depends TEXT,
        PRIMARY KEY (milestone_id, id)
      );
      CREATE TABLE slice_dependencies (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        depends_on_slice_id TEXT NOT NULL
      );
    `);
    if (options.encoding !== undefined) {
      database.prepare("INSERT INTO slices VALUES ('M001', 'S01', ?)").run('["UTF16-DEPENDENCY"]');
    } else if (options.duplicateDependency === true) {
      database.exec(`
        INSERT INTO slice_dependencies VALUES ('M001', 'S01', 'REPEATED-DEPENDENCY');
        INSERT INTO slice_dependencies VALUES ('M001', 'S02', 'REPEATED-DEPENDENCY');
      `);
    }
  } finally {
    database.close();
  }
}

function root(
  id: string,
  kind: LegacyImportSourceRoot["kind"],
  physicalPath: string,
  logicalPath: string,
): LegacyImportSourceRoot {
  return { id, kind, physical_path: physicalPath, logical_path: logicalPath, presence: "required" };
}

function databaseRequest(capture: LegacyImportSourceCapture): LegacyImportDatabaseTargetInspectionRequest {
  const entry = capture.entries.find((candidate) => candidate.logical_path.endsWith("/gsd.db"));
  if (entry?.kind !== "file" || entry.payload_id === undefined || entry.sha256 === undefined
    || entry.byte_size === undefined) throw new Error("test capture has no retained database file");
  const payload = capture.payloads.find((candidate) => candidate.payload_id === entry.payload_id);
  const capturedRoot = capture.roots.find((candidate) => candidate.id === entry.root_id);
  if (payload === undefined || (capturedRoot?.kind !== "project" && capturedRoot?.kind !== "external")) {
    throw new Error("test capture has incomplete database identity");
  }
  return {
    capture_hash: capture.capture_hash,
    source_id: entry.source_id,
    root_kind: capturedRoot.kind,
    logical_path: entry.logical_path,
    source_sha256: entry.sha256,
    source_byte_size: entry.byte_size,
    bytes: Buffer.from(payload.bytes_base64, "base64"),
  };
}

function resealEvidence(
  evidence: LegacyImportDatabaseTargetInspectionEvidence,
  mutate: (value: Record<string, unknown>) => void,
): LegacyImportDatabaseTargetInspectionEvidence {
  const value = structuredClone(evidence) as unknown as Record<string, unknown>;
  delete value["evidence_hash"];
  mutate(value);
  return {
    ...value,
    evidence_hash: hashLegacyImportValue(value),
  } as unknown as LegacyImportDatabaseTargetInspectionEvidence;
}

function assertTargetError(
  fn: () => unknown,
  code: string,
  stage: "collect" | "interpret",
  retryable: boolean,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LegacyImportDatabaseTargetError);
    assert.equal(error.code, code);
    assert.equal(error.stage, stage);
    assert.equal(error.retryable, retryable);
    return true;
  });
}

function assertInspectionError(
  fn: () => unknown,
  code: string,
  stage: "materialize" | "provider" | "evidence" | "close" | "cleanup",
  retryable: boolean,
): LegacyImportDatabaseTargetInspectionError {
  let inspected: LegacyImportDatabaseTargetInspectionError | undefined;
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LegacyImportDatabaseTargetInspectionError);
    assert.equal(error.code, code);
    assert.equal(error.stage, stage);
    assert.equal(error.retryable, retryable);
    assert.doesNotMatch(error.message, /protected|sensitive/u);
    inspected = error;
    return true;
  });
  return inspected!;
}

function inspectorHarness(t: { after(fn: () => void): void }): {
  deps: LegacyImportDatabaseTargetInspectorDeps;
  state: { cleanupCalls: number; scratch: string };
} {
  const state = { cleanupCalls: 0, scratch: "" };
  const deps: LegacyImportDatabaseTargetInspectorDeps = {
    makeTemporaryDirectory: () => {
      state.scratch = mkdtempSync(join(tmpdir(), "gsd-preview-database-inspector-"));
      return state.scratch;
    },
    writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
    readFile: (path) => readFileSync(path),
    removeTemporaryDirectory: (path) => {
      state.cleanupCalls += 1;
      rmSync(path, { recursive: true, force: true });
    },
    openReadOnly: (path) => ({ db: createDbAdapter(new DatabaseSync(path, { readOnly: true })) }),
  };
  t.after(() => {
    if (state.scratch !== "") rmSync(state.scratch, { recursive: true, force: true });
  });
  return { deps, state };
}

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function sourcePaths(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]): unknown[] {
  return sources.map(({ source_id: _sourceId, ...source }) => source).sort(compareCanonical);
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: paths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  const diagnosisKeys = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    canonicalLegacyImportJson({
      code: diagnosis.code,
      source: paths.get(diagnosis.source_id) ?? diagnosis.source_id,
      locator: diagnosis.locator,
    }),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: diagnosisKeys.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

test("legacy preview database inspector collects exact retained-byte lifecycle dependency evidence", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  cpSync(
    fileURLToPath(new URL("./lifecycle-truth-matrix/source/.gsd", CORPUS_ROOT)),
    gsd,
    { recursive: true, dereference: false, verbatimSymlinks: true },
  );
  const databasePath = join(gsd, "gsd.db");
  const beforeBytes = readFileSync(databasePath);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const request = databaseRequest(capture);
  const harness = inspectorHarness(t);

  const first = inspectLegacyImportGsdDatabaseEvidence(request, harness.deps);
  const second = inspectLegacyImportGsdDatabaseEvidence(request, harness.deps);

  assert.deepEqual(second, first);
  assert.deepEqual(first.coverage, [
    { table: "slices", field: "depends", complete: true, row_count: 1 },
    { table: "slice_dependencies", field: "depends_on_slice_id", complete: true, row_count: 1 },
  ]);
  assert.deepEqual(first.observations, [
    {
      table: "slices",
      key: { milestone_id: "M001", id: "S02" },
      field: "depends",
      value: ["S00"],
      raw: {
        locator: { start_byte: 118696, end_byte: 118703 },
        value: '["S00"]',
        sha256: "sha256:4b3f2c064a7a7f5d23f1efe7776e52ccc4a5cfe3627ed1735ceb26ffe32103b0",
      },
    },
    {
      table: "slice_dependencies",
      key: { milestone_id: "M001", slice_id: "S02" },
      field: "depends_on_slice_id",
      value: "S99",
      raw: {
        locator: { start_byte: 180209, end_byte: 180212 },
        value: "S99",
        sha256: "sha256:5c06606b31c31c3dfab03ce04ee502731830f6220178e10b5d006815de8b06ba",
      },
    },
  ]);
  assert.equal(first.capture_hash, capture.capture_hash);
  assert.equal(first.source_id, request.source_id);
  assert.equal(first.source_sha256, request.source_sha256);
  assert.equal(first.source_byte_size, request.source_byte_size);
  const evidenceValue = { ...first };
  delete (evidenceValue as Partial<typeof first>).evidence_hash;
  assert.equal(first.evidence_hash, hashLegacyImportValue(evidenceValue));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.observations), true);
  assert.deepEqual(
    interpretLegacyGsdCapture(capture, [first]).candidates
      .filter((candidate) => candidate.reason_code === "dependency-conflict-raw-evidence")
      .map((candidate) => [candidate.target.key, candidate.raw.locator] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["M001/S02/dependency-junction", { start_byte: 180209, end_byte: 180212 }],
      ["M001/S02/depends-column", { start_byte: 118696, end_byte: 118703 }],
    ],
  );
  assert.deepEqual(readFileSync(databasePath), beforeBytes);
  assert.equal(harness.state.cleanupCalls, 2);
  assert.equal(existsSync(harness.state.scratch), false);
});

test("legacy preview database inspector reports complete empty dependency coverage for absent legacy schema", (t) => {
  const base = temporaryDirectory(t);
  const scenarios = [
    {
      name: "absent-tables",
      create(path: string) {
        cpSync(
          fileURLToPath(new URL("./action-matrix/source/.gsd/gsd.db", CORPUS_ROOT)),
          path,
        );
      },
    },
    {
      name: "absent-columns",
      create(path: string) {
        const database = new DatabaseSync(path);
        try {
          database.exec(`
            CREATE TABLE slices (milestone_id TEXT NOT NULL, id TEXT NOT NULL);
            CREATE TABLE slice_dependencies (milestone_id TEXT NOT NULL, slice_id TEXT NOT NULL);
          `);
        } finally {
          database.close();
        }
      },
    },
  ];

  for (const scenario of scenarios) {
    const gsd = join(base, scenario.name);
    mkdirSync(gsd);
    scenario.create(join(gsd, "gsd.db"));
    const capture = captureLegacyImportSourceSet({
      roots: [root(scenario.name, "project", gsd, ".gsd")],
    });

    const evidence = inspectLegacyImportGsdDatabaseEvidence(databaseRequest(capture));

    assert.deepEqual(evidence.coverage, [
      { table: "slices", field: "depends", complete: true, row_count: 0 },
      { table: "slice_dependencies", field: "depends_on_slice_id", complete: true, row_count: 0 },
    ]);
    assert.deepEqual(evidence.observations, []);
  }
});

test("legacy preview database lifecycle evidence fails closed on missing and ambiguous retained-byte spans", (t) => {
  const base = temporaryDirectory(t);
  const scenarios = [
    {
      name: "missing",
      value: "UTF16-DEPENDENCY",
      code: "LEGACY_IMPORT_DATABASE_EVIDENCE_SPAN_MISSING",
      options: { encoding: "UTF-16le" as const },
      occurrences: "0",
    },
    {
      name: "ambiguous",
      value: "REPEATED-DEPENDENCY",
      code: "LEGACY_IMPORT_DATABASE_EVIDENCE_SPAN_AMBIGUOUS",
      options: { duplicateDependency: true },
      occurrences: "2",
    },
  ];

  for (const scenario of scenarios) {
    const gsd = join(base, scenario.name);
    mkdirSync(gsd);
    createLifecycleEvidenceDatabase(join(gsd, "gsd.db"), scenario.options);
    const capture = captureLegacyImportSourceSet({
      roots: [root(scenario.name, "project", gsd, ".gsd")],
    });
    const request = databaseRequest(capture);

    const error = assertInspectionError(
      () => inspectLegacyImportGsdDatabaseEvidence(request),
      scenario.code,
      "evidence",
      false,
    );

    assert.equal(error.context.occurrence_count, scenario.occurrences);
    assert.equal(JSON.stringify(error).includes(scenario.value), false);
  }
});

test("legacy preview database lifecycle evidence rejects malformed present dependency values", (t) => {
  const gsd = join(temporaryDirectory(t), ".gsd");
  mkdirSync(gsd);
  const database = new DatabaseSync(join(gsd, "gsd.db"));
  try {
    database.exec(`
      CREATE TABLE slices (
        milestone_id TEXT NOT NULL,
        id TEXT NOT NULL,
        depends TEXT
      );
      INSERT INTO slices VALUES ('M001', 'S01', 'not-json');
    `);
  } finally {
    database.close();
  }
  const capture = captureLegacyImportSourceSet({
    roots: [root("malformed", "project", gsd, ".gsd")],
  });

  assertInspectionError(
    () => inspectLegacyImportGsdDatabaseEvidence(databaseRequest(capture)),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_QUERY_FAILED",
    "evidence",
    false,
  );
});

test("legacy preview database target inspects retained main-only bytes and leaves the source untouched", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  const databasePath = join(gsd, "gsd.db");
  createDatabase(databasePath, SCHEMA_VERSION);
  const beforeBytes = readFileSync(databasePath);
  const beforeNames = readdirSync(gsd).sort();
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  let scratch = "";

  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, (request) => (
    inspectLegacyImportDatabaseTarget(request, {
      makeTemporaryDirectory: () => {
        scratch = mkdtempSync(join(tmpdir(), "gsd-preview-database-test-"));
        return scratch;
      },
      writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
      readFile: (path) => readFileSync(path),
      removeTemporaryDirectory: (path) => rmSync(path, { recursive: true, force: true }),
      openReadOnly: (path) => ({ db: createDbAdapter(new DatabaseSync(path, { readOnly: true })) }),
    })
  ));
  const interpretation = interpretLegacyImportDatabaseTargets(capture, evidence);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.inspection.kind, "sqlite");
  assert.equal(Object.isFrozen(evidence[0]), true);
  assert.equal(Object.isFrozen(evidence[0]?.inspection), true);
  assert.equal(JSON.stringify(evidence).includes(base), false);
  assert.notEqual(scratch, "");
  assert.equal(existsSync(scratch), false);
  assert.deepEqual(interpretation.sources.map((source) => [source.path, source.outcome]), [[".gsd/gsd.db", "mapped"]]);
  assert.deepEqual(interpretation.diagnoses, []);
  assert.deepEqual(readFileSync(databasePath), beforeBytes);
  assert.deepEqual(readdirSync(gsd).sort(), beforeNames);
});

test("database contribution claims only decoded database files and preserves wrapper semantics", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 43);
  writeFileSync(join(gsd, "NOTES.md"), "# Not database evidence\n");
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  const files = decodeLegacyImportCapture(capture, {
    sourceLabel: "database contribution",
    includes: (entry) => entry.kind !== "directory",
    parserId: () => "unclaimed",
    kind: () => "unclaimed",
    parserVersion: "1",
  });
  rmSync(gsd, { recursive: true, force: true });
  const diagnoses: LegacyImportPendingDiagnosis[] = [];

  const claimed = contributeLegacyImportDatabaseTargets(capture, files, evidence, diagnoses);
  const claimedFiles = files.filter((file) => claimed.has(file.entry.source_id));
  const contributed = finalizeLegacyImportInterpretation(claimedFiles, [], diagnoses);
  const compatibility = interpretLegacyImportDatabaseTargets(capture, evidence);
  const database = files.find((file) => file.entry.logical_path === ".gsd/gsd.db");
  const notes = files.find((file) => file.entry.logical_path === ".gsd/NOTES.md");

  assert.deepEqual([...claimed], [database?.entry.source_id]);
  assert.deepEqual(contributed, compatibility);
  assert.equal(database?.parserId, "gsd-sqlite-target");
  assert.equal(database?.outcome, "mapped");
  assert.equal(notes?.parserId, "unclaimed");
  assert.equal(notes?.outcome, "mapped");
});

test("database targets recognize prefixed project .gsd logical roots", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 43);
  const capture = captureLegacyImportSourceSet({
    roots: [root("historical-v43", "project", gsd, "historical-v43/.gsd")],
  });

  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  const interpretation = interpretLegacyImportDatabaseTargets(capture, evidence);

  assert.equal(evidence.length, 1);
  assert.deepEqual(interpretation.sources.map((source) => source.path), [
    "historical-v43/.gsd/gsd.db",
  ]);
  assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), [
    "historical-schema-version",
  ]);
});

test("legacy preview database target never inspects WAL, SHM, journal, or worktree groups", (t) => {
  const base = temporaryDirectory(t);
  const project = join(base, "project");
  const worktree = join(base, "worktree");
  mkdirSync(project);
  mkdirSync(worktree);
  for (const name of ["gsd.db", "gsd.db-wal", "gsd.db-shm"]) writeFileSync(join(project, name), name);
  writeFileSync(join(worktree, "gsd.db"), "worktree database");
  const capture = captureLegacyImportSourceSet({
    roots: [
      root("project", "project", project, ".gsd"),
      root("worktree", "worktree", worktree, ".gsd-worktrees/M001/.gsd"),
    ],
  });
  let calls = 0;

  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, () => {
    calls += 1;
    throw new Error("must not inspect a journal group");
  });
  const decoded = decodeLegacyImportCapture(capture, {
    sourceLabel: "database contribution",
    includes: (entry) => entry.kind !== "directory",
    parserId: () => "unclaimed",
    kind: () => "unclaimed",
    parserVersion: "1",
  });
  const directDiagnoses: LegacyImportPendingDiagnosis[] = [];
  const claimed = contributeLegacyImportDatabaseTargets(capture, decoded, evidence, directDiagnoses);
  const interpretation = interpretLegacyImportDatabaseTargets(capture, evidence);

  assert.equal(calls, 0);
  assert.deepEqual(evidence, []);
  assert.deepEqual(
    decoded.filter((file) => claimed.has(file.entry.source_id)).map((file) => file.entry.logical_path),
    [".gsd/gsd.db", ".gsd/gsd.db-shm", ".gsd/gsd.db-wal"],
  );
  assert.deepEqual(directDiagnoses.map((diagnosis) => diagnosis.code), ["wal-sidecars-present"]);
  assert.deepEqual(interpretation.sources.map((source) => [source.path, source.outcome]), [
    [".gsd/gsd.db", "mapped"],
    [".gsd/gsd.db-shm", "preserved"],
    [".gsd/gsd.db-wal", "preserved"],
  ]);
  assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["wal-sidecars-present"]);

  const journal = join(base, "journal");
  mkdirSync(journal);
  writeFileSync(join(journal, "gsd.db"), "main database");
  writeFileSync(join(journal, "gsd.db-journal"), "rollback journal");
  const journalCapture = captureLegacyImportSourceSet({
    roots: [root("journal", "project", journal, ".gsd")],
  });
  const journalEvidence = collectLegacyImportDatabaseTargetEvidence(journalCapture, () => {
    calls += 1;
    throw new Error("must not inspect a rollback-journal group");
  });
  const journalResult = interpretLegacyImportDatabaseTargets(journalCapture, journalEvidence);

  assert.equal(calls, 0);
  assert.deepEqual(journalResult.sources.map((source) => [source.path, source.outcome]), [
    [".gsd/gsd.db", "unparsed"],
    [".gsd/gsd.db-journal", "preserved"],
  ]);
  assert.deepEqual(journalResult.diagnoses.map((diagnosis) => diagnosis.code), [
    "incomplete-database-sidecars",
  ]);
});

test("legacy preview database target sanitizes provider setup failures and removes the copy", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  let scratch = "";

  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, (request) => (
    inspectLegacyImportDatabaseTarget(request, {
      makeTemporaryDirectory: () => {
        scratch = mkdtempSync(join(tmpdir(), "gsd-preview-database-failure-"));
        return scratch;
      },
      writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
      readFile: (path) => readFileSync(path),
      removeTemporaryDirectory: (path) => rmSync(path, { recursive: true, force: true }),
      openReadOnly: () => ({
        db: {
          exec: () => {
            throw new Error("sensitive provider detail /protected/source.db");
          },
          prepare: () => {
            throw new Error("must not query after setup failure");
          },
          close: () => undefined,
        },
      }),
    })
  ));

  const inspection = evidence[0]?.inspection;
  assert.equal(inspection?.kind, "rejected");
  assert.equal(inspection?.kind === "rejected" ? inspection.reason : undefined, "open-failed");
  assert.match(inspection?.kind === "rejected" ? inspection.failure_fingerprint : "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("sensitive provider detail"), false);
  assert.notEqual(scratch, "");
  assert.equal(existsSync(scratch), false);
});

test("database inspector exposes exact typed failures without leaking operational details", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const request = databaseRequest(capture);

  const invalid = inspectorHarness(t);
  const requestError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(
      { ...request, source_byte_size: request.source_byte_size + 1 },
      invalid.deps,
    ),
    "LEGACY_IMPORT_DATABASE_INSPECTION_REQUEST_INVALID",
    "materialize",
    false,
  );
  assert.deepEqual(requestError.context, { source_id: request.source_id, logical_path: request.logical_path });
  assert.equal(invalid.state.scratch, "");
  assert.equal(invalid.state.cleanupCalls, 0);

  const temporary = inspectorHarness(t);
  temporary.deps.makeTemporaryDirectory = () => {
    throw new Error("sensitive /protected/temp");
  };
  const temporaryError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, temporary.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_TEMP_FAILED",
    "materialize",
    true,
  );
  assert.deepEqual(temporaryError.context, requestError.context);
  assert.equal(temporary.state.cleanupCalls, 0);

  const copy = inspectorHarness(t);
  copy.deps.writePrivateFile = () => {
    throw new Error("sensitive /protected/copy");
  };
  const copyError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, copy.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_FAILED",
    "materialize",
    true,
  );
  assert.deepEqual(copyError.context, requestError.context);
  assert.equal(copy.state.cleanupCalls, 1);
  assert.equal(existsSync(copy.state.scratch), false);

  const provider = inspectorHarness(t);
  const providerError = new LegacyImportDatabaseTargetInspectionError(
    "provider",
    "LEGACY_IMPORT_DATABASE_INSPECTION_PROVIDER_UNAVAILABLE",
    "legacy import database inspection requires an available SQLite provider",
    false,
  );
  provider.deps.openReadOnly = () => {
    throw providerError;
  };
  const propagated = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, provider.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_PROVIDER_UNAVAILABLE",
    "provider",
    false,
  );
  assert.equal(propagated, providerError);
  assert.deepEqual(propagated.context, {});
  assert.equal(provider.state.cleanupCalls, 1);
  assert.equal(existsSync(provider.state.scratch), false);

  const close = inspectorHarness(t);
  close.deps.openReadOnly = (path) => {
    const adapter = createDbAdapter(new DatabaseSync(path, { readOnly: true }));
    return {
      db: {
        ...adapter,
        close: () => {
          adapter.close();
          throw new Error("sensitive /protected/close");
        },
      },
    };
  };
  const closeError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, close.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_CLOSE_FAILED",
    "close",
    true,
  );
  assert.deepEqual(closeError.context, requestError.context);
  assert.equal(close.state.cleanupCalls, 1);
  assert.equal(existsSync(close.state.scratch), false);

  const changed = inspectorHarness(t);
  const stableRead = changed.deps.readFile;
  let reads = 0;
  changed.deps.readFile = (path) => {
    const bytes = stableRead(path);
    reads += 1;
    if (reads === 1) return bytes;
    const altered = Buffer.from(bytes);
    altered[altered.length - 1] ^= 1;
    return altered;
  };
  const changedError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, changed.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_CHANGED",
    "cleanup",
    false,
  );
  assert.deepEqual(changedError.context, requestError.context);
  assert.equal(changed.state.cleanupCalls, 1);
  assert.equal(existsSync(changed.state.scratch), false);

  const cleanup = inspectorHarness(t);
  cleanup.deps.removeTemporaryDirectory = (path) => {
    cleanup.state.cleanupCalls += 1;
    rmSync(path, { recursive: true, force: true });
    throw new Error("sensitive /protected/cleanup");
  };
  const cleanupError = assertInspectionError(
    () => inspectLegacyImportDatabaseTarget(request, cleanup.deps),
    "LEGACY_IMPORT_DATABASE_INSPECTION_CLEANUP_FAILED",
    "cleanup",
    true,
  );
  assert.deepEqual(cleanupError.context, requestError.context);
  assert.equal(cleanup.state.cleanupCalls, 1);
  assert.equal(existsSync(cleanup.state.scratch), false);
});

test("legacy preview database target keeps competing project and external targets unresolved", (t) => {
  const base = temporaryDirectory(t);
  const project = join(base, "project");
  const external = join(base, "external");
  mkdirSync(project);
  mkdirSync(external);
  createDatabase(join(project, "gsd.db"), 44);
  createDatabase(join(external, "gsd.db"), 43);
  const capture = captureLegacyImportSourceSet({
    roots: [
      root("project", "project", project, ".gsd"),
      root("external", "external", external, "$GSD_STATE_DIR/projects/project-1"),
    ],
  });

  const evidence = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  const interpretation = interpretLegacyImportDatabaseTargets(capture, evidence);
  const conflict = interpretation.diagnoses.find((diagnosis) => diagnosis.code === "competing-database-targets");
  assert.ok(conflict);
  assert.deepEqual(
    interpretation.resolutions.find((resolution) => resolution.diagnosis_id === conflict.diagnosis_id),
    { diagnosis_id: conflict.diagnosis_id, disposition: "requires-user" },
  );
});

test("legacy preview database target rejects evidence rebound to another source", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  const value = {
    ...evidence,
    source_byte_size: evidence.source_byte_size + 1,
    evidence_hash: undefined,
  };
  delete value.evidence_hash;
  const rebound = {
    ...value,
    evidence_hash: hashLegacyImportValue(value),
  } as LegacyImportDatabaseTargetInspectionEvidence;

  assert.throws(
    () => interpretLegacyImportDatabaseTargets(capture, [rebound]),
    /database target evidence source is inconsistent/,
  );
});

test("database evidence is bound to the complete capture, not only identical database bytes", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  const support = join(base, "support");
  mkdirSync(gsd);
  mkdirSync(support);
  createDatabase(join(gsd, "gsd.db"), 44);
  writeFileSync(join(support, "README.md"), "unrelated capture evidence\n");
  const databaseRoot = root("project", "project", gsd, ".gsd");
  const original = captureLegacyImportSourceSet({ roots: [databaseRoot] });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(original, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  const expanded = captureLegacyImportSourceSet({
    roots: [databaseRoot, root("support", "external", support, "support")],
  });
  assert.notEqual(expanded.capture_hash, original.capture_hash);
  assert.equal(databaseRequest(expanded).source_sha256, databaseRequest(original).source_sha256);

  assertTargetError(
    () => interpretLegacyImportDatabaseTargets(expanded, [evidence]),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_SOURCE_INCONSISTENT",
    "interpret",
    false,
  );
  const files = decodeLegacyImportCapture(expanded, {
    sourceLabel: "database capture binding",
    includes: (entry) => entry.kind !== "directory",
    parserId: () => "unclaimed",
    kind: () => "unclaimed",
    parserVersion: "1",
  });
  assertTargetError(
    () => contributeLegacyImportDatabaseTargets(expanded, files, [evidence], []),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_SOURCE_INCONSISTENT",
    "interpret",
    false,
  );
});

test("database evidence rejects missing, duplicate, and unexpected inspection records", (t) => {
  const base = temporaryDirectory(t);
  const first = join(base, "first");
  const second = join(base, "second");
  mkdirSync(first);
  mkdirSync(second);
  createDatabase(join(first, "gsd.db"), 44);
  createDatabase(join(second, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("first", "project", first, ".gsd")] });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  const otherCapture = captureLegacyImportSourceSet({
    roots: [root("second", "project", second, "other/.gsd")],
  });
  const [unexpected] = collectLegacyImportDatabaseTargetEvidence(otherCapture, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  assert.ok(unexpected);

  assertTargetError(
    () => interpretLegacyImportDatabaseTargets(capture, []),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_MISSING",
    "interpret",
    true,
  );
  assertTargetError(
    () => interpretLegacyImportDatabaseTargets(capture, [evidence, evidence]),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_UNEXPECTED",
    "interpret",
    false,
  );
  assertTargetError(
    () => interpretLegacyImportDatabaseTargets(capture, [unexpected]),
    "LEGACY_IMPORT_DATABASE_EVIDENCE_UNEXPECTED",
    "interpret",
    false,
  );
});

test("malformed sealed database evidence always fails with the typed invalid contract", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  const malformed = [
    resealEvidence(evidence, (value) => delete value["inspection"]),
    resealEvidence(evidence, (value) => {
      const inspection = value["inspection"] as Record<string, unknown>;
      const schema = inspection["schema"] as Record<string, unknown>;
      delete schema["anchors"];
    }),
    resealEvidence(evidence, (value) => {
      value["sidecars"] = { length: 0 };
    }),
    resealEvidence(evidence, (value) => {
      const inspection = value["inspection"] as Record<string, unknown>;
      inspection["kind"] = "unknown";
    }),
  ];

  for (const candidate of malformed) {
    assertTargetError(
      () => interpretLegacyImportDatabaseTargets(capture, [candidate]),
      "LEGACY_IMPORT_DATABASE_EVIDENCE_INVALID",
      "interpret",
      false,
    );
    assertTargetError(
      () => collectLegacyImportDatabaseTargetEvidence(capture, () => candidate),
      "LEGACY_IMPORT_DATABASE_EVIDENCE_INVALID",
      "collect",
      false,
    );
  }
});

test("legacy preview database target classifies supported schema boundaries and rejects unsafe ones", (t) => {
  const base = temporaryDirectory(t);
  const scenarios = [
    { name: "historical-v30", version: 30, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v34", version: 34, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v43", version: 43, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v45", version: 45, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v46", version: 46, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v47", version: 47, code: "historical-schema-version", outcome: "mapped" },
    { name: "historical-v48", version: 48, code: "historical-schema-version", outcome: "mapped" },
    { name: "future-v50", version: 50, code: "future-schema-version", outcome: "unparsed" },
  ] as const;
  for (const scenario of scenarios) {
    const gsd = join(base, scenario.name);
    mkdirSync(gsd);
    createDatabase(join(gsd, "gsd.db"), scenario.version);
    const capture = captureLegacyImportSourceSet({
      roots: [root(scenario.name, "project", gsd, ".gsd")],
    });
    const evidence = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
    const interpretation = interpretLegacyImportDatabaseTargets(capture, evidence);
    assert.equal(interpretation.sources[0]?.outcome, scenario.outcome, scenario.name);
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), [scenario.code], scenario.name);
  }

  const unversioned = join(base, "unversioned");
  mkdirSync(unversioned);
  createDatabase(join(unversioned, "gsd.db"), null, true);
  const unversionedCapture = captureLegacyImportSourceSet({
    roots: [root("unversioned", "project", unversioned, ".gsd")],
  });
  const unversionedResult = interpretLegacyImportDatabaseTargets(
    unversionedCapture,
    collectLegacyImportDatabaseTargetEvidence(unversionedCapture, inspectLegacyImportDatabaseTarget),
  );
  assert.equal(unversionedResult.sources[0]?.outcome, "mapped");
  assert.deepEqual(unversionedResult.diagnoses.map((diagnosis) => diagnosis.code), [
    "unversioned-populated-database",
  ]);

  const corrupt = join(base, "corrupt");
  mkdirSync(corrupt);
  writeFileSync(join(corrupt, "gsd.db"), "not a sqlite database");
  const corruptCapture = captureLegacyImportSourceSet({
    roots: [root("corrupt", "project", corrupt, ".gsd")],
  });
  const corruptEvidence = collectLegacyImportDatabaseTargetEvidence(corruptCapture, inspectLegacyImportDatabaseTarget);
  const corruptResult = interpretLegacyImportDatabaseTargets(corruptCapture, corruptEvidence);
  assert.equal(corruptEvidence[0]?.inspection.kind, "rejected");
  assert.equal(corruptResult.sources[0]?.outcome, "unparsed");
  assert.deepEqual(corruptResult.diagnoses.map((diagnosis) => diagnosis.code), ["corrupt-database"]);
  assert.deepEqual(corruptResult.diagnoses[0]?.locator, { start_byte: 0, end_byte: 16 });
  assert.doesNotMatch(JSON.stringify(corruptResult.diagnoses), /not a sqlite database/u);
  assert.deepEqual(Object.keys(corruptResult.diagnoses[0]?.raw_value ?? {}).sort(), ["redacted", "sha256"]);
});

test("legacy preview database target requires every v46 recovery receipt anchor", (t) => {
  const base = temporaryDirectory(t);
  for (const missingName of [
    "workflow_authority_cutovers",
    "workflow_import_restores",
    "workflow_import_forward_repairs",
  ]) {
    const gsd = join(base, missingName);
    mkdirSync(gsd);
    const path = join(gsd, "gsd.db");
    createDatabase(path, 46);
    const database = new DatabaseSync(path);
    database.exec(`DROP TABLE ${missingName}`);
    database.close();
    const capture = captureLegacyImportSourceSet({
      roots: [root(missingName.replaceAll("_", "-"), "project", gsd, ".gsd")],
    });
    const result = interpretLegacyImportDatabaseTargets(
      capture,
      collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget),
    );
    assert.equal(result.sources[0]?.outcome, "unparsed", missingName);
    assert.deepEqual(
      result.diagnoses.map((diagnosis) => diagnosis.code),
      ["unsupported-database-schema"],
      missingName,
    );
  }
});

test("legacy preview database target rejects undeclared evidence fields even with a recomputed hash", (t) => {
  const base = temporaryDirectory(t);
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  createDatabase(join(gsd, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({ roots: [root("project", "project", gsd, ".gsd")] });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  const value = { ...evidence, debug_path: "/protected/source.db", evidence_hash: undefined };
  delete value.evidence_hash;
  const injected = { ...value, evidence_hash: hashLegacyImportValue(value) };

  assert.throws(
    () => interpretLegacyImportDatabaseTargets(
      capture,
      [injected as unknown as LegacyImportDatabaseTargetInspectionEvidence],
    ),
    /database target evidence is invalid/,
  );
});

test("legacy preview database target treats multiple external databases as competing targets", (t) => {
  const base = temporaryDirectory(t);
  const first = join(base, "external-1");
  const second = join(base, "external-2");
  mkdirSync(first);
  mkdirSync(second);
  createDatabase(join(first, "gsd.db"), 44);
  createDatabase(join(second, "gsd.db"), 44);
  const capture = captureLegacyImportSourceSet({
    roots: [
      root("external-1", "external", first, "$GSD_STATE_DIR/projects/project-1"),
      root("external-2", "external", second, "$GSD_STATE_DIR/projects/project-2"),
    ],
  });
  const result = interpretLegacyImportDatabaseTargets(
    capture,
    collectLegacyImportDatabaseTargetEvidence(capture, inspectLegacyImportDatabaseTarget),
  );

  const conflicts = result.diagnoses.filter((diagnosis) => diagnosis.code === "competing-database-targets");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    result.resolutions.find((resolution) => resolution.diagnosis_id === conflicts[0]?.diagnosis_id),
    { diagnosis_id: conflicts[0]?.diagnosis_id, disposition: "requires-user" },
  );
});

test("database target interpretation covers orphan sidecars, symlinks, and invalid schema metadata", (t) => {
  const base = temporaryDirectory(t);
  const orphan = join(base, "orphan");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "gsd.db-wal"), "orphan WAL bytes");
  const orphanCapture = captureLegacyImportSourceSet({
    roots: [root("orphan", "project", orphan, ".gsd")],
  });
  const orphanResult = interpretLegacyImportDatabaseTargets(orphanCapture, []);
  assert.deepEqual(orphanResult.sources.map((source) => [source.path, source.outcome]), [
    [".gsd/gsd.db-wal", "preserved"],
  ]);
  assert.deepEqual(orphanResult.diagnoses.map((diagnosis) => diagnosis.code), [
    "orphaned-database-sidecars",
  ]);

  const linked = join(base, "linked");
  mkdirSync(linked);
  const linkedTarget = join(linked, "actual.db");
  createDatabase(linkedTarget, 44);
  symlinkSync(linkedTarget, join(linked, "gsd.db"));
  const linkedCapture = captureLegacyImportSourceSet({
    roots: [root("linked", "project", linked, ".gsd")],
  });
  const linkedResult = interpretLegacyImportDatabaseTargets(linkedCapture, []);
  assert.equal(linkedResult.sources[0]?.outcome, "unparsed");
  assert.deepEqual(linkedResult.diagnoses.map((diagnosis) => diagnosis.code), [
    "unsupported-database-symlink",
  ]);

  const invalid = join(base, "invalid");
  mkdirSync(invalid);
  createDatabase(join(invalid, "gsd.db"), 44);
  const invalidCapture = captureLegacyImportSourceSet({
    roots: [root("invalid", "project", invalid, ".gsd")],
  });
  const [evidence] = collectLegacyImportDatabaseTargetEvidence(invalidCapture, inspectLegacyImportDatabaseTarget);
  assert.ok(evidence);
  const invalidMetadata = resealEvidence(evidence, (value) => {
    const inspection = value["inspection"] as Record<string, unknown>;
    const schema = inspection["schema"] as Record<string, unknown>;
    schema["version_table_kind"] = "other";
  });
  const invalidResult = interpretLegacyImportDatabaseTargets(invalidCapture, [invalidMetadata]);
  assert.equal(invalidResult.sources[0]?.outcome, "unparsed");
  assert.deepEqual(invalidResult.diagnoses.map((diagnosis) => diagnosis.code), [
    "invalid-database-schema-metadata",
  ]);
});

test("independent retained database scenarios aggregate to the exact sealed matrix semantics", (t) => {
  const corpusBefore = loadLegacyImportCorpusCase(CORPUS_ROOT, "db-target-matrix");
  const fixtureIdentity = corpusBefore.files.map(({ path, byteSize, sha256, entryKind }) => ({
    path,
    byteSize,
    sha256,
    entryKind,
  }));
  const actualSources: LegacyImportPreviewSource[] = [];
  const actualDiagnoses: LegacyImportPreviewDiagnosis[] = [];
  const actualResolutions: LegacyImportPreviewResolution[] = [];
  const inspectorCalls = new Map<string, number>();
  const base = temporaryDirectory(t);

  for (const scenario of DATABASE_MATRIX_SCENARIOS) {
    const copiedScenario = join(base, scenario);
    const copiedGsd = join(copiedScenario, ".gsd");
    mkdirSync(copiedScenario);
    cpSync(
      fileURLToPath(new URL(`./db-target-matrix/source/${scenario}/.gsd`, CORPUS_ROOT)),
      copiedGsd,
      { recursive: true, dereference: false, verbatimSymlinks: true },
    );
    const capture = captureLegacyImportSourceSet({
      roots: [root(scenario, "project", copiedGsd, `${scenario}/.gsd`)],
    });
    rmSync(copiedScenario, { recursive: true, force: true });
    assert.equal(existsSync(copiedScenario), false, `${scenario}: source copy deleted before inspection`);
    function inspect(request: Parameters<typeof inspectLegacyImportDatabaseTarget>[0]) {
      inspectorCalls.set(scenario, (inspectorCalls.get(scenario) ?? 0) + 1);
      return inspectLegacyImportDatabaseTarget(request);
    }

    const firstEvidence = collectLegacyImportDatabaseTargetEvidence(capture, inspect);
    const first = interpretLegacyImportDatabaseTargets(capture, firstEvidence);
    const secondEvidence = collectLegacyImportDatabaseTargetEvidence(capture, inspect);
    const second = interpretLegacyImportDatabaseTargets(capture, secondEvidence);

    assert.deepEqual(secondEvidence, firstEvidence, `${scenario}: deterministic evidence`);
    assert.deepEqual(second, first, `${scenario}: deterministic interpretation`);
    actualSources.push(...first.sources);
    actualDiagnoses.push(...first.diagnoses);
    actualResolutions.push(...first.resolutions);
  }

  const oracle = corpusBefore.oracle;
  const actualPaths = sourcePaths(actualSources);
  const oraclePaths = sourcePaths(oracle.sources);
  assert.deepEqual(normalizedSources(actualSources), normalizedSources(oracle.sources));
  assert.deepEqual(
    normalizedDiagnoses(actualDiagnoses, actualPaths),
    normalizedDiagnoses(oracle.diagnoses, oraclePaths),
  );
  assert.deepEqual(
    normalizedResolutions(actualResolutions, actualDiagnoses, actualPaths),
    normalizedResolutions(oracle.resolutions, oracle.diagnoses, oraclePaths),
  );
  assert.deepEqual(oracle.changes, []);
  assert.equal(inspectorCalls.get("wal-present") ?? 0, 0, "WAL trio is never inspected");
  assert.deepEqual(
    loadLegacyImportCorpusCase(CORPUS_ROOT, "db-target-matrix").files
      .map(({ path, byteSize, sha256, entryKind }) => ({ path, byteSize, sha256, entryKind })),
    fixtureIdentity,
    "sealed source fixture remains byte-identical",
  );
});
