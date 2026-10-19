// Project/App: gsd-pi
// File Purpose: The /gsd migrate DB import refreshes the PROJECT Milestone Sequence rows (ADR-046).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, test, type TestContext } from "node:test";

import { _getAdapter, closeDatabase, insertArtifact, insertMilestone, openDatabase } from "../gsd-db.ts";
import { readProjectMilestoneSequence } from "../db/writers/project-milestone-sequence.ts";
import { importWrittenMigrationToDb } from "../migrate/execution.ts";
import { writeGSDDirectory } from "../migrate/writer.ts";
import { stagedMigrationProjection } from "../migrate/publication-store.ts";
import type { GSDProject } from "../migrate/types.ts";
import { selectActiveMilestone } from "../milestone-readiness.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { applyImport, emptyPreview, planFor } from "./helpers/legacy-import-writer-harness.ts";
import type { LegacyImportApplicationPlanInstruction } from "../legacy-import-application-plan.ts";

function migrateProjectFixture(projectContent: string): GSDProject {
  return {
    milestones: [{
      id: "M001",
      title: "Auth System",
      vision: "Build the authentication system.",
      successCriteria: [],
      slices: [{
        id: "S01",
        title: "First Slice",
        risk: "low",
        depends: [],
        done: false,
        demo: "The authentication system works.",
        goal: "auth-system",
        tasks: [{ id: "T01", title: "Create auth middleware", description: "", done: false, estimate: "", files: [], mustHaves: [], summary: null }],
        research: null,
        summary: null,
      }],
      research: null,
      boundaryMap: [],
    }],
    projectContent,
    requirements: [],
    decisionsContent: "| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |\n|---|------|-------|----------|--------|-----------|------------|---------|\n",
  };
}

const PROJECT_CONTENT = [
  "# Migrated Project",
  "",
  "A project to migrate.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Auth System — Build the authentication system.",
  "- [ ] M002: Follow-up — The next stage after auth.",
  "",
].join("\n");

function makeWorkspace(t: TestContext): string {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-project-sequence-import-"));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function stageMigration(project: GSDProject, workspace: string): Promise<string> {
  const stagingRoot = join(workspace, "staging");
  mkdirSync(stagingRoot, { recursive: true });
  const staged = await writeGSDDirectory(project, stagingRoot);
  const stagedGsd = join(stagingRoot, ".gsd");
  const { logicalPaths, artifactHashes } = stagedMigrationProjection(stagedGsd, staged);
  // The target .gsd exists before the import, as the migration preparation leaves it.
  const base = join(workspace, "target");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  await importWrittenMigrationToDb(
    base,
    logicalPaths.map((logicalPath) => join(stagedGsd, logicalPath)),
    undefined,
    stagedGsd,
    undefined,
    artifactHashes,
  );
  return base;
}

function seedStaleSequenceRows(): void {
  const insert = _getAdapter()!.prepare(
    "INSERT INTO project_milestone_sequence (milestone_id, position) VALUES (:id, :position)",
  );
  insert.run({ ":id": "M999", ":position": 0 });
  insert.run({ ":id": "M002", ":position": 1 });
}

const writerDirectories = new Set<string>();

/** A fresh database for one Import Application writer test. */
function openWriterFixture(): void {
  const directory = mkdtempSync(join(tmpdir(), "gsd-project-sequence-writer-"));
  writerDirectories.add(directory);
  assert.equal(openDatabase(join(directory, "gsd.db")), true);
}

afterEach(() => {
  closeDatabase();
  for (const directory of writerDirectories) rmSync(directory, { recursive: true, force: true });
  writerDirectories.clear();
});

test("the migrate import replaces stale Milestone Sequence rows with the rows of the PROJECT artifact it stores", async (t) => {
  const workspace = makeWorkspace(t);
  const base = join(workspace, "target");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedStaleSequenceRows();
  closeDatabase();

  await stageMigration(migrateProjectFixture(PROJECT_CONTENT), workspace);
  assert.deepEqual(
    readProjectMilestoneSequence(_getAdapter()!),
    ["M001", "M002"],
    "the stale rows are gone: the sequence is exactly what the stored PROJECT document commits to",
  );

  // The refreshed rows decide the promotion. M002 is a content-less queued
  // shell listed in the sequence: a real, not-yet-planned roadmap stage. M003
  // is a phantom row that gsd_milestone_generate_id leaves behind.
  insertMilestone({ id: "M002", title: "Follow-up", status: "queued" });
  insertMilestone({ id: "M003", title: "Phantom", status: "queued" });
  invalidateStateCache();
  const active = await deriveStateFromDb(base);
  assert.equal(active.activeMilestone?.id, "M001");

  _getAdapter()!.prepare("UPDATE milestones SET status = 'complete' WHERE id = 'M001'").run();
  invalidateStateCache();
  const next = await deriveStateFromDb(base);
  assert.equal(next.activeMilestone?.id, "M002", "the in-sequence shell is promoted once M001 completes");
  assert.equal(next.phase, "pre-planning", "an in-sequence content-less shell goes to pre-planning");
  assert.equal(
    next.registry.find((entry) => entry.id === "M003")?.status,
    "pending",
    "the phantom is not promoted: its id left the sequence with the stale rows",
  );
});

