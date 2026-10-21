import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { CompleteSliceParams } from "../types.js";
import {
  _getAdapter,
  closeDatabase,
  getSlice,
  getTask,
  insertSlice,
  insertTask,
  updateTaskStatus,
} from "../gsd-db.js";
import { relSliceFile } from "../paths.js";
import {
  handleCompleteSlice as handleCompleteSliceWithInvocation,
} from "../tools/complete-slice.js";
import { handleReopenSlice } from "../tools/reopen-slice.js";
import { executeSkipSlice } from "../tools/workflow-tool-executors.js";
import {
  internalExecutionInvocation,
  type ExecutionInvocation,
} from "../execution-invocation.js";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.js";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.js";
import {
  createWorkflowFaultHarness,
  type WorkflowFaultHarness,
  type WorkflowFaultPoint,
} from "./workflow-fault-harness.js";
import { discardProjectionEvidence } from "./projection-evidence-helpers.js";

interface FaultScenario {
  point: WorkflowFaultPoint;
  committed: boolean;
}

interface AuthoritySnapshot {
  pid: number;
  taskStatus: string | null;
  sliceStatus: string | null;
  activeSlice: string | null;
}

type ReplayCommand = "complete" | "cancel" | "reopen";

interface ReplayProcessResult {
  pid: number;
  result: {
    duplicate?: boolean;
    stale?: boolean;
    error?: string;
    uatPath?: string;
    details?: { stale?: boolean };
  };
}

const SCENARIOS: FaultScenario[] = [
  { point: "before-transaction-commit", committed: false },
  { point: "after-db-commit-before-render", committed: true },
  { point: "during-projection-write", committed: true },
  { point: "before-independent-reopen", committed: true },
  { point: "after-independent-reopen", committed: true },
];

const COMPLETE_SLICE_PARAMS: CompleteSliceParams = {
  milestoneId: "M001",
  sliceId: "S02",
  sliceTitle: "Ready dependent slice",
  oneLiner: "Complete the dependent slice",
  narrative: "The database records the completed slice before projections are refreshed.",
  verification: "The focused authority matrix passed.",
  uatContent: "## UAT Type\n\n- UAT mode: runtime-executable\n\n## Result\n\nPassed.",
};

let completeSliceInvocationSequence = 0;
function handleCompleteSlice(
  params: Parameters<typeof handleCompleteSliceWithInvocation>[0],
  basePath: string,
  invocation = internalExecutionInvocation(
    `test/workflow-authority-faults/complete-slice/${++completeSliceInvocationSequence}`,
  ),
) {
  return handleCompleteSliceWithInvocation(params, basePath, invocation);
}

function seedCompletionBoundary(): void {
  updateTaskStatus("M001", "S02", "T01", "complete", "2026-07-11T00:00:00.000Z");
  seedSliceCompletionAuthority({
    milestoneId: "M001",
    sliceId: "S02",
    completedTaskIds: ["T01"],
  });
  insertSlice({
    id: "S03",
    milestoneId: "M001",
    title: "Blocked dependent slice",
    status: "pending",
    depends: ["S02"],
    sequence: 3,
  });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S03",
    title: "Blocked task",
    status: "pending",
    sequence: 1,
  });
}

