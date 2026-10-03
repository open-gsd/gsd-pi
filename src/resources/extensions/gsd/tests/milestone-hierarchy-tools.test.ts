// Project/App: gsd-pi
// File Purpose: The milestone park, unpark, discard, reorder and set-dependencies tools change the database through one Domain Operation each.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { piExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getMilestone,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { getParkedReason } from "../milestone-actions.ts";
import { clearPathCache } from "../paths.ts";
import { drainProjectionWork } from "../projection-worker.ts";
import { invalidateStateCache } from "../state.ts";
import {
  executeMilestoneDiscard,
  executeMilestonePark,
  executeMilestoneReorder,
  executeMilestoneSetDependencies,
  executeMilestoneUnpark,
} from "../tools/workflow-tool-executors.ts";

function scalar(sql: string, params: Record<string, unknown> = {}): unknown {
  return Object.values(_getAdapter()!.prepare(sql).get(params) ?? {})[0];
}

function revision(): number {
  return Number(scalar("SELECT revision FROM project_authority WHERE singleton = 1"));
}

function operationCount(): number {
  return Number(scalar("SELECT COUNT(*) FROM workflow_operations"));
}

function errorText(result: { content: Array<{ text: string }>; isError?: boolean }): string {
  assert.equal(result.isError, true, "the tool call must be refused");
  return result.content[0]!.text;
}

