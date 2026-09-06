// Project/App: gsd-pi
// File Purpose: readProgressFromDb — DB-authoritative integration progress
// reads (#2101). Pins both the values derived from the DB and the exact
// ProgressResult key set the Hermes contract depends on.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  _getAdapter,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import {
  deriveState,
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
} from "../state.ts";
import { readProgressFromDb, readProjectProgressFromDb } from "../state/progress-from-db.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

function seedSecondMilestone(fixture: WorkflowAuthorityFixture): void {
  insertMilestone({ id: "M002", title: "Later milestone", status: "pending" });
  insertSlice({
    id: "S03",
    milestoneId: "M002",
    title: "In-flight slice",
    status: "in_progress",
    risk: "low",
    depends: [],
    sequence: 1,
  });
}

function changeAuthorityDuringCounts(
  t: TestContext,
  limit: number,
): () => number {
  const adapter = _getAdapter();
  assert.ok(adapter);
  const originalPrepare = adapter.prepare.bind(adapter);
  let changes = 0;

  adapter.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("AS completed") || !sql.includes("FROM milestones")) return statement;
    return {
      ...statement,
      get(...params: unknown[]) {
        if (changes < limit) {
          changes++;
          originalPrepare("UPDATE milestones SET title = ? WHERE id = 'M001'")
            .run(`Authority revision ${changes}`);
          originalPrepare("UPDATE project_authority SET revision = revision + 1 WHERE singleton = 1")
            .run();
        }
        return statement.get(...params);
      },
    };
  };
  t.after(() => {
    adapter.prepare = originalPrepare;
  });
  return () => changes;
}

function updateMilestoneFromExternalConnection(dbPath: string): void {
  const external = new DatabaseSync(dbPath);
  external.prepare("UPDATE milestones SET title = ? WHERE id = 'M001'")
    .run("External hierarchy commit");
  external.close();
}

function changeHierarchyFromAnotherConnectionDuringCounts(
  t: TestContext,
  dbPath: string,
): () => number {
  const adapter = _getAdapter();
  assert.ok(adapter);
  const originalPrepare = adapter.prepare.bind(adapter);
  let changes = 0;

  adapter.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("AS completed") || !sql.includes("FROM milestones")) return statement;
    return {
      ...statement,
      get(...params: unknown[]) {
        if (changes === 0) {
          changes++;
          updateMilestoneFromExternalConnection(dbPath);
        }
        return statement.get(...params);
      },
    };
  };
  t.after(() => {
    adapter.prepare = originalPrepare;
  });
  return () => changes;
}

test("readProgressFromDb emits exactly the ProgressResult key set", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  const result = await readProgressFromDb(fixture.root);
  assert.ok(result);
  assert.deepEqual(Object.keys(result), [
    "activeMilestone",
    "activeSlice",
    "activeTask",
    "phase",
    "milestones",
    "slices",
    "tasks",
    "requirements",
    "blockers",
    "nextAction",
  ]);
  assert.deepEqual(Object.keys(result.milestones), ["total", "done", "active", "pending", "parked"]);
  assert.deepEqual(Object.keys(result.slices), ["total", "done", "active", "pending"]);
  assert.deepEqual(Object.keys(result.tasks), ["total", "done", "pending"]);
  assert.deepEqual(
    Object.keys(result.requirements ?? {}),
    ["active", "validated", "deferred", "outOfScope"],
  );
});

test("readProgressFromDb derives refs, project-wide counts, and requirements from the DB", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedSecondMilestone(fixture);

  const result = await readProgressFromDb(fixture.root);
  assert.ok(result);
  const state = await deriveState(fixture.root);

  assert.deepEqual(result.activeMilestone, { id: "M001", title: "Authority Fixture" });
  assert.deepEqual(result.activeSlice, { id: "S02", title: "Ready dependent slice" });
  assert.deepEqual(result.activeTask, { id: "T01", title: "Ready task" });
  assert.equal(result.phase, state.phase);
  assert.deepEqual(result.milestones, { total: 2, done: 0, active: 1, pending: 1, parked: 0 });
  assert.deepEqual(result.slices, { total: 3, done: 1, active: 1, pending: 1 });
  assert.deepEqual(result.tasks, { total: 2, done: 1, pending: 1 });
  assert.deepEqual(result.requirements, { active: 1, validated: 0, deferred: 0, outOfScope: 0 });
  assert.deepEqual(result.blockers, []);
  assert.equal(typeof result.nextAction, "string");
  assert.ok(result.nextAction.length > 0);
  const detailedResult = await readProjectProgressFromDb(fixture.root);
  assert.equal(detailedResult?.milestoneDetails?.[0]?.slices[0]?.tasks[0]?.id, "T01");
});

