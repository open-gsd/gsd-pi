// Project/App: gsd-pi
// File Purpose: Behavior proof for the one-time lifecycle.backfill Domain Operation on an old-database corpus.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { invalidateAllCaches } from "../cache.ts";
import { handleDbAdopt } from "../commands-maintenance.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import {
  applyLifecycleBackfill,
  LifecycleBackfillRefusedError,
  previewLifecycleBackfill,
} from "../lifecycle-backfill-domain-operation.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { compareLifecycleShadow } from "../db/lifecycle-shadow-comparison.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import { discardMilestone } from "../milestone-actions.ts";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { _clearGsdRootCache } from "../paths.ts";
import {
  checkPostUnitHooks,
  isRetryPending,
  resetHookState,
  resolveHookArtifactPath,
} from "../post-unit-hooks.ts";
import { handleUndoTask } from "../undo.ts";

const COMPLETED_AT = "2026-01-02T03:04:05.000Z";

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "database must be open");
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function scalar(sql: string): unknown {
  return Object.values(db().prepare(sql).get() ?? {})[0];
}

function unadoptedCount(): number {
  return Number(scalar(`
    SELECT
      (SELECT COUNT(*) FROM milestones m WHERE NOT EXISTS (
        SELECT 1 FROM workflow_item_lifecycles l
        WHERE l.item_kind = 'milestone' AND l.milestone_id = m.id)) +
      (SELECT COUNT(*) FROM slices s WHERE NOT EXISTS (
        SELECT 1 FROM workflow_item_lifecycles l
        WHERE l.item_kind = 'slice' AND l.milestone_id = s.milestone_id AND l.slice_id = s.id)) +
      (SELECT COUNT(*) FROM tasks t WHERE NOT EXISTS (
        SELECT 1 FROM workflow_item_lifecycles l
        WHERE l.item_kind = 'task' AND l.milestone_id = t.milestone_id
          AND l.slice_id = t.slice_id AND l.task_id = t.id))
  `));
}