test("the migrate import fills an empty Milestone Sequence table from the PROJECT artifact it stores", async (t) => {
  const workspace = makeWorkspace(t);
  const base = await stageMigration(migrateProjectFixture(PROJECT_CONTENT), workspace);

  assert.ok(
    _getAdapter()!.prepare("SELECT 1 AS present FROM artifacts WHERE path = '.gsd/PROJECT.md'").get(),
    "the import stored the PROJECT artifact row",
  );
  assert.deepEqual(
    readProjectMilestoneSequence(_getAdapter()!),
    ["M001", "M002"],
    "the table the startup backfill left empty holds the sequence of the stored document",
  );

  const rows = new Set(readProjectMilestoneSequence(_getAdapter()!));
  const shell = (id: string) => ({
    id, status: "queued", dependsOn: [] as const, queuedShell: true, done: false, parked: false,
    sliceCount: 0, hasContext: false, hasDraftContext: false,
  });
  assert.equal(
    selectActiveMilestone([shell("M999"), shell("M001")], rows)?.milestone.id,
    "M001",
    "the phantom M999 is not promotable: only a sequence row promotes a content-less shell",
  );
  assert.equal(
    selectActiveMilestone([shell("M999"), shell("M001")], new Set(["M999", "M002"]))?.milestone.id,
    "M999",
    "the stale rows the import replaced would have promoted the phantom — the failure mode this refresh prevents",
  );
});

function artifactRowInstruction(
  action: "create" | "update" | "delete",
  path: string,
  content: string | null,
  artifactType = "PROJECT",
): LegacyImportApplicationPlanInstruction {
  const identity = { path };
  const values = content === null
    ? {}
    : {
      ...(action === "create" ? identity : {}),
      artifact_type: artifactType,
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: content,
      content_hash: createHash("sha256").update(content).digest("hex"),
    };
  return { action, targetKind: "artifact", targetKey: path, rowSet: "artifacts", identity, values, changeIds: [path] };
}

function projectDocument(...milestoneLines: string[]): string {
  return ["# Project", "", "## Milestone Sequence", "", ...milestoneLines, ""].join("\n");
}

test("an Import Application that rewrites the PROJECT artifact row replaces the sequence rows in the same operation", () => {
  openWriterFixture();
  insertArtifact({
    path: ".gsd/PROJECT.md",
    artifact_type: "PROJECT",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: projectDocument("- [ ] M999: Phantom — A stale commitment."),
  });
  seedStaleSequenceRows();
  assert.deepEqual(readProjectMilestoneSequence(_getAdapter()!), ["M999", "M002"]);

  const rewritten = projectDocument(
    "- [ ] M001: Foundation — First runnable slice.",
    "- [ ] M004: Experiments — Follow-up work.",
  );
  const artifact = emptyPreview();
  const plan = planFor(artifact, [artifactRowInstruction("update", ".gsd/PROJECT.md", rewritten)]);
  applyImport(artifact, plan);

  assert.deepEqual(
    readProjectMilestoneSequence(_getAdapter()!),
    ["M001", "M004"],
    "the stored rows follow the rewritten document of the same committed Application",
  );
});

test("an Import Application that does not write the PROJECT artifact row leaves the stored sequence rows untouched", () => {
  openWriterFixture();
  seedStaleSequenceRows();

  const artifact = emptyPreview();
  const plan = planFor(artifact, [
    artifactRowInstruction("create", ".gsd/QUEUE.md", "# Queue\n\nNothing parked.\n", "QUEUE"),
  ]);
  applyImport(artifact, plan);

  assert.deepEqual(
    readProjectMilestoneSequence(_getAdapter()!),
    ["M999", "M002"],
    "no PROJECT write, no sequence refresh: the import must not fabricate rows from a document it did not store",
  );
});

test("an Import Application that deletes the PROJECT artifact row leaves no sequence rows", () => {
  openWriterFixture();
  insertArtifact({
    path: ".gsd/PROJECT.md",
    artifact_type: "PROJECT",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: projectDocument("- [ ] M001: Foundation — First runnable slice."),
  });
  seedStaleSequenceRows();

  const artifact = emptyPreview();
  const plan = planFor(artifact, [artifactRowInstruction("delete", ".gsd/PROJECT.md", null)]);
  applyImport(artifact, plan);

  assert.deepEqual(
    readProjectMilestoneSequence(_getAdapter()!),
    [],
    "a document that left the database leaves no sequence rows behind",
  );
});
