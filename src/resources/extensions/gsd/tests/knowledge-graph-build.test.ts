// Project/App: gsd-pi
// File Purpose: ADR-046 gates G1/G2 for the in-process knowledge graph build: the graph that slice completion and `gsd graph build` write comes from the database, not from projection files.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { graphQuery } from "@opengsd/mcp-server";

import { _getAdapter } from "../gsd-db.ts";
import { rebuildKnowledgeGraph } from "../knowledge-graph-build.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { deleteProjections, poisonProjections } from "./db-authority-gate.ts";
import { createWorkflowAuthorityFixture, type WorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

// Fixture rows: M001 active; S01 complete (T01 complete); S02 pending (T01 pending).
let fixture: WorkflowAuthorityFixture;

afterEach(() => fixture?.cleanup());

for (const [gate, damage] of [
  ["G1: files deleted", deleteProjections],
  ["G2: files poisoned", poisonProjections],
] as const) {
  test(`${gate}: the graph that the in-process build writes holds the database hierarchy`, async () => {
    fixture = await createWorkflowAuthorityFixture();
    assert.deepEqual((await renderAllFromDb(fixture.root)).errors, []);
    // A title that is in the database only: the rendered files keep the old one.
    _getAdapter()!.exec("UPDATE slices SET title = 'Renamed in the database' WHERE milestone_id = 'M001' AND id = 'S02'");

    damage(fixture.root);

    const built = await rebuildKnowledgeGraph(fixture.root);

    // Every hierarchy node label holds a "0" (M001, S01, S02, T01), so the
    // query returns the whole hierarchy of the graph that the build wrote.
    assert.deepEqual(
      (await graphQuery(fixture.root, "0")).nodes
        .filter((node) => ["milestone", "slice", "task"].includes(node.type))
        .map((node) => [node.id, node.label])
        .sort(),
      [
        ["milestone:M001", "M001: Authority Fixture"],
        ["slice:M001:S01", "S01: Completed prerequisite"],
        ["slice:M001:S02", "S02: Renamed in the database"],
        ["task:M001:S01:T01", "T01: Completed task"],
        ["task:M001:S02:T01", "T01: Ready task"],
      ],
    );
    assert.equal(built.source, "database");
  });
}
