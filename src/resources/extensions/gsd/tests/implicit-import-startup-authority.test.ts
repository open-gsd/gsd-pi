// Project/App: gsd-pi
// File Purpose: Proves startup and layout compatibility paths never import Markdown into canonical authority.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { openProjectDbIfPresent } from "../auto-start.ts";
import { migrateToFlatPhase } from "../flat-phase-migration.ts";
import {
  _getAdapter,
  closeDatabase,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { fingerprintLegacyImportCorpusTree } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = join(
  import.meta.dirname,
  "__fixtures__",
  "legacy-import-corpus",
  "v1",
  "gsd-nested",
  "source",
  ".gsd",
);
const SNAPSHOT_TABLES = [
  "project_authority",
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "decisions",
  "memories",
  "artifacts",
  "assessments",
  "workflow_item_lifecycles",
  "workflow_execution_attempts",
  "workflow_attempt_results",
  "workflow_kernel_checkpoints",
  "workflow_operations",
  "workflow_import_applications",
  "workflow_domain_events",
  "workflow_outbox",
  "workflow_projection_work",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
] as const;
const temporaryDirectories = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function createMarkdownOnlyProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-implicit-import-authority-"));
  temporaryDirectories.add(base);
  cpSync(CORPUS_ROOT, join(base, ".gsd"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  return base;
}

function durableSnapshot(): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_TABLES.map((table) => [
    table,
    db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function totalChanges(): number {
  return Number(db().prepare("SELECT total_changes() AS count").get()?.["count"]);
}

function nonDatabaseTreeSnapshot(root: string, relative = ""): string[] {
  const rows: string[] = [];
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (/^gsd\.db(?:-(?:wal|shm|journal))?$/.test(entry.name)) continue;
    if (entry.isDirectory()) {
      rows.push(`${child}/`);
      rows.push(...nonDatabaseTreeSnapshot(root, child));
    } else if (entry.isSymbolicLink()) {
      rows.push(`${child}->${readlinkSync(join(root, child))}`);
    } else {
      rows.push(`${child}:${readFileSync(join(root, child)).toString("base64")}`);
    }
  }
  return rows;
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("startup database open and derive ignore markdown-only hierarchy without changing authority", async () => {
  const base = createMarkdownOnlyProject();
  const databasePath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(databasePath), true);
  const beforeOpen = durableSnapshot();
  closeDatabase();
  const sourceTreeBefore = nonDatabaseTreeSnapshot(join(base, ".gsd"));

  await openProjectDbIfPresent(base);

  assert.equal(isDbAvailable(), true);
  assert.deepEqual(durableSnapshot(), beforeOpen);
  assert.deepEqual(nonDatabaseTreeSnapshot(join(base, ".gsd")), sourceTreeBefore);
  assert.equal(totalChanges(), 0, "opening an existing database performs no authority write");
  const beforeDerive = durableSnapshot();
  const changesBeforeDerive = totalChanges();
  invalidateStateCache();

  const state = await deriveStateFromDb(base);

  assert.equal(state.registry.length, 0);
  assert.equal(state.activeMilestone, null);
  assert.equal(state.phase, "pre-planning");
  assert.deepEqual(durableSnapshot(), beforeDerive);
  assert.equal(totalChanges(), changesBeforeDerive);
  assert.deepEqual(
    nonDatabaseTreeSnapshot(join(base, ".gsd")),
    sourceTreeBefore,
    "open and derive leave every non-database source byte exact",
  );
});

test("PROJECT.md startup reconciliation cannot create canonical milestone rows", async () => {
  const base = createMarkdownOnlyProject();
  writeFileSync(
    join(base, ".gsd", "PROJECT.md"),
    "# Project\n\n## Milestone Sequence\n- [ ] M010: Disk-only milestone - Must remain projection-only\n",
    "utf8",
  );
  const databasePath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(databasePath), true);
  const beforeOpen = durableSnapshot();
  closeDatabase();
  const sourceTreeBefore = nonDatabaseTreeSnapshot(join(base, ".gsd"));

  // The real bootstrap startup path (bootstrapAutoSession → openProjectDbIfPresent
  // → deriveStateFromDb) must leave the PROJECT.md milestone sequence as
  // projection-only bytes: zero authority writes, zero canonical rows.
  await openProjectDbIfPresent(base);

  assert.equal(isDbAvailable(), true);
  assert.deepEqual(durableSnapshot(), beforeOpen);
  assert.equal(totalChanges(), 0, "startup database open performs no authority write");
  const beforeDerive = durableSnapshot();
  const changesBeforeDerive = totalChanges();
  invalidateStateCache();

  const state = await deriveStateFromDb(base);

  assert.equal(state.registry.length, 0, "PROJECT.md milestone sequence must not enter the registry");
  assert.equal(state.activeMilestone, null);
  assert.deepEqual(durableSnapshot(), beforeDerive);
  assert.equal(totalChanges(), changesBeforeDerive);
  assert.deepEqual(
    nonDatabaseTreeSnapshot(join(base, ".gsd")),
    sourceTreeBefore,
    "PROJECT.md startup refusal leaves the complete non-database source tree exact",
  );
});

test("flat-phase layout migration cannot ingest markdown-only hierarchy into an empty database", async () => {
  const base = createMarkdownOnlyProject();
  const milestonesPath = join(base, ".gsd", "milestones");
  const sourceBefore = fingerprintLegacyImportCorpusTree(milestonesPath);
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const before = durableSnapshot();
  const changesBefore = totalChanges();
  const sourceTreeBefore = nonDatabaseTreeSnapshot(join(base, ".gsd"));

  await assert.rejects(
    () => migrateToFlatPhase(base),
    /Recommended: run `\/gsd recover`/,
  );

  assert.deepEqual(durableSnapshot(), before);
  assert.equal(totalChanges(), changesBefore);
  assert.equal(existsSync(milestonesPath), true, "projection remains available for explicit import");
  assert.equal(fingerprintLegacyImportCorpusTree(milestonesPath), sourceBefore);
  assert.deepEqual(
    nonDatabaseTreeSnapshot(join(base, ".gsd")),
    sourceTreeBefore,
    "refused flat migration leaves the complete non-database source tree exact",
  );
  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
  assert.equal(existsSync(join(base, ".gsd-backups")), false);
});

test("no production module imports the legacy markdown importer (md-importer is test-only)", () => {
  // md-importer's migrateFromMarkdown/migrateHierarchyToDb are an unconsented,
  // unverified markdown→DB write path kept alive for test scaffolding only.
  // Every production markdown→DB import must go through the crash-safe Import
  // Application (workflow_import_applications). This guard fails if any
  // non-test module starts importing md-importer directly.
  const gsdSourceDir = join(import.meta.dirname, "..");
  const MD_IMPORTER_RE =
    /from\s+["'][^"']*md-importer(?:\.js|\.ts)?["']|import\(\s*["'][^"']*md-importer(?:\.js|\.ts)?["']\s*\)|require\(\s*["'][^"']*md-importer(?:\.js|\.ts)?["']\s*\)/;

  const productionFiles: string[] = [];
  const stack = [gsdSourceDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests" && entry.name !== "node_modules") stack.push(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        productionFiles.push(full);
      }
    }
  }
  assert.ok(productionFiles.length > 0, "should find GSD production source files");

  const offenders = productionFiles
    .filter((file) => MD_IMPORTER_RE.test(readFileSync(file, "utf-8")))
    .map((file) => file.slice(gsdSourceDir.length + 1));
  assert.deepEqual(
    offenders,
    [],
    `Production modules must not import the test-only legacy markdown importer ` +
      `(md-importer); route markdown→DB imports through the Import Application ` +
      `instead. Offenders:\n  ${offenders.join("\n  ")}`,
  );
});
