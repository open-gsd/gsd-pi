// Project/App: gsd-pi
// File Purpose: Executable contract for atomic, replay-safe planning Domain Operations.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  _getAdapter,
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { canonicalPhaseDirName } from "../paths.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "../db/writers/lifecycle-commands.ts";
import {
  handlePlanMilestone,
  type PlanMilestoneParams,
  type PlanMilestoneResult,
} from "../tools/plan-milestone.ts";
import {
  handlePlanSlice,
  type PlanSliceParams,
  type PlanSliceResult,
} from "../tools/plan-slice.ts";
import {
  handlePlanTask,
  type PlanTaskParams,
  type PlanTaskResult,
} from "../tools/plan-task.ts";
import {
  handleReplanSlice,
  type ReplanSliceParams,
  type ReplanSliceResult,
} from "../tools/replan-slice.ts";
import {
  handleReplanTask,
  type ReplanTaskParams,
  type ReplanTaskResult,
} from "../tools/replan-task.ts";

interface PlanningInvocation {
  idempotencyKey: string;
  sourceTransport: "pi-tool" | "workflow-mcp" | "internal";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

type PlanningHandler<P, R> = (
  params: P,
  basePath: string,
  invocation: PlanningInvocation,
) => Promise<R | { error: string }>;

const tempDirs = new Set<string>();

function makeFixture(): { base: string; dbPath: string } {
  const createdBase = mkdtempSync(join(tmpdir(), "gsd-planning-domain-"));
  tempDirs.add(createdBase);
  const base = realpathSync(createdBase);
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "input.ts"), "export const input = true;\n");
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  return { base, dbPath };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function setLegacyTaskStatus(taskId: string, status: string, completedAt: string | null = null): void {
  db().prepare(`
    UPDATE tasks SET status = :status, completed_at = :completed_at
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :task_id
  `).run({ ":status": status, ":completed_at": completedAt, ":task_id": taskId });
}

