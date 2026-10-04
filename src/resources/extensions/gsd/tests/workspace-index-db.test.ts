// Project/App: gsd-pi
// File Purpose: The workspace index (web boot payload, doctor scopes) lists the hierarchy from database rows.

import assert from "node:assert/strict";
import { test } from "node:test";

import { closeDatabase, insertMilestone } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { indexWorkspace } from "../workspace-index.ts";
import { deleteProjections, poisonProjections } from "./db-authority-gate.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

// Fixture rows: M001 "Authority Fixture" active; S01 complete (T01 complete); S02 pending (T01 pending).
const DATABASE_HIERARCHY = [{
  id: "M001",
  title: "Authority Fixture",
  slices: [
    { id: "S01", done: true, tasks: [{ id: "T01", done: true }] },
    { id: "S02", done: false, tasks: [{ id: "T01", done: false }] },
  ],
}];

function hierarchyOf(index: Awaited<ReturnType<typeof indexWorkspace>>) {
  return index.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    slices: milestone.slices.map((slice) => ({
      id: slice.id,
      done: slice.done,
      tasks: slice.tasks.map((task) => ({ id: task.id, done: task.done })),
    })),
  }));
}

for (const [name, damage] of [
  ["deleted", deleteProjections],
  ["poisoned", poisonProjections],
] as const) {
  test(`indexWorkspace opens the database itself and lists its hierarchy when the projection files are ${name}`, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    assert.deepEqual((await renderAllFromDb(fixture.root)).errors, []);
    damage(fixture.root);
    // The web boot runs indexWorkspace in a new process: no database is open yet.
    closeDatabase();
    invalidateStateCache();

    const index = await indexWorkspace(fixture.root);

    assert.deepEqual(hierarchyOf(index), DATABASE_HIERARCHY);
    assert.equal(index.active.milestoneId, "M001");
  });
}

test("indexWorkspace does not list a discarded milestone", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  insertMilestone({ id: "M002", title: "Dropped", status: "cancelled" });
  invalidateStateCache();

  const index = await indexWorkspace(fixture.root);

  assert.deepEqual(index.milestones.map((milestone) => milestone.id), ["M001"]);
});
