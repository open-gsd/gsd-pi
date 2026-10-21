// Project/App: gsd-pi
// File Purpose: Tests for reassess-roadmap dispatch detection.
//
// `checkNeedsReassessment` reads slice state from the DB (post-cutover there is
// no roadmap-markdown fallback), and reads ASSESSMENT/SUMMARY artifacts from
// disk. Every fixture therefore seeds slice rows; the markdown files decide
// only whether the last completed slice has already been assessed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { checkNeedsReassessment } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import type { GSDState } from "../types.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-reassess-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Seed the DB rows `checkNeedsReassessment` reads: S01 closed, S02 still open
 * unless the caller asks for an all-closed milestone.
 */
function seedSlices(s01Status: string, s02Status: string): void {
  openDatabase(":memory:");
  assert.ok(isDbAvailable(), "fixture must have an open DB");
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: s01Status, risk: "high", depends: [], sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Second", status: s02Status, risk: "medium", depends: ["S01"], sequence: 2 });
}

function writeSummary(base: string, sid: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-SUMMARY.md`),
    `---\nid: ${sid}\n---\n# ${sid} Summary\nDone.`,
  );
}

function writeAssessment(base: string, sid: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-ASSESSMENT.md`),
    `# ${sid} Assessment\nNo changes needed.`,
  );
}

const dummyState: GSDState = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Test" },
  activeSlice: { id: "S02", title: "Second" },
  activeTask: null,
  recentDecisions: [],
  blockers: [],
  nextAction: "",
  registry: [{ id: "M001", title: "Test", status: "active" }],
};

// ─── checkNeedsReassessment: returns null when assessment exists ─────────
// Discriminating because the SUMMARY is present and S02 is still open: drop the
// ASSESSMENT check and this fixture dispatches { sliceId: "S01" }.

test("checkNeedsReassessment returns null when assessment file exists", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "pending");
    writeSummary(base, "S01");
    writeAssessment(base, "S01");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null when assessment exists");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns sliceId when assessment missing ─────

test("checkNeedsReassessment returns sliceId when assessment is missing", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "pending");
    writeSummary(base, "S01");
    // No assessment written

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(result, { sliceId: "S01" });
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns null when no summary exists ─────────
// Discriminating because everything else is dispatch-ready: drop the SUMMARY
// requirement and this fixture dispatches { sliceId: "S01" }.

test("checkNeedsReassessment returns null when summary is missing", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "pending");
    // No summary, no assessment

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null — can't reassess without summary");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: detects assessment written after cache ──────
// This is the core regression test for #1112: the assessment file is written
// to disk AFTER the path cache was populated (simulating the worktree race
// condition where readdirSync doesn't see a freshly written file).

test("checkNeedsReassessment detects assessment written after initial cache population", async () => {
  const base = makeTmpBase();
  try {
    seedSlices("complete", "pending");
    writeSummary(base, "S01");

    // First call: no assessment exists — populates internal caches
    invalidateAllCaches();
    const before = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(before, { sliceId: "S01" }, "should need reassessment initially");

    // Now write the assessment — after the first pass already cached the slice
    // directory listing. This is the #1112 worktree race: the reassess unit's
    // agent writes ASSESSMENT.md directly, so nothing in the path layer knows.
    writeAssessment(base, "S01");

    // The auto loop clears the path caches once per completed unit
    // (`auto-post-unit.ts:1474`), which is what unblocks the race in
    // production; mirror exactly that and nothing more.
    invalidateAllCaches();

    // Second pass must now see the assessment and stop dispatching reassess —
    // a detection that memoized the first answer, or a cache invalidation that
    // missed the directory-entry cache, still returns { sliceId: "S01" }.
    const after = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(after, null, "should return null — assessment exists on disk (fallback check)");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns null when all slices done ───────────
// Discriminating because S02 is the last completed slice and has a SUMMARY but
// no ASSESSMENT: drop the "milestone still has open slices" guard and this
// fixture dispatches { sliceId: "S02" }.

test("checkNeedsReassessment returns null when all slices are complete", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "complete");
    writeSummary(base, "S02");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null — all slices done, no point reassessing");
  } finally {
    cleanup(base);
  }
});
