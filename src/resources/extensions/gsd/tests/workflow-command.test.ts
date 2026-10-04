// Project/App: gsd-pi
// File Purpose: The typed workflow command (RPC `workflow_command`) runs one Domain Operation per idempotency key and honors the expected revision.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { _getAdapter, getMilestone, getProjectAuthorityVersion } from "../gsd-db.ts";
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
  assert.deepEqual(operations("milestone.park"), []);
});
