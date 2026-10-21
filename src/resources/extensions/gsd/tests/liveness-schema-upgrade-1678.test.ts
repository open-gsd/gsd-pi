import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getOpenWedge } from "../auto-liveness-backstop.ts";
import { databaseMaintenanceIntentPath } from "../database-maintenance-fence.ts";
import { runGSDDoctor } from "../doctor.ts";
import { createDbAdapter, type DbAdapter } from "../db-adapter.ts";
import { SCHEMA_VERSION, _setStartupInitializationBoundaryForTest } from "../db/engine.ts";
import {
  _getAdapter,
  closeAllDatabases,
  closeDatabase,
  openDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
} from "../gsd-db.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";

const V113_SCHEMA_V46_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/liveness-upgrade/v113-schema-v46.gsd.db",
);
const TEST_LOADER = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const DOCTOR_MODULE = new URL("../doctor.ts", import.meta.url).href;

const LIVENESS_OBJECTS = [
  ["table", "liveness_block_signatures"],
  ["table", "liveness_wedge_records"],
  ["index", "idx_liveness_wedges_open"],
] as const;

const PRESERVED_TABLES = [
  "milestones",
  "slices",
  "tasks",
  "verification_evidence",
  "artifacts",
  "workflow_execution_attempts",
  "workflow_attempt_results",
  "workflow_technical_verdicts",
  "workflow_verification_evidence",
] as const;

function createProject(): { basePath: string; dbPath: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-liveness-upgrade-1678-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  return { basePath, dbPath: join(basePath, ".gsd", "gsd.db") };
}

function seedWorkflowRows(db: DbAdapter): void {
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  db.exec("PRAGMA foreign_keys = OFF");
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${String(trigger["name"])}`);
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M003', 'Upgrade safety', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
      VALUES ('M003', 'S01', 'Bootstrap', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
      VALUES ('M003', 'S01', 'T05', 'Preserve state', 'in_progress');
    INSERT INTO verification_evidence
      (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
      VALUES ('T05', 'S01', 'M003', 'pnpm test', 0, 'pass', 42, '2026-01-01T00:02:00.000Z');
    INSERT INTO artifacts
      (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
      VALUES ('milestones/M003/slices/S01/tasks/T05-SUMMARY.md', 'SUMMARY', 'M003', 'S01', 'T05',
        '# Preserved upgrade evidence', '2026-01-01T00:02:00.000Z');
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
      claimed_at, ended_at, claim_operation_id, claim_project_revision,
      claim_authority_epoch, settle_operation_id, settle_project_revision,
      settle_authority_epoch, settle_outcome
    ) VALUES (
      'attempt-1678', 'project-1678', 'lifecycle-1678', 1, 'settled',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'claim-1678', 1,
      0, 'settle-1678', 2, 0, 'succeeded'
    );
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      'result-1678', 'project-1678', 'lifecycle-1678', 'attempt-1678', 'succeeded',
      '2026-01-01T00:01:00.000Z', 'settle-1678', 2, 0
    );
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      'verdict-1678', 'project-1678', 'criterion-1678', 'lifecycle-1678', 'attempt-1678',
      'revision-1678', 'pass', 'policy-1678', '1', 'release fixture evidence',
      '2026-01-01T00:02:00.000Z', 'verify-1678', 3, 0
    );
    INSERT INTO workflow_verification_evidence (
      evidence_id, project_id, verdict_id, criterion_id, lifecycle_id, attempt_id,
      evidence_class, command_or_tool, working_directory, started_at, ended_at,
      exit_code, observation, source_revision, observed_project_revision,
      content_hash, durable_output_ref, environment_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      'evidence-1678', 'project-1678', 'verdict-1678', 'criterion-1678',
      'lifecycle-1678', 'attempt-1678', 'command', 'pnpm test', '.',
      '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', 0, 'passed',
      'revision-1678', 2,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'evidence/1678.txt', '{"runner":"fixture"}', '2026-01-01T00:02:00.000Z',
      'verify-1678', 3, 0
    );
  `);
  for (const trigger of triggers) db.exec(String(trigger["sql"]));
  db.exec("PRAGMA foreign_keys = ON");
}

function dropLivenessSchema(): void {
  const db = _getAdapter();
  assert.ok(db);
  db.exec(`
    DROP INDEX IF EXISTS idx_liveness_wedges_open;
    DROP TABLE IF EXISTS liveness_wedge_records;
    DROP TABLE IF EXISTS liveness_block_signatures;
  `);
}

function loadV113Fixture(dbPath: string): void {
  copyFileSync(V113_SCHEMA_V46_FIXTURE, dbPath);
}

function fixtureHash(): string {
  return createHash("sha256").update(readFileSync(V113_SCHEMA_V46_FIXTURE)).digest("hex");
}