function setLegacySliceStatus(sliceId: string, status: string): void {
  db().prepare(`
    UPDATE slices SET status = :status
    WHERE milestone_id = 'M001' AND id = :slice_id
  `).run({ ":status": status, ":slice_id": sliceId });
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`)["count"] ?? 0);
}

function invocation(key: string, sourceTransport: PlanningInvocation["sourceTransport"] = "pi-tool"): PlanningInvocation {
  return {
    idempotencyKey: key,
    sourceTransport,
    actorType: "agent",
    actorId: "planning-test",
    traceId: "trace-planning",
    turnId: "turn-planning",
  };
}

async function invoke<P, R>(
  handler: PlanningHandler<P, R>,
  params: P,
  basePath: string,
  envelope: PlanningInvocation,
): Promise<R | { error: string }> {
  return handler(params, basePath, envelope);
}

function assertSuccess<R>(result: R | { error: string }): asserts result is R {
  assert.ok(!("error" in (result as object)), `unexpected error: ${"error" in (result as object) ? (result as { error: string }).error : ""}`);
}

function milestoneParams(): PlanMilestoneParams {
  return {
    milestoneId: "M001",
    title: "Atomic planning",
    vision: "Planning writes one durable authority transaction.",
    successCriteria: ["Canonical planning state is durable"],
    slices: [
      {
        sliceId: "S01",
        title: "Fully planned slice",
        risk: "medium",
        depends: [],
        demo: "The planned slice is ready.",
        goal: "Persist a complete slice plan.",
        successCriteria: "The slice is ready for task planning.",
        proofLevel: "integration",
        integrationClosure: "The roadmap response remains compatible.",
        observabilityImpact: "Domain events expose the planning mutation.",
      },
      {
        sliceId: "S02",
        title: "Sketch slice",
        risk: "low",
        depends: ["S01"],
        demo: "The sketch remains pending.",
        goal: "Reserve later scope.",
        successCriteria: "",
        proofLevel: "",
        integrationClosure: "",
        observabilityImpact: "",
        isSketch: true,
        sketchScope: "Explore the later integration without promoting it to ready.",
      },
    ],
  };
}

function taskParams(taskId = "T01", title = "Plan authority writer"): PlanTaskParams {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
    title,
    description: "Persist legacy planning and canonical lifecycle state together.",
    estimate: "45m",
    files: ["src/planning.ts"],
    verify: "node --test planning.test.ts",
    inputs: ["src/input.ts"],
    expectedOutput: ["src/planning.ts"],
    observabilityImpact: "The operation records a semantic event.",
  };
}

function seedPlanningParents(): void {
  insertMilestone({ id: "M001", title: "Existing milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Existing slice",
    status: "pending",
    demo: "Planning output is projected.",
  });
}

function lifecycleSnapshot(): Array<Record<string, unknown>> {
  return rows(`
    SELECT item_kind, milestone_id, slice_id, task_id, lifecycle_status,
           state_version, last_operation_id, last_project_revision
    FROM workflow_item_lifecycles
    ORDER BY item_kind, milestone_id, slice_id, task_id
  `);
}

function assertNoInventedExecutionHistory(): void {
  for (const table of [
    "workflow_execution_attempts",
    "workflow_attempt_results",
    "workflow_kernel_checkpoints",
    "workflow_blockers",
    "workflow_waivers",
    "workflow_requirement_dispositions",
  ]) {
    assert.equal(count(table), 0, `${table} must remain empty during planning adoption`);
  }
}

type TestLifecycleIdentity = {
  itemKind: "milestone" | "slice" | "task";
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
};

function transitionTestLifecycle(
  identity: TestLifecycleIdentity,
  lifecycleStatus: CanonicalLifecycleStatus,
  key: string,
): void {
  const fence = readDomainOperationFence();
  const operationType = identity.itemKind === "milestone" && lifecycleStatus === "completed"
    ? "milestone.complete"
    : `test.lifecycle.${lifecycleStatus}`;
  executeDomainOperation({
    operationType,
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { ...identity, lifecycleStatus },
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus });
    return {
      events: [{
        eventType: `test.lifecycle.${lifecycleStatus}`,
        entityType: identity.itemKind,
        entityId: key,
        payload: { lifecycleStatus },
        destinations: ["test"],
      }],
      projections: [{ projectionKey: key.toLowerCase(), projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function completeTestLifecycle(identity: TestLifecycleIdentity, key: string): void {
  transitionTestLifecycle(identity, "ready", `${key}/ready`);
  transitionTestLifecycle(identity, "in_progress", `${key}/in-progress`);
  transitionTestLifecycle(identity, "completed", `${key}/completed`);
}

function runPlanningChild(base: string, dbPath: string, params: PlanTaskParams, envelope: PlanningInvocation): Promise<unknown> {
  const dbModule = pathToFileURL(join(import.meta.dirname, "..", "gsd-db.ts")).href;
  const handlerModule = pathToFileURL(join(import.meta.dirname, "..", "tools", "plan-task.ts")).href;
  const script = `
    (async () => {
      const { openDatabase, closeDatabase } = await import(${JSON.stringify(dbModule)});
      const { handlePlanTask } = await import(${JSON.stringify(handlerModule)});
      openDatabase(${JSON.stringify(dbPath)});
      try {
        const result = await handlePlanTask(
          ${JSON.stringify(params)},
          ${JSON.stringify(base)},
          ${JSON.stringify(envelope)},
        );
        process.stdout.write(JSON.stringify(result));
      } finally {
        closeDatabase();
      }
    })().catch((error) => {
      process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`planning child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`planning child returned invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("fresh milestone planning keeps its public response and atomically adopts ready and sketch lifecycles", async () => {
  const { base } = makeFixture();
  const result = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    milestoneParams(),
    base,
    invocation("plan-milestone/call-1"),
  );
  assertSuccess(result);

  assert.deepEqual(result, {
    milestoneId: "M001",
    roadmapPath: join(base, ".gsd", "phases", canonicalPhaseDirName("M001", "Atomic planning"), "01-ROADMAP.md"),
  });
  assert.deepEqual(rows(`
    SELECT item_kind, milestone_id, slice_id, lifecycle_status, state_version
    FROM workflow_item_lifecycles
    ORDER BY item_kind, slice_id
  `), [
    { item_kind: "milestone", milestone_id: "M001", slice_id: null, lifecycle_status: "ready", state_version: 0 },
    { item_kind: "slice", milestone_id: "M001", slice_id: "S01", lifecycle_status: "ready", state_version: 0 },
    { item_kind: "slice", milestone_id: "M001", slice_id: "S02", lifecycle_status: "pending", state_version: 0 },
  ]);
  assert.equal(count("workflow_operations"), 1);
  assert.equal(count("workflow_domain_events"), 1);
  assert.ok(count("workflow_projection_work") >= 1);
  assertNoInventedExecutionHistory();
});

for (const status of ["complete", "skipped"]) {
  test(`fresh milestone planning rejects terminal legacy status ${status} without creating authority`, async () => {
    const { base } = makeFixture();

    const result = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
      handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
      { ...milestoneParams(), status },
      base,
      invocation(`plan-milestone/terminal-status/${status}`),
    );

    assert.deepEqual(result, {
      error: `cannot plan milestone M001 with terminal status ${status}`,
    });
    assert.equal(count("milestones"), 0);
    assert.equal(count("slices"), 0);
    assert.equal(count("workflow_item_lifecycles"), 0);
    assert.equal(count("workflow_operations"), 0);
    assert.equal(count("workflow_domain_events"), 0);
  });
}

test("milestone replanning rejects omitted pending slices without changing authority", async () => {
  const { base } = makeFixture();
  assertSuccess(await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    milestoneParams(),
    base,
    invocation("plan-milestone/before-omission"),
  ));
  const before = {
    hierarchy: rows("SELECT id, title, status FROM slices ORDER BY sequence, id"),
    lifecycles: lifecycleSnapshot(),
    operations: count("workflow_operations"),
  };

  const result = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    { ...milestoneParams(), slices: milestoneParams().slices.filter((slice) => slice.sliceId !== "S02") },
    base,
    invocation("plan-milestone/omit-pending"),
  );

  assert.deepEqual(result, {
    error: "cannot re-plan milestone M001: pending slice S02 would be dropped. Use gsd_reassess_roadmap to remove it.",
  });
  assert.deepEqual({
    hierarchy: rows("SELECT id, title, status FROM slices ORDER BY sequence, id"),
    lifecycles: lifecycleSnapshot(),
    operations: count("workflow_operations"),
  }, before);
});

