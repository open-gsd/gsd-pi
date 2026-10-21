import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase, _getAdapter } from "../gsd-db.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { PAUSED_SESSION_KV_KEY, type PausedSessionMetadata } from "../interrupted-session.ts";
import { findPauseLifecycleId, openPauseBlockerForSession, resolveAutoPauseBlockerById } from "../pause-blocker-domain-operation.ts";

// A synthetic internal-user fixture models the domain caller after genuine
// terminal confirmation. This is not MCP provenance or evidence of a real user
// decision; command transport/confirmation boundaries are tested separately.
function syntheticOperatorInvocation(key: string) {
  return { ...internalExecutionInvocation(key), actorType: "user" as const };
}

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-pause-blocker-"));
  openDatabase(join(dir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.pause-blocker.seed",
    idempotencyKey: "test/pause-blocker/seed",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    for (const unit of [
      { itemKind: "milestone" as const, milestoneId: "M001", lifecycleStatus: "ready" as const },
      { itemKind: "slice" as const, milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" as const },
      { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "ready" as const },
    ]) adoptOrTransitionLifecycle(context, unit);
    return {
      events: [{ eventType: "test.pause-blocker.seeded", entityType: "project", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/pause-blocker/seed", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return dir;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

test("pause lifecycle lookup requires exact canonical unit type and identity", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const cases = [
    { unitType: "execute-task", unitId: "M001/S01/T01", expected: "task" },
    { unitType: "replan-task", unitId: "M001/S01/T01", expected: "task" },
    { unitType: "discuss-slice", unitId: "M001/S01", expected: "slice" },
    { unitType: "run-uat", unitId: "M001/S01", expected: "slice" },
    { unitType: "reassess-roadmap", unitId: "M001/S01", expected: "slice" },
    { unitType: "rewrite-docs", unitId: "M001/S01", expected: "slice" },
    { unitType: "plan-milestone", unitId: "M001", expected: "milestone" },
    { unitType: "validate-milestone", unitId: "M001", expected: "milestone" },
    { unitType: "rewrite-docs", unitId: "M001", expected: "milestone" },
  ];
  for (const item of cases) {
    const id = findPauseLifecycleId({ milestoneId: "M001", ...item });
    assert.equal(id, db().prepare(
      "SELECT lifecycle_id FROM workflow_item_lifecycles WHERE item_kind = :kind",
    ).get({ ":kind": item.expected })?.["lifecycle_id"]);
  }
  for (const item of [
    { unitType: "plan-slice", unitId: "M001/S99" },
    { unitType: "plan-milestone", unitId: "M001/S01" },
    { unitType: "execute-task", unitId: "M001/S01" },
    { unitType: "research-slice", unitId: "M001/parallel-research" },
    { unitType: "plan-slice", unitId: "M002/S01" },
    { unitType: "unknown", unitId: "M001" },
  ]) {
    assert.equal(findPauseLifecycleId({ milestoneId: "M001", ...item }), null);
  }
});

test("slice-prefixed task IDs create and resolve an exact task blocker", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  insertTask({ id: "S01-T02", sliceId: "S01", milestoneId: "M001", title: "Prefixed task", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.pause-blocker.prefixed-task",
    idempotencyKey: "test/pause-blocker/prefixed-task",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "S01-T02", lifecycleStatus: "ready",
    });
    return {
      events: [{ eventType: "test.pause-blocker.seeded", entityType: "task", entityId: "S01-T02", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/pause-blocker/prefixed-task", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  const pause = { pauseId: "prefixed-task-pause", milestoneId: "M001", unitType: "execute-task", unitId: "M001/S01/S01-T02" };
  for (const unitType of ["execute-task", "replan-task"]) {
    assert.ok(findPauseLifecycleId({ ...pause, unitType }));
  }
  assert.equal(findPauseLifecycleId({ ...pause, unitId: "M001/S01/S02-T02" }), null);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const blockerId = openPauseBlockerForSession({
    pause, blockerKind: "consent", description: "Approval required", requestedAction: "Review",
  });
  assert.ok(blockerId);
  assert.equal(db().prepare(
    "SELECT lifecycle_id FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["lifecycle_id"], findPauseLifecycleId(pause));
  const currentFence = readDomainOperationFence();
  assert.deepEqual(resolveAutoPauseBlockerById({
    blockerId,
    rationale: "Approved",
    invocation: syntheticOperatorInvocation("test/pause-blocker/prefixed-resolve"),
    expectedRevision: currentFence.revision,
    expectedAuthorityEpoch: currentFence.authorityEpoch,
  }), { resolved: true });
  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
});

test("human pause blocker is linked durably and resolves clear-only with stable replay", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const pause: PausedSessionMetadata & { pauseId: string } = {
    pauseId: "pause-id-1",
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
    pausedAt: "2026-10-19T09:00:00.000Z",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const blockerId = openPauseBlockerForSession({
    pause,
    blockerKind: "subjective_uat",
    description: "Waiting for human validation",
    requestedAction: "Run /gsd auto after resolving the blocker.",
  });
  assert.ok(blockerId);
  assert.equal(getRuntimeKv<PausedSessionMetadata>("global", "", PAUSED_SESSION_KV_KEY)?.pauseBlockerId, blockerId);
  const association = db().prepare(
    "SELECT lifecycle_id, unit_type, unit_id FROM auto_pause_blocker_links WHERE blocker_id = :id",
  ).get({ ":id": blockerId });
  assert.equal(association?.["unit_type"], "plan-slice");
  assert.equal(association?.["unit_id"], "M001/S01");

  const fence = readDomainOperationFence();
  const input = {
    blockerId,
    rationale: "Human validation completed",
    invocation: syntheticOperatorInvocation("test/pause-blocker/resolve"),
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
  };
  const first = resolveAutoPauseBlockerById(input);
  assert.deepEqual(first, { resolved: true });
  assert.deepEqual(resolveAutoPauseBlockerById(input), first);
  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
  assert.equal(db().prepare(
    "SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["blocker_status"], "resolved");
  assert.equal(db().prepare(
    "SELECT resolved_at FROM auto_pause_blocker_links WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["resolved_at"] !== null, true);
});

test("pause blocker resolution refuses mismatched persisted pause identity without mutation", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const pause: PausedSessionMetadata & { pauseId: string } = {
    pauseId: "pause-id-2",
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const blockerId = openPauseBlockerForSession({
    pause,
    blockerKind: "ambiguous_intent",
    description: "Need clarification",
    requestedAction: "Run /gsd auto after resolving the blocker.",
  });
  assert.ok(blockerId);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, { ...pause, pauseBlockerId: blockerId, unitId: "M001/S99" });
  const fence = readDomainOperationFence();
  const result = resolveAutoPauseBlockerById({
    blockerId,
    rationale: "Resolved",
    invocation: syntheticOperatorInvocation("test/pause-blocker/mismatch"),
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
  });
  assert.deepEqual(result, { resolved: false, failure: "association-mismatch" });
  assert.equal(db().prepare(
    "SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["blocker_status"], "open");
});

test("legacy pause resolution refuses a persisted blocker-kind mismatch without mutation", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const pause: PausedSessionMetadata & { pauseId: string } = {
    pauseId: "pause-kind-mismatch",
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const blockerId = openPauseBlockerForSession({
    pause,
    blockerKind: "subjective_uat",
    description: "Human review",
    requestedAction: "Review",
  });
  assert.ok(blockerId);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    ...pause,
    pauseBlockerId: blockerId,
    blockerKind: "machine_fixable",
  });

  const fence = readDomainOperationFence();
  const result = resolveAutoPauseBlockerById({
    blockerId,
    rationale: "Clear mismatched kind",
    invocation: syntheticOperatorInvocation("test/pause-blocker/legacy-kind-mismatch"),
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
  });

  assert.deepEqual(result, { resolved: false, failure: "association-mismatch" });
  assert.equal(getRuntimeKv<PausedSessionMetadata>("global", "", PAUSED_SESSION_KV_KEY)?.pauseBlockerId, blockerId);
  assert.equal(db().prepare(
    "SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["blocker_status"], "open");
});

test("legacy pause resolution refuses external-owned blockers without clearing the pause", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const pause: PausedSessionMetadata & { pauseId: string } = {
    pauseId: "pause-external-owner",
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
    blockerKind: "external_dependency",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const blockerId = openPauseBlockerForSession({
    pause,
    blockerKind: "external_dependency",
    description: "External dependency",
    requestedAction: "Wait for dependency",
  });
  assert.ok(blockerId);

  const fence = readDomainOperationFence();
  const result = resolveAutoPauseBlockerById({
    blockerId,
    rationale: "Clear external blocker",
    invocation: syntheticOperatorInvocation("test/pause-blocker/legacy-external-owner"),
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
  });

  // Authorization rejects a foreign owner before association/receipt handling.
  assert.deepEqual(result, { resolved: false, failure: "owner-mismatch" });
  assert.equal(getRuntimeKv<PausedSessionMetadata>("global", "", PAUSED_SESSION_KV_KEY)?.pauseBlockerId, blockerId);
  assert.equal(db().prepare(
    "SELECT blocker_status, resolution_owner FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["blocker_status"], "open");
  assert.equal(db().prepare(
    "SELECT resolution_owner FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": blockerId })?.["resolution_owner"], "external");
});

test("existing exact human blocker is not reused for a distinct pause", (t) => {
  const dir = createProject();
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const lifecycleId = findPauseLifecycleId({
    milestoneId: "M001",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  });
  assert.ok(lifecycleId);
  const fence = readDomainOperationFence();
  const existingBlockerId = "existing-human-review-blocker";
  executeDomainOperation({
    operationType: "test.pause-blocker.existing",
    idempotencyKey: "test/pause-blocker/existing",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { blockerId: existingBlockerId },
  }, (context) => {
    db().prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, requested_action, resolution, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES (
        :blocker_id, :project_id, :lifecycle_id, 'subjective_uat', 'user',
        'open', 'Review required', 'Review the output', '', :opened_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":blocker_id": existingBlockerId,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
      ":opened_at": "2026-10-19T09:00:00.000Z",
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    return {
      events: [{ eventType: "test.pause-blocker.existing", entityType: "blocker", entityId: existingBlockerId, payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/pause-blocker/existing", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  const pause: PausedSessionMetadata & { pauseId: string } = {
    pauseId: "existing-pause-id",
    milestoneId: "M001",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pause);
  const pauseBlockerId = openPauseBlockerForSession({
    pause,
    blockerKind: "subjective_uat",
    description: "Review required",
    requestedAction: "Review the output",
  });
  assert.ok(pauseBlockerId);
  assert.notEqual(pauseBlockerId, existingBlockerId);
  assert.equal(db().prepare(
    "SELECT COUNT(*) AS count FROM workflow_blockers WHERE lifecycle_id = :lifecycle_id",
  ).get({ ":lifecycle_id": lifecycleId })?.["count"], 2);
  assert.equal(db().prepare(
    "SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id",
  ).get({ ":id": existingBlockerId })?.["blocker_status"], "open");
});
