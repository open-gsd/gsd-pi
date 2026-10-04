// Project/App: gsd-pi
// File Purpose: ADR-046 behavior gates G1-G8: the database is the only workflow authority.
//
// A check wrapped in expectedFail("P##") cannot pass on current code. The
// named cutover package makes it pass and deletes the wrapper. All other
// assertions are enforced now.
//
//   Gate                       Expected-fail checks and the package that makes them pass
//   G1 files deleted           none
//   G2 files poisoned          no projection reads P23
//   G3 canonical wins          P23
//   G4 operation-only writes   gsd_slice_complete P35, gsd_summary_save task SUMMARY P12
//   G5 render failure          handler writes no projection P12
//   G6 evidence before unlock  slice P24, milestone P27
//   G7 epoch fence             none
//   G8 legacy counters         P36
//
// Legs in other files:
//   G1 projection rebuild from the database alone: tests/projection-rebuild-gate.test.ts
//   G1 runtime control files deleted between units: tests/runtime-control-files-gate.test.ts
//   G1/G2 for MCP read tools: packages/mcp-server/src/db-authority-gates.test.ts
//   G4 per tool and transport, G5 handler writes: packages/mcp-server/src/workflow-tools-parity.test.ts
//
// When the G2 "no projection reads" check is enforced, delete
// tests/parsers-legacy-importers.test.ts and scripts/legacy-state-path-proof.mjs.
// They search for parser names that no longer exist, so they cannot fail.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resolveDispatch } from "../auto-dispatch.ts";
import { verifyExpectedArtifact } from "../artifact-verification.ts";
import { _setManagedMutationBoundaryForTest } from "../atomic-write.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import {
  _getAdapter,
  insertMilestone,
  insertSlice,
  updateTaskStatus,
} from "../gsd-db.ts";
import { getLegacyTelemetry, resetLegacyTelemetry } from "../legacy-telemetry.ts";
import { applyLifecycleBackfill } from "../lifecycle-backfill-domain-operation.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { resolveMilestoneFile } from "../paths.ts";
import { drainProjectionWork } from "../projection-worker.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation/index.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";
import { renderStateContent } from "../workflow-projections.ts";
import {
  deleteProjections,
  expectedFail,
  fenceWorkflowWrites,
  poisonProjections,
  recordProjectionReads,
  seedLifecycle,
  snapshotWorkflowTables,
} from "./db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

// Fixture: M001 active; S01 complete (T01 complete); S02 pending, depends on
// S01, with T01 pending. All rows are legacy rows with no lifecycle row.
let fixture: WorkflowAuthorityFixture;

async function openFixture(): Promise<string> {
  fixture = await createWorkflowAuthorityFixture();
  return fixture.root;
}

afterEach(() => {
  _setManagedMutationBoundaryForTest(null);
  fixture?.cleanup();
  invalidateStateCache();
});

async function dispatchFor(base: string, mid = "M001") {
  invalidateStateCache();
  const state = await deriveState(base);
  return resolveDispatch({ basePath: base, mid, midTitle: "Authority Fixture", prefs: undefined, state });
}

/** The decision surfaces that must give the same answer with or without projection files. */
async function decide(base: string) {
  invalidateStateCache();
  const state = await deriveState(base);
  const dispatch = await dispatchFor(base);
  return {
    state,
    dispatch: {
      action: dispatch.action,
      unitType: "unitType" in dispatch ? dispatch.unitType : null,
      unitId: "unitId" in dispatch ? dispatch.unitId : null,
    },
    prompt: "prompt" in dispatch ? dispatch.prompt : null,
    artifacts: {
      planSlice: verifyExpectedArtifact("plan-slice", "M001/S02", base),
      planMilestone: verifyExpectedArtifact("plan-milestone", "M001", base),
    },
  };
}

/** Classify the given milestones. Today a milestone is a candidate only when its directory exists. */
async function eligibilityOf(base: string, milestoneIds: string[]) {
  for (const id of milestoneIds) mkdirSync(join(base, ".gsd", "milestones", id), { recursive: true });
  invalidateStateCache();
  const result = await analyzeParallelEligibility(base);
  const pick = (entries: Array<{ milestoneId: string }>) =>
    entries.map((entry) => entry.milestoneId).filter((id) => milestoneIds.includes(id));
  const eligible = pick(result.eligible);
  const ineligible = pick(result.ineligible);
  assert.deepEqual([...eligible, ...ineligible].sort(), milestoneIds, "every milestone is classified");
  return { eligible, ineligible };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "database must be open");
  return adapter;
}

