// Project/App: gsd-pi
// File Purpose: Round-trip property test for the flat-phase layout.
// import → render → import must produce stable milestone/slice/task hierarchy.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "flat-phase");
const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-fprt-${randomUUID()}`));
  cpSync(FIXTURE_ROOT, base, { recursive: true });
  tmpDirs.push(base);
  return base;
}

test("flat-phase round-trip: import → render → import is stable", async () => {
  const base = copyFixture();
  openDatabase(join(base, ".gsd", "gsd.db"));

  // Pass 1: import fixture markdown → DB
  migrateHierarchyToDb(base);
  invalidateStateCache();
  const ms1 = getAllMilestones();
  const slices1 = ms1.length > 0 ? getMilestoneSlices(ms1[0]!.id) : [];
  const tasks1 = slices1.length > 0 ? getSliceTasks(ms1[0]!.id, slices1[0]!.id) : [];
  assert.ok(ms1.length > 0, "expected at least one milestone after import");

  // Render DB → flat-phase markdown
  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, [], `render errors: ${JSON.stringify(result.errors)}`);

  // Pass 2: re-import the rendered markdown
  migrateHierarchyToDb(base);
  invalidateStateCache();
  const ms2 = getAllMilestones();
  const slices2 = ms2.length > 0 ? getMilestoneSlices(ms2[0]!.id) : [];
  const tasks2 = slices2.length > 0 ? getSliceTasks(ms2[0]!.id, slices2[0]!.id) : [];

  assert.equal(ms2.length, ms1.length, "milestone count drifted");
  assert.equal(slices2.length, slices1.length, "slice count drifted");
  assert.equal(tasks2.length, tasks1.length, "task count drifted");
});

test("flat-phase layout writes to .gsd/phases/ after import", async () => {
  const base = copyFixture();
  openDatabase(join(base, ".gsd", "gsd.db"));

  migrateHierarchyToDb(base);
  invalidateStateCache();
  await renderAllFromDb(base);

  // Confirm flat-phase structure on disk
  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist after render");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should NOT exist");
});
