import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { projectRoot, withCommandCwd } from "../commands/context.ts";
import { nativeInit } from "../native-git-bridge.ts";
import { gsdRoot } from "../paths.ts";
import { resolveProjectRoot } from "../worktree.ts";

function makeParentRepo(): string {
  const parent = join(tmpdir(), `gsd-root-resolution-${randomUUID()}`);
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: parent });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: parent });
  return parent;
}

test("resolveProjectRoot prefers nearest bootstrapped .gsd before parent git root", () => {
  const parent = makeParentRepo();
  const child = join(parent, "nested-app");
  const nested = join(child, "src", "components");

  try {
    mkdirSync(join(parent, ".gsd", "milestones"), { recursive: true });
    mkdirSync(join(child, ".gsd"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(child, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");

    assert.equal(resolveProjectRoot(child), child);
    assert.equal(resolveProjectRoot(nested), child);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveProjectRoot ignores zombie .gsd without bootstrap artifacts", () => {
  const parent = makeParentRepo();
  const child = join(parent, "nested-app");

  try {
    mkdirSync(join(parent, ".gsd", "milestones"), { recursive: true });
    mkdirSync(join(child, ".gsd"), { recursive: true });

    assert.equal(resolveProjectRoot(child), parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// A bootstrapped `.gsd` in a folder that is in no git repository, with an
// empty child folder: the layout of the F3 live-run finding.
function makeBootstrappedParentWithoutGit(): { parent: string; child: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "gsd-root-no-git-")));
  const child = join(parent, "new-app");
  mkdirSync(join(parent, ".gsd"), { recursive: true });
  writeFileSync(join(parent, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  mkdirSync(child, { recursive: true });
  return { parent, child };
}

test("resolveProjectRoot does not adopt an ancestor .gsd outside a git working tree", (t) => {
  const { parent, child } = makeBootstrappedParentWithoutGit();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  assert.equal(resolveProjectRoot(child), child);
  assert.equal(resolveProjectRoot(parent), parent);
});

test("init in a folder outside git acts on that folder, not on an ancestor .gsd", async (t) => {
  const { parent, child } = makeBootstrappedParentWithoutGit();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const root = await withCommandCwd(child, async () => projectRoot());
  assert.equal(root, child, "the command root is the workspace folder shown to the user");
  assert.equal(gsdRoot(root), join(child, ".gsd"), "setup files go into the workspace folder");

  nativeInit(root, "main");
  assert.equal(existsSync(join(child, ".git")), true, "git init runs in the workspace folder");
  assert.equal(existsSync(join(parent, ".git")), false, "git init does not touch the ancestor");
});