test("milestone replanning omits durably cancelled slices without deleting their history", async () => {
  const { base } = makeFixture();
  assertSuccess(await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    milestoneParams(),
    base,
    invocation("plan-milestone/before-cancelled-omission"),
  ));
  transitionTestLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02" },
    "cancelled",
    "test/slice/cancelled-before-milestone-replan",
  );
  setLegacySliceStatus("S02", "skipped");

  const result = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    { ...milestoneParams(), slices: milestoneParams().slices.filter((slice) => slice.sliceId !== "S02") },
    base,
    invocation("plan-milestone/omit-cancelled"),
  );

  assertSuccess(result);
  assert.deepEqual(row("SELECT id, status FROM slices WHERE milestone_id = 'M001' AND id = 'S02'"), {
    id: "S02",
    status: "skipped",
  });
  assert.deepEqual(
    row("SELECT lifecycle_status, state_version FROM workflow_item_lifecycles WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S02'"),
    { lifecycle_status: "cancelled", state_version: 1 },
  );
  assert.doesNotMatch(readFileSync(result.roadmapPath, "utf8"), /S02|Sketch slice/);

  const rejectedReuse = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
    handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
    milestoneParams(),
    base,
    invocation("plan-milestone/reuse-cancelled"),
  );
  assert.ok("error" in rejectedReuse);
  assert.match(rejectedReuse.error, /cancelled slice S02.*gsd_slice_reopen/i);
});

for (const itemKind of ["milestone", "slice"] as const) {
  test(`milestone planning rejects canonically completed ${itemKind} despite open legacy drift`, async () => {
    const { base } = makeFixture();
    assertSuccess(await invoke<PlanMilestoneParams, PlanMilestoneResult>(
      handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
      milestoneParams(),
      base,
      invocation(`plan-milestone/seed-completed-${itemKind}`),
    ));
    completeTestLifecycle({
      itemKind,
      milestoneId: "M001",
      ...(itemKind === "slice" ? { sliceId: "S01" } : {}),
    }, `test/${itemKind}`);
    db().prepare(
      itemKind === "milestone"
        ? "UPDATE milestones SET status = 'active' WHERE id = 'M001'"
        : "UPDATE slices SET status = 'pending' WHERE milestone_id = 'M001' AND id = 'S01'",
    ).run();
    const before = {
      hierarchy: rows("SELECT id, title, status FROM milestones UNION ALL SELECT id, title, status FROM slices ORDER BY id"),
      lifecycles: lifecycleSnapshot(),
      operations: count("workflow_operations"),
    };

    const result = await invoke<PlanMilestoneParams, PlanMilestoneResult>(
      handlePlanMilestone as PlanningHandler<PlanMilestoneParams, PlanMilestoneResult>,
      { ...milestoneParams(), title: "Must not overwrite terminal authority" },
      base,
      invocation(`plan-milestone/reject-completed-${itemKind}`),
    );
    assert.ok("error" in result);
    assert.match(result.error, new RegExp(`completed ${itemKind}.*reopen|cannot re-plan ${itemKind}`, "i"));
    assert.deepEqual({
      hierarchy: rows("SELECT id, title, status FROM milestones UNION ALL SELECT id, title, status FROM slices ORDER BY id"),
      lifecycles: lifecycleSnapshot(),
      operations: count("workflow_operations"),
    }, before);
  });
}

