// gsd-pi — Code-change safety checks for auto-worktree merge closeout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNoUnanchoredCodeChangesAfterEmptyMerge,
  detectMergedCodeFilesChanged,
} from "../auto-worktree-merge-code-changes.ts";
import { GSDError } from "../errors.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

function createRepo(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "gsd-code-changes-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "# test\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["branch", "-M", "main"]);
  return root;
}

test("detectMergedCodeFilesChanged ignores metadata-only commits and reports code commits", (t) => {
  const metadataRepo = createRepo(t);
  mkdirSync(join(metadataRepo, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(metadataRepo, ".gsd", "milestones", "M001", "CONTEXT.md"), "# metadata\n");
  git(metadataRepo, ["add", "."]);
  git(metadataRepo, ["commit", "-m", "metadata only"]);
  assert.equal(detectMergedCodeFilesChanged(metadataRepo, false), false);

  const codeRepo = createRepo(t);
  writeFileSync(join(codeRepo, "feature.ts"), "export const value = 1;\n");
  git(codeRepo, ["add", "."]);
  git(codeRepo, ["commit", "-m", "add code"]);
  assert.equal(detectMergedCodeFilesChanged(codeRepo, false), true);
});

test("empty merge safety throws only when milestone has unanchored code changes", (t) => {
  const codeRepo = createRepo(t);
  git(codeRepo, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(codeRepo, "feature.ts"), "export const value = 1;\n");
  git(codeRepo, ["add", "."]);
  git(codeRepo, ["commit", "-m", "milestone code"]);
  git(codeRepo, ["checkout", "main"]);

  assert.throws(
    () => assertNoUnanchoredCodeChangesAfterEmptyMerge(codeRepo, "main", "milestone/M001", "squash", true),
    (err) => err instanceof GSDError && /1 code file\(s\)/u.test(err.message),
  );

  const metadataRepo = createRepo(t);
  git(metadataRepo, ["checkout", "-b", "milestone/M002"]);
  mkdirSync(join(metadataRepo, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(join(metadataRepo, ".gsd", "milestones", "M002", "CONTEXT.md"), "# metadata\n");
  git(metadataRepo, ["add", "."]);
  git(metadataRepo, ["commit", "-m", "metadata"]);
  git(metadataRepo, ["checkout", "main"]);

  assert.doesNotThrow(() =>
    assertNoUnanchoredCodeChangesAfterEmptyMerge(metadataRepo, "main", "milestone/M002", "squash", true),
  );
});