describe("gate harness", () => {
  test("expectedFail fails when the check passes and hides only assertion failures", () => {
    expectedFail("P00", () => assert.equal(1, 2));
    assert.throws(() => expectedFail("P00", () => {}), /gate passes now: delete expectedFail\("P00"\)/);
    assert.throws(() => expectedFail("P00", () => { throw new TypeError("broken fixture"); }), TypeError);
  });
});

describe("G1: files-deleted run", () => {
  test("decisions are the same after every projection file is deleted", async () => {
    const base = await openFixture();
    assert.deepEqual((await renderAllFromDb(base)).errors, []);
    const control = await decide(base);
    assert.equal(control.dispatch.unitId, "M001/S02/T01", "control run dispatches the ready task");
    assert.deepEqual(control.artifacts, { planSlice: true, planMilestone: true });

    deleteProjections(base);
    const deleted = await decide(base);

    assert.deepEqual(deleted.state, control.state, "derived state comes from DB rows");
    assert.deepEqual(deleted.dispatch, control.dispatch, "the dispatch decision comes from DB rows");
    // Dispatch renders the missing slice PLAN from DB rows before it builds the prompt.
    assert.equal(deleted.prompt, control.prompt, "the prompt is the same after the projections are deleted");
    assert.deepEqual(deleted.artifacts, control.artifacts, "unit verification comes from DB rows");
  });
});

describe("G2: files-poisoned run", () => {
  test("decisions and the database ignore contradicting projection files", async () => {
    const base = await openFixture();
    assert.deepEqual((await renderAllFromDb(base)).errors, []);
    const control = await decide(base);
    const tablesBefore = snapshotWorkflowTables();

    poisonProjections(base);
    let poisoned!: Awaited<ReturnType<typeof decide>>;
    const projectionReads = await recordProjectionReads(base, async () => {
      poisoned = await decide(base);
    });

    assert.deepEqual(poisoned.state, control.state, "derived state comes from DB rows");
    assert.deepEqual(poisoned.dispatch, control.dispatch, "dispatch decision comes from DB rows");
    assert.deepEqual(poisoned.artifacts, control.artifacts, "artifact verification ignores file content");
    assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "decision reads write no workflow row");
    assert.equal(poisoned.prompt, control.prompt, "the prompt takes its narrative from artifact rows");
    expectedFail("P23", () => assert.deepEqual(projectionReads, []));

    await reconcileBeforeDispatch(base);
    assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "reconciliation writes no workflow row from a file");
  });
});

