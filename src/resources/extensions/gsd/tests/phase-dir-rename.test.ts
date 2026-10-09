// Regression tests for #1526: phase-dir slug drift when a milestone title changes.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renamePhaseDirOnTitleChange, canonicalPhaseDirExists } from "../phase-dir-rename.ts";
import { canonicalPhaseDirName, normalizeRealPath } from "../paths.ts";
import {
  closeDatabase,
  insertArtifact,
  insertMilestone,
  openDatabase,
  setProjectRootBinding,
  upsertMilestonePlanning,
  getArtifact,
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

test("upsertMilestonePlanning follows the rename with artifact rows in a real .gsd layout (#2633)", (t) => {
  const base = makeProject();
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M034", title: "M034", status: "active" });
  insertArtifact({
    path: "phases/34-m034/01-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M034",
    slice_id: null,
    task_id: null,
    full_content: "# Roadmap\n",
  });

  const oldDir = join(base, ".gsd", "phases", "34-m034");
  const newDir = join(base, ".gsd", "phases", "34-lokably-brand");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "01-ROADMAP.md"), "# Roadmap\n");

  upsertMilestonePlanning("M034", { title: "Lokably brand" });

  assert.equal(existsSync(oldDir), false, "old slug dir should be renamed");
  assert.equal(existsSync(join(newDir, "01-ROADMAP.md")), true, "file should move with the dir");
  assert.notEqual(getArtifact("phases/34-lokably-brand/01-ROADMAP.md"), null, "row should follow the rename");
  assert.equal(getArtifact("phases/34-m034/01-ROADMAP.md"), null, "stale row should be gone");
});

// External state (`.gsd` → ~/.gsd/projects/<hash>) resolves gsd.db outside a
// `.gsd` parent, so the rename base must come from the project_authority
// binding recorded at open (#2633).
test("upsertMilestonePlanning uses the bound checkout root to rename under external state (#2633)", (t) => {
  const base = makeProject();
  const external = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-external-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  // The database file's parent is not named `.gsd` — the realpath'd shape of
  // an external-state project.
  openDatabase(join(external, "gsd.db"));
  setProjectRootBinding(normalizeRealPath(base));
  insertMilestone({ id: "M034", title: "M034", status: "active" });
  insertArtifact({
    path: "phases/34-m034/01-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M034",
    slice_id: null,
    task_id: null,
    full_content: "# Roadmap\n",
  });

  const oldDir = join(base, ".gsd", "phases", "34-m034");
  const newDir = join(base, ".gsd", "phases", "34-lokably-brand");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "01-ROADMAP.md"), "# Roadmap\n");

  upsertMilestonePlanning("M034", { title: "Lokably brand" });

  assert.equal(existsSync(oldDir), false, "phase dir should be renamed via the bound checkout root");
  assert.equal(existsSync(join(newDir, "01-ROADMAP.md")), true, "file should move with the dir");
  assert.notEqual(getArtifact("phases/34-lokably-brand/01-ROADMAP.md"), null, "row should follow the rename");
  assert.equal(getArtifact("phases/34-m034/01-ROADMAP.md"), null, "stale row should be gone");
});

test("upsertMilestonePlanning leaves artifact rows untouched when the phase dir cannot be renamed (#2633)", (t) => {
  const base = makeProject();
  const external = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-external-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  openDatabase(join(external, "gsd.db"));
  setProjectRootBinding(normalizeRealPath(base));
  insertMilestone({ id: "M034", title: "M034", status: "active" });
  insertArtifact({
    path: "phases/34-m034/01-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M034",
    slice_id: null,
    task_id: null,
    full_content: "# Roadmap\n",
  });
  // No phase directory on disk — the rename has no source to move.

  upsertMilestonePlanning("M034", { title: "Lokably brand" });

  assert.notEqual(
    getArtifact("phases/34-m034/01-ROADMAP.md"),
    null,
    "rows must stay at their on-disk paths when the rename cannot happen",
  );
  assert.equal(
    getArtifact("phases/34-lokably-brand/01-ROADMAP.md"),
    null,
    "no row may be rewritten to a directory that does not exist",
  );
  assert.equal(existsSync(join(base, ".gsd", "phases", "34-lokably-brand")), false);
});

// Recovery path: the canonical dir is already on disk (rename earlier, or the
// rename no-ops because target == source) — rows must still follow (#2633).
test("upsertMilestonePlanning reconciles rows when the canonical dir already exists (#2633)", (t) => {
  const base = makeProject();
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M034", title: "M034", status: "active" });
  insertArtifact({
    path: "phases/34-m034/01-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M034",
    slice_id: null,
    task_id: null,
    full_content: "# Roadmap\n",
  });

  const oldDir = join(base, ".gsd", "phases", "34-m034");
  const canonicalDir = join(base, ".gsd", "phases", "34-lokably-brand");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "01-ROADMAP.md"), "# Old\n");
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, "01-ROADMAP.md"), "# New\n");

  upsertMilestonePlanning("M034", { title: "Lokably brand" });

  assert.equal(existsSync(canonicalDir), true, "canonical dir is the render target");
  const row = getArtifact("phases/34-lokably-brand/01-ROADMAP.md");
  assert.notEqual(row, null, "rows reconcile to the existing canonical dir");
  assert.equal(row?.full_content, "# Roadmap\n", "the row keeps its own content when it moves (existing reconcile rule)");
  assert.equal(getArtifact("phases/34-m034/01-ROADMAP.md"), null, "stale row should be gone");
});

test("canonicalPhaseDirExists mirrors the rename's target state (#2633)", (t) => {
  const base = makeProject();
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  assert.equal(canonicalPhaseDirExists(base, "M001", "Foundation"), false);
  mkdirSync(join(base, ".gsd", "phases", canonicalPhaseDirName("M001", "Foundation")), { recursive: true });
  assert.equal(canonicalPhaseDirExists(base, "M001", "Foundation"), true);
  assert.equal(canonicalPhaseDirExists(base, "M001", "Other"), false);
});