function writeProjection(root: string, relativePath: string, content: string): void {
  const path = join(root, ".gsd", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeContradictoryProjection(root: string, committed: boolean): void {
  const s02Checked = committed ? " " : "x";
  const s03Checked = committed ? "x" : " ";
  writeProjection(
    root,
    "milestones/M001/M001-ROADMAP.md",
    [
      "# M001: Contradictory projection",
      "",
      "## Slices",
      "- [x] **S01: Completed prerequisite** `risk:low` `depends:[]`",
      `- [${s02Checked}] **S02: Ready dependent slice** \`risk:medium\` \`depends:[S01]\``,
      `- [${s03Checked}] **S03: Blocked dependent slice** \`risk:low\` \`depends:[S02]\``,
    ].join("\n"),
  );
  writeProjection(
    root,
    "STATE.md",
    [
      "# GSD State",
      "",
      `**Active Slice:** ${committed ? "S02" : "S03"}`,
      "**Phase:** executing",
    ].join("\n"),
  );
}

function armProductionFault(
  point: WorkflowFaultPoint,
  harness: WorkflowFaultHarness,
  root: string,
): void {
  if (point === "before-transaction-commit") {
    harness.armDatabaseAbort("status", "NEW.status = 'complete' AND OLD.status <> 'complete'");
  } else if (point === "after-db-commit-before-render") {
    harness.armDatabaseAbort("full_summary_md", "NEW.full_summary_md IS NOT OLD.full_summary_md");
  } else if (point === "during-projection-write") {
    const summaryPath = join(root, relSliceFile(root, "M001", "S02", "SUMMARY"));
    harness.obstructProjection(summaryPath);
  }
}

function runAuthorityProcess(
  root: string,
  dbPath: string,
  faultPoint?: WorkflowFaultPoint,
): SpawnSyncReturns<string> {
  const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
  const databaseModule = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const stateModule = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/state.ts")).href;
  const faultHarnessModule = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/tests/workflow-fault-harness.ts",
  )).href;
  const script = `
    const [
      { openDatabase, closeDatabase, getSlice, getTask },
      { deriveStateFromDb },
      { createWorkflowFaultHarness },
    ] = await Promise.all([
      import(${JSON.stringify(databaseModule)}),
      import(${JSON.stringify(stateModule)}),
      import(${JSON.stringify(faultHarnessModule)}),
    ]);
    const [root, dbPath, faultPoint] = process.argv.slice(-3);
    if (!openDatabase(dbPath)) throw new Error("fresh process could not open workflow database");
    if (faultPoint) {
      process.stderr.write("DATABASE_OPENED_BEFORE_FAULT=" + process.pid + "\\n");
      createWorkflowFaultHarness(faultPoint).hit(faultPoint, "fresh-process-reopen");
    }
    const state = await deriveStateFromDb(root);
    const snapshot = {
      pid: process.pid,
      taskStatus: getTask("M001", "S02", "T01")?.status ?? null,
      sliceStatus: getSlice("M001", "S02")?.status ?? null,
      activeSlice: state.activeSlice?.id ?? null,
    };
    closeDatabase();
    process.stdout.write("AUTHORITY_SNAPSHOT=" + JSON.stringify(snapshot) + "\\n");
  `;
  return spawnSync(
    process.execPath,
    [
      "--import",
      resolver,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
      root,
      dbPath,
      faultPoint ?? "",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function readAuthorityInFreshProcess(root: string, dbPath: string): AuthoritySnapshot {
  const child = runAuthorityProcess(root, dbPath);

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split("\n").find((entry) => entry.startsWith("AUTHORITY_SNAPSHOT="));
  assert.ok(line, `fresh process did not return an authority snapshot: ${child.stdout}`);
  return JSON.parse(line.slice("AUTHORITY_SNAPSHOT=".length)) as AuthoritySnapshot;
}

function runLifecycleReplayProcess(
  command: ReplayCommand,
  root: string,
  dbPath: string,
  params: unknown,
  invocation: ExecutionInvocation,
): SpawnSyncReturns<string> {
  const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
  const databaseModule = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const completionModule = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/tools/complete-slice.ts",
  )).href;
  const reopenModule = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/tools/reopen-slice.ts",
  )).href;
  const executorsModule = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/tools/workflow-tool-executors.ts",
  )).href;
  const script = `
    const [
      { openDatabase, closeDatabase },
      { handleCompleteSlice },
      { handleReopenSlice },
      { executeSkipSlice },
    ] = await Promise.all([
      import(${JSON.stringify(databaseModule)}),
      import(${JSON.stringify(completionModule)}),
      import(${JSON.stringify(reopenModule)}),
      import(${JSON.stringify(executorsModule)}),
    ]);
    const [command, root, dbPath, paramsJson, invocationJson] = process.argv.slice(-5);
    if (!openDatabase(dbPath)) throw new Error("fresh process could not open workflow database");
    const params = JSON.parse(paramsJson);
    const invocation = JSON.parse(invocationJson);
    let result;
    if (command === "complete") {
      result = await handleCompleteSlice(params, root, invocation);
    } else if (command === "reopen") {
      result = await handleReopenSlice(params, root, invocation);
    } else {
      result = await executeSkipSlice(params, root, invocation);
    }
    closeDatabase();
    process.stdout.write("REPLAY_RESULT=" + JSON.stringify({ pid: process.pid, result }) + "\\n");
  `;
  return spawnSync(
    process.execPath,
    [
      "--import",
      resolver,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
      command,
      root,
      dbPath,
      JSON.stringify(params),
      JSON.stringify(invocation),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function lifecycleLineageSnapshot(idempotencyKey: string): Record<string, unknown> {
  const db = _getAdapter();
  assert.ok(db, "workflow database must be open");
  const bindings = { ":idempotency_key": idempotencyKey };
  return {
    authority: db.prepare(
      "SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1",
    ).get(),
    operations: db.prepare(`
      SELECT * FROM workflow_operations
      WHERE idempotency_key = :idempotency_key
      ORDER BY resulting_revision
    `).all(bindings),
    events: db.prepare(`
      SELECT event.* FROM workflow_domain_events event
      JOIN workflow_operations operation ON operation.operation_id = event.operation_id
      WHERE operation.idempotency_key = :idempotency_key
      ORDER BY event.event_index
    `).all(bindings),
    outbox: db.prepare(`
      SELECT outbox.* FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      JOIN workflow_operations operation ON operation.operation_id = event.operation_id
      WHERE operation.idempotency_key = :idempotency_key
      ORDER BY outbox.outbox_id
    `).all(bindings),
    projections: db.prepare(`
      SELECT work.* FROM workflow_projection_work work
      JOIN workflow_operations operation ON operation.operation_id = work.enqueue_operation_id
      WHERE operation.idempotency_key = :idempotency_key
      ORDER BY work.projection_work_id
    `).all(bindings),
  };
}

function assertSingleLifecycleLineage(snapshot: Record<string, unknown>): void {
  for (const table of ["operations", "events", "outbox", "projections"] as const) {
    assert.equal((snapshot[table] as unknown[]).length, 1, `${table} must contain exactly one lineage row`);
  }
}

function parseReplayResult(replay: SpawnSyncReturns<string>): ReplayProcessResult {
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  const replayLine = replay.stdout.split("\n").find((line) => line.startsWith("REPLAY_RESULT="));
  assert.ok(replayLine, `fresh process did not return a replay result: ${replay.stdout}`);
  return JSON.parse(replayLine.slice("REPLAY_RESULT=".length)) as ReplayProcessResult;
}

for (const scenario of SCENARIOS) {
  test(`database authority remains coherent at ${scenario.point}`, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    seedCompletionBoundary();
    const harness = createWorkflowFaultHarness(scenario.point);
    armProductionFault(scenario.point, harness, fixture.root);

    let completionError: unknown;
    let completionStale = false;
    try {
      const result = await handleCompleteSlice(COMPLETE_SLICE_PARAMS, fixture.root);
      assert.ok(!("error" in result), "production completion must reach its mutation boundary");
      completionStale = result.stale === true;
      harness.hit("before-independent-reopen", "complete-dependent-slice");
    } catch (error) {
      completionError = error;
    }

    if (
      scenario.point === "after-db-commit-before-render"
      || scenario.point === "during-projection-write"
    ) {
      assert.equal(completionError, undefined, "post-commit projection failures must not undo completion");
      assert.equal(completionStale, true, "the production renderer must surface a stale projection");
    } else if (scenario.point === "after-independent-reopen") {
      assert.equal(completionError, undefined, "completion must succeed before the reopen fault");
      assert.equal(completionStale, false, "completion must not be stale before the reopen fault");
    } else {
      assert.match(String(completionError), new RegExp(scenario.point));
    }

    writeContradictoryProjection(fixture.root, scenario.committed);
    closeDatabase();
    if (scenario.point === "after-independent-reopen") {
      const faultedChild = runAuthorityProcess(fixture.root, fixture.dbPath, scenario.point);
      assert.notEqual(faultedChild.status, 0, "fresh process must fault after opening the database");
      assert.match(faultedChild.stderr, /DATABASE_OPENED_BEFORE_FAULT=/);
      assert.match(faultedChild.stderr, /after-independent-reopen/);
    }
    const snapshot = readAuthorityInFreshProcess(fixture.root, fixture.dbPath);
    fixture.reopen();

    const expectedStatus = scenario.committed ? "complete" : "pending";
    const { pid, ...authority } = snapshot;
    assert.notEqual(pid, process.pid, "authority must be verified by another process");
    assert.deepEqual(authority, {
      taskStatus: "complete",
      sliceStatus: expectedStatus,
      activeSlice: scenario.committed ? "S03" : "S02",
    });
    assert.equal(getTask("M001", "S02", "T01")?.status, "complete");
    assert.equal(getSlice("M001", "S02")?.status, expectedStatus);
  });
}

test("fresh-process exact replay repairs an obstructed Slice completion projection without duplicate authority", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedCompletionBoundary();
  const idempotencyKey = "test/workflow-authority-faults/fresh-process-projection-repair";
  const invocation = internalExecutionInvocation(idempotencyKey);
  const summaryPath = join(fixture.root, relSliceFile(fixture.root, "M001", "S02", "SUMMARY"));
  createWorkflowFaultHarness("during-projection-write").obstructProjection(summaryPath);

  const committed = await handleCompleteSlice(COMPLETE_SLICE_PARAMS, fixture.root, invocation);
  assert.ok(!("error" in committed), "completion must commit before projection repair");
  assert.equal(committed.stale, true, "the obstructed first render must be reported stale");
  assert.throws(() => readFileSync(summaryPath, "utf8"), /EISDIR|illegal operation on a directory/i);
  const committedLineage = lifecycleLineageSnapshot(idempotencyKey);
  assertSingleLifecycleLineage(committedLineage);

  discardProjectionEvidence(fixture.root);
  rmSync(summaryPath, { recursive: true });
  closeDatabase();
  const replay = runLifecycleReplayProcess(
    "complete",
    fixture.root,
    fixture.dbPath,
    COMPLETE_SLICE_PARAMS,
    invocation,
  );
  const replayResult = parseReplayResult(replay);
  assert.notEqual(replayResult.pid, process.pid, "repair must execute in a fresh process");
  assert.equal(replayResult.result.error, undefined);
  assert.equal(replayResult.result.duplicate, true);
  assert.equal(replayResult.result.stale, undefined);

  fixture.reopen();
  assert.deepEqual(
    lifecycleLineageSnapshot(idempotencyKey),
    committedLineage,
    "fresh replay must not advance revision or duplicate operation lineage",
  );
  assert.match(readFileSync(summaryPath, "utf8"), /database records the completed slice/i);
  assert.ok(replayResult.result.uatPath, "replay must return the durable UAT projection path");
  assert.match(readFileSync(replayResult.result.uatPath, "utf8"), /Passed\./);
});

