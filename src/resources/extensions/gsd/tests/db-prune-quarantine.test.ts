// Project/App: gsd-pi
// File Purpose: Behavior tests for `gsd db prune-quarantine` (P13b). The
// command is the owner-decided explicit removal route for quarantined
// projection copies: the default run lists what it would delete and deletes
// nothing; `--apply` deletes only the copies under
// `.gsd/quarantine/projections/` — never a live projection, never the
// database, never the other quarantine folders.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handleDbPruneQuarantine } from "../commands-maintenance.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { quarantineProjectionEvidence } from "../projection-observation.ts";
import { invalidateStateCache } from "../state.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  invalidateStateCache();
});

function makeCtx(): { ctx: any; notes: Array<{ message: string; kind: string }> } {
  const notes: Array<{ message: string; kind: string }> = [];
  return {
    ctx: { ui: { notify: (message: string, kind: string) => notes.push({ message, kind }) } },
    notes,
  };
}

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-prune-quarantine-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  _getAdapter()!.prepare(
    "INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run("M001", "Prune fixture", "active", new Date().toISOString());
  return base;
}

/** Quarantine one real hand edit through the production quarantine path. */
function quarantineHandEdit(base: string, name: string, bytes: string): void {
  const source = join(base, ".gsd", name);
  writeFileSync(source, bytes);
  const evidence = quarantineProjectionEvidence(base, source);
  assert.ok(evidence, `the hand edit ${name} was quarantined`);
  assert.equal(existsSync(source), false, "the live file was moved into quarantine");
}

/** Paths of the quarantined copies under `.gsd/quarantine/projections/`. */
function quarantineCopyPaths(base: string): string[] {
  const root = join(base, ".gsd", "quarantine", "projections");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(entry.parentPath, entry.name));
}

function milestoneRows(): unknown[] {
  return _getAdapter()!.prepare("SELECT * FROM milestones ORDER BY id").all();
}

/** Quarantine folders outside the prune scope, plus one live projection. */
function keepsideFiles(base: string): Array<{ path: string; bytes: string }> {
  const keeps = [
    join(base, ".gsd", "quarantine", "restore-20260101T00-00-00-000Z", "milestones", "M001", "ROADMAP.md"),
    join(base, ".gsd", "quarantine", "milestones", "M001", "slices", "S01-manual-review", "note.md"),
    join(base, ".gsd", "migration", "quarantined-control-publications", "unit.quarantined"),
    join(base, ".gsd", "migration", "quarantined-control-publications", "unit.quarantined.json"),
    join(base, ".gsd", "milestones", "M001", "ROADMAP.md"),
  ];
  for (const path of keeps) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# kept\n");
  }
  return keeps.map((path) => ({ path, bytes: readFileSync(path, "utf-8") }));
}

test("prune-quarantine without --apply lists the copies and deletes nothing", async () => {
  const base = makeProject();
  const keeps = keepsideFiles(base);
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  quarantineHandEdit(base, "STATE-draft.md", "# Hand edit B\n");
  const copies = quarantineCopyPaths(base);
  assert.equal(copies.length, 2);
  const rows = milestoneRows();

  const { ctx, notes } = makeCtx();
  await handleDbPruneQuarantine(ctx, base, "");

  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.kind, "info");
  assert.match(notes[0]!.message, /2 quarantined projection cop/);
  assert.match(notes[0]!.message, /, \d+(?:\.\d+)? (?:B|KB|MB):/);
  assert.match(notes[0]!.message, /--apply/);
  for (const name of ["ROADMAP-draft.md", "STATE-draft.md"]) {
    assert.ok(notes[0]!.message.includes(name), `the list names ${name}`);
  }
  assert.deepEqual(quarantineCopyPaths(base).sort(), copies.sort(), "no copy was deleted without --apply");
  assert.deepEqual(milestoneRows(), rows, "the database rows are untouched");
  for (const keep of keeps) assert.equal(readFileSync(keep.path, "utf-8"), keep.bytes);
});

test("prune-quarantine --apply deletes only the quarantined copies", async () => {
  const base = makeProject();
  const keeps = keepsideFiles(base);
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  quarantineHandEdit(base, "STATE-draft.md", "# Hand edit B\n");
  const rows = milestoneRows();

  const { ctx, notes } = makeCtx();
  await handleDbPruneQuarantine(ctx, base, "--apply");

  assert.equal(notes.length, 1);
  assert.match(notes[0]!.message, /deleted 2 quarantined projection cop/);
  assert.match(notes[0]!.message, /freed/);
  assert.match(notes[0]!.message, /Live projections and the database were not touched/);
  assert.equal(existsSync(join(base, ".gsd", "quarantine", "projections")), false, "the copies are gone");
  for (const keep of keeps) {
    assert.equal(readFileSync(keep.path, "utf-8"), keep.bytes, `${keep.path} survives the prune`);
  }
  assert.deepEqual(milestoneRows(), rows, "the database rows are untouched");
});

test("prune-quarantine --apply reports a copy it cannot delete and keeps it", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores directory write permissions");
    return;
  }
  const base = makeProject();
  keepsideFiles(base);
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  // A copy whose parent directory forbids deletion.
  const runDir = join(base, ".gsd", "quarantine", "projections", "stubborn", "gsd");
  mkdirSync(runDir, { recursive: true });
  const stubbornPath = join(runDir, "REQUIREMENTS.md");
  writeFileSync(stubbornPath, "# stubborn\n");
  chmodSync(runDir, 0o500);

  try {
    const { ctx, notes } = makeCtx();
    await handleDbPruneQuarantine(ctx, base, "--apply");

    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.kind, "error");
    assert.match(notes[0]!.message, /deleted 1 of 2 copies/);
    assert.match(notes[0]!.message, /could not be deleted/);
    assert.equal(existsSync(stubbornPath), true, "the failing copy is kept and reported");
    const leftovers = (readdirSync(join(base, ".gsd", "quarantine", "projections"), { recursive: true }) as string[])
      .filter((entry) => !entry.split("/")[0]!.startsWith("stubborn"));
    assert.deepEqual(leftovers, [], "the emptied stamp directories are removed");
  } finally {
    chmodSync(runDir, 0o700);
  }
  assert.equal(milestoneRows().length, 1, "the database rows are untouched");
});

test("prune-quarantine with no quarantine reports nothing to prune", async () => {
  const base = makeProject();

  const { ctx, notes } = makeCtx();
  await handleDbPruneQuarantine(ctx, base, "");
  await handleDbPruneQuarantine(ctx, base, "--apply");

  assert.equal(notes.length, 2);
  for (const note of notes) {
    assert.match(note.message, /no quarantined projection copies — nothing to prune/);
    assert.equal(note.kind, "info");
  }
  assert.equal(existsSync(join(base, ".gsd", "quarantine")), false);
});

test("prune-quarantine deletes nothing but files and reports the missing root", async () => {
  const base = makeProject();
  // An empty skeleton (a stamp directory with no copy in it) is not a copy.
  mkdirSync(join(base, ".gsd", "quarantine", "projections", "20260101T00-00-00-000Z", "gsd"), { recursive: true });

  const { ctx, notes } = makeCtx();
  await handleDbPruneQuarantine(ctx, base, "");

  assert.equal(notes.length, 1);
  assert.match(notes[0]!.message, /no quarantined projection copies — nothing to prune/);
  assert.deepEqual(quarantineCopyPaths(base), []);
  assert.equal(statSync(join(base, ".gsd", "quarantine", "projections")).isDirectory(), true, "the skeleton is left for the next prune");
});
