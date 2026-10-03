// Project/App: gsd-pi
// File Purpose: New milestone rows are written only by the milestone.register Domain Operation; id generation is one executor for every transport.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { piExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getMilestone,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { countUnadoptedHierarchyRows } from "../lifecycle-backfill-domain-operation.ts";
import { discardMilestone, parkMilestone, unparkMilestone } from "../milestone-actions.ts";
import { clearReservedMilestoneIds, reserveMilestoneId } from "../milestone-ids.ts";
import { registerMilestones } from "../milestone-registration.ts";
import { clearPathCache } from "../paths.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { executeMilestoneGenerateId, executeSummarySave } from "../tools/workflow-tool-executors.ts";
import { fenceWorkflowWrites } from "./db-authority-gate.ts";

function scalar(sql: string): unknown {
  return Object.values(_getAdapter()!.prepare(sql).get() ?? {})[0];
}

function revision(): number {
  return Number(scalar("SELECT revision FROM project_authority WHERE singleton = 1"));
}

function registerOperations(): number {
  return Number(scalar("SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'milestone.register'"));
}

function registeredEvents(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`
    SELECT entity_id AS id,
           json_extract(payload_json, '$.source') AS source,
           json_extract(payload_json, '$.created') AS created
    FROM workflow_domain_events WHERE event_type = 'milestone.registered'
    ORDER BY project_revision, event_index
  `).all().map((event) => ({ ...event }));
}

/** The milestone lifecycle row and the type of the operation that last wrote it. */
function milestoneLifecycle(milestoneId: string): Record<string, unknown> | undefined {
  const row = _getAdapter()!.prepare(`
    SELECT lifecycle.lifecycle_status AS status, lifecycle.state_version AS version,
           operation.operation_type AS writer
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_operations operation ON operation.operation_id = lifecycle.last_operation_id
    WHERE lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = :milestone_id
  `).get({ ":milestone_id": milestoneId });
  return row ? { ...row } : undefined;
}

function generateId(base: string, callId: string) {
  return executeMilestoneGenerateId(base, piExecutionInvocation("gsd_milestone_generate_id", callId));
}

