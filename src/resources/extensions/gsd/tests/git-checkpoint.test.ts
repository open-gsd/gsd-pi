// gsd-pi — Regression tests for git-checkpoint rollback (#3576)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createCheckpoint,
  rollbackToCheckpoint,
  rollbackToCheckpointAndRebuild,
  cleanupCheckpoint,
} from "../safety/git-checkpoint.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
import { renderRoadmapFromDb } from "../markdown-renderer.js";
import { invalidateStateCache } from "../state.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-test-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "file.txt"), "initial\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}

describe("git-checkpoint rollback", () => {
  it("skips checkpoint creation in a git repo without commits", (t) => {
    const repo = mkdtempSync(join(tmpdir(), "ckpt-unborn-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    git(["init"], repo);

    const sha = createCheckpoint(repo, "unit-unborn");
    assert.equal(sha, null, "unborn repos do not have a checkpointable HEAD");
  });

  it("rolls back to checkpoint on checked-out branch", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    // Create checkpoint at initial commit
    const sha = createCheckpoint(repo, "unit-1");
    assert.ok(sha, "checkpoint should return a SHA");

    // Make a second commit
    writeFileSync(join(repo, "file.txt"), "modified\n");
    git(["add", "."], repo);
    git(["commit", "-m", "second"], repo);

    const headBefore = git(["rev-parse", "HEAD"], repo);
    assert.notEqual(headBefore, sha, "HEAD should have advanced");

    // Rollback — this must work on the checked-out branch
    const result = rollbackToCheckpoint(repo, "unit-1", sha);
    assert.equal(result, true, "rollback should succeed");

    const headAfter = git(["rev-parse", "HEAD"], repo);
    assert.equal(headAfter, sha, "HEAD should match checkpoint SHA after rollback");
  });

  it("renders tracked projections again from the database after a rollback", async (t) => {
    const repo = createTempRepo();
    t.after(() => {
      closeDatabase();
      invalidateStateCache();
      rmSync(repo, { recursive: true, force: true });
    });
    // Team mode: the projections are tracked; the database is not.
    writeFileSync(join(repo, ".gitignore"), ".gsd/gsd.db*\n");
    mkdirSync(join(repo, ".gsd"));
    openDatabase(join(repo, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test", status: "active", planning: { vision: "Rollback keeps the database." } });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "pending", risk: "low", depends: [] });
    const rendered = await renderRoadmapFromDb(repo, "M001");
    assert.ok("roadmapPath" in rendered);
    git(["add", "."], repo);
    git(["commit", "-m", "checkpoint state"], repo);
    const sha = createCheckpoint(repo, "unit-render");
    assert.ok(sha);

    // The failed unit committed a slice to the database and its render to git.
    insertSlice({ id: "S02", milestoneId: "M001", title: "Added by the unit", status: "pending", risk: "low", depends: [] });
    await renderRoadmapFromDb(repo, "M001");
    git(["add", "."], repo);
    git(["commit", "-m", "unit work"], repo);

    assert.equal(await rollbackToCheckpointAndRebuild(repo, "unit-render", sha), true);

    assert.equal(git(["rev-parse", "HEAD"], repo), sha, "the branch is rolled back");
    assert.match(
      readFileSync(rendered.roadmapPath, "utf-8"),
      /S02: Added by the unit/,
      "the roadmap shows the database content, not the reverted file",
    );
  });

  it("returns false on detached HEAD", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = git(["rev-parse", "HEAD"], repo);
    git(["checkout", "--detach", sha], repo);

    const result = rollbackToCheckpoint(repo, "unit-2", sha);
    assert.equal(result, false, "rollback should fail on detached HEAD");
  });

  it("cleans up checkpoint ref after rollback", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = createCheckpoint(repo, "unit-3");
    assert.ok(sha);

    // Ref should exist
    const refBefore = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refBefore, sha);

    rollbackToCheckpoint(repo, "unit-3", sha);

    // Ref should be cleaned up
    const refAfter = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refAfter, "", "checkpoint ref should be removed after rollback");
  });

  it("cleanupCheckpoint removes the ref without error", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = createCheckpoint(repo, "unit-4");
    assert.ok(sha);

    cleanupCheckpoint(repo, "unit-4");

    const ref = git(["for-each-ref", "refs/gsd/checkpoints/unit-4", "--format=%(objectname)"], repo);
    assert.equal(ref, "", "ref should be gone");
  });
});
