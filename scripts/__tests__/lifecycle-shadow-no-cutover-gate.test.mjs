// Project/App: gsd-pi
// File Purpose: Tests that the no-cutover gate pins the read interface to legacy rows.

import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLifecycleShadowSources } from "../lifecycle-shadow-no-cutover-gate.mjs";

// A read interface with the shape of db/lifecycle-read.ts: the Slice mapper is
// passed to `.map()` and is never called directly.
function readInterfaceSource({ extraImport = "", sliceDone = "isInactiveStatus(row.status)" } = {}) {
  return `
import {
  getAllMilestones,
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestone,
  getMilestoneSlices,
  getMilestoneStatusCounts,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getSliceTasks,
  getSlicesByMilestoneIds,
} from "./queries.js";
import { isClosedStatus, isInactiveStatus } from "../status-guards.js";
${extraImport}

function toMilestoneRead(row) {
  return { ...row, done: isClosedStatus(row.status) };
}

function toSliceRead(row) {
  return { ...row, done: ${sliceDone} };
}

export function readMilestones() {
  return getAllMilestones().map(toMilestoneRead);
}

export function readMilestone(milestoneId) {
  const row = getMilestone(milestoneId);
  return row ? toMilestoneRead(row) : null;
}

export function readMilestoneSlices(milestoneId) {
  return getMilestoneSlices(milestoneId).map(toSliceRead);
}

export function readSlicesByMilestoneIds(milestoneIds) {
  return new Map([...getSlicesByMilestoneIds(milestoneIds)].map(([id, rows]) => [id, rows.map(toSliceRead)]));
}

export function readSliceTasks(milestoneId, sliceId) {
  return getSliceTasks(milestoneId, sliceId).map((row) => ({ ...row, done: isClosedStatus(row.status) }));
}

export function readMilestoneStatus(milestoneId) {
  return getSliceStatusSummary(milestoneId).map((slice) => getSliceTaskCounts(milestoneId, slice.id));
}

export function readProgressCounts() {
  return [getHierarchyCompletionCounts(), getInFlightSliceCount(), getMilestoneStatusCounts()];
}
`;
}

function readInterfaceCheck(read) {
  return analyzeLifecycleShadowSources({ read }).find((check) => check.id === "read-interface-legacy-authority");
}

test("read interface that answers from legacy rows passes the gate", () => {
  assert.deepEqual(readInterfaceCheck(readInterfaceSource()), {
    id: "read-interface-legacy-authority",
    verdict: "pass",
    error: null,
  });
});

test("canonical lifecycle call in the Slice mapper fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({
    extraImport: 'import { getSliceLifecycleShadowSnapshot } from "./lifecycle-shadow.js";',
    sliceDone: "getSliceLifecycleShadowSnapshot(row.milestone_id, row.id) !== null",
  }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /calls canonical lifecycle binding getSliceLifecycleShadowSnapshot/);
});

test("canonical lifecycle SQL in the Slice mapper fails the gate", () => {
  const check = readInterfaceCheck(readInterfaceSource({
    sliceDone: 'db.prepare("SELECT 1 FROM workflow_item_lifecycles WHERE item_id = ?").get(row.id) !== undefined',
  }));
  assert.equal(check.verdict, "fail");
  assert.match(check.error, /queries canonical lifecycle rows/);
});