function schemaObjects(db: DbAdapter = _getAdapter()!): Array<{ type: unknown; name: unknown }> {
  return db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name IN (
      'liveness_block_signatures',
      'liveness_wedge_records',
      'idx_liveness_wedges_open'
    )
    ORDER BY type, name
  `).all().map((row) => ({ type: row["type"], name: row["name"] }));
}

function expectedSchemaObjects(): Array<{ type: string; name: string }> {
  return LIVENESS_OBJECTS
    .map(([type, name]) => ({ type, name }))
    .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

function snapshotWorkflowRows(db: DbAdapter = _getAdapter()!): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(PRESERVED_TABLES.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table}`).all(),
  ]));
}

function versionStamps(db: DbAdapter = _getAdapter()!): Record<string, number> {
  return {
    schemaVersion: Number(db.prepare("SELECT MAX(version) AS value FROM schema_version").get()?.["value"]),
    userVersion: Number(db.prepare("PRAGMA user_version").get()?.["user_version"]),
    applicationId: Number(db.prepare("PRAGMA application_id").get()?.["application_id"]),
  };
}

function assertLivenessSchemaReadOnly(dbPath: string): void {
  const db = createDbAdapter(new DatabaseSync(dbPath, { readOnly: true }));
  try {
    assert.deepEqual(schemaObjects(db), expectedSchemaObjects());
  } finally {
    db.close();
  }
}

test("#1678: opening a pre-v1.14 v46 database bootstraps liveness schema without changing workflow state", (t) => {
  const { basePath, dbPath } = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  loadV113Fixture(dbPath);
  const sealedHash = fixtureHash();
  const raw = new DatabaseSync(dbPath);
  const fixtureDb = createDbAdapter(raw);
  seedWorkflowRows(fixtureDb);
  assert.deepEqual(schemaObjects(fixtureDb), [], "v1.13 fixture must predate every liveness object");
  const rowsBefore = snapshotWorkflowRows(fixtureDb);
  const stampsBefore = versionStamps(fixtureDb);
  fixtureDb.close();
  assert.equal(fixtureHash(), sealedHash, "upgrade test must not mutate its sealed source fixture");

  assert.equal(openDatabase(dbPath), true);
  assert.deepEqual(schemaObjects(), expectedSchemaObjects());
  assert.deepEqual(
    versionStamps(),
    {
      schemaVersion: SCHEMA_VERSION,
      userVersion: SCHEMA_VERSION,
      applicationId: stampsBefore.applicationId,
    },
    "V47 and V48 migrations may move the version stamps to the current schema",
  );
  const rowsAfter = snapshotWorkflowRows();
  assert.deepEqual(
    {
      ...rowsAfter,
      tasks: rowsAfter.tasks.map(({ required_workflow_tools: _requiredWorkflowTools, ...row }) => row),
    },
    rowsBefore,
    "startup repair must not rewrite workflow-owned rows",
  );
  assert.deepEqual(
    rowsAfter.tasks.map((row) => row.required_workflow_tools),
    ["[]"],
    "V48 adds required_workflow_tools with the empty default",
  );
  assert.deepEqual(getOpenWedge(basePath), { ok: true, wedge: null });
  assert.equal(fixtureHash(), sealedHash, "upgrade must not mutate its sealed source fixture");
});

type OpenSurfaceContext = {
  target: ReturnType<typeof createProject>;
  alternate: ReturnType<typeof createProject>;
};

type OpenSurface = {
  name: string;
  setup(context: OpenSurfaceContext): void;
  invoke(context: OpenSurfaceContext): void | Promise<void>;
};

