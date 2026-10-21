// Project/App: gsd-pi
// File Purpose: Contract tests for private Pi planning invocation identity and replay behavior.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

import { registerDbTools } from "../bootstrap/db-tools.ts";
import {
  _getAdapter,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  getSlice,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<Record<string, unknown>>;
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-planning-invocation-pi-"));
  mkdirSync(join(base, ".gsd", "phases", "01-identity"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  rmSync(base, { recursive: true, force: true });
}

function params(title = "Private planning identity", includeSketch = false) {
  return {
    milestoneId: "M001",
    title,
    vision: "Make transport retries safe without exposing concurrency fields.",
    slices: [{
      sliceId: "S01",
      title: "Identity contract",
      risk: "low",
      depends: [],
      demo: "A repeated transport invocation replays one database operation.",
      goal: "Bind planning to the private Pi tool-call identity.",
      successCriteria: "The same invocation cannot mutate planning twice.",
      proofLevel: "integration",
      integrationClosure: "The registered tool passes identity into the planning handler.",
      observabilityImpact: "The workflow operation ledger exposes replay behavior.",
    }, ...(includeSketch ? [{
      sliceId: "S02",
      title: "Deferred sketch",
      risk: "medium",
      depends: ["S01"],
      demo: "The sketch remains pending until refinement.",
      goal: "Preserve progressive planning semantics.",
      successCriteria: "",
      proofLevel: "",
      integrationClosure: "",
      observabilityImpact: "",
      isSketch: true,
      sketchScope: "Defer the detailed task contract until S01 proves the foundation.",
    }] : [])],
  };
}

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerDbTools({
    registerTool(tool: RegisteredTool) { tools.push(tool); },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  return tools;
}

function registeredPlanMilestone(): RegisteredTool {
  const tools = registeredTools();
  const tool = tools.find((candidate) => candidate.name === "gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");
  return tool;
}

function workflowOperations(): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db, "database must be open");
  return db.prepare(`
    SELECT operation_type, idempotency_key, source_transport, expected_revision, resulting_revision
    FROM workflow_operations ORDER BY resulting_revision
  `).all();
}

function lifecycleRows(): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db, "database must be open");
  return db.prepare(`
    SELECT item_kind, milestone_id, slice_id, lifecycle_status, state_version,
           last_operation_id, last_project_revision
    FROM workflow_item_lifecycles
    ORDER BY item_kind, slice_id
  `).all();
}

test("Pi planning retries replay one private tool-call operation without changing the public contract", async () => {
  const base = makeBase();
  try {
    const tool = registeredPlanMilestone();
    assert.equal(tool.parameters.properties?.["idempotencyKey"], undefined);
    assert.equal(tool.parameters.properties?.["expectedRevision"], undefined);
    assert.equal(tool.parameters.properties?.["expectedAuthorityEpoch"], undefined);

    const first = await tool.execute("pi-call-42", params(), undefined, undefined, { cwd: base });
    const replay = await tool.execute("pi-call-42", params(), undefined, undefined, { cwd: base });

    assert.deepEqual(replay, first, "a replay must preserve the existing public tool result");
    assert.deepEqual(Object.keys(first).sort(), ["content", "details"]);
    assert.deepEqual(workflowOperations(), [{
      operation_type: "workflow.milestone.plan",
      idempotency_key: "pi:gsd_plan_milestone:pi-call-42",
      source_transport: "pi-tool",
      expected_revision: 0,
      resulting_revision: 1,
    }]);
    const legacyEvents = readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { cmd: string });
    assert.equal(
      legacyEvents.filter((event) => event.cmd === "plan-milestone").length,
      1,
      "transport replay must not duplicate the legacy compatibility event",
    );
  } finally {
    cleanup(base);
  }
});

test("Pi planning rejects changed payload under the same private tool-call identity", async () => {
  const base = makeBase();
  try {
    const tool = registeredPlanMilestone();
    const first = await tool.execute("pi-call-conflict", params(), undefined, undefined, { cwd: base });
    assert.equal(first["isError"], undefined);

    const conflict = await tool.execute(
      "pi-call-conflict",
      params("Changed title must not commit"),
      undefined,
      undefined,
      { cwd: base },
    );

    assert.equal(conflict["isError"], true);
    assert.match(JSON.stringify(conflict), /idempotency conflict/i);
    assert.equal(getMilestone("M001")?.title, "Private planning identity");
    assert.equal(workflowOperations().length, 1);
  } finally {
    cleanup(base);
  }
});

test("Pi tool-call identities are scoped by canonical planning tool", async () => {
  const base = makeBase();
  try {
    const tools = registeredTools();
    const milestone = tools.find((candidate) => candidate.name === "gsd_plan_milestone");
    const slice = tools.find((candidate) => candidate.name === "gsd_plan_slice");
    assert.ok(milestone);
    assert.ok(slice);

    const milestoneResult = await milestone.execute("shared-call-id", params(), undefined, undefined, { cwd: base });
    assert.equal(milestoneResult["isError"], undefined);
    const sliceResult = await slice.execute("shared-call-id", {
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Refine the existing slice without colliding with milestone planning.",
    }, undefined, undefined, { cwd: base });
    assert.equal(sliceResult["isError"], undefined);

    assert.deepEqual(
      workflowOperations().map((operation) => operation["idempotency_key"]),
      [
        "pi:gsd_plan_milestone:shared-call-id",
        "pi:gsd_plan_slice:shared-call-id",
      ],
    );
  } finally {
    cleanup(base);
  }
});

test("milestone planning adopts fresh roadmap lifecycles with progressive readiness", async () => {
  const base = makeBase();
  try {
    const tool = registeredPlanMilestone();
    const result = await tool.execute("pi-lifecycle-adoption", params(undefined, true), undefined, undefined, { cwd: base });
    assert.equal(result["isError"], undefined);

    assert.deepEqual(
      lifecycleRows().map((row) => ({
        item_kind: row["item_kind"],
        slice_id: row["slice_id"],
        lifecycle_status: row["lifecycle_status"],
        state_version: row["state_version"],
      })),
      [
        { item_kind: "milestone", slice_id: null, lifecycle_status: "ready", state_version: 0 },
        { item_kind: "slice", slice_id: "S01", lifecycle_status: "ready", state_version: 0 },
        { item_kind: "slice", slice_id: "S02", lifecycle_status: "pending", state_version: 0 },
      ],
    );
  } finally {
    cleanup(base);
  }
});

test("milestone replanning preserves existing lifecycle status and causal provenance", async () => {
  const base = makeBase();
  try {
    insertMilestone({ id: "M001", title: "Reserved", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Reserved slice", status: "paused" });
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "test.lifecycle.seed",
      idempotencyKey: "test:seed-existing-lifecycle",
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { milestoneId: "M001" },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone",
        milestoneId: "M001",
        lifecycleStatus: "in_progress",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "paused",
      });
      return {
        events: [{
          eventType: "test.lifecycle.seeded",
          entityType: "milestone",
          entityId: "M001",
          payload: { milestoneId: "M001" },
          destinations: ["test"],
        }],
        projections: [{ projectionKey: "test:m001", projectionKind: "test", rendererVersion: "1" }],
      };
    });
    const before = lifecycleRows();

    const tool = registeredPlanMilestone();
    const result = await tool.execute("pi-preserve-lifecycle", params(), undefined, undefined, { cwd: base });
    assert.equal(result["isError"], undefined);

    assert.deepEqual(lifecycleRows(), before);
    assert.equal(getSlice("M001", "S01")?.status, "paused");
  } finally {
    cleanup(base);
  }
});