test("fresh-process exact replay repairs an obstructed Slice cancellation projection without duplicate authority", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  const params = {
    milestoneId: "M001",
    sliceId: "S02",
    reason: "Cancel the remaining Slice work.",
  };
  const idempotencyKey = "test/workflow-authority-faults/fresh-process-cancel-repair";
  const invocation = internalExecutionInvocation(idempotencyKey);
  const statePath = join(fixture.root, ".gsd", "STATE.md");
  mkdirSync(statePath, { recursive: true });

  const committed = await executeSkipSlice(params, fixture.root, invocation);
  assert.equal(committed.isError, undefined);
  assert.equal(committed.details.stale, true, "the obstructed first render must be reported stale");
  const committedLineage = lifecycleLineageSnapshot(idempotencyKey);
  assertSingleLifecycleLineage(committedLineage);

  discardProjectionEvidence(fixture.root);
  rmSync(statePath, { recursive: true });
  closeDatabase();
  const replay = runLifecycleReplayProcess(
    "cancel",
    fixture.root,
    fixture.dbPath,
    params,
    invocation,
  );
  const replayResult = parseReplayResult(replay);
  assert.notEqual(replayResult.pid, process.pid, "repair must execute in a fresh process");
  assert.equal(replayResult.result.error, undefined);
  assert.equal(replayResult.result.details?.stale, undefined);

  fixture.reopen();
  assert.deepEqual(
    lifecycleLineageSnapshot(idempotencyKey),
    committedLineage,
    "fresh replay must not advance revision or duplicate operation lineage",
  );
  assert.match(readFileSync(statePath, "utf8"), /S02/);
  assert.equal(getSlice("M001", "S02")?.status, "skipped");
  assert.equal(getTask("M001", "S02", "T01")?.status, "skipped");
});

