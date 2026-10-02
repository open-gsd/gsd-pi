// Project/App: gsd-pi
// File Purpose: Orphan project-state cleanup must never delete a workflow database that holds content.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCleanupProjects } from "../commands-maintenance.ts";
import { checkGlobalHealth } from "../doctor-global-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { closeDatabase, getAllMilestones, insertMilestone, openDatabase } from "../gsd-db.ts";

type Note = { message: string; kind: string };

/** Build a state root with three orphans: a DB with rows, an empty DB, and no DB. */
function makeStateRoot(t: { after(fn: () => void): void }): { projects: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "gsd-orphan-cleanup-"));
  const previous = process.env.GSD_STATE_DIR;
  process.env.GSD_STATE_DIR = stateDir;
  t.after(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const projects = join(stateDir, "projects");
  for (const hash of ["withrows", "emptydb", "nodb"]) {
    const dir = join(projects, hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "repo-meta.json"), JSON.stringify({
      version: 1,
      hash,
      // The repo was moved: the recorded root no longer exists.
      gitRoot: join(stateDir, "moved-away", hash),
      remoteUrl: "",
      createdAt: new Date().toISOString(),
    }), "utf-8");
  }

  openDatabase(join(projects, "withrows", "gsd.db"));
  insertMilestone({ id: "M001", title: "Work that must survive", status: "active" });
  closeDatabase();
  openDatabase(join(projects, "emptydb", "gsd.db"));
  closeDatabase();
  return { projects };
}

function assertWorkflowDbSurvived(projects: string): void {
  assert.equal(existsSync(join(projects, "nodb")), false, "an orphan without a database is removed");
  assert.equal(existsSync(join(projects, "emptydb")), false, "an orphan with an empty database is removed");
  assert.equal(openDatabase(join(projects, "withrows", "gsd.db")), true, "the database with content must still open");
  assert.deepEqual(getAllMilestones().map((milestone) => milestone.id), ["M001"]);
}

test("/gsd cleanup projects --fix keeps an orphan directory whose database holds content", async (t) => {
  const { projects } = makeStateRoot(t);
  const notes: Note[] = [];
  const ctx = { ui: { notify: (message: string, kind: string) => notes.push({ message, kind }) } };

  await handleCleanupProjects("--fix", ctx as any);

  assertWorkflowDbSurvived(projects);
  assert.match(notes.at(-1)?.message ?? "", /Kept 1 directory that holds a workflow database with content: withrows/);
});

test("doctor orphan fix keeps an orphan directory whose database holds content", async (t) => {
  const { projects } = makeStateRoot(t);
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];

  await checkGlobalHealth(issues, fixesApplied, () => true);

  assertWorkflowDbSurvived(projects);
  assert.equal(issues[0]?.code, "orphaned_project_state");
  assert.match(fixesApplied[0] ?? "", /removed 2 orphaned project state directories/);
  assert.match(fixesApplied[0] ?? "", /kept 1 that holds a workflow database with content/);
});
