// Project/App: gsd-pi
// File Purpose: Tests for reassess-roadmap dispatch detection.
//
// `checkNeedsReassessment` reads only the DB: slice rows, and the roadmap
// assessment row that reassess-roadmap records. ASSESSMENT and SUMMARY files
// are projections and decide nothing (ADR-046).

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
  insertAssessment,
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

// ─── checkNeedsReassessment: an ASSESSMENT file is not a reassessment ────
// Only the roadmap assessment row records a reassessment. A slice ASSESSMENT.md
// on disk (a run-uat projection, or a hand-written file) must not suppress it.

test("checkNeedsReassessment still returns sliceId when only an ASSESSMENT file exists", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "pending");
    writeSummary(base, "S01");
    writeAssessment(base, "S01");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(result, { sliceId: "S01" }, "an ASSESSMENT file with no roadmap row is not a reassessment");
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

// ─── checkNeedsReassessment: a missing SUMMARY file does not block ───────
// The slice row says S01 is complete. A missing SUMMARY projection must not
// stop the reassessment.

test("checkNeedsReassessment returns sliceId when the SUMMARY file is missing", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "pending");
    // No summary file, no assessment

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(result, { sliceId: "S01" });
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: sees a reassessment recorded after a first check ─
// #1112: a reassessment recorded after a first check must stop the next
// dispatch. The roadmap assessment row is read on every call, so no path
// cache can hide it.

test("checkNeedsReassessment detects a roadmap assessment recorded after a first check", async () => {
  const base = makeTmpBase();
  try {
    seedSlices("complete", "pending");

    const before = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(before, { sliceId: "S01" }, "should need reassessment initially");

    insertAssessment({
      path: ".gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md",
      milestoneId: "M001",
      sliceId: "S01",
      status: "no-changes",
      scope: "roadmap",
      fullContent: "No changes needed.",
    });

    const after = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(after, null, "should return null — the reassessment is recorded");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns null when all slices done ───────────
// Discriminating because S02 is the last completed slice and has no roadmap
// assessment row: drop the "milestone still has open slices" guard and this
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

// ─── checkNeedsReassessment: a deferred slice is not open work ───────────
// Discriminating because S01 is complete with no roadmap assessment row: count
// deferred S02 as open and this fixture dispatches { sliceId: "S01" }.

test("checkNeedsReassessment returns null when the only other slice is deferred", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    seedSlices("complete", "deferred");
    writeSummary(base, "S01");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null — a deferred slice leaves nothing to run");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: reads the durable roadmap assessment row ─────
// #2344: reassess-roadmap persists its verdict as a roadmap-scoped assessments
// row and never writes a slice ASSESSMENT.md, so a completed reassessment must
// satisfy dispatch through the DB or the rule re-selects the unit every cycle.

test("checkNeedsReassessment returns null when a roadmap assessment row exists for the last completed slice", async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedSlices("complete", "pending");
  writeSummary(base, "S01");
  // No slice ASSESSMENT.md on disk — only the durable row reassess-roadmap writes.
  insertAssessment({
    path: ".gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status: "no-changes",
    scope: "roadmap",
    fullContent: "No changes needed.",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const result = await checkNeedsReassessment(base, "M001", dummyState);
  assert.strictEqual(result, null, "roadmap-scoped row must satisfy dispatch without a slice ASSESSMENT.md");
});

test("checkNeedsReassessment ignores roadmap assessment rows for other slices", async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedSlices("complete", "pending");
  writeSummary(base, "S01");
  insertAssessment({
    path: ".gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S02",
    status: "no-changes",
    scope: "roadmap",
    fullContent: "No changes needed.",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const result = await checkNeedsReassessment(base, "M001", dummyState);
  assert.deepStrictEqual(result, { sliceId: "S01" }, "a row recorded against a different slice must not suppress dispatch");
});
