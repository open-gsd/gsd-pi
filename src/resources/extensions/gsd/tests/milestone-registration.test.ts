// Project/App: gsd-pi
// File Purpose: New milestone rows are written only inside a Domain Operation (milestone.register, or the artifact.save of a PROJECT save); id generation is one executor for every transport.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { _setDomainOperationFaultForTest, executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.js";
import { readProjectMilestoneSequence } from "../db/writers/project-milestone-sequence.js";
import { piExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getArtifact,
  getMilestone,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { countUnadoptedHierarchyRows } from "../lifecycle-backfill-domain-operation.ts";
import { discardMilestone, parkMilestone, unparkMilestone } from "../milestone-actions.ts";
import { clearReservedMilestoneIds, reserveMilestoneId } from "../milestone-ids.ts";
import { registerMilestones } from "../milestone-registration.ts";
import { canonicalPhaseDirName, clearPathCache } from "../paths.ts";
import { piPlanningInvocation } from "../planning-invocation.ts";
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

/**
 * Insert a milestone row and adopt it with the lifecycle status its legacy
 * status maps to, as the lifecycle backfill would — the state of a row that
 * predates a given tool call.
 */
function adoptMilestoneRow(milestoneId: string, title: string, status: "complete" | "active"): void {
  insertMilestone({ id: milestoneId, title, status });
  const lifecycleStatus = status === "complete" ? "completed" : "ready";
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: `test.milestone.adopt.${milestoneId.toLowerCase()}`,
    idempotencyKey: `test:milestone-registration:adopt:${milestoneId.toLowerCase()}:${lifecycleStatus}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId, lifecycleStatus },
  }, (context) => {
    const lifecycle = adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus,
      adoptedFromStatus: lifecycleStatus,
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { lifecycleId: lifecycle.lifecycleId, lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `test/milestone/${milestoneId.toLowerCase()}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
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

  test("gsd_summary_save(PROJECT) writes the sequence rows and the artifact row in one artifact.save operation", async (t) => {
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

    const invocation = piPlanningInvocation("gsd_summary_save", "project-call");
    const revisionBefore = revision();
    const fence = fenceWorkflowWrites();

    const first = await executeSummarySave({ artifact_type: "PROJECT", content }, base, invocation);
    const revisionAfterFirst = revision();
    const replay = await executeSummarySave({ artifact_type: "PROJECT", content }, base, invocation);
    fence.restore();

    assert.ok(!first.isError, first.content[0]!.text);
    assert.deepEqual(fence.violations, [], "the milestone rows and the artifact row are written inside the Domain Operation");
    assert.equal(revisionAfterFirst, revisionBefore + 1, "the save is one operation");
    assert.deepEqual(
      { ..._getAdapter()!.prepare("SELECT operation_type, idempotency_key FROM workflow_operations").get() },
      { operation_type: "artifact.save", idempotency_key: "pi:gsd_summary_save:project-call" },
    );
    assert.deepEqual(registeredEvents(), [
      { id: "M001", source: "project-sequence", created: 1 },
    ]);
    assert.equal(getMilestone("M002"), null, "a checked box never registers a milestone (#2801)");
    assert.deepEqual(
      milestoneLifecycle("M001"),
      { status: "ready", version: 0, writer: "artifact.save" },
      "the new milestone is adopted in the same operation",
    );
    assert.equal(getArtifact("PROJECT.md")?.full_content, content);
    assert.equal(revision(), revisionAfterFirst, "the replay commits no operation");
    assert.deepEqual(replay.content, first.content, "the replay returns the result of the first call");

    const second = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!second.isError, second.content[0]!.text);
    assert.equal(registeredEvents().length, 1, "an unchanged sequence registers nothing");
    assert.equal(registerOperations(), 0, "a PROJECT save commits no separate milestone.register operation");
  });

  test("a PROJECT save whose milestone row write fails saves no artifact row", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));
    const first = "# Project\n\n## Milestone Sequence\n\n- [ ] M001: Foo — bar\n";
    assert.ok(!(await executeSummarySave({ artifact_type: "PROJECT", content: first }, base)).isError);
    const revisionBefore = revision();
    _setDomainOperationFaultForTest("after-mutation", "artifact.save");
    t.after(() => _setDomainOperationFaultForTest(null));

    const result = await executeSummarySave({
      artifact_type: "PROJECT",
      content: `${first}- [ ] M002: Baz — qux\n`,
    }, base);

    assert.equal(result.isError, true);
    assert.equal(getMilestone("M002"), null, "the milestone row is rolled back with the artifact row");
    assert.equal(getArtifact("PROJECT.md")?.full_content, first);
    assert.equal(readFileSync(join(base, ".gsd", "PROJECT.md"), "utf-8"), first, "the file keeps the stored content");
    assert.equal(revision(), revisionBefore);
  });

  test("a PROJECT save that repairs a checked box keeps a new milestone line, and the new milestone becomes active", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));
    // M001 registers from an open line; the NEXT save checks its box (as a
    // model rewrite would) and the repair re-renders it from the DB, which
    // says the milestone is not complete.
    const firstContent = ["# Project", "", "## Milestone Sequence", "", "- [ ] M001: Legacy — done before", ""].join("\n");
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

  test("a PROJECT save keeps stored titles, phase dirs, and done history; it registers only new open lines (#2801)", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));

    // The issue's starting state: complete M002/M003, active M004, each with
    // an established phase directory. M001 predates the DB — no row.
    const adopted: Array<[string, string, "complete" | "active"]> = [
      ["M002", "Billing - Invoices and Payments", "complete"],
      ["M003", "Reporting - Monthly Revenue Dashboards", "complete"],
      ["M004", "Notifications - Email and Push Delivery", "active"],
    ];
    for (const [id, title, status] of adopted) adoptMilestoneRow(id, title, status);
    const dirs = adopted.map(([id, title]) => canonicalPhaseDirName(id, title));
    for (const dir of dirs) {
      mkdirSync(join(base, ".gsd", "phases", dir), { recursive: true });
      writeFileSync(join(base, ".gsd", "phases", dir, "01-01-PLAN.md"), "# Plan\n");
    }

    // The discuss rewrite from the issue: short titles, checked history, one
    // genuinely new open milestone.
    const content = [
      "# Project",
      "",
      "## Milestone Sequence",
      "",
      "- [x] M001: Foundation — app shell, auth and settings.",
      "- [x] M002: Billing — invoices and payments.",
      "- [x] M003: Reporting — monthly revenue dashboards.",
      "- [ ] M004: Notifications — email and push delivery.",
      "- [ ] M005: Search — full-text search.",
      "",
    ].join("\n");

    const result = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!result.isError, result.content[0]!.text);

    // Existing rows keep their stored titles — complete ones included.
    assert.equal(getMilestone("M002")?.title, "Billing - Invoices and Payments", "a complete row keeps its stored title");
    assert.equal(getMilestone("M003")?.title, "Reporting - Monthly Revenue Dashboards");
    assert.equal(getMilestone("M004")?.title, "Notifications - Email and Push Delivery");
    assert.equal(getMilestone("M002")?.status, "complete", "a checked box never completes a milestone");
    assert.equal(getMilestone("M004")?.status, "active", "an existing row keeps its lifecycle status");

    // Established phase directories stay where they are.
    for (const dir of dirs) {
      assert.ok(existsSync(join(base, ".gsd", "phases", dir, "01-01-PLAN.md")), `${dir} is not renamed`);
    }
    assert.ok(!existsSync(join(base, ".gsd", "phases", "02-billing")), "no short-title directory is created");

    // Done history with no row is never resurrected as queued; only the new
    // open line registers.
    assert.equal(getMilestone("M001"), null, "a [x] line with no row does not become a queued milestone");
    assert.equal(getMilestone("M005")?.status, "queued", "the new open milestone registers");
    assert.equal(getMilestone("M005")?.title, "Search");
    assert.deepEqual(
      milestoneLifecycle("M005"),
      { status: "ready", version: 0, writer: "artifact.save" },
      "the new milestone is adopted in the same operation",
    );
  });

  test("a PROJECT save of pure done history with no rows succeeds and keeps the lines (#2801)", async (t) => {
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
      "- [x] M001: Foundation — done.",
      "- [x] M002: Billing — done.",
      "",
    ].join("\n");

    const result = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!result.isError, result.content[0]!.text);
    assert.equal(getAllMilestones().length, 0, "no rows are resurrected from done lines");
    const stored = getArtifact("PROJECT.md");
    assert.ok(stored);
    assert.ok(stored.full_content.includes("- [x] M001: Foundation — done."), "the history lines persist");
    assert.deepEqual(
      readProjectMilestoneSequence(_getAdapter()!),
      ["M001", "M002"],
      "the sequence table keeps the history in document order",
    );
  });

  test("a PROJECT save that repairs a done mismatch keeps checked history with no row (#2801)", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));

    // M002 is active in the DB; the document wrongly checks its box. M001 has
    // no row — its checked line is history the repair must keep (once, even
    // when the document repeats it).
    adoptMilestoneRow("M002", "Existing - Work", "active");
    const content = [
      "# Project",
      "",
      "## Milestone Sequence",
      "",
      "- [x] M001: Foundation — done.",
      "- [x] M001: Foundation — done.",
      "- [x] M002: Existing — work.",
      "",
    ].join("\n");

    const result = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!result.isError, result.content[0]!.text);
    assert.equal(result.details.milestoneSequenceSelfHealed, true);
    assert.equal(getMilestone("M001"), null, "the history line stays rowless");
    assert.equal(getMilestone("M002")?.status, "active", "a checked box never completes a milestone");

    const stored = getArtifact("PROJECT.md");
    assert.ok(stored);
    assert.equal(
      stored.full_content.split("- [x] M001: Foundation — done.").length - 1,
      1,
      "the checked history survives the repair exactly once",
    );
    assert.match(stored.full_content, /- \[ \] M002: [^\n]*\bwork\./, "the DB status corrects the checked box");
  });

  test("a sequence line fills an empty title only over a placeholder directory; an established directory is untouched (#2801)", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));

    insertMilestone({ id: "M001", status: "queued" });
    insertMilestone({ id: "M002", status: "queued" });
    insertMilestone({ id: "M003", status: "queued" });
    // M002 has an established directory named for a real title; M003 has the
    // id-slug placeholder a generate-id-era directory would have.
    mkdirSync(join(base, ".gsd", "phases", "02-established-name"), { recursive: true });
    writeFileSync(join(base, ".gsd", "phases", "02-established-name", "01-01-PLAN.md"), "# Plan\n");
    mkdirSync(join(base, ".gsd", "phases", canonicalPhaseDirName("M003", "M003")), { recursive: true });

    const content = [
      "# Project",
      "",
      "## Milestone Sequence",
      "",
      "- [ ] M001: Fresh — thing.",
      "- [ ] M002: Short — other.",
      "- [ ] M003: Third — bit.",
      "",
    ].join("\n");

    const result = await executeSummarySave({ artifact_type: "PROJECT", content }, base);
    assert.ok(!result.isError, result.content[0]!.text);

    assert.equal(getMilestone("M001")?.title, "Fresh", "no directory: the line fills the empty title");
    assert.equal(getMilestone("M002")?.title, "", "an established directory blocks the fill");
    assert.ok(existsSync(join(base, ".gsd", "phases", "02-established-name", "01-01-PLAN.md")), "the established directory stays");
    assert.ok(!existsSync(join(base, ".gsd", "phases", "02-short")), "no short-title directory is created");

    assert.equal(getMilestone("M003")?.title, "Third", "a placeholder directory still fills and renames (#1526)");
    assert.ok(!existsSync(join(base, ".gsd", "phases", canonicalPhaseDirName("M003", "M003"))), "the placeholder directory is gone");
    assert.ok(existsSync(join(base, ".gsd", "phases", canonicalPhaseDirName("M003", "Third"))), "the placeholder renamed to the title slug");
  });

  test("a sequence line fills only an empty stored title; a stored title is never overwritten", async (t) => {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    markApprovalGateVerified("depth_verification_project_confirm", base);
    t.after(() => clearDiscussionFlowState(base));
    const originalCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(originalCwd));

    // A generate-id placeholder row: id only, no title yet.
    insertMilestone({ id: "M001", status: "queued" });

    const first = await executeSummarySave(
      { artifact_type: "PROJECT", content: "# Project\n\n## Milestone Sequence\n\n- [ ] M001: Real Title — one-liner\n" },
      base,
    );
    assert.ok(!first.isError, first.content[0]!.text);
    assert.equal(getMilestone("M001")?.title, "Real Title", "the line fills an empty stored title");

    const second = await executeSummarySave(
      { artifact_type: "PROJECT", content: "# Project\n\n## Milestone Sequence\n\n- [ ] M001: Other — tail\n" },
      base,
    );
    assert.ok(!second.isError, second.content[0]!.text);
    assert.equal(getMilestone("M001")?.title, "Real Title", "a stored title survives a rewrite with different wording");
  });
});