describe("milestone hierarchy tools", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-milestone-hierarchy-tools-"));
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    assert.ok(openDatabase(join(base, ".gsd", "gsd.db")), "database opens");
    clearPathCache();
    invalidateStateCache();
    insertMilestone({ id: "M001", title: "First", status: "queued" });
    insertMilestone({ id: "M002", title: "Second", status: "queued" });
    insertMilestone({ id: "M003", title: "Third", status: "queued" });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // Gate G4 for each new tool. Order matters: each call needs the state the
  // one before it leaves.
  const CALLS = [
    {
      tool: "gsd_milestone_park",
      operationType: "milestone.park",
      run: (key: string) => executeMilestonePark(
        { milestoneId: "M002", reason: "Waiting on the vendor" }, base, piExecutionInvocation("gsd_milestone_park", key)),
    },
    {
      tool: "gsd_milestone_unpark",
      operationType: "milestone.unpark",
      run: (key: string) => executeMilestoneUnpark(
        { milestoneId: "M002" }, base, piExecutionInvocation("gsd_milestone_unpark", key)),
    },
    {
      tool: "gsd_milestone_set_dependencies",
      operationType: "milestone.set_dependencies",
      run: (key: string) => executeMilestoneSetDependencies(
        { milestoneId: "M002", dependsOn: ["M001"] }, base, piExecutionInvocation("gsd_milestone_set_dependencies", key)),
    },
    {
      tool: "gsd_milestone_reorder",
      operationType: "milestone.reorder",
      run: (key: string) => executeMilestoneReorder(
        { order: ["M003", "M001", "M002"] }, base, piExecutionInvocation("gsd_milestone_reorder", key)),
    },
    {
      tool: "gsd_milestone_discard",
      operationType: "milestone.discard",
      run: (key: string) => executeMilestoneDiscard(
        { milestoneId: "M002", reason: "Superseded by M003" }, base, piExecutionInvocation("gsd_milestone_discard", key)),
    },
  ];

  test("each tool call commits one operation at revision +1, and a retry of the same call writes nothing", async () => {
    for (const call of CALLS) {
      const revisionBefore = revision();
      const operationsBefore = operationCount();

      const first = await call.run("call-1");
      assert.ok(!first.isError, `${call.tool}: ${first.content[0]!.text}`);
      assert.equal(revision(), revisionBefore + 1, `${call.tool} advances the revision by one`);
      assert.equal(operationCount(), operationsBefore + 1, `${call.tool} commits one operation`);
      assert.deepEqual(
        { ..._getAdapter()!.prepare(`
          SELECT operation_type, source_transport, actor_type, resulting_revision
          FROM workflow_operations WHERE idempotency_key = :key
        `).get({ ":key": `pi:${call.tool}:call-1` }) },
        {
          operation_type: call.operationType,
          source_transport: "pi-tool",
          actor_type: "agent",
          resulting_revision: revisionBefore + 1,
        },
        `${call.tool} records the tool call as the operation identity`,
      );

      const retry = await call.run("call-1");
      assert.ok(!retry.isError, `${call.tool} retry: ${retry.content[0]!.text}`);
      assert.deepEqual(retry.content, first.content, `${call.tool} retry returns the first answer`);
      assert.equal(revision(), revisionBefore + 1, `${call.tool} retry does not advance the revision`);
      assert.equal(operationCount(), operationsBefore + 1, `${call.tool} retry commits no operation`);
    }
  });

  test("an auto-mode unit cannot call the milestone hierarchy tools", () => {
    for (const call of CALLS) {
      assert.equal(shouldBlockAutoUnitToolCall("execute-task", call.tool).block, true, call.tool);
      assert.equal(shouldBlockAutoUnitToolCall("plan-milestone", `mcp__gsd-workflow__${call.tool}`).block, true, call.tool);
    }
  });

  test("a tool-call key that is reused with other arguments is refused", async () => {
    const invocation = piExecutionInvocation("gsd_milestone_park", "call-1");
    assert.ok(!(await executeMilestonePark({ milestoneId: "M001", reason: "First reason" }, base, invocation)).isError);

    const reused = await executeMilestonePark({ milestoneId: "M001", reason: "Other reason" }, base, invocation);

    assert.match(errorText(reused), /idempotency conflict/);
    assert.equal(getParkedReason("M001"), "First reason");
  });

  test("park and unpark change the database status and keep the reason in the park record", async () => {
    const parked = await executeMilestonePark(
      { milestoneId: "M001", reason: "Blocked on legal" }, base, piExecutionInvocation("gsd_milestone_park", "park"));
    assert.ok(!parked.isError);
    assert.equal(getMilestone("M001")?.status, "parked");
    assert.equal(getParkedReason("M001"), "Blocked on legal");

    const again = await executeMilestonePark(
      { milestoneId: "M001", reason: "Again" }, base, piExecutionInvocation("gsd_milestone_park", "park-again"));
    assert.match(errorText(again), /M001 cannot be parked \(status: parked\)/);

    const unparked = await executeMilestoneUnpark(
      { milestoneId: "M001" }, base, piExecutionInvocation("gsd_milestone_unpark", "unpark"));
    assert.ok(!unparked.isError);
    assert.equal(getMilestone("M001")?.status, "active");

    const missing = await executeMilestoneUnpark(
      { milestoneId: "M999" }, base, piExecutionInvocation("gsd_milestone_unpark", "unpark-missing"));
    assert.match(errorText(missing), /M999 does not exist/);
  });

  test("discard cancels the milestone and records the reason in a policy Waiver", async () => {
    const result = await executeMilestoneDiscard(
      { milestoneId: "M003", reason: "Out of scope" }, base, piExecutionInvocation("gsd_milestone_discard", "discard"));

    assert.ok(!result.isError, result.content[0]!.text);
    assert.equal(getMilestone("M003")?.status, "skipped", "the row stays as a tombstone");
    assert.deepEqual(
      { ..._getAdapter()!.prepare(`
        SELECT waiver_status, rationale, granted_by_actor_type FROM workflow_waivers WHERE scope = 'milestone:M003'
      `).get() },
      { waiver_status: "active", rationale: "Out of scope", granted_by_actor_type: "policy" },
    );
  });

  test("reorder writes the database sequence and renders QUEUE-ORDER.json from it", async () => {
    const result = await executeMilestoneReorder(
      { order: ["M003", "M001", "M002"] }, base, piExecutionInvocation("gsd_milestone_reorder", "reorder"));

    assert.ok(!result.isError, result.content[0]!.text);
    assert.deepEqual(getAllMilestones().map((milestone) => milestone.id), ["M003", "M001", "M002"]);
    const queueOrderPath = join(base, ".gsd", "QUEUE-ORDER.json");
    assert.deepEqual(JSON.parse(readFileSync(queueOrderPath, "utf-8")).order, ["M003", "M001", "M002"]);

    // The file is a projection: the Projection Worker renders it again from the database.
    rmSync(queueOrderPath);
    const drained = await drainProjectionWork(base);
    assert.deepEqual(drained.errors, []);
    assert.ok(existsSync(queueOrderPath), "the queue-order Projection Work renders the file");
    assert.deepEqual(JSON.parse(readFileSync(queueOrderPath, "utf-8")).order, ["M003", "M001", "M002"]);
    assert.equal(
      scalar("SELECT delivery_state FROM workflow_projection_work WHERE projection_key = 'queue-order'"),
      "rendered",
    );
  });

  test("reorder refuses an order that breaks a dependency, repeats an id, or names an unknown or closed milestone", async () => {
    await executeMilestoneSetDependencies(
      { milestoneId: "M002", dependsOn: ["M001"] }, base, piExecutionInvocation("gsd_milestone_set_dependencies", "deps"));
    _getAdapter()!.prepare("UPDATE milestones SET status = 'complete' WHERE id = 'M003'").run();
    const sequenceBefore = getAllMilestones().map((milestone) => [milestone.id, milestone.sequence]);
    const reorder = (order: string[], key: string) =>
      executeMilestoneReorder({ order }, base, piExecutionInvocation("gsd_milestone_reorder", key));

    assert.match(errorText(await reorder(["M002", "M001"], "blocked")), /M002 cannot run before M001/);
    assert.match(errorText(await reorder(["M001", "M001"], "repeat")), /repeats a milestone id/);
    assert.match(errorText(await reorder(["M001", "M404"], "unknown")), /M404 does not exist/);
    assert.match(errorText(await reorder(["M003", "M001"], "closed")), /M003 is closed/);

    assert.deepEqual(getAllMilestones().map((milestone) => [milestone.id, milestone.sequence]), sequenceBefore);
    assert.equal(scalar("SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'milestone.reorder'"), 0);
  });

  test("set dependencies replaces the list and refuses unknown, self, discarded, cyclic and closed targets", async () => {
    const setDependencies = (milestoneId: string, dependsOn: string[], key: string) =>
      executeMilestoneSetDependencies(
        { milestoneId, dependsOn }, base, piExecutionInvocation("gsd_milestone_set_dependencies", key));

    assert.ok(!(await setDependencies("M002", ["M001"], "set")).isError);
    assert.deepEqual(getMilestone("M002")?.depends_on, ["M001"]);

    assert.match(errorText(await setDependencies("M002", ["M404"], "unknown")), /unknown milestone: M404/);
    assert.match(errorText(await setDependencies("M002", ["M002"], "self")), /cannot depend on itself/);
    assert.match(errorText(await setDependencies("M001", ["M002"], "cycle")), /Circular dependency/);
    assert.match(errorText(await setDependencies("M404", [], "missing")), /M404 does not exist/);
    await executeMilestoneDiscard(
      { milestoneId: "M003", reason: "Dropped" }, base, piExecutionInvocation("gsd_milestone_discard", "discard"));
    assert.match(errorText(await setDependencies("M002", ["M003"], "discarded")), /M003 was discarded/);
    assert.match(errorText(await setDependencies("M003", [], "closed")), /M003 is closed/);
    assert.deepEqual(getMilestone("M002")?.depends_on, ["M001"], "a refused call changes nothing");

    assert.ok(!(await setDependencies("M002", [], "clear")).isError);
    assert.deepEqual(getMilestone("M002")?.depends_on, []);
  });
});
