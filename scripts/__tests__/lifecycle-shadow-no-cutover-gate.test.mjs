// Project/App: gsd-pi
// File Purpose: Tests that the gate requires the read interface to choose its
// read source from the Authority Epoch and to read canonical lifecycle rows.

import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLifecycleShadowSources } from "../lifecycle-shadow-no-cutover-gate.mjs";

const LIFECYCLE_ROWS = 'getDb().prepare("SELECT lifecycle_status FROM workflow_item_lifecycles").all()';

// A read interface with the shape of db/lifecycle-read.ts: one function reads
// the Authority Epoch, and each reader answers from lifecycle rows after the
// Cutover and from the legacy readers before it.
function readInterfaceSource({
  extraImport = "",
  cutoverHasRun = "(getProjectAuthorityRow()?.authorityEpoch ?? 0) > 0",
  lifecycleRows = LIFECYCLE_ROWS,
  sliceDone = "isInactiveStatus(row.status)",
} = {}) {
  return `
import { getDb } from "./engine.js";
import {
  getAllMilestones,
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestone,
  getMilestoneSlices,
  getMilestoneStatusCounts,
  getOpenBlockers,
  getOpenQuestions,
  getProjectAuthorityRow,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getSliceTasks,
  getSlicesByMilestoneIds,
} from "./queries.js";
import { isClosedStatus, isInactiveStatus } from "../status-guards.js";
${extraImport}

function cutoverHasRun() {
  return ${cutoverHasRun};
}

function readLifecycleItems() {
  return ${lifecycleRows};
}

function toMilestoneRead(row, items) {
  return { ...row, done: items ? items.length > 0 : isClosedStatus(row.status) };
}

function toSliceRead(row, items) {
  return { ...row, done: items ? items.length > 0 : ${sliceDone} };
}

export function readMilestones() {
  const items = cutoverHasRun() ? readLifecycleItems() : null;
  return getAllMilestones().map((row) => toMilestoneRead(row, items));
}

export function readMilestone(milestoneId) {
  const row = getMilestone(milestoneId);
  return row ? toMilestoneRead(row, cutoverHasRun() ? readLifecycleItems() : null) : null;
}

export function readMilestoneDoneIn(db, milestoneId) {
  const status = db.prepare("SELECT status FROM milestones WHERE id = :id").get({ ":id": milestoneId })?.status;
  return cutoverHasRun(db) ? readLifecycleItems(db).length > 0 : isClosedStatus(status);
}

export function readMilestoneSlices(milestoneId) {
  const items = cutoverHasRun() ? readLifecycleItems() : null;
  return getMilestoneSlices(milestoneId).map((row) => toSliceRead(row, items));
}

export function readClosedSliceIds(milestoneId) {
  return readMilestoneSlices(milestoneId).filter((slice) => slice.done).map((slice) => slice.id);
}

export function readSlice(milestoneId, sliceId) {
  return readMilestoneSlices(milestoneId).find((slice) => slice.id === sliceId) ?? null;
}

export function readSlicesByMilestoneIds(milestoneIds) {
  return new Map([...getSlicesByMilestoneIds(milestoneIds)].map(([id, rows]) => [id, rows.map((row) => toSliceRead(row, null))]));
}

export function readSliceTasks(milestoneId, sliceId) {
  return getSliceTasks(milestoneId, sliceId).map((row) => ({ ...row, done: isClosedStatus(row.status) }));
}

export function readTask(milestoneId, sliceId, taskId) {
  return readSliceTasks(milestoneId, sliceId).find((task) => task.id === taskId) ?? null;
}

export function readMilestoneStatus(milestoneId) {
  return getSliceStatusSummary(milestoneId).map((slice) => getSliceTaskCounts(milestoneId, slice.id));
}

export function readProgressCounts() {
  return [getHierarchyCompletionCounts(), getInFlightSliceCount(), getMilestoneStatusCounts()];
}

// The canonical blockers and questions have no legacy row: the answer is the
// same at every Authority Epoch, so these never ask cutoverHasRun.
export function readOpenBlockers() {
  return getOpenBlockers();
}

export function readOpenQuestions() {
  return getOpenQuestions();
}
`;
}

function readInterfaceCheck(read) {
  return analyzeLifecycleShadowSources({ read }).find((check) => check.id === "read-interface-epoch-authority");
}

test("read interface that chooses by the Authority Epoch and reads lifecycle rows passes the gate", () => {
  assert.deepEqual(readInterfaceCheck(readInterfaceSource()), {
    id: "read-interface-epoch-authority",
    verdict: "pass",
    error: null,
  });
});

test("read interface that answers from legacy rows only fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({ lifecycleRows: "[]" }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /does not query canonical lifecycle rows/);
});

test("read interface that does not read the Authority Epoch fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({ cutoverHasRun: "true" }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /lost decision witness \.\/queries\.js#getProjectAuthorityRow/);
});

test("a second function that reads the Authority Epoch fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({
    sliceDone: "getProjectAuthorityRow() === null && isInactiveStatus(row.status)",
  }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /must choose its read source in one function; 2 functions read the Authority Epoch/);
});

test("read interface that drops a legacy reader fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource().replace("getInFlightSliceCount(), ", ""));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /lost decision witness \.\/queries\.js#getInFlightSliceCount/);
});

test("unapproved import in the Slice mapper fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({
    extraImport: 'import { getSliceLifecycleShadowSnapshot } from "./lifecycle-shadow.js";',
    sliceDone: "getSliceLifecycleShadowSnapshot(row.milestone_id, row.id) !== null",
  }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /calls unapproved imported decision binding \.\/lifecycle-shadow\.js#getSliceLifecycleShadowSnapshot/);
});

// The dispatch guard is a decision reader: it must ask the read interface and
// never query lifecycle rows itself, in any form of SQL string.
test("canonical lifecycle SQL in a template with substitutions fails a decision reader", () => {
  const dispatch = `
import { readMilestone, readMilestones, readMilestoneSlices } from "./db/lifecycle-read.js";

export function getPriorSliceCompletionBlocker(db, kind) {
  readMilestones();
  readMilestone("M001");
  readMilestoneSlices("M001");
  return db.prepare(\`SELECT 1 FROM workflow_item_lifecycles WHERE item_kind = '\${kind}'\`).get();
}
`;
  const check = analyzeLifecycleShadowSources({ dispatch }).find((entry) => entry.id === "slice-dispatch-authority");
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /queries canonical lifecycle rows/);
});
