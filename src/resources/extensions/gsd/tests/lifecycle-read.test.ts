// Project/App: gsd-pi
// File Purpose: Behavior tests for the one read interface (db/lifecycle-read.ts)
// and for the decision readers that must give its answers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  readMilestone,
  readMilestoneSlices,
  readMilestoneStatus,
  readMilestones,
  readProgressCounts,
  readSliceTasks,
  readSlicesByMilestoneIds,
} from "../db/lifecycle-read.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { readProgressFromDb } from "../state/progress-from-db.ts";
import { readProjectSnapshotFromDb } from "../state/project-snapshot.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-lifecycle-read-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

test("the read interface answers done, parked and discarded for each item status", () => {
  makeProject();
  const milestoneStatuses = ["complete", "parked", "skipped", "deferred", "cancelled", "blocker-accepted", "active", "queued"];
  milestoneStatuses.forEach((status, index) => {
    insertMilestone({ id: `M00${index + 1}`, title: status, status });
  });

  assert.deepEqual(
    readMilestones().map((m) => [m.id, m.status, m.done, m.parked, m.discarded]),
    [
      ["M001", "complete", true, false, false],
      ["M002", "parked", false, true, false],
      ["M003", "skipped", true, false, true],
      ["M004", "deferred", false, false, true],
      ["M005", "cancelled", true, false, true],
      ["M006", "blocker-accepted", true, false, false],
      ["M007", "active", false, false, false],
      ["M008", "queued", false, false, false],
    ],
  );
  assert.deepEqual(readMilestone("M002"), readMilestones()[1]);
  assert.equal(readMilestone("M999"), null);

  const sliceStatuses = ["complete", "done", "skipped", "closed", "deferred", "active", "pending"];
  sliceStatuses.forEach((status, index) => {
    insertSlice({
      id: `S0${index + 1}`,
      milestoneId: "M007",
      title: status,
      status,
      depends: index === 6 ? ["S06"] : [],
      sequence: index + 1,
    });
  });
  const slices = readMilestoneSlices("M007");
  assert.deepEqual(
    slices.map((s) => [s.id, s.done]),
    [["S01", true], ["S02", true], ["S03", true], ["S04", true], ["S05", true], ["S06", false], ["S07", false]],
  );
  assert.deepEqual(slices[6]?.depends, ["S06"]);
  assert.deepEqual(readSlicesByMilestoneIds(["M007", "M008"]), new Map([["M007", slices]]));

  insertTask({ id: "T01", sliceId: "S06", milestoneId: "M007", title: "Complete", status: "complete" });
  insertTask({ id: "T02", sliceId: "S06", milestoneId: "M007", title: "Skipped", status: "skipped" });
  insertTask({ id: "T03", sliceId: "S06", milestoneId: "M007", title: "Pending", status: "pending" });
  assert.deepEqual(
    readSliceTasks("M007", "S06").map((t) => [t.id, t.done]),
    [["T01", true], ["T02", true], ["T03", false]],
  );
});

function seedActiveProject(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Complete", status: "complete" });
  insertMilestone({ id: "M002", title: "Parked", status: "parked" });
  insertMilestone({ id: "M003", title: "Discarded", status: "skipped" });
  insertMilestone({ id: "M004", title: "Active", status: "active", depends_on: ["M001"] });
  insertSlice({ id: "S01", milestoneId: "M004", title: "Complete", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M004", title: "Skipped", status: "skipped", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M004", title: "Next", status: "pending", depends: ["S02"], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M004", title: "Waiting", status: "pending", depends: ["S03"], sequence: 4 });
  insertTask({ id: "T01", sliceId: "S03", milestoneId: "M004", title: "Complete", status: "complete" });
  insertTask({ id: "T02", sliceId: "S03", milestoneId: "M004", title: "Pending", status: "pending" });
  invalidateStateCache();
  return base;
}

test("the status answer for one milestone carries each slice status and its task counts", () => {
  seedActiveProject();

  const status = readMilestoneStatus("M004");
  assert.ok(status);
  assert.equal(status.milestone.id, "M004");
  assert.equal(status.milestone.status, "active");
  assert.deepEqual(status.milestone.depends_on, ["M001"]);
  assert.deepEqual(status.slices, [
    { id: "S01", status: "complete", taskCounts: { total: 0, done: 0, pending: 0 } },
    { id: "S02", status: "skipped", taskCounts: { total: 0, done: 0, pending: 0 } },
    { id: "S03", status: "pending", taskCounts: { total: 2, done: 1, pending: 1 } },
    { id: "S04", status: "pending", taskCounts: { total: 0, done: 0, pending: 0 } },
  ]);
  assert.equal(readMilestoneStatus("M999"), null);
});

test("deriveState and the dispatch guard select the work the read interface reports as open and unblocked", async () => {
  const base = seedActiveProject();

  const milestones = readMilestones().filter((m) => !m.discarded);
  const doneMilestones = new Set(milestones.filter((m) => m.done).map((m) => m.id));
  const openMilestone = milestones.find((m) => !m.done && !m.parked && m.depends_on.every((dep) => doneMilestones.has(dep)));
  const slices = readMilestoneSlices("M004");
  const doneSlices = new Set(slices.filter((s) => s.done).map((s) => s.id));
  const openSlice = slices.find((s) => !s.done && s.depends.every((dep) => doneSlices.has(dep)));
  const openTask = readSliceTasks("M004", "S03").find((t) => !t.done);
  assert.deepEqual([openMilestone?.id, openSlice?.id, openTask?.id], ["M004", "S03", "T02"]);

  const state = await deriveState(base);
  assert.deepEqual(
    [state.activeMilestone?.id, state.activeSlice?.id, state.activeTask?.id],
    [openMilestone?.id, openSlice?.id, openTask?.id],
  );
  assert.deepEqual(
    state.registry.map((entry) => [entry.id, entry.status]),
    [["M001", "complete"], ["M002", "parked"], ["M004", "active"]],
  );
  assert.deepEqual(state.progress, {
    milestones: { done: 1, total: 3 },
    slices: { done: 2, total: 4 },
    tasks: { done: 1, total: 2 },
  });

  assert.equal(getPriorSliceCompletionBlocker(base, "main", "execute-task", "M004/S03/T02"), null);
  assert.match(
    getPriorSliceCompletionBlocker(base, "main", "execute-task", "M004/S04/T01") ?? "",
    /dependency slice M004\/S03 is not complete/,
  );
});

test("progress and the project snapshot report the same counts as the read interface", async () => {
  const base = seedActiveProject();

  const counts = readProgressCounts();
  assert.deepEqual(counts, {
    milestones: { total: 4, done: 2, active: 1, pending: 0, parked: 1 },
    slices: { total: 4, done: 2, active: 0, pending: 2 },
    tasks: { total: 2, done: 1, pending: 1 },
  });

  const progress = await readProgressFromDb(base);
  assert.ok(progress);
  assert.deepEqual(
    { milestones: progress.milestones, slices: progress.slices, tasks: progress.tasks },
    counts,
  );

  const snapshot = await readProjectSnapshotFromDb(base);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.progress, counts);
  assert.deepEqual(
    snapshot.milestones.items.map((m) => [m.id, m.status]),
    readMilestones().map((m) => [m.id, m.status]),
  );
});
