// Project/App: gsd-pi
// File Purpose: Behavior tests: a conflict on a tracked `.gsd` projection never removes the file and never blocks the merge.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { autoResolveSafeConflictPaths } from "../git-conflict-resolve.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/**
 * A repository on `main` with a squash merge of `milestone` in conflict:
 * the milestone deleted `.gsd/STATE.md` and `pnpm-lock.yaml` and renamed
 * `.gsd/OLD.md`; main changed the first two and renamed the third another way.
 */
function makeConflictedMerge(t: TestContext): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-projection-conflict-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  mkdirSync(join(repo, ".gsd"));
  writeFileSync(join(repo, ".gsd", "STATE.md"), "base\n");
  writeFileSync(join(repo, ".gsd", "OLD.md"), "a projection that both sides rename\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "base\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);

  git(["checkout", "-b", "milestone"], repo);
  git(["rm", ".gsd/STATE.md", "pnpm-lock.yaml"], repo);
  git(["mv", ".gsd/OLD.md", ".gsd/THEIRS.md"], repo);
  git(["commit", "-m", "milestone"], repo);

  git(["checkout", "main"], repo);
  writeFileSync(join(repo, ".gsd", "STATE.md"), "project root\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "project root\n");
  git(["mv", ".gsd/OLD.md", ".gsd/OURS.md"], repo);
  git(["commit", "-am", "main"], repo);

  assert.throws(() => git(["merge", "--squash", "milestone"], repo), "the merge is in conflict");
  return repo;
}

function unmergedPaths(repo: string): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"], repo).split("\n").filter(Boolean);
}

test("a .gsd projection that the milestone deleted is kept from the project-root side, not removed", (t) => {
  const repo = makeConflictedMerge(t);

  const { resolved, remaining } = autoResolveSafeConflictPaths(repo, [".gsd/STATE.md"]);

  assert.deepEqual({ resolved, remaining }, { resolved: [".gsd/STATE.md"], remaining: [] });
  assert.equal(readFileSync(join(repo, ".gsd", "STATE.md"), "utf-8"), "project root\n");
  assert.equal(git(["ls-files", "--stage", "--", ".gsd/STATE.md"], repo).split("\n").length, 1, "one resolved index entry");
  assert.equal(git(["diff", "--cached", "--name-status", "--", ".gsd/STATE.md"], repo), "", "no deletion is staged");
});

test("a .gsd conflict in which no side has the path does not block the merge", (t) => {
  const repo = makeConflictedMerge(t);

  const { remaining } = autoResolveSafeConflictPaths(repo, unmergedPaths(repo));

  assert.deepEqual(remaining, []);
  assert.deepEqual(unmergedPaths(repo), []);
  assert.equal(existsSync(join(repo, ".gsd", "OURS.md")), true, "the project-root file is kept");
  assert.equal(existsSync(join(repo, ".gsd", "THEIRS.md")), true, "the milestone file is kept");
});

test("a regenerable file outside .gsd that the milestone deleted is still removed", (t) => {
  const repo = makeConflictedMerge(t);

  const { resolved } = autoResolveSafeConflictPaths(repo, ["pnpm-lock.yaml"]);

  assert.deepEqual(resolved, ["pnpm-lock.yaml"]);
  assert.equal(existsSync(join(repo, "pnpm-lock.yaml")), false);
});
