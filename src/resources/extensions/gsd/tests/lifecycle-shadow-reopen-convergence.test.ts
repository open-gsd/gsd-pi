// Project/App: gsd-pi
// File Purpose: Executable contract for #2440 — reopen-path shadow-drift
// convergence, project-scoped lifecycle joins, and the doctor drift check.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import type { DomainJsonValue } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "../db/writers/lifecycle-commands.ts";
import { cancelSliceHierarchy } from "../db/writers/slice-lifecycle.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import { handleReopenSlice } from "../tools/reopen-slice.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "shadow-reopen-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function openDriftFixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-reopen-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  // #2440 drift shape: legacy hierarchy went terminal through the legacy path
  // while the canonical lifecycle rows stayed `ready`.
  db().exec(`
    INSERT INTO milestones (id, title, status, completed_at, created_at)
    VALUES ('M001', 'Drifted milestone', 'complete', '2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES (
      'M001', 'S01', 'Drifted slice', 'complete',
      '2026-07-04T00:00:00.000Z', '# S01 summary', 1, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Drifted task', 'complete',
      '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary', 1
    );
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "completed", "shadow-reopen/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "ready", "shadow-reopen/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "shadow-reopen/task",
  );
  t.after(closeDatabase);
  return dir;
}

function openActiveFixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-scoped-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Active milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES ('M001', 'S01', 'Active slice', 'in_progress', 1, '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, sequence
    ) VALUES ('M001', 'S01', 'T01', 'Pending task', 'pending', 1);
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "in_progress", "shadow-scoped/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress", "shadow-scoped/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "pending",
    "shadow-scoped/task",
  );
  t.after(closeDatabase);
  return dir;
}

function seedLifecycle(
  item: {
    itemKind: "milestone" | "slice" | "task";
    milestoneId: string;
    sliceId?: string;
    taskId?: string;
  },
  status: CanonicalLifecycleStatus,
  idempotencyKey: string,
): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  const payload: DomainJsonValue = {
    itemKind: item.itemKind,
    milestoneId: item.milestoneId,
    sliceId: item.sliceId ?? null,
    taskId: item.taskId ?? null,
    status,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.shadow-reopen.seed",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...item, lifecycleStatus: status });
    return {
      events: [{
        eventType: "test.shadow-reopen.seeded",
        entityType: item.itemKind,
        entityId: id,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: idempotencyKey.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function lifecycleStatus(where: string): string | null {
  const row = db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE ${where}
  `).get() as Record<string, unknown> | undefined;
  return row ? String(row["lifecycle_status"]) : null;
}

test("reopen converges drifted legacy-terminal slices, then commits", async (t) => {
  const dir = openDriftFixture(t);

  const result = await handleReopenMilestone(
    { milestoneId: "M001", reason: "A verified regression requires a full redo." },
    dir,
    invocation("shadow-reopen/tool/M001"),
  );

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 1);
  assert.equal(result.tasksReset, 1);

  // Reopen moved the converged rows back to ready — terminal parity held.
  assert.equal(
    lifecycleStatus("item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id IS NULL"),
    "ready",
  );
  assert.equal(
    lifecycleStatus("item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'"),
    "ready",
  );
  assert.equal(
    String(db().prepare("SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get()!.status),
    "in_progress",
  );
});

test("slice reopen converges its own drift and ignores unverifiable drift elsewhere", async (t) => {  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-slice-reopen-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  t.after(closeDatabase);
  // S01 is drifted but evidence-backed (repairable); S02 is drifted WITHOUT
  // durable completion evidence. Reopening S01 must not be blocked by S02 —
  // that is a Milestone-reopen concern.
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Mixed milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES
      (
        'M001', 'S01', 'Repairable slice', 'complete',
        '2026-07-04T00:00:00.000Z', '# S01 summary', 1, '2026-07-01T00:00:00.000Z'
      ),
      (
        'M001', 'S02', 'Unverifiable drift', 'complete',
        '2026-07-04T00:00:00.000Z', '', 2, '2026-07-01T00:00:00.000Z'
      );
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Repairable task', 'complete',
      '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary', 1
    );
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "in_progress", "shadow-slice-reopen/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "ready", "shadow-slice-reopen/slice-1");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "shadow-slice-reopen/task",
  );
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S02" }, "ready", "shadow-slice-reopen/slice-2");

  const result = await handleReopenSlice(
    { milestoneId: "M001", sliceId: "S01", reason: "Redo the completed Slice." },
    dir,
    invocation("shadow-slice-reopen/tool/S01"),
  );

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.tasksReset, 1);
  assert.equal(
    String(db().prepare("SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get()!.status),
    "in_progress",
  );
});