const OPEN_SURFACES: OpenSurface[] = [
  {
    name: "direct",
    setup: ({ target }) => loadV113Fixture(target.dbPath),
    invoke: ({ target }) => assert.equal(openDatabase(target.dbPath), true),
  },
  {
    name: "workspace cache miss",
    setup: ({ target }) => loadV113Fixture(target.dbPath),
    invoke: ({ target }) => assert.equal(openDatabaseByWorkspace(createWorkspace(target.basePath)), true),
  },
  {
    name: "workspace cache hit",
    setup: ({ target, alternate }) => {
      assert.equal(openDatabaseByWorkspace(createWorkspace(target.basePath)), true);
      dropLivenessSchema();
      assert.equal(openDatabaseByWorkspace(createWorkspace(alternate.basePath)), true);
    },
    invoke: ({ target }) => assert.equal(openDatabaseByWorkspace(createWorkspace(target.basePath)), true),
  },
  {
    name: "scope activation",
    setup: ({ target, alternate }) => {
      assert.equal(openDatabaseByWorkspace(createWorkspace(target.basePath)), true);
      dropLivenessSchema();
      assert.equal(openDatabaseByWorkspace(createWorkspace(alternate.basePath)), true);
    },
    invoke: ({ target }) => assert.equal(
      openDatabaseByScope(scopeMilestone(createWorkspace(target.basePath), "M001")),
      true,
    ),
  },
  {
    name: "fresh-process doctor",
    setup: ({ target }) => loadV113Fixture(target.dbPath),
    invoke: ({ target }) => {
      const output = execFileSync(process.execPath, [
        "--import", TEST_LOADER,
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { runGSDDoctor } from ${JSON.stringify(DOCTOR_MODULE)};
         const report = await runGSDDoctor(${JSON.stringify(target.basePath)}, { fix: true });
         process.stdout.write(JSON.stringify(report));`,
      ], { encoding: "utf8" });
      const report = JSON.parse(output) as Awaited<ReturnType<typeof runGSDDoctor>>;
      assert.ok(report.fixesApplied.some((fix) => fix.includes("liveness backstop schema")));
    },
  },
  {
    name: "same-process doctor",
    setup: ({ target }) => loadV113Fixture(target.dbPath),
    invoke: async ({ target }) => {
      const report = await runGSDDoctor(target.basePath, { fix: true });
      assert.ok(report.fixesApplied.some((fix) => fix.includes("liveness backstop schema")));
    },
  },
];

test("#1678: every open surface repairs missing liveness schema", async (t) => {
  for (const surface of OPEN_SURFACES) {
    await t.test(surface.name, async () => {
      const target = createProject();
      const alternate = createProject();
      try {
        const context = { target, alternate };
        surface.setup(context);
        await surface.invoke(context);

        closeAllDatabases();
        assertLivenessSchemaReadOnly(target.dbPath);
      } finally {
        closeAllDatabases();
        rmSync(target.basePath, { recursive: true, force: true });
        rmSync(alternate.basePath, { recursive: true, force: true });
      }
    });
  }
});

test("#1678: failed cached repair preserves the active workspace", (t) => {
  const target = createProject();
  const active = createProject();
  t.after(() => {
    _setStartupInitializationBoundaryForTest(null);
    closeAllDatabases();
    rmSync(target.basePath, { recursive: true, force: true });
    rmSync(active.basePath, { recursive: true, force: true });
  });

  const targetWorkspace = createWorkspace(target.basePath);
  const activeWorkspace = createWorkspace(active.basePath);
  assert.equal(openDatabaseByWorkspace(targetWorkspace), true);
  dropLivenessSchema();
  assert.equal(openDatabaseByWorkspace(activeWorkspace), true);
  _setStartupInitializationBoundaryForTest(() => {
    throw new Error("repair blocked");
  });

  assert.throws(() => openDatabaseByWorkspace(targetWorkspace), /repair blocked/);
  assert.equal(
    _getAdapter()!.prepare("PRAGMA database_list").get()?.["file"],
    activeWorkspace.contract.projectDb,
  );
  assert.equal(_getAdapter()!.prepare("SELECT 1 AS value").get()?.["value"], 1);
});

for (const [name, dropStatement] of [
  ["block-signature table", "DROP TABLE liveness_block_signatures"],
  ["wedge table", "DROP TABLE liveness_wedge_records"],
  ["open-wedge index", "DROP INDEX idx_liveness_wedges_open"],
] as const) {
  test(`#1678: startup repairs a schema missing only the ${name}`, (t) => {
    const { basePath, dbPath } = createProject();
    t.after(() => {
      closeDatabase();
      rmSync(basePath, { recursive: true, force: true });
    });

    assert.equal(openDatabase(dbPath), true);
    _getAdapter()!.exec(dropStatement);
    closeDatabase();

    assert.equal(openDatabase(dbPath), true);
    assert.deepEqual(schemaObjects(), expectedSchemaObjects());
  });
}

test("#1678: same-process doctor fix reports and repairs missing liveness schema", async (t) => {
  const { basePath, dbPath } = createProject();
  t.after(() => {
    _setStartupInitializationBoundaryForTest(null);
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  assert.equal(openDatabase(dbPath), true);
  seedWorkflowRows(_getAdapter()!);
  dropLivenessSchema();
  const failedRead = getOpenWedge(basePath);
  assert.equal(failedRead.ok, false);
  if (!failedRead.ok) assert.match(failedRead.error, /no such table: liveness_wedge_records/);
  const rowsBefore = snapshotWorkflowRows();
  let guardedStartupObserved = false;
  _setStartupInitializationBoundaryForTest((path) => {
    guardedStartupObserved = true;
    assert.equal(existsSync(databaseMaintenanceIntentPath(path)), true);
  });

  const report = await runGSDDoctor(basePath, { fix: true });

  assert.equal(guardedStartupObserved, true, "doctor repair must run through guarded startup maintenance");
  assert.ok(
    report.issues.some((issue) => String(issue.code) === "liveness_backstop_schema_missing"),
    "doctor records the schema defect it encountered",
  );
  assert.ok(
    report.fixesApplied.some((fix) => fix.includes("liveness backstop schema")),
    "doctor records the guarded startup repair",
  );
  assert.deepEqual(schemaObjects(), expectedSchemaObjects());
  assert.deepEqual(getOpenWedge(basePath), { ok: true, wedge: null });
  assert.deepEqual(snapshotWorkflowRows(), rowsBefore, "doctor repair must preserve workflow state and completion timestamps");
});