describe("G3: canonical lifecycle wins over legacy status rows", () => {
  test("status tool follows the canonical row in both directions", async () => {
    const base = await openFixture();
    insertMilestone({ id: "M002", title: "Legacy complete", status: "complete" });
    seedLifecycle({ itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" }, "status-m001");
    seedLifecycle({ itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" }, "status-m002");

    const closed = await executeMilestoneStatus({ milestoneId: "M001" }, base);
    const open = await executeMilestoneStatus({ milestoneId: "M002" }, base);

    assert.equal(closed.details?.["status"], "active", "legacy value today");
    assert.equal(open.details?.["status"], "complete", "legacy value today");
    expectedFail("P23", () => {
      assert.match(String(closed.details?.["status"]), /^complete/);
      assert.doesNotMatch(String(open.details?.["status"]), /^complete/);
    });
  });

  test("parallel eligibility follows the canonical row in both directions", async () => {
    const base = await openFixture();
    insertMilestone({ id: "M002", title: "Legacy complete", status: "complete" });
    insertMilestone({ id: "M003", title: "Needs M002", status: "active", depends_on: ["M002"] });
    insertMilestone({ id: "M004", title: "Needs M001", status: "active", depends_on: ["M001"] });
    seedLifecycle({ itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" }, "eligible-m001");
    seedLifecycle({ itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" }, "eligible-m002");

    const { eligible, ineligible } = await eligibilityOf(base, ["M003", "M004"]);

    expectedFail("P23", () => {
      assert.deepEqual(ineligible, ["M003"]);
      assert.deepEqual(eligible, ["M004"]);
    });
  });

  test("slice dispatch guard follows the canonical row in both directions", async () => {
    const base = await openFixture();
    insertSlice({ id: "S03", milestoneId: "M001", title: "Legacy active", status: "active", depends: [] });
    insertSlice({ id: "S04", milestoneId: "M001", title: "Needs S03", status: "pending", depends: ["S03"] });
    seedLifecycle(
      { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "in_progress" },
      "guard-s01",
    );
    seedLifecycle(
      { itemKind: "slice", milestoneId: "M001", sliceId: "S03", lifecycleStatus: "completed" },
      "guard-s03",
    );

    const needsOpenSlice = getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01");
    const needsClosedSlice = getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S04/T01");

    expectedFail("P23", () => {
      assert.match(needsOpenSlice ?? "", /M001\/S01 is not complete/);
      assert.equal(needsClosedSlice, null);
    });
  });

  test("resolveDispatch and deriveState follow the canonical row", async () => {
    const base = await openFixture();
    seedLifecycle({ itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" }, "derive-m001");

    invalidateStateCache();
    const state = await deriveState(base);
    const dispatch = await dispatchFor(base);

    expectedFail("P23", () => assert.notEqual(state.activeMilestone?.id, "M001"));
    expectedFail("P23", () => assert.equal(dispatch.action, "stop"));
  });
});

describe("G4: the write fence used by the per-tool gates", () => {
  test("allows a workflow-table write inside a Domain Operation and refuses one outside", async () => {
    await openFixture();
    const fence = fenceWorkflowWrites();

    const authority = readDomainOperationFence();
    executeDomainOperation({
      operationType: "db-authority-gate.fence-inside",
      idempotencyKey: "db-authority-gate/fence-inside",
      expectedRevision: authority.revision,
      expectedAuthorityEpoch: authority.authorityEpoch,
      actorType: "agent",
      sourceTransport: "test",
      payload: {},
    }, () => {
      db().prepare("UPDATE tasks SET title = 'Written inside' WHERE slice_id = 'S02'").run();
      db().exec("UPDATE tasks SET description = 'exec inside' WHERE slice_id = 'S02'");
      db().prepare("REPLACE INTO tasks SELECT * FROM tasks WHERE slice_id = 'S02'").run();
      db().prepare("WITH x AS (SELECT 1) UPDATE tasks SET narrative = 'with inside' WHERE slice_id = 'S02'").run();
      return {
        events: [{
          eventType: "db-authority-gate.fence-inside",
          entityType: "task",
          entityId: "M001/S02/T01",
          payload: {},
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: "db-authority-gate/fence-inside",
          projectionKind: "markdown",
          rendererVersion: "v1",
        }],
      };
    });
    const fenceAfterOperation = [...fence.violations];
    assert.throws(
      () => updateTaskStatus("M001", "S02", "T01", "complete"),
      /write to workflow table "tasks" outside a Domain Operation/,
    );
    const refused = /write to workflow table "tasks" outside a Domain Operation/;
    assert.throws(() => db().exec("DELETE FROM tasks"), refused);
    assert.throws(() => db().prepare("REPLACE INTO tasks SELECT * FROM tasks").run(), refused);
    assert.throws(
      () => db().prepare("WITH x AS (SELECT 1) UPDATE tasks SET title = 'Written outside'").run(),
      refused,
    );
    fence.restore();

    assert.deepEqual(fenceAfterOperation, []);
    assert.deepEqual(fence.violations, ["tasks", "tasks", "tasks", "tasks"]);
    assert.deepEqual(
      db().prepare("SELECT title, status, description, narrative FROM tasks WHERE slice_id = 'S02'").get(),
      { title: "Written inside", status: "pending", description: "exec inside", narrative: "with inside" },
      "the operation write is stored and the refused write is not",
    );
  });
});

describe("G5: a render failure after commit does not lose the projection", () => {
  test("only the failed key stays pending and the next drain renders it", async () => {
    const base = await openFixture();
    insertMilestone({ id: "M002", title: "Second milestone", status: "active" });
    assert.deepEqual((await renderAllFromDb(base)).errors, []);
    // The fixture saves a decision, which enqueues a "decisions" row. Settle it first.
    assert.deepEqual((await drainProjectionWork(base)).errors, []);
    const roadmapPath = resolveMilestoneFile(base, "M001", "ROADMAP");
    assert.ok(roadmapPath && existsSync(roadmapPath), "fixture renders the M001 ROADMAP projection");
    const work = (key: string) => db().prepare(`
      SELECT delivery_state, attempt_count, last_error, next_attempt_at, rendered_content_hash
      FROM workflow_projection_work WHERE projection_key = :key
    `).get({ ":key": key }) as {
      delivery_state: string;
      attempt_count: number;
      last_error: string;
      next_attempt_at: string;
      rendered_content_hash: string | null;
    };

    rmSync(roadmapPath);
    _setManagedMutationBoundaryForTest((_boundary, path) => {
      if (path === roadmapPath) throw new Error("injected render failure");
    });
    seedLifecycle(
      { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
      "render-failure",
      "slice-lifecycle",
      "lifecycle/m001/s02",
    );
    seedLifecycle(
      { itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" },
      "render-ok",
      "milestone-lifecycle",
      "lifecycle/m002",
    );
    const now = new Date();
    const failed = await drainProjectionWork(base, { now });

    assert.equal(failed.delivered, 1, "the healthy key is delivered");
    assert.match(failed.errors.join("\n"), /lifecycle\/m001\/s02: .*injected render failure/);
    assert.equal(work("lifecycle/m001/s02").delivery_state, "pending", "failed work is kept for the next drain");
    assert.match(work("lifecycle/m001/s02").last_error, /injected render failure/);
    assert.equal(work("lifecycle/m001/s02").rendered_content_hash, null);
    assert.equal(work("lifecycle/m002").delivery_state, "rendered");
    assert.match(String(work("lifecycle/m002").rendered_content_hash), /^sha256:[0-9a-f]{64}$/);

    _setManagedMutationBoundaryForTest(null);
    assert.equal((await drainProjectionWork(base, { now })).delivered, 0, "no retry before the retry time");
    const retried = await drainProjectionWork(base, { now: new Date(work("lifecycle/m001/s02").next_attempt_at) });
    const retriedBytes = readFileSync(roadmapPath, "utf-8");

    assert.deepEqual(retried.errors, []);
    assert.equal(retried.delivered, 1);
    assert.equal(work("lifecycle/m001/s02").delivery_state, "rendered");
    assert.equal(work("lifecycle/m001/s02").last_error, "");
    rmSync(roadmapPath);
    assert.deepEqual((await renderAllFromDb(base)).errors, []);
    assert.equal(retriedBytes, readFileSync(roadmapPath, "utf-8"), "retry bytes equal a clean render");

    seedLifecycle(
      { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" },
      "state-render",
      "state",
      "project/authority",
    );
    await drainProjectionWork(base, { now: new Date(Date.now() + 86_400_000) });
    assert.equal(work("project/authority").delivery_state, "rendered");
    // Work of kind "state" is settled as rendered, so STATE.md must hold the one render of the DB state.
    invalidateStateCache();
    assert.equal(
      readFileSync(join(base, ".gsd", "STATE.md"), "utf-8"),
      renderStateContent(await deriveState(base)),
    );
  });
});

describe("G6: evidence before unlock", () => {
  test("a legacy 'complete' row with no canonical completion does not unlock dependents", async () => {
    const base = await openFixture();
    insertMilestone({ id: "M002", title: "Legacy complete", status: "complete" });
    insertMilestone({ id: "M003", title: "Needs M002", status: "active", depends_on: ["M002"] });
    assert.deepEqual((await renderAllFromDb(base)).errors, [], "projection files exist and must not count");

    const sliceBlocker = getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01");
    const { ineligible } = await eligibilityOf(base, ["M003"]);

    expectedFail("P24", () => assert.match(sliceBlocker ?? "", /M001\/S01 is not complete/));
    expectedFail("P27", () => assert.deepEqual(ineligible, ["M003"]));
  });
});

describe("G7: Authority Epoch fence", () => {
  test("a writer with an old epoch is refused", async () => {
    // The epoch can advance only when every hierarchy row has a lifecycle row.
    applyLifecycleBackfill(await openFixture());
    const stale = readDomainOperationFence();
    db().prepare("UPDATE project_authority SET authority_epoch = authority_epoch + 1").run();
    const tablesBefore = snapshotWorkflowTables();

    assert.throws(() => executeDomainOperation({
      operationType: "db-authority-gate.stale-epoch",
      idempotencyKey: "db-authority-gate/stale-epoch",
      expectedRevision: stale.revision,
      expectedAuthorityEpoch: stale.authorityEpoch,
      actorType: "agent",
      sourceTransport: "test",
      payload: {},
    }, () => {
      db().prepare("UPDATE tasks SET status = 'complete' WHERE slice_id = 'S02'").run();
      return { events: [], projections: [] };
    }), /stale authority epoch/);
    assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "the refused write leaves no row change");
  });

  test("a direct UPDATE on tasks outside a Domain Operation aborts", async () => {
    applyLifecycleBackfill(await openFixture());
    db().prepare("UPDATE project_authority SET authority_epoch = authority_epoch + 1").run();
    const tablesBefore = snapshotWorkflowTables();

    assert.throws(
      () => db().prepare("UPDATE tasks SET status = 'complete' WHERE slice_id = 'S02'").run(),
      /the status of a hierarchy row changes only in a Domain Operation/,
    );
    assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "the refused write leaves no row change");
  });
});

describe("G8: zero legacy counters", () => {
  test("the gate scenario uses no counted legacy path, and a legacy status write is counted", async () => {
    const base = await openFixture();
    resetLegacyTelemetry();

    await decide(base);
    assert.deepEqual(
      Object.values(getLegacyTelemetry()).filter((count) => count > 0),
      [],
      "decision reads hit no counted legacy path",
    );

    // updateTaskStatus is a legacy-only status writer: no Domain Operation, no lifecycle row.
    updateTaskStatus("M001", "S02", "T01", "complete");
    expectedFail("P36", () =>
      assert.ok(Object.values(getLegacyTelemetry()).some((count) => count > 0)));
  });
});
