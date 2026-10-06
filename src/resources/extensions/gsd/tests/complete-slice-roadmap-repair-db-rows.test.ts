// Project/App: gsd-pi
// File Purpose: The complete-slice ROADMAP projection repair is gated by the slice row, not by SUMMARY and UAT files.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _repairCompleteSliceRoadmapProjectionForTest } from "../auto-post-unit.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { roadmapRenderMarksSliceDone } from "../markdown-renderer.ts";
import { clearPathCache, resolveMilestoneFile } from "../paths.ts";

function makeProject(t: { after: (fn: () => void) => void }, sliceStatus: string): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-roadmap-repair-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active", planning: { vision: "Ship it" } });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: sliceStatus });
  return base;
}

function roadmapMarksSliceDone(base: string): boolean {
  clearPathCache();
  const roadmapPath = resolveMilestoneFile(base, "M001", "ROADMAP");
  return !!roadmapPath && existsSync(roadmapPath) &&
    roadmapRenderMarksSliceDone(readFileSync(roadmapPath, "utf-8"), "S01");
}

test("a closed slice row repairs the ROADMAP projection with no SUMMARY or UAT file on disk", async (t) => {
  const base = makeProject(t, "complete");

  const repaired = await _repairCompleteSliceRoadmapProjectionForTest("complete-slice", "M001/S01", base);

  assert.equal(repaired, true);
  assert.equal(roadmapMarksSliceDone(base), true);
});

test("SUMMARY and UAT files do not repair the ROADMAP projection of a slice whose row is open", async (t) => {
  const base = makeProject(t, "in_progress");
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.\n");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# S01 UAT\n\nverdict: PASS\n");

  const repaired = await _repairCompleteSliceRoadmapProjectionForTest("complete-slice", "M001/S01", base);

  assert.equal(repaired, false);
  assert.equal(roadmapMarksSliceDone(base), false);
});
