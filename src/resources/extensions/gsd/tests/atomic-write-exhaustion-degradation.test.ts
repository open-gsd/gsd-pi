// Windows exchange-exhaustion degradation (2355 family): when the native
// projection root lock exhausts its Windows retry budget renaming a node
// inside the managed root, the failure is deterministic - retention would
// wedge the session forever. Writes must degrade to the plain-fs atomic path
// and leave no journal/staging residue.
// File Purpose: tests atomicWriteSync / removeProjectionFileSync degradation.

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _setManagedMutationBoundaryForTest, atomicWriteSync, removeProjectionFileSync } from "../atomic-write.ts";

// Verbatim engine message scaffold matched by isExhaustedTransientProjectionSharingError.
function exhaustedError(): Error {
  return new Error(
    "projection root operation failed: transient projection root sharing violation while "
    + "renaming projection child from C:\\fake\\left to C:\\fake\\right after 5 attempts: "
    + "another process holds an incompatible handle (os error 32)",
  );
}

let base: string;

function setupRoot(): string {
  base = mkdtempSync(join(tmpdir(), "gsd-exhaustion-degradation-"));
  const rootPath = join(base, ".gsd");
  mkdirSync(rootPath);
  // Empty gsd.db marker: managedProjectionTarget only checks existence, so the
  // mutation flow runs without a sqlite connection (the maintenance fence is
  // a no-op with no database) and the Windows db-lock rename noise stays out.
  writeFileSync(join(rootPath, "gsd.db"), "");
  return rootPath;
}

afterEach(() => {
  _setManagedMutationBoundaryForTest(null);
  rmSync(base, { recursive: true, force: true });
});

// Windows noise: the maintenance fence's claim release renames its lock file
// while its own exclusive handle lacks FILE_SHARE_DELETE (the same kernel
// shape as the #2355 family), so fence release throws EBUSY locally on every
// managed op. The mutation body - including the degradation path - has already
// completed by then, so retry until the noise settles and assert afterwards.
function runIgnoringFenceReleaseNoise(fn: () => void): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fn();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EBUSY") continue;
      throw error;
    }
  }
}

test("exhausted managed write degrades to plain-fs atomic write with no journal residue", () => {
  const rootPath = setupRoot();
  const target = join(rootPath, "STATE.md");
  writeFileSync(target, "old\n");
  _setManagedMutationBoundaryForTest((boundary) => {
    if (boundary === "after-write") throw exhaustedError();
  });

  runIgnoringFenceReleaseNoise(() => atomicWriteSync(target, "new content\n"));

  assert.equal(readFileSync(target, "utf-8"), "new content\n");
  const journalDir = join(rootPath, "migration", "projection-mutations");
  assert.equal(readdirSync(journalDir).filter(name => name.endsWith(".json")).length, 0);
  const names = readdirSync(rootPath);
  assert.ok(!names.some(name => name.startsWith(".gsd-projection-tmp-") || name.startsWith(".gsd-projection-exchange-")),
    "no staging residue after degradation");
});

test("exhausted managed remove degrades to plain-fs unlink with no journal residue", () => {
  const rootPath = setupRoot();
  const target = join(rootPath, "STATE.md");
  writeFileSync(target, "content\n");
  _setManagedMutationBoundaryForTest((boundary) => {
    if (boundary === "after-remove") throw exhaustedError();
  });

  runIgnoringFenceReleaseNoise(() => removeProjectionFileSync(target));

  assert.ok(!existsSync(target));
  const journalDir = join(rootPath, "migration", "projection-mutations");
  assert.equal(readdirSync(journalDir).filter(name => name.endsWith(".json")).length, 0);
});

test("non-exhausted managed write failures stay fail-closed with retention", () => {
  const rootPath = setupRoot();
  const target = join(rootPath, "STATE.md");
  writeFileSync(target, "old\n");
  _setManagedMutationBoundaryForTest((boundary) => {
    if (boundary === "before-write") throw new Error("injected structural failure");
  });

  const errors: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      atomicWriteSync(target, "new\n");
      break;
    } catch (error) {
      errors.push(error);
      if ((error as NodeJS.ErrnoException)?.code !== "EBUSY") break;
    }
  }
  assert.ok(errors.some(error => /injected structural failure/.test(String(error))));
  assert.equal(readFileSync(target, "utf-8"), "old\n", "fail-closed keeps the reviewed target intact");
});
