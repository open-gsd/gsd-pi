// gsd-pi — Behavior test: slice-parallel cleanup keeps the slice branch.
//
// No code merges `slice/<MID>/<SID>` yet. Cleanup removes the slice worktree
// directory and must keep the branch, so the commits of a slice worker are
// never force-deleted.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  _createSliceWorktreeForTest,
  resetSliceOrchestrator,
  restoreSliceState,
} from "../slice-parallel-orchestrator.ts";
import { createWorktree } from "../worktree-manager.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function initRepo(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(["init", "-b", "main"], base);
  git(["config", "user.name", "Test"], base);
  git(["config", "user.email", "test@example.invalid"], base);
  git(["config", "commit.gpgsign", "false"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# project\n");
  git(["add", ".gsd/PROJECT.md"], base);
  git(["commit", "-m", "init"], base);
  return base;
}

function advanceMain(base: string): string {
  writeFileSync(join(base, "main-work.ts"), "export const moved = true;\n");
  git(["add", "main-work.ts"], base);
  git(["commit", "-m", "feat: main moves"], base);
  return git(["rev-parse", "HEAD"], base);
}

test("a kept slice branch without own commits restarts at the current start point", (t) => {
  const base = initRepo("gsd-slice-stale-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // A worker failed the startup gate: the worktree is gone, the branch stays.
  git(["branch", "slice/M001/S01"], base);
  const movedMain = advanceMain(base);

  const wtPath = _createSliceWorktreeForTest(base, "M001", "S01");

  assert.equal(git(["rev-parse", "HEAD"], wtPath), movedMain, "the worktree is at the current start point");
  assert.equal(git(["rev-parse", "slice/M001/S01"], base), movedMain, "the slice branch moved to the start point");
});

test("a kept slice branch with own commits is reused after main moves", (t) => {
  const base = initRepo("gsd-slice-reuse-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const first = createWorktree(base, "M001-S01", { branch: "slice/M001/S01" });
  writeFileSync(join(first.path, "slice-work.ts"), "export const done = true;\n");
  git(["add", "slice-work.ts"], first.path);
  git(["commit", "-m", "feat: slice work"], first.path);
  const workerCommit = git(["rev-parse", "HEAD"], first.path);
  git(["worktree", "remove", "--force", first.path], base);
  advanceMain(base);

  const wtPath = _createSliceWorktreeForTest(base, "M001", "S01");

  assert.equal(git(["rev-parse", "HEAD"], wtPath), workerCommit, "the worktree has the worker's commit");
});

test("cleanup of a slice worker removes the worktree and keeps the commits on the slice branch", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-slice-branch-")));
  t.after(() => {
    resetSliceOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });
  git(["init", "-b", "main"], base);
  git(["config", "user.name", "Test"], base);
  git(["config", "user.email", "test@example.invalid"], base);
  git(["config", "commit.gpgsign", "false"], base);
  writeFileSync(join(base, "README.md"), "# project\n");
  git(["add", "README.md"], base);
  git(["commit", "-m", "init"], base);

  const worktree = createWorktree(base, "M001-S01", { branch: "slice/M001/S01" });
  writeFileSync(join(worktree.path, "slice-work.ts"), "export const done = true;\n");
  git(["add", "slice-work.ts"], worktree.path);
  git(["commit", "-m", "feat: slice work"], worktree.path);
  const workerCommit = git(["rev-parse", "HEAD"], worktree.path);

  // The coordinator restarts and finds the worker process gone.
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "slice-orchestrator.json"), JSON.stringify({
    active: true,
    workers: [{
      milestoneId: "M001",
      sliceId: "S01",
      pid: 2147483646,
      worktreePath: worktree.path,
      startedAt: 1,
      state: "running",
      completedUnits: 1,
      cost: 0,
    }],
    totalCost: 0,
    maxWorkers: 1,
    startedAt: 1,
    basePath: base,
  }));

  assert.equal(restoreSliceState(base), null, "no worker survives");
  assert.equal(existsSync(worktree.path), false, "the slice worktree is removed");
  assert.equal(git(["rev-parse", "slice/M001/S01"], base), workerCommit, "the slice branch keeps the worker's commit");

  // The next start for the slice attaches to the kept branch.
  const again = createWorktree(base, "M001-S01", { branch: "slice/M001/S01", reuseExistingBranch: true });
  assert.equal(git(["rev-parse", "HEAD"], again.path), workerCommit);
});
