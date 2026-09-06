// gsd-pi — Regression tests for already-merged milestone cleanup safety.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  finalizeAlreadyMergedMilestoneIfReachable,
  type AlreadyMergedMilestoneRequest,
} from "../auto-worktree-merge-already-merged.js";
import {
  _resetMilestoneCleanupDepsForTests,
  _setMilestoneCleanupDepsForTests,
} from "../auto-worktree-merge-cleanup.js";
import { GSDError } from "../errors.js";

const cleanupPaths: string[] = [];
const initialCwd = process.cwd();

beforeEach(() => {
  _resetMilestoneCleanupDepsForTests();
});

afterEach(() => {
  _resetMilestoneCleanupDepsForTests();
  process.chdir(initialCwd);
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-already-merged-"));
  cleanupPaths.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  commitFile(repo, "README.md", "base\n", "initial");
  return repo;
}

function createRegularMergedMilestone(repo: string, milestoneId = "M001"): { milestoneBranch: string } {
  const milestoneBranch = `milestone/${milestoneId}`;
  git(repo, ["checkout", "-b", milestoneBranch]);
  commitFile(repo, "feature.txt", "milestone work\n", `feat: implement ${milestoneId}`);
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", milestoneBranch, "-m", `merge ${milestoneId}`]);
  return { milestoneBranch };
}

function request(
  repo: string,
  milestoneBranch: string,
  previousCwd: string,
): AlreadyMergedMilestoneRequest {
  return {
    commitMessage: "merge milestone",
    mainBranch: "main",
    milestoneBranch,
    milestoneId: "M001",
    previousCwd,
    projectRoot: repo,
  };
}

function createRepoWithBareRemote(): { repo: string; bare: string } {
  const repo = createRepo();
  const bare = join(
    mkdtempSync(join(tmpdir(), "gsd-already-merged-remote-")),
    "remote.git",
  );
  cleanupPaths.push(bare);
  git(repo, ["init", "--bare", bare]);
  git(repo, ["remote", "add", "origin", bare]);
  return { repo, bare };
}

function enableAutoPush(repo: string): void {
	mkdirSync(join(repo, ".gsd"), { recursive: true });
	// Pin auto_pr and remote so machine-global preferences can't leak in and
	// suppress or redirect the push this test asserts on.
	writeFileSync(
		join(repo, ".gsd", "preferences.md"),
		["## Git", "- auto_push: true", "- auto_pr: false", "- remote: origin"].join("\n"),
	);
}

function cleanupMocks(): void {
  _setMilestoneCleanupDepsForTests({
    removeWorktree: () => true,
    nativeBranchDelete: () => {},
    setActiveWorkspace: () => {},
    nudgeGitBranchCache: () => {},
    chdir: () => {},
  });
}

describe("finalizeAlreadyMergedMilestoneIfReachable", () => {
  test("returns null when the milestone branch is not reachable from integration branch", () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "milestone/M001"]);
    commitFile(repo, "feature.txt", "milestone work\n", "feat: implement M001");
    git(repo, ["checkout", "main"]);

    let cleanupCalled = false;
    _setMilestoneCleanupDepsForTests({
      removeWorktree: () => {
        cleanupCalled = true;
        return true;
      },
    });

    const result = finalizeAlreadyMergedMilestoneIfReachable(
      request(repo, "milestone/M001", repo),
    );

    assert.equal(result, null);
    assert.equal(cleanupCalled, false, "unmerged branch must not be cleaned up");
  });

  test("cleans up a regular-merged milestone after main advances", () => {
    const repo = createRepo();
    const { milestoneBranch } = createRegularMergedMilestone(repo);
    commitFile(repo, "hotfix.txt", "later main work\n", "fix: advance main");
    const previousCwd = join(repo, ".gsd-worktrees", "M001");
    const calls: string[] = [];

    _setMilestoneCleanupDepsForTests({
      removeWorktree: (_projectRoot, milestoneId, options) => {
        assert.ok(options, "cleanup must pass branch options");
        calls.push(
          `remove:${milestoneId}:${options.branch}:${String(options.deleteBranch)}`,
        );
        return true;
      },
      nativeBranchDelete: (_projectRoot, branch) => {
        calls.push(`delete:${branch}`);
      },
      setActiveWorkspace: (workspace) => {
        calls.push(`workspace:${String(workspace)}`);
      },
      nudgeGitBranchCache: (path) => {
        calls.push(`nudge:${path}`);
      },
      chdir: (path) => {
        calls.push(`chdir:${path}`);
      },
    });

    const result = finalizeAlreadyMergedMilestoneIfReachable(
      request(repo, milestoneBranch, previousCwd),
    );

    assert.deepEqual(result, {
      commitMessage: "merge milestone",
      pushed: false,
      prCreated: false,
      codeFilesChanged: true,
    });
    assert.deepEqual(calls, [
      "remove:M001:milestone/M001:false",
      "delete:milestone/M001",
      "workspace:null",
      `nudge:${previousCwd}`,
      `chdir:${repo}`,
    ]);
  });

  test("throws and restores cwd when regular-merged code was later removed from main", () => {
    const repo = createRepo();
    const { milestoneBranch } = createRegularMergedMilestone(repo);
    commitFile(repo, "feature.txt", "", "chore: remove milestone feature");
    const previousCwd = join(repo, "caller-cwd");
    mkdirSync(previousCwd);
    process.chdir(repo);

    assert.throws(
      () => finalizeAlreadyMergedMilestoneIfReachable(
        request(repo, milestoneBranch, previousCwd),
      ),
      (err: unknown) => err instanceof GSDError
        && /milestone-touched code file/.test(err.message)
        && /prevent data loss/.test(err.message),
    );
    assert.equal(
      realpathSync(process.cwd()),
      realpathSync(previousCwd),
      "throws before cleanup but restores to the caller's previous cwd",
    );
  });

  test("pushes the integration branch when auto_push is on and main is ahead of upstream (#2153)", () => {
    const { repo, bare } = createRepoWithBareRemote();
    git(repo, ["push", "-u", "origin", "main"]); // upstream configured, in sync
    enableAutoPush(repo);
    const { milestoneBranch } = createRegularMergedMilestone(repo);
    commitFile(repo, "hotfix.txt", "later main work\n", "fix: advance main");
    cleanupMocks();

    const result = finalizeAlreadyMergedMilestoneIfReachable(
      request(repo, milestoneBranch, repo),
    );

    assert.equal(result?.pushed, true);
    const remoteHeads = git(repo, ["ls-remote", "--heads", bare]);
    assert.match(remoteHeads, /refs\/heads\/main/);
    assert.ok(
      remoteHeads.startsWith(git(repo, ["rev-parse", "HEAD"])),
      `remote main should equal local HEAD, got: ${remoteHeads}`,
    );
  });

  test("reports push failure without throwing when the remote is unreachable (#2153)", () => {
    const { repo, bare } = createRepoWithBareRemote();
    git(repo, ["remote", "set-url", "origin", join(bare, "..", "does-not-exist.git")]);
    enableAutoPush(repo);
    const { milestoneBranch } = createRegularMergedMilestone(repo);
    cleanupMocks();

    const result = finalizeAlreadyMergedMilestoneIfReachable(
      request(repo, milestoneBranch, repo),
    ); // must not throw

    assert.equal(result?.pushed, false);
    assert.ok(
      typeof result?.pushError === "string" && result.pushError.length > 0,
      `expected pushError to describe the failure, got: ${String(result?.pushError)}`,
    );
  });

  test("does not push when auto_push is off even if main is ahead (#2153)", () => {
    const { repo, bare } = createRepoWithBareRemote();
    git(repo, ["push", "-u", "origin", "main"]); // upstream configured, in sync
    // Pin auto_push: false explicitly — global prefs merge in per-key and this
    // machine (or CI) may have auto_push: true globally.
    mkdirSync(join(repo, ".gsd"), { recursive: true });
    writeFileSync(
      join(repo, ".gsd", "preferences.md"),
      ["## Git", "- auto_push: false", "- auto_pr: false", "- remote: origin"].join("\n"),
    );
    const { milestoneBranch } = createRegularMergedMilestone(repo);
    commitFile(repo, "hotfix.txt", "later main work\n", "fix: advance main");
    cleanupMocks();

    const result = finalizeAlreadyMergedMilestoneIfReachable(
      request(repo, milestoneBranch, repo),
    );

    assert.equal(result?.pushed, false);
    assert.equal(result?.pushError, undefined);
    const remoteHeads = git(repo, ["ls-remote", "--heads", bare]);
    assert.doesNotMatch(remoteHeads, new RegExp(git(repo, ["rev-parse", "HEAD"])));
  });
});
