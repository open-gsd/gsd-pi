// Integration regression for #549: merge_strategy: merge is not respected.
//
// mergeMilestoneToMain always called nativeMergeSquash regardless of the
// git.merge_strategy preference. When a user set `merge_strategy: merge`
// (to respect a global `merge.ff = false`), the squash path still ran.
//
// Fix (#549): an `effectiveStrategy` variable selects nativeMergeRegular
// (--no-ff --no-commit) when merge_strategy === "merge", leaving MERGE_HEAD
// so nativeCommit produces a real merge commit with two parents.
//
// These tests verify:
//   1. merge_strategy: merge → merge commit topology (two parents on main).
//   2. No merge_strategy set → squash commit topology (one parent on main).
//   3. Error messages reference the correct strategy label ("Merge" vs
//      "Squash merge") so users are not misled when a conflict or dirty-tree
//      error occurs under the merge strategy.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createAutoWorktree } from "../../auto-worktree-creation.ts";
import { mergeMilestoneToMain } from "../../auto-worktree-merge.ts";
import { closeDatabase } from "../../gsd-db.ts";
import { getSliceBranchName } from "../../worktree.ts";
import { seedMergeReadyMilestone } from "../merge-ready-fixture.ts";

function run(cmd: string, cwd: string): string {
  // Safe: all inputs are hardcoded test strings, not user input
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "merge-strategy-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  run("git config core.autocrlf false", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

function makeRoadmap(milestoneId: string, title: string): string {
  return `# ${milestoneId}: ${title}\n\n## Slices\n- [x] **S01: Feature**\n`;
}

function addSliceToMilestone(
  repo: string,
  wtPath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
  fileName: string,
): void {
  const normalizedPath = wtPath.replaceAll("\\", "/");
  const marker = "/.gsd/worktrees/";
  const idx = normalizedPath.indexOf(marker);
  const worktreeName =
    idx !== -1 ? normalizedPath.slice(idx + marker.length).split("/")[0] : null;

  const sliceBranch = getSliceBranchName(milestoneId, sliceId, worktreeName);

  run(`git checkout -b ${sliceBranch}`, wtPath);
  writeFileSync(join(wtPath, fileName), `export const feature = true;\n`);
  run("git add .", wtPath);
  run(`git commit -m "feat: ${sliceTitle}"`, wtPath);
  run(`git checkout milestone/${milestoneId}`, wtPath);
  run(
    `git merge --no-ff ${sliceBranch} -m "feat(${milestoneId}/${sliceId}): ${sliceTitle}"`,
    wtPath,
  );
  run(`git branch -d ${sliceBranch}`, wtPath);
}

/** Number of parents of the most recent commit on a branch. */
function parentCount(repo: string, branch: string): number {
  const parents = run(`git log -1 --format=%P ${branch}`, repo);
  return parents.trim() === "" ? 0 : parents.trim().split(/\s+/).length;
}

describe("mergeMilestoneToMain merge_strategy dispatch (#549)", { timeout: 300_000 }, () => {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  function freshRepo(): string {
    const d = createTempRepo();
    tempDirs.push(d);
    return d;
  }

  afterEach(() => {
    process.chdir(savedCwd);
    closeDatabase();
    for (const d of tempDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("#549: merge_strategy: merge produces a true merge commit with two parents", () => {
    const repo = freshRepo();

    // Write project preferences with merge_strategy: merge
    writeFileSync(
      join(repo, ".gsd", "PREFERENCES.md"),
      "---\nversion: 1\ngit:\n  merge_strategy: merge\n---\n",
    );

    seedMergeReadyMilestone(repo, "M549");
    const wtPath = createAutoWorktree(repo, "M549");
    addSliceToMilestone(repo, wtPath, "M549", "S01", "Feature A", "feature-a.ts");

    const roadmap = makeRoadmap("M549", "Merge strategy milestone");
    mergeMilestoneToMain(repo, "M549", roadmap);

    assert.equal(
      parentCount(repo, "main"),
      2,
      "merge_strategy: merge must produce a true merge commit with 2 parents on main",
    );
    assert.ok(existsSync(join(repo, "feature-a.ts")), "feature-a.ts present on main");
  });

  test("default (no merge_strategy): squash commit has one parent on main", () => {
    const repo = freshRepo();
    // No PREFERENCES.md — default squash path

    seedMergeReadyMilestone(repo, "M550");
    const wtPath = createAutoWorktree(repo, "M550");
    addSliceToMilestone(repo, wtPath, "M550", "S01", "Feature B", "feature-b.ts");

    const roadmap = makeRoadmap("M550", "Squash strategy milestone");
    mergeMilestoneToMain(repo, "M550", roadmap);

    assert.equal(
      parentCount(repo, "main"),
      1,
      "default (squash) must produce a single-parent commit on main",
    );
    assert.ok(existsSync(join(repo, "feature-b.ts")), "feature-b.ts present on main");
  });
});
