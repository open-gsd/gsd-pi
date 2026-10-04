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

import { resetSliceOrchestrator, restoreSliceState } from "../slice-parallel-orchestrator.ts";
import { createWorktree } from "../worktree-manager.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

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
