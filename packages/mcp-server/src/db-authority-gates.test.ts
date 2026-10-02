// Project/App: gsd-pi
// File Purpose: ADR-046 gates G1/G2 for the MCP read tools: answers come from the database, not from projection files.
//
// See src/resources/extensions/gsd/tests/db-authority-gates.test.ts for the
// gate list and the meaning of expectedFail. Package P30 makes these pass.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { renderAllFromDb } from "../../../src/resources/extensions/gsd/markdown-renderer.ts";
import {
  deleteProjections,
  expectedFail,
  poisonProjections,
} from "../../../src/resources/extensions/gsd/tests/db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "../../../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts";
import { readRoadmap } from "./readers/roadmap.ts";
import { readProgress } from "./readers/state.ts";

// Fixture rows: M001 active; S01 complete (T01 complete); S02 pending (T01 pending).
let fixture: WorkflowAuthorityFixture;

afterEach(() => fixture?.cleanup());

/** What gsd_roadmap and gsd_progress return, reduced to the fields the database owns. */
function readTools(base: string) {
  const progress = readProgress(base);
  return {
    roadmap: readRoadmap(base).milestones.map((milestone) => ({
      id: milestone.id,
      slices: milestone.slices.map((slice) => ({
        id: slice.id,
        status: slice.status,
        tasks: slice.tasks.map((task) => ({ id: task.id, status: task.status })),
      })),
    })),
    activeMilestone: progress.activeMilestone?.id ?? null,
    slices: { total: progress.slices.total, done: progress.slices.done },
  };
}

const DATABASE_ANSWER = {
  roadmap: [{
    id: "M001",
    slices: [
      { id: "S01", status: "done", tasks: [{ id: "T01", status: "done" }] },
      { id: "S02", status: "pending", tasks: [{ id: "T01", status: "pending" }] },
    ],
  }],
  activeMilestone: "M001",
  slices: { total: 2, done: 1 },
};

for (const [gate, damage] of [
  ["G1: files deleted", deleteProjections],
  ["G2: files poisoned", poisonProjections],
] as const) {
  test(`${gate}: gsd_roadmap and gsd_progress return the database state`, async () => {
    fixture = await createWorkflowAuthorityFixture();
    assert.deepEqual((await renderAllFromDb(fixture.root)).errors, []);
    assert.deepEqual(
      readTools(fixture.root).roadmap,
      DATABASE_ANSWER.roadmap,
      "a clean render gives the database answer",
    );

    damage(fixture.root);

    expectedFail("P30", () => assert.deepEqual(readTools(fixture.root), DATABASE_ANSWER));
  });
}
