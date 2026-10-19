// Project/App: gsd-pi
// File Purpose: ADR-046 gates G1/G2 for the MCP read tools: answers come from the database, not from projection files.
//
// See src/resources/extensions/gsd/tests/db-authority-gates.test.ts for the
// gate list.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { renderAllFromDb } from "../../../src/resources/extensions/gsd/markdown-renderer.ts";
import {
  deleteProjections,
  poisonProjections,
} from "../../../src/resources/extensions/gsd/tests/db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "../../../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts";
import { createMcpServer } from "./server.ts";
import { SessionManager } from "./session-manager.ts";

// Fixture rows: M001 active; S01 complete (T01 complete); S02 pending (T01 pending).
let fixture: WorkflowAuthorityFixture;

afterEach(() => fixture?.cleanup());

const DATABASE_READ = { source: "database", authority: "db-authoritative" };

/** Call each session-less read tool through its registered handler. */
async function readTools(base: string) {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await (server as any)._registeredTools[name].handler({ projectDir: base, ...args });
    assert.notEqual(result.isError, true, `${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  return {
    roadmap: await call("gsd_roadmap"),
    progress: await call("gsd_progress"),
    query: await call("gsd_query"),
    doctor: await call("gsd_doctor"),
    graphBuild: await call("gsd_graph", { mode: "build" }),
    graphQuery: await call("gsd_graph", { mode: "query", term: "0" }),
  };
}

for (const [gate, damage] of [
  ["G1: files deleted", deleteProjections],
  ["G2: files poisoned", poisonProjections],
] as const) {
  test(`${gate}: gsd_roadmap, gsd_progress, gsd_query, gsd_doctor and gsd_graph return the database state`, async () => {
    fixture = await createWorkflowAuthorityFixture();
    assert.deepEqual((await renderAllFromDb(fixture.root)).errors, []);

    damage(fixture.root);

    const { roadmap, progress, query, doctor, graphBuild, graphQuery } = await readTools(fixture.root);

    assert.deepEqual(roadmap.readMetadata, DATABASE_READ);
    assert.deepEqual(
      roadmap.milestones.map((milestone: any) => ({
        id: milestone.id,
        status: milestone.status,
        slices: milestone.slices.map((slice: any) => ({
          id: slice.id,
          status: slice.status,
          tasks: slice.tasks.map((task: any) => ({ id: task.id, status: task.status })),
        })),
      })),
      [{
        id: "M001",
        status: "active",
        slices: [
          { id: "S01", status: "done", tasks: [{ id: "T01", status: "done" }] },
          { id: "S02", status: "pending", tasks: [{ id: "T01", status: "pending" }] },
        ],
      }],
    );

    assert.deepEqual(progress.readMetadata, DATABASE_READ);
    assert.equal(progress.activeMilestone?.id, "M001");
    assert.deepEqual(
      { total: progress.slices.total, done: progress.slices.done },
      { total: 2, done: 1 },
    );

    assert.deepEqual(query.readMetadata, DATABASE_READ);
    assert.deepEqual(
      query.milestones.map((milestone: any) => ({ id: milestone.id, status: milestone.status })),
      [{ id: "M001", status: "active" }],
    );
    assert.match(query.state, /\*\*Active Milestone:\*\* M001: Authority Fixture/);
    assert.doesNotMatch(query.state, /M099/);
    assert.match(query.requirements, /SQLite is authoritative/);

    assert.deepEqual(doctor.readMetadata, DATABASE_READ);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.counts.error, 0, JSON.stringify(doctor.issues));

    // Every hierarchy node label holds a "0" (M001, S01, S02, T01), so the
    // query returns the whole hierarchy of the graph that the build wrote.
    assert.deepEqual(graphBuild.readMetadata, DATABASE_READ);
    assert.deepEqual(
      graphQuery.nodes
        .filter((node: any) => ["milestone", "slice", "task"].includes(node.type))
        .map((node: any) => [node.id, node.label])
        .sort(),
      [
        ["milestone:M001", "M001: Authority Fixture"],
        ["slice:M001:S01", "S01: Completed prerequisite"],
        ["slice:M001:S02", "S02: Ready dependent slice"],
        ["task:M001:S01:T01", "T01: Completed task"],
        ["task:M001:S02:T01", "T01: Ready task"],
      ],
    );
  });
}
