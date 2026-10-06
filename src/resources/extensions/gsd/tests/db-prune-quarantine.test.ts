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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handleDbPruneQuarantine } from "../commands-maintenance.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { quarantineProjectionEvidence } from "../projection-observation.ts";
import { invalidateStateCache } from "../state.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  // A test may have locked a directory to force a deletion failure; restore
  // write permission on every real directory (never through a link) so the
  // temp trees delete on all platforms.
  for (const dir of tempDirs) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      try {
        chmodSync(current, 0o700);
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(join(current, entry.name));
        }
      } catch {
        // Best effort: the tree may already be gone.
      }
    }
  }
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

/** An outside temp directory holding a file the prune must never touch. */
function outsideWithPrecious(): { outside: string; precious: string; bytes: string } {
  const outside = mkdtempSync(join(tmpdir(), "gsd-prune-escape-outside-"));
  tempDirs.add(outside);
  const precious = join(outside, "precious.ts");
  writeFileSync(precious, "export const precious = true;\n");
  return { outside, precious, bytes: readFileSync(precious, "utf-8") };
}

/** Plant a symlink under the quarantine root pointing outside the project. */
function plantQuarantineLink(
  base: string,
  name: string,
  target: string,
  type: "dir" | "file" | "junction",
): string {
  const stampDir = join(base, ".gsd", "quarantine", "projections", "20260101T00-00-00-000Z");
  mkdirSync(stampDir, { recursive: true });
  const link = join(stampDir, name);
  symlinkSync(target, link, type);
  return link;
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
    _resetLogs();
    await handleDbPruneQuarantine(ctx, base, "--apply");

    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.kind, "error");
    assert.match(notes[0]!.message, /deleted 1 of 2 copies/);
    assert.match(notes[0]!.message, /could not be deleted/);
    assert.equal(existsSync(stubbornPath), true, "the failing copy is kept and reported");
    const leftovers = (readdirSync(join(base, ".gsd", "quarantine", "projections"), { recursive: true }) as string[])
      .filter((entry) => !entry.split("/")[0]!.startsWith("stubborn"));
    assert.deepEqual(leftovers, [], "the emptied stamp directories are removed");
    // The stamp directories left holding the undeletable copy cannot be
    // removed either; the prune logs that instead of swallowing it.
    const pruneWarnings = peekLogs().filter(
      (entry) => entry.severity === "warn" && entry.message.includes("could not be removed"),
    );
    assert.ok(pruneWarnings.length > 0, "a directory that could not be removed is logged");
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

test("prune-quarantine unlinks a planted directory symlink but never touches its outside target", async () => {
  const base = makeProject();
  const keeps = keepsideFiles(base);
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  const { outside, precious, bytes } = outsideWithPrecious();
  const escape = plantQuarantineLink(
    base,
    "escape",
    outside,
    process.platform === "win32" ? "junction" : "dir",
  );

  const preview = makeCtx();
  await handleDbPruneQuarantine(preview.ctx, base, "");
  assert.equal(preview.notes.length, 1);
  assert.equal(preview.notes[0]!.kind, "info");
  assert.match(preview.notes[0]!.message, /2 quarantined projection cop/, "the real copy and the link itself are listed");
  assert.ok(preview.notes[0]!.message.includes("escape"), "the link is listed at its quarantine path");
  assert.ok(!preview.notes[0]!.message.includes("precious.ts"), "nothing from outside the quarantine is listed");

  const apply = makeCtx();
  await handleDbPruneQuarantine(apply.ctx, base, "--apply");
  assert.equal(apply.notes.length, 1);
  assert.equal(apply.notes[0]!.kind, "info");
  assert.match(apply.notes[0]!.message, /deleted 2 quarantined projection cop/);
  assert.throws(() => lstatSync(escape), /ENOENT/, "the link itself was unlinked");
  assert.equal(readFileSync(precious, "utf-8"), bytes, "the outside file survives byte-identical");
  assert.deepEqual(readdirSync(outside), ["precious.ts"], "nothing outside was deleted");
  assert.equal(existsSync(join(base, ".gsd", "quarantine", "projections")), false, "the emptied quarantine is removed");
  for (const keep of keeps) assert.equal(readFileSync(keep.path, "utf-8"), keep.bytes);
});

test("prune-quarantine keeps and reports a planted link it cannot unlink; the outside target survives", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores directory write permissions");
    return;
  }
  const base = makeProject();
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  const { outside, precious, bytes } = outsideWithPrecious();
  const escape = plantQuarantineLink(
    base,
    "escape",
    outside,
    process.platform === "win32" ? "junction" : "dir",
  );
  // The link's parent forbids deletion, so unlinking the link must fail.
  const stampDir = dirname(escape);
  chmodSync(stampDir, 0o500);

  try {
    const { ctx, notes } = makeCtx();
    await handleDbPruneQuarantine(ctx, base, "--apply");

    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.kind, "error");
    assert.match(notes[0]!.message, /deleted 1 of 2 copies/);
    assert.match(notes[0]!.message, /could not be deleted/);
    assert.match(notes[0]!.message, /escape/);
    assert.equal(lstatSync(escape).isSymbolicLink(), true, "the link is kept");
    assert.equal(readFileSync(precious, "utf-8"), bytes, "the outside target survives untouched");
  } finally {
    chmodSync(stampDir, 0o700);
  }
  assert.equal(milestoneRows().length, 1, "the database rows are untouched");
});

test("prune-quarantine removes a file symlink but never its outside target", async () => {
  const base = makeProject();
  quarantineHandEdit(base, "ROADMAP-draft.md", "# Hand edit A\n");
  const { outside, precious, bytes } = outsideWithPrecious();
  const decoy = plantQuarantineLink(base, "decoy.md", precious, "file");

  const { ctx, notes } = makeCtx();
  await handleDbPruneQuarantine(ctx, base, "--apply");

  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.kind, "info");
  assert.match(notes[0]!.message, /deleted 2 quarantined projection cop/);
  assert.throws(() => lstatSync(decoy), /ENOENT/, "the link itself was removed");
  assert.equal(readFileSync(precious, "utf-8"), bytes, "the outside target survives byte-identical");
  assert.deepEqual(readdirSync(outside), ["precious.ts"]);
});
