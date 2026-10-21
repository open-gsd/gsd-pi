// Project/App: gsd-pi
// File Purpose: M003/S07 milestone-status lifecycle-shadow observation integration proof.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeFixture(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-observation-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);

  _getAdapter()!.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Observed milestone', 'pending', '2026-07-14T10:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES
      ('M001', 'S01', 'Active slice', 'active', 1, '2026-07-14T10:00:00.000Z'),
      ('M001', 'S02', 'Missing shadow slice', 'queued', 2, '2026-07-14T10:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Extra shadow task', 'pending', 1),
      ('M001', 'S01', 'T02', 'Mismatched task', 'done', 2);
  `);

  adopt("milestone", "M001", undefined, undefined, "pending");
  adopt("slice", "M001", "S01", undefined, "in_progress");
  adopt("task", "M001", "S01", "T01", "ready");
  adopt("task", "M001", "S01", "T02", "paused");

  const db = _getAdapter()!;
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(`
    DELETE FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db.exec("PRAGMA foreign_keys = ON");
  return basePath;
}

function adopt(
  itemKind: "milestone" | "slice" | "task",
  milestoneId: string,
  sliceId: string | undefined,
  taskId: string | undefined,
  lifecycleStatus: "pending" | "ready" | "in_progress" | "paused",
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.lifecycle-shadow.adopt",
    idempotencyKey: `shadow-observation/${itemKind}/${milestoneId}/${sliceId ?? "-"}/${taskId ?? "-"}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "milestone-status-shadow-observation-test",
    sourceTransport: "test",
    payload: { itemKind, milestoneId, sliceId: sliceId ?? null, taskId: taskId ?? null, lifecycleStatus },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind,
      milestoneId,
      ...(sliceId ? { sliceId } : {}),
      ...(taskId ? { taskId } : {}),
      lifecycleStatus,
    });
    const entityId = [milestoneId, sliceId, taskId].filter(Boolean).join("/");
    return {
      events: [{
        eventType: "test.lifecycle-shadow.adopted",
        entityType: itemKind,
        entityId,
        payload: { lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `shadow-observation-test/${entityId.toLowerCase()}`,
        projectionKind: "test",
        rendererVersion: "v1",
      }],
    };
  });
}

function authoritySnapshot(): Record<string, unknown> {
  const db = _getAdapter()!;
  return {
    hierarchy: db.prepare(`
      SELECT 'milestone' AS kind, id, status FROM milestones
      UNION ALL SELECT 'slice', milestone_id || '/' || id, status FROM slices
      UNION ALL SELECT 'task', milestone_id || '/' || slice_id || '/' || id, status FROM tasks
      ORDER BY kind, id
    `).all(),
    lifecycles: db.prepare(`
      SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id
      FROM workflow_item_lifecycles ORDER BY lifecycle_id
    `).all(),
    authority: db.prepare("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1").get(),
    operations: db.prepare("SELECT operation_id, operation_type FROM workflow_operations ORDER BY operation_id").all(),
    domainEvents: db.prepare("SELECT event_id, event_type FROM workflow_domain_events ORDER BY event_id").all(),
    projectionWork: db.prepare("SELECT projection_work_id, projection_key FROM workflow_projection_work ORDER BY projection_work_id").all(),
  };
}

function auditPayloads(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observed'
    ORDER BY ts, event_id
  `).all().map((row) => JSON.parse(String(row["payload_json"])) as Record<string, unknown>);
}

test("milestone status observes all five shadow classes from its read snapshot without changing its response", async () => {
  const basePath = makeFixture();
  const before = authoritySnapshot();
  const expectedResult = {
    milestoneId: "M001",
    title: "Observed milestone",
    status: "pending",
    createdAt: "2026-07-14T10:00:00.000Z",
    completedAt: null,
    dependsOn: [],
    sliceCount: 2,
    slices: [
      { id: "S01", status: "active", taskCounts: { total: 1, done: 1, pending: 0 } },
      { id: "S02", status: "queued", taskCounts: { total: 0, done: 0, pending: 0 } },
    ],
  };

  const result = await executeMilestoneStatus(
    { milestoneId: "M001" },
    basePath,
    {
      mode: "guided",
      transport: "workflow_mcp",
      sourceRevision: "sha256:observed-source",
      traceId: "trace-shadow-observation",
      turnId: "turn-shadow-observation",
    },
  );

  assert.equal(result.content[0].text, JSON.stringify(expectedResult, null, 2));
  assert.deepEqual(result.details, { operation: "milestone_status", ...expectedResult });
  assert.deepEqual(authoritySnapshot(), before, "observation may write audit evidence, never workflow authority");

  const payloads = auditPayloads();
  assert.equal(payloads.length, 1);
  const payload = payloads[0] as any;
  assert.equal(payload.mode, "guided");
  assert.equal(payload.transport, "workflow_mcp");
  assert.equal(payload.sourceRevision, "sha256:observed-source");
  assert.equal(payload.traceId, "trace-shadow-observation");
  assert.equal(payload.turnId, "turn-shadow-observation");
  assert.equal(payload.projectRevision, (before.authority as any).revision);
  assert.equal(payload.authorityEpoch, (before.authority as any).authority_epoch);
  assert.equal(payload.repairDisposition, "not_attempted");
  assert.deepEqual(payload.observationLossAccounting, { lossCount: 0, persistedCount: 1 });
  assert.deepEqual(
    payload.items.map((item: any) => item.classification).sort(),
    ["extra_shadow", "match", "missing_shadow", "semantic_match_exact_delta", "status_mismatch"],
  );
  assert.ok(payload.items.every((item: any) => item.itemIdentity.milestoneId === "M001"));
  assert.ok(payload.items.some((item: any) => item.classification === "missing_shadow" && item.itemIdentity.lifecycleId === null));
  assert.ok(payload.items.some((item: any) => item.classification === "extra_shadow" && typeof item.itemIdentity.lifecycleId === "string"));
});