function lifecycleStatus(milestoneId: string, sliceId?: string, taskId?: string): unknown {
  return db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE milestone_id = :m AND slice_id IS :s AND task_id IS :t
  `).get({ ":m": milestoneId, ":s": sliceId ?? null, ":t": taskId ?? null })?.["lifecycle_status"];
}

function activeWaiverCount(milestoneId: string, sliceId?: string, taskId?: string): number {
  return Number(db().prepare(`
    SELECT COUNT(*) AS n
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = waiver.lifecycle_id
    WHERE waiver.waiver_status = 'active'
      AND lifecycle.milestone_id = :m AND lifecycle.slice_id IS :s AND lifecycle.task_id IS :t
  `).get({ ":m": milestoneId, ":s": sliceId ?? null, ":t": taskId ?? null })?.["n"]);
}

function completeTaskRow(milestoneId: string, sliceId: string, taskId: string, verification: string): void {
  db().prepare(`
    UPDATE tasks SET completed_at = :at, full_summary_md = 'Task summary', verification_result = :v
    WHERE milestone_id = :m AND slice_id = :s AND id = :t
  `).run({ ":at": COMPLETED_AT, ":v": verification, ":m": milestoneId, ":s": sliceId, ":t": taskId });
}

/**
 * An old database: hierarchy rows only, written before canonical lifecycle
 * authority existed, with every legacy status shape the one map knows.
 */
function seedOldDatabase(): void {
  // M001: closed milestone with a delivered slice, a skipped task and a skipped slice that kept open work.
  insertMilestone({ id: "M001", title: "Closed", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "complete" });
  insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "skipped" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "skipped" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S02", status: "pending" });
  completeTaskRow("M001", "S01", "T01", "passed");
  db().exec(`
    UPDATE milestones SET completed_at = '${COMPLETED_AT}' WHERE id = 'M001';
    UPDATE slices SET completed_at = '${COMPLETED_AT}', full_summary_md = 'Slice summary'
    WHERE milestone_id = 'M001' AND id = 'S01';
  `);

  // M002: open milestone with a completion that has no verification, open work, a sketch, a deferral
  // and an in-flight slice that has no tasks.
  insertMilestone({ id: "M002", title: "Open", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M002", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M002", sliceId: "S01", status: "done" });
  insertTask({ id: "T02", milestoneId: "M002", sliceId: "S01", status: "pending" });
  insertTask({ id: "T03", milestoneId: "M002", sliceId: "S01", status: "in-progress" });
  insertSlice({ id: "S02", milestoneId: "M002", status: "pending" });
  insertSlice({ id: "S03", milestoneId: "M002", status: "deferred" });
  insertSlice({ id: "S04", milestoneId: "M002", status: "active" });
  completeTaskRow("M002", "S01", "T01", "");

  insertMilestone({ id: "M003", title: "Parked", status: "parked" });
  insertMilestone({ id: "M004", title: "Queued", status: "queued" });
}

let originalCwd = "";
let base = "";

beforeEach(() => {
  originalCwd = process.cwd();
  base = mkdtempSync(join(tmpdir(), "gsd-lifecycle-backfill-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();
  resetHookState();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
});

afterEach(() => {
  closeDatabase();
  process.chdir(originalCwd);
  resetHookState();
  invalidateAllCaches();
  _clearGsdRootCache();
  rmSync(base, { recursive: true, force: true });
});

test("backfill adopts every row of an old database in one operation with one event per row", () => {
  seedOldDatabase();
  // Opening the old database adopted nothing: the backfill is not a migration step.
  assert.equal(unadoptedCount(), 16);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_item_lifecycles"), 0);
  const revisionBefore = Number(scalar("SELECT revision FROM project_authority"));

  const result = applyLifecycleBackfill(base);

  assert.equal(result.adopted, 16);
  assert.equal(unadoptedCount(), 0, "no hierarchy row is left without a lifecycle row");
  assert.equal(Number(scalar("SELECT revision FROM project_authority")), revisionBefore + 1);
  assert.deepEqual(
    rows("SELECT operation_id, operation_type FROM workflow_operations"),
    [{ operation_id: result.operationId, operation_type: "lifecycle.backfill" }],
  );
  assert.equal(
    scalar("SELECT COUNT(*) FROM workflow_item_lifecycles WHERE state_version != 0 OR last_operation_id != '" + result.operationId + "'"),
    0,
  );

  // One event per row; each keeps the raw legacy status and the rule used.
  const events = rows(`
    SELECT entity_type, entity_id,
           json_extract(payload_json, '$.rawStatus') AS raw_status,
           json_extract(payload_json, '$.completedAt') AS completed_at,
           json_extract(payload_json, '$.lifecycleStatus') AS lifecycle_status,
           json_extract(payload_json, '$.rule') AS rule,
           json_extract(payload_json, '$.evidence') AS evidence
    FROM workflow_domain_events WHERE event_type = 'lifecycle.backfilled'
    ORDER BY entity_type, entity_id
  `);
  assert.deepEqual(events, [
    { entity_type: "milestone", entity_id: "M001", raw_status: "complete", completed_at: COMPLETED_AT, lifecycle_status: "completed", rule: "legacy-complete-evidenced", evidence: "unverified-legacy" },
    { entity_type: "milestone", entity_id: "M002", raw_status: "active", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
    { entity_type: "milestone", entity_id: "M003", raw_status: "parked", completed_at: null, lifecycle_status: "paused", rule: "legacy-paused", evidence: null },
    { entity_type: "milestone", entity_id: "M004", raw_status: "queued", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
    { entity_type: "slice", entity_id: "M001/S01", raw_status: "complete", completed_at: COMPLETED_AT, lifecycle_status: "completed", rule: "legacy-complete-evidenced", evidence: "unverified-legacy" },
    { entity_type: "slice", entity_id: "M001/S02", raw_status: "skipped", completed_at: null, lifecycle_status: "cancelled", rule: "legacy-cancelled", evidence: null },
    { entity_type: "slice", entity_id: "M002/S01", raw_status: "in_progress", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
    { entity_type: "slice", entity_id: "M002/S02", raw_status: "pending", completed_at: null, lifecycle_status: "pending", rule: "legacy-open", evidence: null },
    { entity_type: "slice", entity_id: "M002/S03", raw_status: "deferred", completed_at: null, lifecycle_status: "cancelled", rule: "legacy-cancelled", evidence: null },
    { entity_type: "slice", entity_id: "M002/S04", raw_status: "active", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
    { entity_type: "task", entity_id: "M001/S01/T01", raw_status: "complete", completed_at: COMPLETED_AT, lifecycle_status: "completed", rule: "legacy-complete-evidenced", evidence: "unverified-legacy" },
    { entity_type: "task", entity_id: "M001/S01/T02", raw_status: "skipped", completed_at: null, lifecycle_status: "cancelled", rule: "legacy-cancelled", evidence: null },
    { entity_type: "task", entity_id: "M001/S02/T01", raw_status: "pending", completed_at: null, lifecycle_status: "cancelled", rule: "cancelled-with-parent", evidence: null },
    { entity_type: "task", entity_id: "M002/S01/T01", raw_status: "done", completed_at: COMPLETED_AT, lifecycle_status: "ready", rule: "legacy-complete-unproven", evidence: null },
    { entity_type: "task", entity_id: "M002/S01/T02", raw_status: "pending", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
    { entity_type: "task", entity_id: "M002/S01/T03", raw_status: "in-progress", completed_at: null, lifecycle_status: "ready", rule: "legacy-open", evidence: null },
  ]);
  for (const event of events) {
    const [milestoneId, sliceId, taskId] = String(event.entity_id).split("/");
    assert.equal(lifecycleStatus(milestoneId!, sliceId, taskId), event.lifecycle_status, String(event.entity_id));
  }

  // The legacy and canonical heads of every row agree: no row is left in a
  // state that completion, validation, reopen or a status update refuses.
  const heads = rows(`
    SELECT 'milestone ' || m.id AS row, m.status AS legacy, l.lifecycle_status AS canonical
    FROM milestones m JOIN workflow_item_lifecycles l
      ON l.item_kind = 'milestone' AND l.milestone_id = m.id
    UNION ALL
    SELECT 'slice ' || s.milestone_id || '/' || s.id, s.status, l.lifecycle_status
    FROM slices s JOIN workflow_item_lifecycles l
      ON l.item_kind = 'slice' AND l.milestone_id = s.milestone_id AND l.slice_id = s.id
    UNION ALL
    SELECT 'task ' || t.milestone_id || '/' || t.slice_id || '/' || t.id, t.status, l.lifecycle_status
    FROM tasks t JOIN workflow_item_lifecycles l
      ON l.item_kind = 'task' AND l.milestone_id = t.milestone_id AND l.slice_id = t.slice_id AND l.task_id = t.id
  `);
  assert.equal(heads.length, 16);
  for (const head of heads) {
    const kind = compareLifecycleShadow(String(head.legacy), String(head.canonical)).kind;
    assert.ok(
      kind === "match" || kind === "semantic_match_exact_delta",
      `${head.row}: legacy ${head.legacy} / canonical ${head.canonical} is ${kind}`,
    );
  }

  // Each cancelled row has exactly one active legacy-attested Waiver; no other row has one.
  assert.equal(result.waivers, 4);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_waivers"), 4);
  assert.equal(activeWaiverCount("M001", "S01", "T02"), 1);
  assert.equal(activeWaiverCount("M001", "S02"), 1);
  assert.equal(activeWaiverCount("M001", "S02", "T01"), 1);
  assert.equal(activeWaiverCount("M002", "S03"), 1);

  // Completion without evidence is not adopted as completed: it is open work again, with a finding.
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0]!, /task M002\/S01\/T01 .* without completion evidence/);
  assert.equal(getTask("M002", "S01", "T01")?.status, "pending");
  // Open work under a skipped slice is cancelled with it in both vocabularies.
  assert.equal(getTask("M001", "S02", "T01")?.status, "skipped");

  assert.throws(() => applyLifecycleBackfill(base), LifecycleBackfillRefusedError);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_operations"), 1, "a second run writes nothing");
});

test("/gsd db adopt previews without writing; --apply writes a backup and adopts; doctor reports the gap", async () => {
  seedOldDatabase();
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } } as any;
  const missingShadowIssues = async () => {
    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, []);
    return issues.filter((issue) => issue.code === "lifecycle_missing_shadow");
  };
  const backups = () => readdirSync(join(base, ".gsd")).filter((name) => name.startsWith("gsd.db.backup-v"));

  const before = await missingShadowIssues();
  assert.equal(before.length, 1);
  assert.match(before[0]!.message, /^16 milestone, slice or task row\(s\) have no canonical lifecycle row/);

  await handleDbAdopt(ctx, base, "");
  assert.match(notes[0]!.message, /16 row\(s\) would be adopted/);
  assert.equal(unadoptedCount(), 16, "a preview adopts nothing");
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_operations"), 0);
  assert.deepEqual(backups(), []);

  await handleDbAdopt(ctx, base, "--apply");
  assert.equal(notes[1]!.level, "info", notes[1]!.message);
  assert.match(notes[1]!.message, /adopted 16 row\(s\)/);
  assert.equal(unadoptedCount(), 0);
  assert.equal(backups().length, 1, "the pre-backfill backup is the rollback");
  assert.deepEqual(await missingShadowIssues(), []);
});

test("an unknown raw status fails the preview with a list and nothing is adopted", () => {
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "wip-custom" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "halfway" });

  assert.deepEqual(previewLifecycleBackfill().unknownStatuses, [
    { row: "slice M001/S01", rawStatus: "wip-custom" },
    { row: "task M001/S01/T01", rawStatus: "halfway" },
  ]);
  assert.throws(
    () => applyLifecycleBackfill(base),
    (error: unknown) => error instanceof LifecycleBackfillRefusedError &&
      /slice M001\/S01="wip-custom", task M001\/S01\/T01="halfway"/.test(error.message),
  );
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_item_lifecycles"), 0);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_operations"), 0);
});

test("backfill is refused on a worktree-local database", () => {
  const worktree = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  closeDatabase();
  assert.equal(openDatabase(join(worktree, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Old", status: "active" });

  assert.throws(
    () => applyLifecycleBackfill(worktree),
    (error: unknown) => error instanceof LifecycleBackfillRefusedError &&
      /not the project-root database/.test(error.message),
  );
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_item_lifecycles"), 0);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_operations"), 0);
});

test("a backfilled closed milestone reopens and its legacy-attested Waivers are revoked", () => {
  seedOldDatabase();
  applyLifecycleBackfill(base);

  const receipt = reopenMilestone({
    invocation: internalExecutionInvocation("test/backfill/reopen"),
    milestoneId: "M001",
    reason: "Redo after backfill",
  });

  assert.equal(receipt.status, "committed");
  assert.equal(lifecycleStatus("M001"), "ready");
  assert.equal(lifecycleStatus("M001", "S02"), "ready");
  assert.equal(lifecycleStatus("M001", "S02", "T01"), "ready");
  assert.equal(activeWaiverCount("M001", "S01", "T02"), 0);
  assert.equal(activeWaiverCount("M001", "S02"), 0);
  assert.equal(activeWaiverCount("M001", "S02", "T01"), 0);
  assert.equal(activeWaiverCount("M002", "S03"), 1, "another milestone's Waiver stays active");
});

test("a partially adopted closed milestone is refused by reopen until the backfill adopts the rest", async () => {
  insertMilestone({ id: "M001", title: "Old", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "complete" });
  completeTaskRow("M001", "S01", "T01", "passed");
  db().exec(`
    UPDATE milestones SET completed_at = '${COMPLETED_AT}' WHERE id = 'M001';
    UPDATE slices SET completed_at = '${COMPLETED_AT}', full_summary_md = 'Slice summary' WHERE milestone_id = 'M001';
  `);
  // Only the Task was adopted (for example by an earlier Task claim).
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.partial-adoption",
    idempotencyKey: "test/backfill/partial-adoption",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
    return {
      events: [{ eventType: "test.adopted", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/partial-adoption", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  const refused = await handleReopenMilestone(
    { milestoneId: "M001" }, base, internalExecutionInvocation("test/backfill/reopen-partial"),
  );
  assert.ok("error" in refused);
  assert.match(refused.error, /partially adopted Milestone M001; run \/gsd db adopt --apply/);

  assert.equal(applyLifecycleBackfill(base).adopted, 2);
  const reopened = await handleReopenMilestone(
    { milestoneId: "M001" }, base, internalExecutionInvocation("test/backfill/reopen-adopted"),
  );
  assert.ok(!("error" in reopened), "error" in reopened ? reopened.error : "");
  assert.equal(lifecycleStatus("M001"), "ready");
  assert.equal(lifecycleStatus("M001", "S01", "T01"), "ready");
});

test("open work under an already completed milestone is adopted as cancelled, is listed, and the milestone reopens", async () => {
  insertMilestone({ id: "M001", title: "Old", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "complete" });
  // The Task has no verification: its legacy completion is unproven.
  completeTaskRow("M001", "S01", "T01", "");
  db().exec(`
    UPDATE milestones SET completed_at = '${COMPLETED_AT}' WHERE id = 'M001';
    UPDATE slices SET completed_at = '${COMPLETED_AT}', full_summary_md = 'Slice summary' WHERE milestone_id = 'M001';
  `);
  // Only the Milestone was adopted, as completed.
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.partial-adoption",
    idempotencyKey: "test/backfill/completed-parent",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" });
    return {
      events: [{ eventType: "test.adopted", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/completed-parent", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  // The unproven Task would be open work under the completed Milestone. The Slice is then terminal work.
  assert.deepEqual(previewLifecycleBackfill().openUnderCompletedParent, [
    { row: "task M001/S01/T01", rawStatus: "complete" },
  ]);
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } } as any;
  await handleDbAdopt(ctx, base);
  assert.equal(notes[0]!.level, "info");
  assert.match(
    notes[0]!.message,
    /Open work under a completed parent, adopted as cancelled:\n  task M001\/S01\/T01: "complete"/,
  );
  assert.equal(unadoptedCount(), 2, "the preview writes nothing");

  const result = applyLifecycleBackfill(base);

  assert.equal(result.adopted, 2);
  assert.equal(result.cancelledUnderCompletedParent.length, 1);
  assert.match(result.cancelledUnderCompletedParent[0]!, /task M001\/S01\/T01 was legacy "complete" under a completed parent/);
  assert.equal(lifecycleStatus("M001", "S01"), "completed");
  assert.equal(lifecycleStatus("M001", "S01", "T01"), "cancelled");
  assert.equal(activeWaiverCount("M001", "S01", "T01"), 1);
  assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
  assert.deepEqual(rows(`
    SELECT json_extract(payload_json, '$.rawStatus') AS raw_status, json_extract(payload_json, '$.rule') AS rule
    FROM workflow_domain_events
    WHERE event_type = 'lifecycle.backfilled' AND entity_id = 'M001/S01/T01'
  `), [{ raw_status: "complete", rule: "cancelled-under-completed-parent" }]);

  const reopened = await handleReopenMilestone(
    { milestoneId: "M001" }, base, internalExecutionInvocation("test/backfill/reopen-completed-parent"),
  );
  assert.ok(!("error" in reopened), "error" in reopened ? reopened.error : "");
  assert.equal(lifecycleStatus("M001"), "ready");
  assert.equal(lifecycleStatus("M001", "S01"), "ready");
  assert.equal(activeWaiverCount("M001", "S01", "T01"), 0);
});

test("backfill grants one Waiver to each lifecycle row already adopted as cancelled with none, once", () => {
  insertMilestone({ id: "M001", title: "Imported by an earlier build", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "skipped" });
  insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "deferred" });
  // An earlier build adopted every row and gave the cancelled rows no Waiver.
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.earlier-build-adoption",
    idempotencyKey: "test/backfill/earlier-build-adoption",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "cancelled" });
    return {
      events: [{ eventType: "test.adopted", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/earlier-build-adoption", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  assert.equal(unadoptedCount(), 0);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_waivers"), 0);

  const result = applyLifecycleBackfill(base);

  assert.equal(result.adopted, 0);
  assert.equal(result.waivers, 2);
  assert.deepEqual(rows(`
    SELECT waiver.scope, waiver.waiver_status, waiver.requirement_id, waiver.rationale,
           operation.operation_type,
           json_extract(event.payload_json, '$.rawStatus') AS raw_status,
           json_extract(event.payload_json, '$.rule') AS rule,
           json_extract(event.payload_json, '$.lifecycleId') = waiver.lifecycle_id AS bound
    FROM workflow_waivers waiver
    JOIN workflow_operations operation ON operation.operation_id = waiver.operation_id
    JOIN workflow_domain_events event
      ON event.operation_id = waiver.operation_id
     AND event.event_type = 'lifecycle.backfilled'
     AND json_extract(event.payload_json, '$.waiverId') = waiver.waiver_id
    ORDER BY waiver.scope
  `), [
    {
      scope: "M001/S01/T01 cancellation", waiver_status: "active", requirement_id: null,
      rationale: 'Legacy-attested cancellation adopted before lifecycle backfill (raw status "skipped", rule adopted-cancelled-without-waiver)',
      operation_type: "lifecycle.backfill", raw_status: "skipped", rule: "adopted-cancelled-without-waiver", bound: 1,
    },
    {
      scope: "slice:M001/S02", waiver_status: "active", requirement_id: null,
      rationale: 'Legacy-attested cancellation adopted before lifecycle backfill (raw status "deferred", rule adopted-cancelled-without-waiver)',
      operation_type: "lifecycle.backfill", raw_status: "deferred", rule: "adopted-cancelled-without-waiver", bound: 1,
    },
  ]);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_item_lifecycles WHERE state_version != 0"), 0, "no lifecycle row changed");
  assert.equal(activeWaiverCount("M001", "S01", "T02"), 0);

  // Idempotent: a second run finds nothing to grant and writes nothing.
  assert.deepEqual(previewLifecycleBackfill().waiverRepairs, []);
  assert.throws(() => applyLifecycleBackfill(base), LifecycleBackfillRefusedError);
  assert.equal(scalar("SELECT COUNT(*) FROM workflow_waivers"), 2);
});

test("a backfilled open milestone can be discarded", async () => {
  seedOldDatabase();
  applyLifecycleBackfill(base);

  assert.equal(await discardMilestone(base, "M002"), true);

  assert.equal(lifecycleStatus("M002"), "cancelled");
  assert.equal(lifecycleStatus("M002", "S01"), "cancelled");
  assert.equal(lifecycleStatus("M002", "S01", "T02"), "cancelled");
  assert.equal(scalar("SELECT COUNT(*) FROM milestones WHERE id = 'M002'"), 1, "the row stays as a tombstone");
});

function seedOpenSliceWithCompletedTask(): void {
  insertMilestone({ id: "M001", title: "Old", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
  completeTaskRow("M001", "S01", "T01", "passed");
}

test("undo reopens a backfilled completed task", async () => {
  seedOpenSliceWithCompletedTask();
  applyLifecycleBackfill(base);
  assert.equal(lifecycleStatus("M001", "S01", "T01"), "completed");

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };
  await handleUndoTask("M001/S01/T01 --force", ctx as any, {} as any, base);

  assert.equal(notifications[0]?.level, "success", notifications[0]?.message);
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.equal(lifecycleStatus("M001", "S01", "T01"), "ready");
});

test("a post-unit hook retry reopens a backfilled completed task", async () => {
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---
post_unit_hooks:
  - name: review-arbiter
    after:
      - execute-task
    prompt: Review {taskId}
    agent: arbiter
    artifact: REVIEW-DEBATE.md
    retry_on: NEEDS-REWORK.md
    max_cycles: 3
    enabled: true
---
`, "utf-8");
  seedOpenSliceWithCompletedTask();
  applyLifecycleBackfill(base);

  // The hook takes its completion identity from the backfilled lifecycle row.
  assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base), "hook dispatches for the backfilled task");
  writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md"), "rework requested", "utf-8");

  const retryActiveUnit = mock.fn(async (_unit: { unitType: string; unitId: string }) => {});
  const session = new AutoSession();
  session.basePath = base;
  session.active = true;
  session.currentUnit = { type: "hook/review-arbiter", id: "M001/S01/T01", startedAt: Date.now() };
  session.orchestration = {
    start: async () => ({ kind: "started" }),
    advance: async () => ({ kind: "stopped", reason: "unused" }),
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit,
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "resumed" }),
    stop: async (reason: string) => ({ kind: "stopped", reason }),
    getStatus: () => ({ phase: "running", transitionCount: 0 }),
  };
  const pctx: PostUnitContext = {
    s: session,
    ctx: {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} },
      model: { id: "test-model" },
    } as any,
    pi: { sendMessage: async () => {}, setModel: async () => true } as any,
    buildSnapshotOpts: () => ({}),
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };

  assert.equal(await postUnitPostVerification(pctx), "continue");

  assert.equal(retryActiveUnit.mock.callCount(), 1);
  assert.equal(isRetryPending(), false);
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.equal(lifecycleStatus("M001", "S01", "T01"), "ready");
});
