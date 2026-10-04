// Project/App: gsd-pi
// File Purpose: The typed workflow command (RPC `workflow_command`) runs one Domain Operation per idempotency key and honors the expected revision.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { _getAdapter, getAllMilestones, getMilestone, getProjectAuthorityVersion, insertMilestone } from "../gsd-db.ts";
import { runWorkflowCommand } from "../workflow-command.ts";
import { createWorkflowAuthorityFixture, type WorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

// Fixture rows: M001 active.
let fixture: WorkflowAuthorityFixture;

beforeEach(async () => {
  fixture = await createWorkflowAuthorityFixture();
});

afterEach(() => fixture.cleanup());

function operations(operationType: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(
    "SELECT idempotency_key, source_transport, actor_type, expected_revision FROM workflow_operations WHERE operation_type = :type",
  ).all({ ":type": operationType });
}

function park(overrides: Record<string, unknown> = {}) {
  return runWorkflowCommand({
    cwd: fixture.root,
    name: "milestone_park",
    args: { milestoneId: "M001", reason: "waiting for a decision" },
    idempotencyKey: "user-action-1",
    ...overrides,
  });
}

test("a park command sent twice with the same idempotency key gives one operation", async () => {
  const expectedRevision = getProjectAuthorityVersion().revision;

  const first = await park({ expectedRevision });
  const second = await park({ expectedRevision });

  assert.equal(first.ok, true, first.message);
  assert.deepEqual(second, first, "the second send returns the result of the first");
  assert.equal(first.revision, expectedRevision + 1);
  assert.equal(getMilestone("M001")?.status, "parked");
  assert.deepEqual(operations("milestone.park").map((row) => ({ ...row })), [{
    idempotency_key: "rpc:milestone_park:user-action-1",
    source_transport: "internal",
    actor_type: "operator",
    expected_revision: expectedRevision,
  }]);
});

test("a retry that sends the revision it read after the first send replays the first result", async () => {
  const expectedRevision = getProjectAuthorityVersion().revision;

  const first = await park({ expectedRevision });
  const second = await park({ expectedRevision: first.revision });

  assert.equal(first.ok, true, first.message);
  assert.deepEqual(second, first, "the second send returns the result of the first");
  assert.equal(getMilestone("M001")?.status, "parked");
  assert.deepEqual(operations("milestone.park").map((row) => row["expected_revision"]), [expectedRevision]);
});

test("a command with a stale expected revision is refused and changes nothing", async () => {
  const revision = getProjectAuthorityVersion().revision;

  const result = await park({ expectedRevision: revision - 1 });

  assert.equal(result.ok, false);
  assert.match(result.message, /stale project revision/);
  assert.equal(result.revision, revision);
  assert.equal(getMilestone("M001")?.status, "active");
  assert.deepEqual(operations("milestone.park"), []);
});

test("unpark is a separate command with its own key", async () => {
  await park();

  const result = await runWorkflowCommand({
    cwd: fixture.root,
    name: "milestone_unpark",
    args: { milestoneId: "M001" },
    idempotencyKey: "user-action-2",
  });

  assert.equal(result.ok, true, result.message);
  assert.notEqual(getMilestone("M001")?.status, "parked");
  assert.equal(operations("milestone.unpark").length, 1);
});

/** The queue order of the database: open milestones by sequence. */
function queueOrder(): string[] {
  return getAllMilestones()
    .filter((milestone) => (milestone.sequence ?? 0) > 0)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((milestone) => milestone.id);
}

function reorder(overrides: Record<string, unknown> = {}) {
  return runWorkflowCommand({
    cwd: fixture.root,
    name: "milestone_reorder",
    args: { order: ["M002", "M001"] },
    idempotencyKey: "user-action-3",
    ...overrides,
  });
}

test("a reorder command sent twice with the same idempotency key gives one operation", async () => {
  insertMilestone({ id: "M002", title: "Second", status: "queued" });
  const expectedRevision = getProjectAuthorityVersion().revision;

  const first = await reorder({ expectedRevision });
  const second = await reorder({ expectedRevision: first.revision });

  assert.equal(first.ok, true, first.message);
  assert.deepEqual(second, first, "the second send returns the result of the first");
  assert.deepEqual(queueOrder(), ["M002", "M001"]);
  assert.deepEqual(operations("milestone.reorder").map((row) => ({ ...row })), [{
    idempotency_key: "rpc:milestone_reorder:user-action-3",
    source_transport: "internal",
    actor_type: "operator",
    expected_revision: expectedRevision,
  }]);
});

test("reorder, set-dependencies and discard refuse a stale expected revision and change nothing", async () => {
  insertMilestone({ id: "M002", title: "Second", status: "queued" });
  const revision = getProjectAuthorityVersion().revision;
  const orderBefore = queueOrder();
  const stale = { cwd: fixture.root, idempotencyKey: "user-action-4", expectedRevision: revision - 1 };

  const results = [
    await runWorkflowCommand({ ...stale, name: "milestone_reorder", args: { order: ["M002", "M001"] } }),
    await runWorkflowCommand({
      ...stale,
      name: "milestone_set_dependencies",
      args: { milestoneId: "M002", dependsOn: ["M001"] },
    }),
    await runWorkflowCommand({
      ...stale,
      name: "milestone_discard",
      args: { milestoneId: "M002", reason: "no longer needed" },
    }),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    assert.match(result.message, /stale project revision/);
    assert.equal(result.revision, revision);
  }
  assert.deepEqual(queueOrder(), orderBefore);
  assert.deepEqual(getMilestone("M002")?.depends_on, []);
  assert.equal(getMilestone("M002")?.status, "queued");
  for (const type of ["milestone.reorder", "milestone.set_dependencies", "milestone.discard"]) {
    assert.deepEqual(operations(type), [], type);
  }
});

test("set-dependencies and discard run through the typed command with the current revision", async () => {
  insertMilestone({ id: "M002", title: "Second", status: "queued" });

  const dependencies = await runWorkflowCommand({
    cwd: fixture.root,
    name: "milestone_set_dependencies",
    args: { milestoneId: "M002", dependsOn: ["M001"] },
    idempotencyKey: "user-action-5",
    expectedRevision: getProjectAuthorityVersion().revision,
  });
  assert.equal(dependencies.ok, true, dependencies.message);
  assert.deepEqual(getMilestone("M002")?.depends_on, ["M001"]);

  const discard = await runWorkflowCommand({
    cwd: fixture.root,
    name: "milestone_discard",
    args: { milestoneId: "M002", reason: "no longer needed" },
    idempotencyKey: "user-action-6",
    expectedRevision: dependencies.revision,
  });
  assert.equal(discard.ok, true, discard.message);
  assert.equal(operations("milestone.set_dependencies").length, 1);
  assert.deepEqual(operations("milestone.discard").map((row) => row["idempotency_key"]), [
    "rpc:milestone_discard:user-action-6",
  ]);
  // The host command is an operator action, so the user grants the Waiver.
  assert.deepEqual(_getAdapter()!.prepare(
    "SELECT granted_by_actor_type, granted_by_actor_id FROM workflow_waivers WHERE scope = 'milestone:M002'",
  ).all().map((row) => ({ ...row })), [{
    granted_by_actor_type: "user",
    granted_by_actor_id: "gsd-cli-operator",
  }]);
});

test("a command for a milestone that does not exist is refused with the reason", async () => {
  const result = await park({ args: { milestoneId: "M404", reason: "none" } });

  assert.equal(result.ok, false);
  assert.match(result.message, /M404 does not exist/);
});

test("a malformed command throws before any operation runs", async () => {
  await assert.rejects(park({ name: "milestone_delete_everything" }), /Unknown workflow command/);
  await assert.rejects(park({ idempotencyKey: " " }), /requires an idempotencyKey/);
  await assert.rejects(park({ expectedRevision: "3" }), /expectedRevision must be an integer/);
  await assert.rejects(park({ args: { milestoneId: "M001" } }), /requires args\.reason/);
  await assert.rejects(park({ cwd: undefined }), /requires a session CWD/);
  await assert.rejects(reorder({ args: { order: "M001" } }), /requires args\.order as a list/);
  await assert.rejects(reorder({ args: { order: ["M001", 2] } }), /requires args\.order as a list/);
  assert.deepEqual(operations("milestone.park"), []);
});