test("slice and task planning preserve response shapes while promoting complete plans to ready", async () => {
  const { base } = makeFixture();
  seedPlanningParents();

  const sliceParams: PlanSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Break the slice into executable tasks.",
    successCriteria: "Every task has executable verification.",
    proofLevel: "integration",
    integrationClosure: "Task plans are projected from the database.",
    observabilityImpact: "Planning operations are queryable.",
    tasks: [taskParams("T01")],
  };
  const sliceResult = await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    sliceParams,
    base,
    invocation("plan-slice/call-1", "workflow-mcp"),
  );
  assertSuccess(sliceResult);
  assert.deepEqual(Object.keys(sliceResult).sort(), ["milestoneId", "planPath", "sliceId", "taskPlanPaths"]);

  const taskResult = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams("T02", "Add replay coverage"),
    base,
    invocation("plan-task/call-1", "internal"),
  );
  assertSuccess(taskResult);
  assert.deepEqual(Object.keys(taskResult).sort(), ["milestoneId", "sliceId", "taskId", "taskPlanPath"]);

  assert.deepEqual(rows(`
    SELECT item_kind, task_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE item_kind IN ('slice', 'task')
    ORDER BY item_kind, task_id
  `), [
    { item_kind: "slice", task_id: null, lifecycle_status: "ready" },
    { item_kind: "task", task_id: "T01", lifecycle_status: "ready" },
    { item_kind: "task", task_id: "T02", lifecycle_status: "ready" },
  ]);
  assert.equal(count("workflow_operations"), 2);
  assertNoInventedExecutionHistory();
});

test("incremental task planning promotes pending task and parent lifecycles", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    { milestoneId: "M001", sliceId: "S01", goal: "Plan incrementally." },
    base,
    invocation("plan-slice/incremental-metadata"),
  ));
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Reserved task",
    status: "pending",
  });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.reserve",
    idempotencyKey: "test/task/reserve",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "pending",
    });
    return {
      events: [{ eventType: "test.task.reserved", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/m001/s01/t01", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  assertSuccess(await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams(),
    base,
    invocation("plan-task/promote-incremental"),
  ));

  assert.deepEqual(rows(`
    SELECT item_kind, lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind IN ('slice', 'task')
    ORDER BY item_kind
  `), [
    { item_kind: "slice", lifecycle_status: "ready", state_version: 1 },
    { item_kind: "task", lifecycle_status: "ready", state_version: 1 },
  ]);
});

for (const terminalStatus of ["completed", "cancelled"] as const) {
  test(`task planning rejects canonical ${terminalStatus} task and parent drift`, async () => {
    const { base } = makeFixture();
    seedPlanningParents();
    assertSuccess(await invoke<PlanTaskParams, PlanTaskResult>(
      handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
      taskParams(),
      base,
      invocation(`plan-task/seed-${terminalStatus}`),
    ));
    const taskIdentity = { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01" };
    const sliceIdentity = { itemKind: "slice" as const, milestoneId: "M001", sliceId: "S01" };
    if (terminalStatus === "completed") completeTestLifecycle(taskIdentity, "test/task");
    else transitionTestLifecycle(taskIdentity, terminalStatus, `test/task/${terminalStatus}`);
    setLegacyTaskStatus("T01", "pending");
    const taskResult = await invoke<PlanTaskParams, PlanTaskResult>(
      handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
      { ...taskParams(), title: "Must not overwrite terminal task" },
      base,
      invocation(`plan-task/reject-${terminalStatus}-task`),
    );
    assert.ok("error" in taskResult);
    assert.match(taskResult.error, new RegExp(`${terminalStatus} task T01.*reopen`, "i"));

    if (terminalStatus === "completed") completeTestLifecycle(sliceIdentity, "test/slice");
    else transitionTestLifecycle(sliceIdentity, terminalStatus, `test/slice/${terminalStatus}`);
    setLegacySliceStatus("S01", "active");
    const parentResult = await invoke<PlanTaskParams, PlanTaskResult>(
      handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
      taskParams("T02"),
      base,
      invocation(`plan-task/reject-${terminalStatus}-parent`),
    );
    assert.ok("error" in parentResult);
    assert.match(parentResult.error, new RegExp(`${terminalStatus} slice S01.*reopen`, "i"));
  });
}

test("planning events durably record lifecycle shadow comparisons", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  assertSuccess(await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams(),
    base,
    invocation("plan-task/shadow-comparison"),
  ));

  const event = row("SELECT payload_json FROM workflow_domain_events WHERE event_type = 'workflow.task.planned'");
  const payload = JSON.parse(String(event["payload_json"])) as {
    lifecycleShadowComparisons: Array<Record<string, unknown>>;
  };
  assert.deepEqual(payload.lifecycleShadowComparisons.map((comparison) => ({
    itemKind: comparison["itemKind"],
    legacyStatus: comparison["legacyStatus"],
    canonicalStatus: comparison["canonicalStatus"],
    kind: comparison["kind"],
  })), [
    { itemKind: "slice", legacyStatus: "pending", canonicalStatus: "ready", kind: "semantic_match_exact_delta" },
    { itemKind: "task", legacyStatus: "pending", canonicalStatus: "ready", kind: "semantic_match_exact_delta" },
  ]);
});

