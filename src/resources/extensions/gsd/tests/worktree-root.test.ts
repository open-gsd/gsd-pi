import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveWorktreeIdentity,
  resolveWorktreeIdentityAsync,
  resolveWorktreeProjectRoot,
} from "../worktree-root.ts";

test("resolveWorktreeProjectRoot: explicit non-worktree cwd beats stale GSD_PROJECT_ROOT", (t) => {
  const previous = process.env.GSD_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  process.env.GSD_PROJECT_ROOT = "/Users/example";

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_PROJECT_ROOT;
    } else {
      process.env.GSD_PROJECT_ROOT = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(projectDir), projectDir);
});

test("resolveWorktreeProjectRoot: external GSD home is not treated as a project root", (t) => {
  const previous = process.env.GSD_HOME;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const fakeHome = join(dir, "home");
  const projectDir = join(fakeHome, "work", "project");
  mkdirSync(join(fakeHome, ".gsd"), { recursive: true });
  mkdirSync(join(fakeHome, ".git"), { recursive: true });
  writeFileSync(join(fakeHome, ".gsd", "PREFERENCES.md"), "---\n---\n", "utf-8");
  mkdirSync(projectDir, { recursive: true });
  process.env.GSD_HOME = join(fakeHome, ".gsd");

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(projectDir), projectDir);
});

test("resolveWorktreeProjectRoot: GSD_PROJECT_ROOT still anchors auto-worktree paths", (t) => {
  const previous = process.env.GSD_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const projectDir = join(dir, "project");
  const worktreeDir = join(projectDir, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeDir, { recursive: true });
  process.env.GSD_PROJECT_ROOT = projectDir;

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_PROJECT_ROOT;
    } else {
      process.env.GSD_PROJECT_ROOT = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(worktreeDir), projectDir);
});

test("resolveWorktreeIdentity verifies a live Git root and its nested CWD", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-root-"));
  const projectDir = join(dir, "project");
  const cwd = join(projectDir, "packages", "app");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", projectDir], { stdio: "ignore" });
  mkdirSync(cwd, { recursive: true });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(cwd), {
    projectRoot: realpathSync(projectDir),
    worktreeRoot: null,
    status: "verified",
  });
});

test("resolveWorktreeIdentity rejects a directory with only a fake .git marker", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-fake-git-"));
  const projectDir = join(dir, "project");
  mkdirSync(join(projectDir, ".git"), { recursive: true });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(projectDir), {
    projectRoot: null,
    worktreeRoot: null,
    status: "unavailable",
  });
});

test("resolveWorktreeIdentity rejects a recognized worktree path that is not its Git root", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-wrong-root-"));
  const projectDir = join(dir, "project");
  const fakeWorktree = join(projectDir, ".gsd", "worktrees", "fake");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", projectDir], { stdio: "ignore" });
  mkdirSync(fakeWorktree, { recursive: true });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(fakeWorktree), {
    projectRoot: null,
    worktreeRoot: null,
    status: "partial",
  });
});

test("resolveWorktreeIdentity rejects an unrelated repository nested under a GSD worktree path", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-unrelated-worktree-"));
  const projectDir = join(dir, "project");
  const foreignRepo = join(projectDir, ".gsd", "worktrees", "M001");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", projectDir], { stdio: "ignore" });
  mkdirSync(foreignRepo, { recursive: true });
  execFileSync("git", ["init", foreignRepo], { stdio: "ignore" });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(foreignRepo), {
    projectRoot: realpathSync(projectDir),
    worktreeRoot: null,
    status: "partial",
  });
});

test("resolveWorktreeIdentity accepts a linked worktree of its owning repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-linked-worktree-"));
  const projectDir = join(dir, "project");
  const worktree = join(projectDir, ".gsd", "worktrees", "M001");
  mkdirSync(join(projectDir, ".gsd", "worktrees"), { recursive: true });
  execFileSync("git", ["init", projectDir], { stdio: "ignore" });
  execFileSync("git", [
    "-C", projectDir,
    "-c", "user.name=GSD Test",
    "-c", "user.email=gsd-test@example.invalid",
    "commit", "--allow-empty", "-m", "test base",
  ], { stdio: "ignore" });
  execFileSync("git", ["-C", projectDir, "worktree", "add", "--detach", worktree, "HEAD"], {
    stdio: "ignore",
  });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(worktree), {
    projectRoot: realpathSync(projectDir),
    worktreeRoot: realpathSync(worktree),
    status: "verified",
  });
});

test("resolveWorktreeIdentity recovers a linked worktree under a custom external state directory", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-custom-state-"));
  const projectDir = join(dir, "repo");
  const stateDir = join(dir, "state-outside-gsd-home");
  const worktree = join(stateDir, "projects", "custom-project", "worktrees", "M001");
  const previousStateDir = process.env.GSD_STATE_DIR;
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(stateDir, "projects", "custom-project", "worktrees"), { recursive: true });
  process.env.GSD_STATE_DIR = stateDir;
  execFileSync("git", ["init", projectDir], { stdio: "ignore" });
  execFileSync("git", [
    "-C", projectDir,
    "-c", "user.name=GSD Test",
    "-c", "user.email=gsd-test@example.invalid",
    "commit", "--allow-empty", "-m", "test base",
  ], { stdio: "ignore" });
  execFileSync("git", ["-C", projectDir, "worktree", "add", "--detach", worktree, "HEAD"], {
    stdio: "ignore",
  });

  t.after(() => {
    if (previousStateDir === undefined) {
      delete process.env.GSD_STATE_DIR;
    } else {
      process.env.GSD_STATE_DIR = previousStateDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const expected = {
    projectRoot: realpathSync(projectDir),
    worktreeRoot: realpathSync(worktree),
    status: "verified",
  } as const;
  assert.deepEqual(resolveWorktreeIdentity(worktree), expected);
  assert.deepEqual(await resolveWorktreeIdentityAsync(worktree), expected);
});

test("resolveWorktreeIdentity does not claim an unrelated directory as a project root", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-identity-unrooted-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(resolveWorktreeIdentity(cwd), {
    projectRoot: null,
    worktreeRoot: null,
    status: "unavailable",
  });
});