test("a shadow-query failure preserves the milestone response and persists explicit loss accounting", async () => {
  const basePath = makeFixture();
  const db = _getAdapter()!;
  const authority = db.prepare(`
    SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
  `).get()!;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("ALTER TABLE workflow_item_lifecycles RENAME TO unavailable_workflow_item_lifecycles");
  db.exec("PRAGMA foreign_keys = ON");

  const result = await executeMilestoneStatus(
    { milestoneId: "M001" },
    basePath,
    {
      mode: "legacy",
      transport: "native_pi",
      sourceRevision: "unavailable",
      traceId: "trace-shadow-query-failure",
      turnId: "turn-shadow-query-failure",
    },
  );

  assert.equal(JSON.parse(result.content[0].text).milestoneId, "M001");
  assert.equal(result.isError, undefined);
  const payloads = auditPayloads();
  assert.equal(payloads.length, 1);
  assert.deepEqual((payloads[0] as any).items, []);
  assert.equal((payloads[0] as any).reason, "shadow_query_failed");
  assert.equal((payloads[0] as any).projectRevision, authority["revision"]);
  assert.equal((payloads[0] as any).authorityEpoch, authority["authority_epoch"]);
  assert.deepEqual((payloads[0] as any).observationLossAccounting, {
    lossCount: 1,
    persistedCount: 1,
    reason: "shadow_query_failed",
    errorHash: (payloads[0] as any).observationLossAccounting.errorHash,
  });
  assert.match((payloads[0] as any).observationLossAccounting.errorHash, /^sha256:[0-9a-f]{64}$/u);
});

test("an authority-revision query failure is response-neutral and loss-accounted", async () => {
  const basePath = makeFixture();
  const db = _getAdapter()!;
  db.exec("ALTER TABLE project_authority RENAME TO unavailable_project_authority");

  const result = await executeMilestoneStatus({ milestoneId: "M001" }, basePath);

  assert.equal(JSON.parse(result.content[0].text).milestoneId, "M001");
  assert.equal(result.isError, undefined);
  const payloads = auditPayloads();
  assert.equal(payloads.length, 1);
  assert.equal((payloads[0] as any).reason, "shadow_query_failed");
  assert.equal((payloads[0] as any).projectRevision, 0);
  assert.equal((payloads[0] as any).authorityEpoch, 0);
  assert.equal((payloads[0] as any).observationLossAccounting.lossCount, 1);
});

test("a DB-unavailable direct read preserves its error and durably accounts for both losses", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-unavailable-"));
  tempDirs.add(basePath);
  closeDatabase();

  const result = await executeMilestoneStatus({ milestoneId: "M001" }, basePath);

  assert.deepEqual(result, {
    content: [{ type: "text", text: "Error: GSD database is not available." }],
    details: { operation: "milestone_status", error: "db_unavailable" },
    isError: true,
  });
  const events = readFileSync(join(basePath, ".gsd", "audit", "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "lifecycle-shadow-observation-loss");
  assert.equal(events[0].payload.observationLossAccounting.lossCount, 2);
  assert.deepEqual(
    events[0].payload.observationLossAccounting.causes.map((cause: any) => cause.reason),
    ["shadow_query_failed", "primary_sink_failed"],
  );
});

test("a legacy hierarchy query failure preserves its error and persists loss accounting", async () => {
  const basePath = makeFixture();
  const pendingResult = executeMilestoneStatus({ milestoneId: "M001" }, basePath);
  const db = _getAdapter()!;
  db.exec("ALTER TABLE milestones RENAME TO unavailable_milestones");

  const result = await pendingResult;

  assert.deepEqual(result, {
    content: [{ type: "text", text: "Error querying milestone status: no such table: milestones" }],
    details: { operation: "milestone_status", error: "no such table: milestones" },
    isError: true,
  });
  const payloads = auditPayloads();
  assert.equal(payloads.length, 1);
  assert.equal((payloads[0] as any).reason, "shadow_query_failed");
  assert.equal((payloads[0] as any).observationLossAccounting.lossCount, 1);
  assert.equal((payloads[0] as any).observationLossAccounting.persistedCount, 1);
});