test("slice planning promotes only pending lifecycle state and rejects cancelled identity without residue", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const metadataOnly: PlanSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Capture slice metadata before task decomposition.",
  };
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    metadataOnly,
    base,
    invocation("plan-slice/metadata"),
  ));
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
  `), { lifecycle_status: "pending", state_version: 0 });

  const fullPlan = { ...metadataOnly, tasks: [taskParams("T01")] };
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    fullPlan,
    base,
    invocation("plan-slice/promote-ready"),
  ));
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
  `), { lifecycle_status: "ready", state_version: 1 });

  const transition = (status: CanonicalLifecycleStatus, key: string) => {
    const fence = readDomainOperationFence();
    return executeDomainOperation({
      operationType: `test.slice.${status}`,
      idempotencyKey: key,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "agent",
      sourceTransport: "test",
      payload: { status },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: status,
      });
      return {
        events: [{
          eventType: `test.slice.${status}`,
          entityType: "slice",
          entityId: "M001/S01",
          payload: { status },
          destinations: ["projection"],
        }],
        projections: [{ projectionKey: "test/m001/s01", projectionKind: "markdown", rendererVersion: "v1" }],
      };
    });
  };
  transition("in_progress", "test/slice/in-progress");
  const activeBefore = lifecycleSnapshot();
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    { ...fullPlan, goal: "Replan metadata without rewinding active work." },
    base,
    invocation("plan-slice/preserve-active"),
  ));
  assert.deepEqual(lifecycleSnapshot().find((entry) => entry["item_kind"] === "slice"),
    activeBefore.find((entry) => entry["item_kind"] === "slice"));

  transition("cancelled", "test/slice/cancelled");
  setLegacySliceStatus("S01", "pending");
  const beforeRejectedReuse = {
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    operations: count("workflow_operations"),
    lifecycles: lifecycleSnapshot(),
  };
  const rejected = await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    metadataOnly,
    base,
    invocation("plan-slice/reuse-cancelled"),
  );
  assert.ok("error" in rejected);
  assert.match(rejected.error, /cancelled slice S01.*gsd_slice_reopen/i);
  assert.deepEqual({
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    operations: count("workflow_operations"),
    lifecycles: lifecycleSnapshot(),
  }, beforeRejectedReuse);
});

test("slice planning rejects canonically completed slice despite pending legacy drift", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const metadata: PlanSliceParams = { milestoneId: "M001", sliceId: "S01", goal: "Seed planning." };
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    metadata,
    base,
    invocation("plan-slice/seed-completed"),
  ));
  completeTestLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "test/slice/plan");
  setLegacySliceStatus("S01", "pending");

  const result = await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    { ...metadata, goal: "Must not overwrite completion." },
    base,
    invocation("plan-slice/reject-completed"),
  );
  assert.ok("error" in result);
  assert.match(result.error, /completed slice S01.*reopen/i);
});

test("slice planning rejects canonically completed tasks before updating or omitting them", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const plan: PlanSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Seed task planning.",
    tasks: [taskParams()],
  };
  assertSuccess(await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    plan,
    base,
    invocation("plan-slice/seed-completed-task"),
  ));
  completeTestLifecycle({
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }, "test/task/slice-plan");
  setLegacyTaskStatus("T01", "pending");

  for (const tasks of [[taskParams("T01", "Must not update")], [taskParams("T02", "Must not omit T01")]]) {
    const result = await invoke<PlanSliceParams, PlanSliceResult>(
      handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
      { ...plan, tasks },
      base,
      invocation(`plan-slice/reject-completed-task-${tasks[0]!.taskId}`),
    );
    assert.ok("error" in result);
    assert.match(result.error, /completed task T01/i);
  }
});

