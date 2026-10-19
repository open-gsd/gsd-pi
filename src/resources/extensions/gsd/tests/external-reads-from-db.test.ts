// Project/App: gsd-pi
// File Purpose: The roadmap, project query and health reads of the external surfaces answer from database rows.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import {
  readProjectQueryFromDb,
  readRoadmapFromDb,
  runDoctorFromDb,
} from "../state/external-reads-from-db.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-external-reads-"));
  mkdirSync(join(base, ".gsd"));
});

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  rmSync(base, { recursive: true, force: true });
});

function openProject(): void {
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
}

function slice(milestoneId: string, id: string, status: string, sequence: number): void {
  insertSlice({ milestoneId, id, title: `Slice ${id}`, status, risk: "low", depends: [], sequence });
}

function task(milestoneId: string, sliceId: string, id: string, status: string): void {
  insertTask({ milestoneId, sliceId, id, title: `Task ${id}`, status, sequence: 1 });
}

describe("with no database", () => {
  test("every read returns null so the caller can use the labelled projection reader", async () => {
    assert.equal(readRoadmapFromDb(base), null);
    assert.equal(await readProjectQueryFromDb(base, ["milestones"]), null);
    assert.equal(runDoctorFromDb(base), null);
  });
});

describe("readRoadmapFromDb", () => {
  test("maps row status to the roadmap buckets and leaves out a discarded milestone", () => {
    openProject();
    insertMilestone({ id: "M001", title: "M001: Shipped", status: "complete" });
    insertMilestone({ id: "M002", title: "Running", status: "active" });
    insertMilestone({ id: "M003", title: "On hold", status: "parked" });
    insertMilestone({ id: "M004", title: "Dropped", status: "cancelled" });
    insertMilestone({ id: "M005", title: "Later", status: "queued" });
    slice("M002", "S01", "complete", 1);
    slice("M002", "S02", "in_progress", 2);
    slice("M002", "S03", "pending", 3);
    task("M002", "S02", "T01", "complete");
    task("M002", "S02", "T02", "pending");

    const roadmap = readRoadmapFromDb(base);

    assert.deepEqual(roadmap?.readMetadata, { source: "database", authority: "db-authoritative" });
    assert.deepEqual(
      roadmap?.milestones.map((milestone) => [milestone.id, milestone.title, milestone.status]),
      [
        ["M001", "Shipped", "done"],
        ["M002", "Running", "active"],
        ["M003", "On hold", "parked"],
        ["M005", "Later", "pending"],
      ],
    );
    assert.deepEqual(
      roadmap?.milestones[1].slices.map((entry) => [entry.id, entry.status, entry.tasks.map((t) => `${t.id}:${t.status}`)]),
      [
        ["S01", "done", []],
        ["S02", "active", ["T01:done", "T02:pending"]],
        ["S03", "pending", []],
      ],
    );
  });

  test("filters to one milestone", () => {
    openProject();
    insertMilestone({ id: "M001", title: "First", status: "complete" });
    insertMilestone({ id: "M002", title: "Second", status: "active" });

    assert.deepEqual(readRoadmapFromDb(base, "M002")?.milestones.map((milestone) => milestone.id), ["M002"]);
  });
});

describe("readProjectQueryFromDb", () => {
  test("returns only the requested fields", async () => {
    openProject();
    insertMilestone({ id: "M001", title: "Only", status: "active" });
    slice("M001", "S01", "pending", 1);

    const result = await readProjectQueryFromDb(base, ["milestones"]);

    assert.deepEqual(result, {
      readMetadata: { source: "database", authority: "db-authoritative" },
      milestones: [{ id: "M001", title: "Only", status: "active", hasRoadmap: true, hasSummary: false }],
    });
  });

  test("renders the state document from database rows and reports absent documents as null", async () => {
    openProject();
    insertMilestone({ id: "M001", title: "Only", status: "active" });

    const result = await readProjectQueryFromDb(base, ["state", "project", "requirements"]);

    assert.match(result?.state ?? "", /\*\*Active Milestone:\*\* M001: Only/);
    assert.equal(result?.project, null);
    assert.equal(result?.requirements, null);
    assert.equal("milestones" in result!, false);
  });
});

describe("runDoctorFromDb", () => {
  test("reports a status that contradicts its child rows as an error", () => {
    openProject();
    insertMilestone({ id: "M001", title: "Closed too early", status: "complete" });
    slice("M001", "S01", "complete", 1);
    slice("M001", "S02", "pending", 2);
    task("M001", "S01", "T01", "pending");

    const result = runDoctorFromDb(base);

    assert.equal(result?.ok, false);
    assert.deepEqual(
      result?.issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.unitId]),
      [
        ["milestone_done_with_open_slices", "M001"],
        ["slice_done_with_open_tasks", "M001/S01"],
      ],
    );
  });

  test("reports a missing projection file as info, not as an error", () => {
    openProject();
    insertMilestone({ id: "M001", title: "Healthy", status: "active" });
    slice("M001", "S01", "pending", 1);
    task("M001", "S01", "T01", "pending");

    const result = runDoctorFromDb(base);

    assert.equal(result?.ok, true);
    assert.deepEqual(result?.counts, { error: 0, warning: 0, info: 2 });
    assert.deepEqual(
      result?.issues.map((issue) => [issue.severity, issue.code, issue.unitId]),
      [
        ["info", "projection_missing", "M001"],
        ["info", "projection_missing", "M001/S01"],
      ],
    );
    assert.deepEqual(result?.readMetadata, { source: "database", authority: "db-authoritative" });
  });

  test("warns when every slice is done and the milestone is still open, and honors the scope", () => {
    openProject();
    insertMilestone({ id: "M001", title: "Ready to close", status: "active" });
    slice("M001", "S01", "complete", 1);
    insertMilestone({ id: "M002", title: "Closed too early", status: "complete" });
    slice("M002", "S01", "pending", 1);

    const scoped = runDoctorFromDb(base, "M001");

    assert.equal(scoped?.ok, true);
    assert.deepEqual(
      scoped?.issues.filter((issue) => issue.severity !== "info").map((issue) => [issue.severity, issue.code, issue.unitId]),
      [["warning", "all_slices_done_milestone_open", "M001"]],
    );
    assert.equal(runDoctorFromDb(base)?.ok, false, "the unscoped check also covers M002");
  });
});