test("readProgressFromDb keeps milestone counts project-wide under a milestone lock", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedSecondMilestone(fixture);

  const previousLock = process.env.GSD_MILESTONE_LOCK;
  process.env.GSD_MILESTONE_LOCK = "M002";
  t.after(() => {
    if (previousLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = previousLock;
  });

  const result = await readProgressFromDb(fixture.root);
  assert.ok(result);

  assert.equal(result.activeMilestone?.id, "M002");
  assert.deepEqual(result.milestones, { total: 2, done: 0, active: 1, pending: 1, parked: 0 });
});

test("readProgressFromDb reflects DB state, never stale projection files", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  writeFileSync(
    join(fixture.root, ".gsd", "STATE.md"),
    [
      "# Project State",
      "",
      "**Phase:** planning",
      "**Active Milestone:** M999: Stale Projection",
      "",
      "## Next Action",
      "",
      "Stale action from projection",
      "",
    ].join("\n"),
  );

  const result = await readProgressFromDb(fixture.root);
  assert.ok(result);
  assert.equal(result.activeMilestone?.id, "M001");
  assert.notEqual(result.activeMilestone?.title, "Stale Projection");
  assert.notEqual(result.nextAction, "Stale action from projection");
});

test("readProgressFromDb returns null for a missing requested DB instead of reusing an open global DB", async (t) => {
  const existing = await createWorkflowAuthorityFixture();
  const missingRoot = join(tmpdir(), `gsd-progress-missing-${randomUUID()}`);
  mkdirSync(join(missingRoot, ".gsd"), { recursive: true });
  t.after(() => {
    existing.cleanup();
    rmSync(missingRoot, { recursive: true, force: true });
  });

  existing.reopen();
  const result = await readProgressFromDb(missingRoot);

  assert.equal(result, null);
});

test("readProgressFromDb retries when the authority revision moves", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  const getChanges = changeAuthorityDuringCounts(t, 1);
  invalidateStateCache();
  resetDeriveTelemetry();

  const result = await readProgressFromDb(fixture.root);

  assert.ok(result);
  assert.equal(result.activeMilestone?.title, "Authority revision 1");
  assert.equal(getChanges(), 1);
  assert.equal(getDeriveTelemetry().dbDeriveCount, 2);
});

test("readProgressFromDb retries when another connection changes hierarchy data", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  const getChanges = changeHierarchyFromAnotherConnectionDuringCounts(t, fixture.dbPath);
  invalidateStateCache();
  resetDeriveTelemetry();

  const result = await readProgressFromDb(fixture.root);

  assert.ok(result);
  assert.equal(result.activeMilestone?.title, "External hierarchy commit");
  assert.equal(getChanges(), 1);
  assert.equal(getDeriveTelemetry().dbDeriveCount, 2);
});

test("readProgressFromDb rejects a pre-existing stale derive cache", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  t.mock.method(Date, "now", () => 42_000);
  invalidateStateCache();
  const cached = await deriveState(fixture.root);
  assert.equal(cached.activeMilestone?.title, "Authority Fixture");

  _getAdapter()?.prepare("UPDATE milestones SET title = ? WHERE id = 'M001'")
    .run("Current hierarchy title");
  resetDeriveTelemetry();

  const result = await readProgressFromDb(fixture.root);

  assert.ok(result);
  assert.equal(result.activeMilestone?.title, "Current hierarchy title");
  assert.equal(getDeriveTelemetry().dbDeriveCount, 1);
});

test("readProgressFromDb returns the last attempt during sustained revision movement", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  const getChanges = changeAuthorityDuringCounts(t, 3);
  invalidateStateCache();
  resetDeriveTelemetry();

  const result = await readProgressFromDb(fixture.root);

  assert.ok(result);
  assert.equal(result.activeMilestone?.title, "Authority revision 2");
  assert.equal(getChanges(), 3);
  assert.equal(getDeriveTelemetry().dbDeriveCount, 3);
});