test("an exact lost-response retry replays after restart and an unrelated revision advance", async () => {
  const { base, dbPath } = makeFixture();
  seedPlanningParents();
  const envelope = invocation("plan-task/lost-response");
  const first = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>, taskParams(), base, envelope,
  );
  assertSuccess(first);

  const unrelated = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams("T02", "Unrelated task"),
    base,
    invocation("plan-task/unrelated"),
  );
  assertSuccess(unrelated);
  assert.equal(count("workflow_operations"), 2, "each fresh invocation must commit one Domain Operation");
  assert.equal(
    rows("SELECT task_id FROM workflow_item_lifecycles WHERE item_kind = 'task'").length,
    2,
    "both task plans must have canonical lifecycle heads before replay",
  );
  const beforeReplay = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    lifecycles: lifecycleSnapshot(),
  };

  closeDatabase();
  assert.equal(openDatabase(dbPath), true);
  const replay = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>, taskParams(), base, envelope,
  );
  assert.deepEqual(replay, first);
  assert.deepEqual({
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    lifecycles: lifecycleSnapshot(),
  }, beforeReplay);
  const legacyEvents = readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(legacyEvents.length, 2, "an exact replay must not append a duplicate legacy JSONL event");
});

test("the same invocation key rejects changed planning semantics without residue", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const envelope = invocation("plan-task/stable-call");
  const first = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>, taskParams(), base, envelope,
  );
  assertSuccess(first);
  const before = lifecycleSnapshot();

  const conflict = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams("T01", "Changed semantics"),
    base,
    envelope,
  );
  assert.ok("error" in conflict);
  assert.match(conflict.error, /idempotency|semantics|request|conflict/i);
  assert.equal(getTask("M001", "S01", "T01")?.title, "Plan authority writer");
  assert.equal(count("workflow_operations"), 1);
  assert.deepEqual(lifecycleSnapshot(), before);
});

test("two processes racing the same invocation fence commit once and return one compatible result", async () => {
  const { base, dbPath } = makeFixture();
  seedPlanningParents();
  closeDatabase();
  const params = taskParams();
  const envelope = invocation("plan-task/two-process-race", "internal");

  const [left, right] = await Promise.all([
    runPlanningChild(base, dbPath, params, envelope),
    runPlanningChild(base, dbPath, params, envelope),
  ]);
  assert.ok(!(left && typeof left === "object" && "error" in left), `left racer failed: ${JSON.stringify(left)}`);
  assert.ok(!(right && typeof right === "object" && "error" in right), `right racer failed: ${JSON.stringify(right)}`);
  assert.deepEqual(left, right);

  assert.equal(openDatabase(dbPath), true);
  assert.equal(count("workflow_operations"), 1);
  assert.equal(count("workflow_domain_events"), 1);
  assert.equal(count("workflow_projection_work"), 1);
  assert.deepEqual(rows(`
    SELECT task_id, lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
  `), [{ task_id: "T01", lifecycle_status: "ready", state_version: 0 }]);
});