test("fresh-process exact replay repairs obstructed Slice reopen projections without duplicate authority", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedCompletionBoundary();
  const completed = await handleCompleteSlice(
    COMPLETE_SLICE_PARAMS,
    fixture.root,
    internalExecutionInvocation("test/workflow-authority-faults/reopen-prerequisite"),
  );
  assert.ok(!("error" in completed));
  const summaryPath = join(fixture.root, relSliceFile(fixture.root, "M001", "S02", "SUMMARY"));
  assert.ok(completed.uatPath);
  const uatPath = completed.uatPath;
  rmSync(summaryPath, { force: true });
  mkdirSync(summaryPath);
  const params = {
    milestoneId: "M001",
    sliceId: "S02",
    reason: "Redo the completed Slice.",
  };
  const idempotencyKey = "test/workflow-authority-faults/fresh-process-reopen-repair";
  const invocation = internalExecutionInvocation(idempotencyKey);

  const committed = await handleReopenSlice(params, fixture.root, invocation);
  assert.ok(!("error" in committed));
  assert.equal(committed.stale, true, "the obstructed first cleanup must be reported stale");
  const committedLineage = lifecycleLineageSnapshot(idempotencyKey);
  assertSingleLifecycleLineage(committedLineage);

  closeDatabase();
  rmSync(summaryPath, { recursive: true, force: true });
  const replay = runLifecycleReplayProcess(
    "reopen",
    fixture.root,
    fixture.dbPath,
    params,
    invocation,
  );
  const replayResult = parseReplayResult(replay);
  assert.notEqual(replayResult.pid, process.pid, "repair must execute in a fresh process");
  assert.equal(replayResult.result.error, undefined);
  assert.equal(replayResult.result.stale, undefined);

  fixture.reopen();
  assert.deepEqual(
    lifecycleLineageSnapshot(idempotencyKey),
    committedLineage,
    "fresh replay must not advance revision or duplicate operation lineage",
  );
  assert.equal(getSlice("M001", "S02")?.status, "in_progress");
  assert.equal(getTask("M001", "S02", "T01")?.status, "pending");
  assert.throws(() => readFileSync(summaryPath, "utf8"), /ENOENT/);
  assert.throws(() => readFileSync(uatPath, "utf8"), /ENOENT/);
});
