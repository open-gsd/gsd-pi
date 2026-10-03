// Project/App: gsd-pi
// File Purpose: Plain `gsd doctor` (no --fix) reports only: it changes no project file, no git state and no DB row.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { invalidateAllCaches } from "../cache.ts";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
}

// doctor-history.jsonl is the doctor's own run log, written on every run by
// design (see doctor-history-public-api.test.ts). The SQLite files are compared
// by row content instead of bytes.
const NOT_PROJECT_STATE = new Set(["doctor-history.jsonl", "gsd.db", "gsd.db-wal", "gsd.db-shm"]);

function snapshotFiles(base: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || NOT_PROJECT_STATE.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files[`${relative(base, path)}/`] = "dir";
        walk(path);
      } else {
        files[relative(base, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  walk(base);
  return files;
}

function snapshotRows(): Record<string, unknown[]> {
  const db = _getAdapter();
  assert.ok(db);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<Record<string, unknown>>;
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    const name = String(table["name"]);
    rows[name] = db.prepare(`SELECT * FROM "${name}"`).all();
  }
  return rows;
}

test("plain doctor changes no file, no git state and no row", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-read-only-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // A merge conflict on a path doctor --fix resolves by itself.
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gitignore"), ".gsd/gsd.db*\n.gsd/doctor-history.jsonl\n", "utf-8");
  writeFileSync(join(base, ".gsd", "STATE.md"), "base\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  runGit(["checkout", "-b", "feature"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "feature\n", "utf-8");
  runGit(["commit", "-am", "feat: edit"], base);
  runGit(["checkout", "main"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "main\n", "utf-8");
  runGit(["commit", "-am", "feat: edit"], base);
  try {
    runGit(["merge", "feature"], base);
  } catch {
    // The conflict is the fixture.
  }
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")));

  // DB state that doctor --fix repairs: an open milestone with no rendered
  // files, and an artifact row whose file is not on disk.
  assert.equal(openWorkflowDatabase(base).ok, true);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  insertArtifact({
    path: "phases/01-test/01-01-SUMMARY.md",
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# Summary\n",
  });
  invalidateAllCaches();

  const filesBefore = snapshotFiles(base);
  const rowsBefore = snapshotRows();
  const gitBefore = runGit(["status", "--porcelain"], base);

  const report = await runGSDDoctor(base);

  assert.ok(report.issues.length > 0, "the fixture must give doctor something to report");
  assert.ok(report.issues.some((issue) => issue.code === "unresolved_git_conflicts"));
  assert.deepEqual(report.fixesApplied, []);
  assert.deepEqual(snapshotFiles(base), filesBefore);
  assert.equal(runGit(["status", "--porcelain"], base), gitBefore);
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")));
  assert.deepEqual(snapshotRows(), rowsBefore);
});
