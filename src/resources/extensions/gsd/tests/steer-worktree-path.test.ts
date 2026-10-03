// GSD Extension - Auto Worktree Path Resolution Test
// getAutoWorktreePath returns a worktree only when it has a valid gitdir pointer.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAutoWorktreePath } from "../auto-worktree-path-resolution.ts";

describe("auto worktree path resolution (#3476)", () => {
  let projectRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gsd-steer-wt-"));
    mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

    // Simulate a worktree with its own .gsd directory
    worktreePath = join(projectRoot, ".gsd", "worktrees", "M001");
    mkdirSync(join(worktreePath, ".gsd"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("getAutoWorktreePath returns null for worktree without valid .git file", () => {
    // The worktree directory exists but has no .git file — this is an inactive/
    // leftover worktree.
    const result = getAutoWorktreePath(projectRoot, "M001");
    assert.equal(result, null, "returns null for worktree without .git file");
  });

  test("getAutoWorktreePath returns null when .git is a directory", () => {
    mkdirSync(join(worktreePath, ".git"), { recursive: true });

    const result = getAutoWorktreePath(projectRoot, "M001");

    assert.equal(result, null, "returns null for standalone .git directories");
  });

  test("getAutoWorktreePath returns null when .git file is not a gitdir pointer", () => {
    writeFileSync(join(worktreePath, ".git"), "not-a-gitdir\n", "utf-8");

    const result = getAutoWorktreePath(projectRoot, "M001");

    assert.equal(result, null, "returns null for invalid .git files");
  });
});
