// Projection-root structural rejection tests (#2648).
// File Purpose: Verifies the lock-free seams the doctor uses on a store whose
// projection root the native lock structurally rejects: the classifier that
// keeps the family apart from the transient one, the scan that names the
// rejected nodes, and the plain-fs evidence reader.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isStructuralProjectionRootError,
  loadUnboundProjectionEvidenceLockFree,
  scanProjectionRootStructure,
} from "../managed-projection-history.ts";

function createProjectionRoot(t: { after(fn: () => void): void }): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-structure-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, ".gsd");
  mkdirSync(root);
  return { base, root };
}

// A junction on Windows (no privilege needed), a directory symlink elsewhere.
function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}

test("structural rejections are classified apart from transient and protocol failures", () => {
  const bare = new Error("projection root contains an unsupported node");
  assert.equal(isStructuralProjectionRootError(bare), true);
  assert.equal(isStructuralProjectionRootError(new Error(
    String.raw`projection root contains an unsupported node while opening projection file at \\?\C:\repo\.gsd\STATE.md: expected a regular file, found a directory`,
  )), true);
  assert.equal(isStructuralProjectionRootError(new Error(
    "projection root operation failed: projection root contains an unsupported reparse point",
  )), true);
  assert.equal(isStructuralProjectionRootError(new Error(
    "managed projection control file is obstructed by a directory: migration/unbound-projection-evidence.json",
    { cause: bare },
  )), true);
  assert.equal(isStructuralProjectionRootError(new Error("native projection root identity locking failed", { cause: bare })), true);

  assert.equal(isStructuralProjectionRootError(new Error(
    String.raw`projection root operation failed: transient projection root sharing violation at C:\repo\.gsd\STATE.md: another process holds an incompatible handle (os error 32)`,
  )), false);
  assert.equal(isStructuralProjectionRootError(new Error("unbound projection evidence is invalid")), false);
  assert.equal(isStructuralProjectionRootError("projection root contains an unsupported node"), false);
});

test("the structure scan reports nothing for a healthy or empty projection root", (t) => {
  const { base, root } = createProjectionRoot(t);
  assert.deepEqual(scanProjectionRootStructure(base), []);

  mkdirSync(join(root, "migration", "projection-mutations"), { recursive: true });
  mkdirSync(join(root, "migration", "native-projection-evidence"));
  writeFileSync(join(root, "migration", "managed-outputs.json"), "[]\n");
  writeFileSync(join(root, "migration", "unbound-projection-evidence.json"), "[]\n");
  assert.deepEqual(scanProjectionRootStructure(base), []);
});

test("the structure scan names wrong-kind control nodes", (t) => {
  const { base, root } = createProjectionRoot(t);
  mkdirSync(join(root, "migration", "unbound-projection-evidence.json"), { recursive: true });
  mkdirSync(join(root, "migration", "managed-outputs.json"));
  writeFileSync(join(root, "migration", "projection-mutations"), "not a directory\n");
  mkdirSync(join(root, "migration", "native-projection-evidence", "00000000-0000-0000-0000-000000000001.json"), {
    recursive: true,
  });

  assert.deepEqual(scanProjectionRootStructure(base), [
    {
      logicalPath: "migration/managed-outputs.json",
      problem: "a directory where the projection protocol requires a regular file",
    },
    {
      logicalPath: "migration/unbound-projection-evidence.json",
      problem: "a directory where the projection protocol requires a regular file",
    },
    {
      logicalPath: "migration/native-projection-evidence/00000000-0000-0000-0000-000000000001.json",
      problem: "a directory where the projection protocol requires a regular file",
    },
    {
      logicalPath: "migration/projection-mutations",
      problem: "a regular file where the projection protocol requires a directory",
    },
  ]);
});

test("the structure scan reports an obstructed ancestor once, not every node below it", (t) => {
  const { base, root } = createProjectionRoot(t);
  writeFileSync(join(root, "migration"), "not a directory\n");

  assert.deepEqual(scanProjectionRootStructure(base), [{
    logicalPath: "migration",
    problem: "a regular file where the projection protocol requires a directory",
  }]);
});

test("the structure scan follows pending journal entries and retained evidence to linked nodes", (t) => {
  const { base, root } = createProjectionRoot(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  mkdirSync(join(root, "milestones", "M001", "slices"), { recursive: true });
  writeFileSync(join(root, "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap\n");
  linkDirectory(outside, join(root, "milestones", "M001", "slices", "linked"));
  mkdirSync(join(root, "notes", ".gsd-projection-remove-00000000-0000-0000-0000-000000000001"), { recursive: true });
  linkDirectory(outside, join(root, "notes", ".gsd-projection-remove-00000000-0000-0000-0000-000000000001", "kept"));
  // Reachable only through a path that escapes the root: never followed.
  linkDirectory(outside, join(base, "sibling-link"));

  mkdirSync(join(root, "migration", "projection-mutations"), { recursive: true });
  writeFileSync(
    join(root, "migration", "projection-mutations", "00000000-0000-0000-0000-000000000002.json"),
    JSON.stringify({
      operation: "remove-tree",
      logicalPath: "milestones/M001",
      temporaryPath: null,
      quarantinePath: "../sibling-link",
      exchangeGuardPath: join(base, "sibling-link"),
    }),
  );
  writeFileSync(
    join(root, "migration", "unbound-projection-evidence.json"),
    JSON.stringify([{
      evidencePath: "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001",
      logicalPath: "notes/result.md",
    }]),
  );

  assert.deepEqual(scanProjectionRootStructure(base), [
    {
      logicalPath: "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001/kept",
      problem: "a symbolic link or junction",
    },
    {
      logicalPath: "milestones/M001/slices/linked",
      problem: "a symbolic link or junction",
    },
  ]);
});

test("the structure scan is bounded on a root full of rejected nodes", (t) => {
  const { base, root } = createProjectionRoot(t);
  const journal = join(root, "migration", "projection-mutations");
  mkdirSync(journal, { recursive: true });
  for (let index = 0; index < 30; index++) {
    mkdirSync(join(journal, `00000000-0000-0000-0000-${String(index).padStart(12, "0")}.json`));
  }

  assert.equal(scanProjectionRootStructure(base).length, 20);
});

test("the lock-free evidence reader names a directory occupying the index", (t) => {
  const { base, root } = createProjectionRoot(t);
  mkdirSync(join(root, "migration", "unbound-projection-evidence.json"), { recursive: true });

  assert.throws(
    () => loadUnboundProjectionEvidenceLockFree(base),
    (error: unknown) => isStructuralProjectionRootError(error)
      && /obstructed by a directory: migration\/unbound-projection-evidence\.json/u.test((error as Error).message),
  );
});