test("task replanning preserves lifecycle provenance while recording ordered history and the legacy response", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const planned = await invoke<PlanTaskParams, PlanTaskResult>(
    handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
    taskParams(),
    base,
    invocation("plan-task/before-replan"),
  );
  assertSuccess(planned);
  const lifecycleBefore = lifecycleSnapshot();

  const params: ReplanTaskParams = {
    ...taskParams(),
    title: "Replanned authority writer",
    description: "Keep canonical lifecycle history stable while changing metadata.",
    reworkBriefRef: "RB-001",
  };
  const result = await invoke<ReplanTaskParams, ReplanTaskResult>(
    handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
    params,
    base,
    invocation("replan-task/call-1"),
  );
  assertSuccess(result);
  assert.deepEqual(result, {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    taskPlanPath: planned.taskPlanPath,
  });
  const lifecycleAfter = lifecycleSnapshot();
  assert.deepEqual(
    lifecycleAfter.find((entry) => entry["item_kind"] === "task"),
    lifecycleBefore.find((entry) => entry["item_kind"] === "task"),
    "task lifecycle provenance must remain unchanged",
  );
  const adoptedParent = lifecycleAfter.find((entry) => entry["item_kind"] === "slice");
  assert.deepEqual({
    item_kind: adoptedParent?.["item_kind"],
    milestone_id: adoptedParent?.["milestone_id"],
    slice_id: adoptedParent?.["slice_id"],
    task_id: adoptedParent?.["task_id"],
    lifecycle_status: adoptedParent?.["lifecycle_status"],
    state_version: adoptedParent?.["state_version"],
    last_project_revision: adoptedParent?.["last_project_revision"],
  }, {
    item_kind: "slice",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    lifecycle_status: "ready",
    state_version: 0,
    last_project_revision: 1,
  }, "task planning must promote its parent without changing task replan provenance");
  assert.equal(typeof adoptedParent?.["last_operation_id"], "string");
  assert.deepEqual(rows(`SELECT task_id, summary, previous_artifact_path FROM replan_history ORDER BY id`), [{
    task_id: "T01",
    summary: "Task T01 replanned from rework brief RB-001",
    previous_artifact_path: "RB-001",
  }]);
  assert.equal(count("workflow_operations"), 2);
  assertNoInventedExecutionHistory();

  const afterCommit = {
    task: getTask("M001", "S01", "T01"),
    history: rows(`SELECT * FROM replan_history ORDER BY id`),
    operations: rows(`SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision`),
    lifecycles: lifecycleSnapshot(),
    events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
  };
  const replay = await invoke<ReplanTaskParams, ReplanTaskResult>(
    handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
    params,
    base,
    invocation("replan-task/call-1"),
  );
  assert.deepEqual(replay, result, "a lost-response retry must return the exact legacy response");
  assert.deepEqual({
    task: getTask("M001", "S01", "T01"),
    history: rows(`SELECT * FROM replan_history ORDER BY id`),
    operations: rows(`SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision`),
    lifecycles: lifecycleSnapshot(),
    events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
  }, afterCommit, "an exact retry must not duplicate task, history, operation, lifecycle, or JSONL state");

  const conflict = await invoke<ReplanTaskParams, ReplanTaskResult>(
    handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
    { ...params, title: "Conflicting reuse" },
    base,
    invocation("replan-task/call-1"),
  );
  assert.ok("error" in conflict);
  assert.match(conflict.error, /idempotency (?:key )?conflict/i);
  assert.deepEqual({
    task: getTask("M001", "S01", "T01"),
    history: rows(`SELECT * FROM replan_history ORDER BY id`),
    operations: rows(`SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision`),
    lifecycles: lifecycleSnapshot(),
    events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
  }, afterCommit, "changed semantics under the same invocation key must leave no residue");
});

test("task replanning adopts legacy lifecycle statuses through the shared normalizer", async () => {
  const { base } = makeFixture();
  insertMilestone({ id: "M001", title: "Existing milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Active slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Active task", status: "active" });

  const result = await invoke<ReplanTaskParams, ReplanTaskResult>(
    handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
    { ...taskParams(), title: "Replanned active task" },
    base,
    invocation("replan-task/adopt-active"),
  );
  assertSuccess(result);
  assert.deepEqual(rows(`
    SELECT item_kind, lifecycle_status, state_version
    FROM workflow_item_lifecycles
    ORDER BY item_kind
  `), [
    { item_kind: "slice", lifecycle_status: "in_progress", state_version: 0 },
    { item_kind: "task", lifecycle_status: "in_progress", state_version: 0 },
  ]);
});