describe("milestone registration", () => {
  let base: string;

  beforeEach(() => {
    // The resolved path, so the tool does not reopen the database under another name.
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-milestone-registration-")));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.ok(openDatabase(join(base, ".gsd", "gsd.db")), "database opens");
    clearReservedMilestoneIds();
    clearPathCache();
    invalidateStateCache();
  });

  afterEach(() => {
    clearReservedMilestoneIds();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  test("generate id registers the row in one operation and writes no workflow table outside it", async () => {
    const revisionBefore = revision();
    const fence = fenceWorkflowWrites();

    const result = await generateId(base, "call-1");
    fence.restore();

    assert.ok(!result.isError, result.content[0]!.text);
    assert.equal(result.content[0]!.text, "M001");
    assert.deepEqual(fence.violations, [], "the milestone row is written inside the Domain Operation");
    assert.equal(getMilestone("M001")?.status, "queued");
    assert.equal(revision(), revisionBefore + 1);
    assert.deepEqual(
      { ..._getAdapter()!.prepare(`
        SELECT operation_type, idempotency_key, source_transport FROM workflow_operations
      `).get() },
      {
        operation_type: "milestone.register",
        idempotency_key: "pi:gsd_milestone_generate_id:call-1",
        source_transport: "pi-tool",
      },
    );
    assert.deepEqual(registeredEvents(), [{ id: "M001", source: "generate-id", created: 1 }]);
    assert.match(readFileSync(join(base, ".gsd", "STATE.md"), "utf-8"), /M001/, "STATE.md is rendered with the new milestone");
  });

  test("a retry of the same generate-id call returns the same id and writes nothing; a new call gets the next id", async () => {
    const first = await generateId(base, "call-1");
    const revisionAfterFirst = revision();

    const retry = await generateId(base, "call-1");

    assert.equal(retry.content[0]!.text, first.content[0]!.text);
    assert.equal(revision(), revisionAfterFirst, "the retry commits no operation");
    assert.deepEqual(getAllMilestones().map((milestone) => milestone.id), ["M001"]);

    const next = await generateId(base, "call-2");
    assert.equal(next.content[0]!.text, "M002");
    assert.equal(registerOperations(), 2);
  });

  test("generate id counts database rows that have no directory and claims the id a preview reserved", async () => {
    insertMilestone({ id: "M007", title: "Database only", status: "queued" });
    assert.equal((await generateId(base, "after-db-row")).content[0]!.text, "M008");

    reserveMilestoneId("M020");
    assert.equal((await generateId(base, "reserved")).content[0]!.text, "M020");
    assert.equal(getMilestone("M020")?.status, "queued");
    assert.equal((await generateId(base, "after-reserved")).content[0]!.text, "M021");
  });

  test("a command registration writes one operation for new rows and nothing when the rows exist", () => {
    assert.deepEqual(registerMilestones([{ id: "M001", title: "First" }, { id: "M002", title: "Second" }], "test"), ["M001", "M002"]);
    assert.equal(registerOperations(), 1, "both rows are written by one operation");
    assert.equal(getMilestone("M002")?.title, "Second");

    const revisionBefore = revision();
    assert.deepEqual(registerMilestones([{ id: "M001", title: "Other title" }], "test"), []);
    assert.equal(revision(), revisionBefore, "an existing row is not written again");
    assert.equal(getMilestone("M001")?.title, "First", "an existing row keeps its title without retitle");

    assert.deepEqual(registerMilestones([{ id: "M001", title: "Other title", retitle: true }], "test"), []);
    assert.equal(revision(), revisionBefore + 1, "a retitle is one operation");
    assert.equal(getMilestone("M001")?.title, "Other title");
  });

  test("registration adopts each new milestone as ready in the register operation, so no row is left for the backfill", async () => {
    registerMilestones([{ id: "M001", title: "First" }, { id: "M002" }], "test");
    await generateId(base, "call-1");

    for (const id of ["M001", "M002", "M003"]) {
      assert.deepEqual(
        milestoneLifecycle(id),
        { status: "ready", version: 0, writer: "milestone.register" },
        `${id} gets its lifecycle row from the operation that registered it`,
      );
      assert.equal(getMilestone(id)?.status, "queued");
    }
    assert.equal(countUnadoptedHierarchyRows(), 0);
    assert.equal(registerOperations(), 2, "adoption adds no operation of its own");
  });

  test("a registered milestone with no plan and no directory parks, unparks and discards by lifecycle transitions", async () => {
    registerMilestones([{ id: "M001", title: "First" }, { id: "M002", title: "Second" }], "test");

    assert.equal(await parkMilestone(base, "M001", "later"), true);
    assert.deepEqual(milestoneLifecycle("M001"), { status: "paused", version: 1, writer: "milestone.park" });
    assert.equal(getMilestone("M001")?.status, "parked");

    assert.equal(await unparkMilestone(base, "M001"), true);
    assert.deepEqual(milestoneLifecycle("M001"), { status: "in_progress", version: 2, writer: "milestone.unpark" });

    assert.equal(await discardMilestone(base, "M002", { reason: "not needed" }), true);
    assert.deepEqual(milestoneLifecycle("M002"), { status: "cancelled", version: 1, writer: "milestone.discard" });
    assert.equal(getMilestone("M002")?.status, "skipped");
  });

  test("gsd_summary_save(PROJECT) registers the sequence in one milestone.register operation and a second save adds none", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));
    const content = [
      "# Project",
      "",
      "## Milestone Sequence",
      "",
      "- [ ] M001: Foo — bar",
      "- [x] M002: Baz — qux",
      "",
    ].join("\n");

    const first = await executeSummarySave({ artifact_type: "PROJECT", content }, base);

    assert.ok(!first.isError, first.content[0]!.text);
    assert.equal(registerOperations(), 1);
    assert.deepEqual(registeredEvents(), [
      { id: "M001", source: "project-sequence", created: 1 },
      { id: "M002", source: "project-sequence", created: 1 },
    ]);
    assert.equal(getMilestone("M002")?.status, "queued", "a checked box registers an open milestone");

    const second = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!second.isError, second.content[0]!.text);
    assert.equal(registerOperations(), 1, "an unchanged sequence registers nothing");
  });

  test("a PROJECT save that repairs a checked box keeps a new milestone line, and the new milestone becomes active", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));
    const firstContent = ["# Project", "", "## Milestone Sequence", "", "- [x] M001: Legacy — done before", ""].join("\n");
    const first = await executeSummarySave({ artifact_type: "PROJECT", content: firstContent }, base);
    assert.ok(!first.isError, first.content[0]!.text);

    const second = await executeSummarySave({
      artifact_type: "PROJECT",
      content: `${firstContent}- [ ] M002: New — thing\n`,
    }, base);

    assert.ok(!second.isError, second.content[0]!.text);
    const sequence = [
      "- [ ] M001: Legacy — done before",
      "- [ ] M002: New — thing",
    ].join("\n");
    assert.ok(readFileSync(join(base, ".gsd", "PROJECT.md"), "utf-8").includes(sequence), "PROJECT.md keeps the new line");
    assert.ok(
      String(scalar("SELECT full_content FROM artifacts WHERE path = 'PROJECT.md'")).includes(sequence),
      "the PROJECT artifact row keeps the new line",
    );

    assert.equal(await discardMilestone(base, "M001", { reason: "superseded" }), true);
    invalidateStateCache();
    assert.equal((await deriveState(base)).activeMilestone?.id, "M002");
  });
});
