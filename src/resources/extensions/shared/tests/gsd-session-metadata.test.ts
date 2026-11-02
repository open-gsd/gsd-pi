import assert from "node:assert/strict";
import test from "node:test";
import {
  GSD_DELEGATION_CONTEXT, GSD_WORKFLOW_CONTEXT,
  readWorkflowContext, readDelegationContext, recordWorkflowContext, recordDelegation,
} from "../gsd-session-metadata.ts";

const id = "32fd3341-a765-46af-ae2d-2f82051749a0";
const delegation = { id, mode: "parallel" as const, count: 3, forkCount: 1, background: true };

test("workflow provenance accepts only canonical hierarchical identifiers", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = { appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); } };
  for (const unitId of ["M001", "M002-ab12cd/S01", "M003/S02/T03"]) {
    recordWorkflowContext(pi, () => id, unitId);
  }
  assert.deepEqual(entries.map(entry => entry.type), Array(3).fill(GSD_WORKFLOW_CONTEXT));
  assert.deepEqual(entries[2].data, { version: 1, originSessionId: id, milestoneId: "M003", sliceId: "S02", taskId: "T03" });
  for (const unitId of ["project", "M001/private-task-title", "M001/S01/T01/private", "M001/", "secret issue"]) {
    recordWorkflowContext(pi, () => id, unitId);
  }
  assert.equal(entries.length, 3);
  assert.equal(readWorkflowContext({ version: 1, originSessionId: id, milestoneId: "M001", taskId: "T01" }), undefined);
})

test("metadata readers copy approved primitives without reading arbitrary payload fields", () => {
  const data = {
    version: 1, originSessionId: id, ...delegation, status: "settled", successCount: 1, failureCount: 1,
    get task(): never { throw new Error("private task must not be read"); },
    get result(): never { throw new Error("private result must not be read"); },
  };
  assert.deepEqual(readDelegationContext(data), {
    originSessionId: id, ...delegation, status: "settled", successCount: 1, failureCount: 1,
  });
  assert.deepEqual(readWorkflowContext({
    version: 1, originSessionId: id, milestoneId: "M001",
    get title(): never { throw new Error("private title must not be read"); },
  }), { originSessionId: id, milestoneId: "M001" });
})

test("delegation provenance fences delayed completion by the current runtime session", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = { appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); } };
  let session = id;
  const finish = recordDelegation(pi, () => session, delegation);
  assert.deepEqual(entries[0], {
    type: GSD_DELEGATION_CONTEXT,
    data: { version: 1, originSessionId: id, ...delegation, status: "requested" },
  });
  finish(1, 1);
  assert.deepEqual(entries[1].data, {
    version: 1, originSessionId: id, ...delegation, status: "settled", successCount: 1, failureCount: 1,
  });
  session = "different-native-session";
  finish(3, 0);
  assert.equal(entries.length, 2, "late background workers cannot annotate the next parent conversation");
})

test("stale runtime, unavailable provenance and append failures cannot affect execution", () => {
  const pi = { appendEntry: () => { throw new Error("persistence unavailable"); } };
  assert.doesNotThrow(() => recordWorkflowContext(pi, () => id, "M001/S01/T01"));
  assert.doesNotThrow(() => recordWorkflowContext({}, () => id, "M001"));
  assert.doesNotThrow(() => recordDelegation(pi, () => id, delegation)(3, 0));
  assert.doesNotThrow(() => recordDelegation({}, () => { throw new Error("disposed"); }, delegation)(1, 0));
})

test("invalid delegation IDs, enums, versions and counters fail closed", () => {
  const valid = { version: 1, originSessionId: id, ...delegation, status: "requested" };
  assert.ok(readDelegationContext(valid));
  for (const patch of [
    { version: 2 }, { originSessionId: "" }, { id: "private-name" }, { mode: "unknown" },
    { count: 0 }, { count: 1025 }, { count: Infinity }, { count: 1.5 },
    { forkCount: -1 }, { forkCount: 4 }, { background: "true" }, { status: "running" },
    { status: "settled" }, { status: "settled", successCount: 2, failureCount: 2 },
    { status: "settled", successCount: 1, failureCount: -1 },
  ]) {
    assert.equal(readDelegationContext({ ...valid, ...patch }), undefined, JSON.stringify(patch));
  }
})