for (const terminalStatus of ["completed", "cancelled"] as const) {
  test(`task replanning rejects canonical ${terminalStatus} despite pending legacy drift without residue`, async () => {
    const { base } = makeFixture();
    seedPlanningParents();
    assertSuccess(await invoke<PlanTaskParams, PlanTaskResult>(
      handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
      taskParams(),
      base,
      invocation(`plan-task/before-${terminalStatus}-replan`),
    ));

    const taskIdentity = { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01" };
    if (terminalStatus === "completed") completeTestLifecycle(taskIdentity, "test/replan-task/completed");
    else transitionTestLifecycle(taskIdentity, terminalStatus, "test/replan-task/cancelled");
    setLegacyTaskStatus("T01", "pending");

    const before = {
      authority: row("SELECT revision, authority_epoch FROM project_authority"),
      task: getTask("M001", "S01", "T01"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: lifecycleSnapshot(),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    };
    const rejected = await invoke<ReplanTaskParams, ReplanTaskResult>(
      handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
      {
        ...taskParams(),
        title: `Must not replace ${terminalStatus} authority`,
        description: `Legacy drift cannot reopen canonical ${terminalStatus}.`,
      },
      base,
      invocation(`replan-task/reject-${terminalStatus}`),
    );
    assert.ok("error" in rejected);
    assert.match(rejected.error, new RegExp(`${terminalStatus} task T01.*gsd_task_reopen`, "i"));
    assert.deepEqual({
      authority: row("SELECT revision, authority_epoch FROM project_authority"),
      task: getTask("M001", "S01", "T01"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: lifecycleSnapshot(),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    }, before);
  });
}

for (const terminalStatus of ["completed", "cancelled"] as const) {
  test(`task replanning rejects canonical ${terminalStatus} parent despite open legacy drift without residue`, async () => {
    const { base } = makeFixture();
    seedPlanningParents();
    assertSuccess(await invoke<PlanTaskParams, PlanTaskResult>(
      handlePlanTask as PlanningHandler<PlanTaskParams, PlanTaskResult>,
      taskParams(),
      base,
      invocation(`plan-task/before-${terminalStatus}-parent-replan`),
    ));
    setLegacySliceStatus("S01", "active");

    const sliceIdentity = { itemKind: "slice" as const, milestoneId: "M001", sliceId: "S01" };
    if (terminalStatus === "completed") completeTestLifecycle(sliceIdentity, "test/replan-parent/slice");
    else transitionTestLifecycle(sliceIdentity, terminalStatus, `test/replan-parent/slice/${terminalStatus}`);
    assert.equal(row(`SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'`)["status"], "active");

    const before = {
      authority: row("SELECT revision, authority_epoch FROM project_authority"),
      task: getTask("M001", "S01", "T01"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: lifecycleSnapshot(),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    };
    const rejected = await invoke<ReplanTaskParams, ReplanTaskResult>(
      handleReplanTask as PlanningHandler<ReplanTaskParams, ReplanTaskResult>,
      {
        ...taskParams(),
        title: "Must not bypass terminal parent authority",
        description: "Open legacy status cannot override a terminal canonical parent.",
      },
      base,
      invocation(`replan-task/reject-${terminalStatus}-parent`),
    );
    assert.ok("error" in rejected);
    assert.match(rejected.error, new RegExp(`${terminalStatus} slice S01.*gsd_slice_reopen`, "i"));
    assert.deepEqual({
      authority: row("SELECT revision, authority_epoch FROM project_authority"),
      task: getTask("M001", "S01", "T01"),
      history: rows("SELECT * FROM replan_history ORDER BY id"),
      operations: rows("SELECT operation_id, resulting_revision FROM workflow_operations ORDER BY resulting_revision"),
      lifecycles: lifecycleSnapshot(),
      events: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
    }, before);
  });
}

test("slice replanning cancels removed pending work durably instead of deleting its identity", async () => {
  const { base } = makeFixture();
  seedPlanningParents();
  const slicePlan: PlanSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Plan work before a blocker is found.",
    tasks: [taskParams("T01", "Completed blocker"), taskParams("T02", "Work to remove")],
  };
  const planned = await invoke<PlanSliceParams, PlanSliceResult>(
    handlePlanSlice as PlanningHandler<PlanSliceParams, PlanSliceResult>,
    slicePlan,
    base,
    invocation("plan-slice/before-replan"),
  );
  assertSuccess(planned);
  insertTask({ id: "T04", sliceId: "S01", milestoneId: "M001", title: "Legacy-only work to remove", status: "pending" });
  completeTestLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "test/replan-slice/blocker",
  );
  setLegacyTaskStatus("T01", "complete", "2026-07-12T00:00:00.000Z");
  const operationCountBeforeReplan = count("workflow_operations");

  const params: ReplanSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    blockerTaskId: "T01",
    blockerDescription: "The first approach cannot satisfy the contract.",
    whatChanged: "Cancel T02 and replace it with T03.",
    updatedTasks: [{ ...taskParams("T03", "Replacement task") }],
    removedTaskIds: ["T02", "T04"],
  };
  const result = await invoke<ReplanSliceParams, ReplanSliceResult>(
    handleReplanSlice as PlanningHandler<ReplanSliceParams, ReplanSliceResult>,
    params,
    base,
    invocation("replan-slice/call-1"),
  );
  assertSuccess(result);
  assert.deepEqual(Object.keys(result).sort(), ["milestoneId", "planPath", "replanPath", "sliceId"]);

  assert.equal(getTask("M001", "S01", "T02")?.status, "skipped");
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T02'
  `), { lifecycle_status: "cancelled", state_version: 1 });
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T04'
  `), { lifecycle_status: "cancelled", state_version: 1 });
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T03'
  `), { lifecycle_status: "ready", state_version: 0 });
  assert.equal(count("workflow_operations"), operationCountBeforeReplan + 1);
  assertNoInventedExecutionHistory();
});
