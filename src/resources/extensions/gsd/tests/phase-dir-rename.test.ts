// Regression tests for #1526: phase-dir slug drift when a milestone title changes.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renamePhaseDirOnTitleChange } from "../phase-dir-rename.ts";
import { canonicalPhaseDirName } from "../paths.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
  upsertMilestonePlanning,
} from "../gsd-db.ts";

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-"));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  return base;
}

test("renamePhaseDirOnTitleChange moves the old slug dir to the canonical name (#1526)", () => {
  const base = makeProject();
  try {
    const oldName = canonicalPhaseDirName("M001", "New milestone M001");
    const newName = canonicalPhaseDirName("M001", "Lokably brand foundation and welcome page rebuild");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "01-CONTEXT.md"), "# New milestone M001\n");

    assert.equal(renamePhaseDirOnTitleChange(base, "M001", "New milestone M001", "Lokably brand foundation and welcome page rebuild"), true);
    assert.equal(existsSync(oldDir), false, "old slug dir should be gone");
    assert.equal(existsSync(newDir), true, "canonical slug dir should exist");
    assert.equal(readFileSync(join(newDir, "01-CONTEXT.md"), "utf8"), "# New milestone M001\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the new dir already exists", () => {
  const base = makeProject();
  try {
    const oldName = canonicalPhaseDirName("M001", "Old title");
    const newName = canonicalPhaseDirName("M001", "New title");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "old.md"), "old");
    writeFileSync(join(newDir, "new.md"), "new");

    assert.equal(renamePhaseDirOnTitleChange(base, "M001", "Old title", "New title"), false);
    assert.equal(existsSync(oldDir), true, "old dir must be left in place");
    assert.equal(existsSync(join(newDir, "new.md")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the old dir is missing", () => {
  const base = makeProject();
  try {
    assert.equal(renamePhaseDirOnTitleChange(base, "M001", "Old title", "New title"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the slug does not change", () => {
  const base = makeProject();
  try {
    const name = canonicalPhaseDirName("M001", "Foundation");
    const dir = join(base, ".gsd", "phases", name);
    mkdirSync(dir, { recursive: true });
    assert.equal(renamePhaseDirOnTitleChange(base, "M001", "Foundation", "foundation"), false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("upsertMilestonePlanning renames the on-disk phase dir when the title changes (#1526)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "New milestone M001", status: "active" });

    const oldName = canonicalPhaseDirName("M001", "New milestone M001");
    const newName = canonicalPhaseDirName("M001", "Lokably brand foundation");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "01-ROADMAP.md"), "# Placeholder\n");

    upsertMilestonePlanning("M001", { title: "Lokably brand foundation" });

    assert.equal(existsSync(oldDir), false, "placeholder slug dir should be renamed");
    assert.equal(existsSync(newDir), true, "canonical slug dir should exist after title update");
    assert.equal(readFileSync(join(newDir, "01-ROADMAP.md"), "utf8"), "# Placeholder\n");
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  }
});
