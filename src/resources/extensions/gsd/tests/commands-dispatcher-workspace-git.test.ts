// Project/App: gsd-pi
// File Purpose: Regression tests for workspace git preflight blocking /gsd commands.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isBlockerCommand } from "../commands/blocker-routing.ts";
import { closeDatabase } from "../db/engine.js";
import { getWorkspaceGitBlockMessageForBase } from "../workspace-git-guard.js";
import { isUnmergedMilestoneAllowedCommand } from "../unmerged-milestone-guard.js";
import { isValidationBlockAllowedCommand } from "../validation-block-guard.js";
import { cleanup, git, makeTempDir, makeTempRepo } from "./test-utils.ts";

test("blocker commands never bootstrap or prepare a workspace database before consent", async () => {
  const base = makeTempRepo();
  const stateDir = join(base, ".gsd");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "PROJECT.md"), "# Isolated dispatcher fixture\n");
  const before = readdirSync(stateDir).sort();
  try {
    for (const command of [
      "blocker inspect blocker-id",
      "blocker resolve blocker-id resolved operator-decision",
      "blocker\tinspect blocker-id",
      "blocker\tresolve blocker-id resolved operator-decision",
      "blocker\ninvalid",
      "blocker",
      "blocker invalid",
    ]) {
      assert.equal(isBlockerCommand(command), true, "ops must consume the recognized command");
      assert.equal(await getWorkspaceGitBlockMessageForBase(base, command), null);
      // The real dispatcher checks both classifiers before their bootstrapping
      // getters; all three preflight paths must leave metadata-only commands alone.
      assert.equal(isUnmergedMilestoneAllowedCommand(command), true);
      assert.equal(isValidationBlockAllowedCommand(command), true);
      assert.deepEqual(readdirSync(stateDir).sort(), before,
        `workspace preflight must not initialize state for ${command}`);
    }
    assert.equal(isBlockerCommand("blockers inspect"), false);
    assert.equal(isBlockerCommand("blocker-extra"), false);
    assert.equal(isUnmergedMilestoneAllowedCommand("auto"), false);
    assert.equal(isValidationBlockAllowedCommand("auto"), false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

function seedProductConflict(base: string): void {
  writeFileSync(join(base, "app.ts"), "root\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "add app");
  git(base, "checkout", "-b", "side");
  writeFileSync(join(base, "app.ts"), "side\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "side app");
  git(base, "checkout", "main");
  writeFileSync(join(base, "app.ts"), "main\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "main app");
  try {
    git(base, "merge", "side");
  } catch {
    // Expected merge conflict.
  }
}

test("getWorkspaceGitBlockMessageForBase blocks auto when product conflicts remain", async () => {
  const base = makeTempRepo("gsd-dispatch-ws-git-block-");
  try {
    seedProductConflict(base);
    const blocked = await getWorkspaceGitBlockMessageForBase(base, "auto");
    assert.ok(blocked);
    assert.match(blocked, /blocked until Git conflicts/i);
    assert.match(blocked, /app\.ts/);
  } finally {
    cleanup(base);
  }
});

test("getWorkspaceGitBlockMessageForBase does not block project setup in non-git folders", async () => {
  const base = makeTempDir("gsd-dispatch-ws-git-new-project-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });

    assert.equal(await getWorkspaceGitBlockMessageForBase(base, ""), null);
    assert.equal(await getWorkspaceGitBlockMessageForBase(base, "init"), null);
    assert.equal(await getWorkspaceGitBlockMessageForBase(base, "new-project"), null);
  } finally {
    cleanup(base);
  }
});

test("getWorkspaceGitBlockMessageForBase allows doctor on product conflicts", async () => {
  const base = makeTempRepo("gsd-dispatch-ws-git-doctor-");
  try {
    seedProductConflict(base);
    const blocked = await getWorkspaceGitBlockMessageForBase(base, "doctor");
    assert.equal(blocked, null);
  } finally {
    cleanup(base);
  }
});

test("getWorkspaceGitBlockMessageForBase allows forensics on product conflicts", async () => {
  const base = makeTempRepo("gsd-dispatch-ws-git-forensics-");
  try {
    seedProductConflict(base);
    const blocked = await getWorkspaceGitBlockMessageForBase(base, "forensics");
    assert.equal(blocked, null);
  } finally {
    cleanup(base);
  }
});