test("drift without durable completion evidence fails the reopen, listed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-unverified-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  t.after(closeDatabase);
  // Same drift shape as the convergence fixture, but the slice carries no
  // completion evidence (no completed_at, empty summary) — the evidence gate
  // must refuse, not fabricate a completion.
  db().exec(`
    INSERT INTO milestones (id, title, status, completed_at, created_at)
    VALUES ('M001', 'Unverified milestone', 'complete', '2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES ('M001', 'S01', 'Unverified slice', 'complete', NULL, '', 1, '2026-07-01T00:00:00.000Z');
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "completed", "shadow-unverified/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "ready", "shadow-unverified/slice");

  const result = await handleReopenMilestone(
    { milestoneId: "M001", reason: "Redo requested." },
    dir,
    invocation("shadow-unverified/tool/M001"),
  );
  assert.ok("error" in result);
  assert.match(result.error, /unresolved canonical lifecycle shadows: M001\/S01/);
  // Nothing was written: the drift remains.
  assert.equal(
    lifecycleStatus("item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id IS NULL"),
    "ready",
  );
});

test("a missing canonical slice shadow with evidence is adopted at reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-missing-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  t.after(closeDatabase);
  // The slice closed through the legacy path and never minted a canonical row;
  // the task did. Reopen adopts the missing shadow instead of refusing with
  // "missing canonical lifecycle authority" (#2440).
  db().exec(`
    INSERT INTO milestones (id, title, status, completed_at, created_at)
    VALUES ('M001', 'Partially imported milestone', 'complete', '2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES (
      'M001', 'S01', 'Unimported slice', 'complete',
      '2026-07-04T00:00:00.000Z', '# S01 summary', 1, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Imported task', 'complete',
      '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary', 1
    );
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "completed", "shadow-missing/milestone");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "completed",
    "shadow-missing/task",
  );

  const result = await handleReopenMilestone(
    { milestoneId: "M001", reason: "Redo requested." },
    dir,
    invocation("shadow-missing/tool/M001"),
  );
  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 1);
  assert.equal(
    lifecycleStatus("item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id IS NULL"),
    "ready",
  );
});

test("lifecycle joins are scoped to the current project", (t) => {
  const dir = openActiveFixture(t);
  // A stale imported row from another project sharing the milestone/slice ids
  // must not be picked up by the writer joins.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'decoy-slice', 'decoy-project', 'slice', 'M001', 'S01', NULL,
      'completed', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      'decoy-op', 1, 0
    )
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "slice.cancel",
    idempotencyKey: "shadow-reopen/cancel/M001/S01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { milestoneId: "M001", sliceId: "S01", reason: "project-scoped join check" },
  }, (context) => {
    const receipt = cancelSliceHierarchy(context, {
      milestoneId: "M001",
      sliceId: "S01",
      reason: "project-scoped join check",
    });
    return {
      events: [{
        eventType: "slice.cancelled",
        entityType: "slice",
        entityId: "M001/S01",
        payload: { tasksReset: receipt.cancelledTaskIds.length } as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "test/shadow-reopen/cancel",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });

  // The cancellation read THIS project's row (in_progress → cancelled), not
  // the decoy's 'completed' row (which would have failed terminal-parity
  // checks or reported the slice already terminal).
  assert.equal(
    lifecycleStatus(
      "item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id IS NULL AND project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)",
    ),
    "cancelled",
  );
  assert.equal(
    lifecycleStatus("lifecycle_id = 'decoy-slice'"),
    "completed",
  );
});
