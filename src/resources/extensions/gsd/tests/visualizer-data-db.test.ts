// Project/App: gsd-pi
// File Purpose: Visualizer data (TUI overlay, web /api/visualizer, HTML export) lists milestones and the changelog from database rows.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { _getAdapter, closeDatabase } from "../gsd-db.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";
import { loadVisualizerData } from "../visualizer-data.ts";
import { deleteProjections, poisonProjections } from "./db-authority-gate.ts";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

const SLICE_SUMMARY = [
  "---",
  "id: S01",
  "verification_result: passed",
  "completed_at: 2026-07-10T00:00:00.000Z",
  "---",
  "",
  "# S01: Completed prerequisite",
  "",
  "**Summary from the database**",
  "",
].join("\n");

for (const [name, damage] of [
  ["deleted", deleteProjections],
  ["poisoned", poisonProjections],
] as const) {
  test(`loadVisualizerData returns the database hierarchy and changelog when the projection files are ${name}`, async (t) => {
    // Fixture rows: M001 active; S01 complete (T01 complete); S02 pending (T01 pending).
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    _getAdapter()!.prepare(
      "UPDATE slices SET full_summary_md = :summary WHERE milestone_id = 'M001' AND id = 'S01'",
    ).run({ ":summary": SLICE_SUMMARY });
    assert.deepEqual((await renderAllFromDb(fixture.root)).errors, []);
    damage(fixture.root);
    // The web service runs the loader in a new process: no database is open yet.
    closeDatabase();
    invalidateStateCache();

    const data = await loadVisualizerData(fixture.root);

    assert.deepEqual(
      data.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        slices: milestone.slices.map((slice) => [slice.id, slice.done]),
      })),
      [{ id: "M001", title: "Authority Fixture", status: "active", slices: [["S01", true], ["S02", false]] }],
    );
    assert.deepEqual(
      data.changelog.entries.map((entry) => [entry.sliceId, entry.oneLiner, entry.completedAt]),
      [["S01", "Summary from the database", "2026-07-10T00:00:00.000Z"]],
    );
    assert.deepEqual(
      data.sliceVerifications.map((verification) => [verification.sliceId, verification.verificationResult]),
      [["S01", "passed"]],
    );
  });
}

test("loadVisualizerData does not list a milestone directory that has no database row", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  const strayDir = join(fixture.root, ".gsd", "milestones", "M099");
  mkdirSync(strayDir, { recursive: true });
  writeFileSync(join(strayDir, "M099-ROADMAP.md"), "# M099: Stray\n");
  invalidateStateCache();

  const data = await loadVisualizerData(fixture.root);

  assert.deepEqual(data.milestones.map((milestone) => milestone.id), ["M001"]);
});
