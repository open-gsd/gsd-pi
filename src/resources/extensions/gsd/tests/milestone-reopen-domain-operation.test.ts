// Project/App: gsd-pi
// File Purpose: Intent-first contracts for atomic adopted Milestone full-redo reopen.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _setDomainOperationFaultForTest } from "../db/domain-operation.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import { grantSliceCancellationWaiver } from "../db/writers/slice-lifecycle.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  grantRecoveryWaiver,
  recordRequirementDisposition,
} from "../db/writers/task-recovery.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import * as milestoneLifecycle from "../milestone-lifecycle-domain-operation.ts";
import { completeMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

const tempDirs = new Set<string>();
let sourceRevision = "";

interface ReopenInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  reason: string;
  audit: { actorName: string; triggerReason: string };
}

type ReopenReceipt = Record<string, unknown> & {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  canonicalStatus: "ready";
  legacyStatus: "active";
  revokedWaiverIds: string[];
  supersedingDispositionIds: string[];
  isCurrent: boolean;
};

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

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "milestone-reopen-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function reopenInput(idempotencyKey: string): ReopenInput {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    reason: "A verified regression requires a full Milestone redo.",
    audit: {
      actorName: "milestone-reopen-contract",
      triggerReason: "Verified post-completion regression",
    },
  };
}

function reopenMilestone(input: ReopenInput): ReopenReceipt {
  const reopen = (milestoneLifecycle as unknown as {
    reopenMilestone?: (request: ReopenInput) => ReopenReceipt;
  }).reopenMilestone;
  assert.equal(
    typeof reopen,
    "function",
    "Milestone lifecycle module must expose the reopen Domain Operation",
  );
  return reopen!(input);
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event?: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, string>;
  },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    const emitted = event?.() ?? {
      eventType: operationType,
      entityType: "milestone",
      entityId: "M001",
      payload: { idempotencyKey },
    };
    return {
      events: [{ ...emitted, destinations: ["test"] }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function lifecycleId(itemKind: "milestone" | "slice" | "task", sliceId?: string, taskId?: string): string {
  return String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = '${itemKind}' AND milestone_id = 'M001'
      AND slice_id ${sliceId ? `= '${sliceId}'` : "IS NULL"}
      AND task_id ${taskId ? `= '${taskId}'` : "IS NULL"}
  `).lifecycle_id);
}

function makeBase({ adoptMilestone = true }: { adoptMilestone?: boolean } = {}): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-reopen-domain-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'milestone reopen';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) assert.fail(source.error);
  sourceRevision = source.snapshot.aggregateRevision;

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Atomic reopen", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "skipped" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", status: "skipped" });
  db().exec(`
    INSERT INTO requirements (id, class, status, description) VALUES
      ('REQ-T02-CANCELLATION', 'contract', 'active', 'T02 cancellation remains explicit'),
      ('REQ-T01-OBSERVABILITY', 'quality', 'active', 'T01 remains observable');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
  `);
  executeAtFence("test.milestone-reopen.terminal", "fixture/milestone-reopen/terminal", (context) => {
    if (adoptMilestone) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
      });
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T02",
      lifecycleStatus: "cancelled",
    });
  });
  const cancelledSliceLifecycleId = lifecycleId("slice", "S02");
  let waiverId = "";
  executeAtFence("slice.cancel", "fixture/milestone-reopen/waiver", (context) => {
    waiverId = grantSliceCancellationWaiver(context, {
      lifecycleId: cancelledSliceLifecycleId,
      milestoneId: "M001",
      sliceId: "S02",
      rationale: "S02 is intentionally omitted from the completed Milestone.",
      grantedByActorType: "policy",
    }).waiverId;
  }, () => ({
    eventType: "slice.cancelled",
    entityType: "slice",
    entityId: "M001/S02",
    payload: { sliceLifecycleId: cancelledSliceLifecycleId, waiverId },
  }));
  const cancelledTaskLifecycleId = lifecycleId("task", "S02", "T02");
  let taskCancellationWaiverId = "";
  executeAtFence("task.waiver.grant", "fixture/milestone-reopen/task-waivers", (context) => {
    taskCancellationWaiverId = grantRecoveryWaiver(context, {
      lifecycleId: cancelledTaskLifecycleId,
      requirementId: "REQ-T02-CANCELLATION",
      scope: "M001/S02/T02 cancellation",
      rationale: "T02 cancellation is temporarily authorized.",
      grantedByActorType: "policy",
    }).waiverId;
    grantRecoveryWaiver(context, {
      lifecycleId: lifecycleId("task", "S01", "T01"),
      requirementId: "REQ-T01-OBSERVABILITY",
      scope: "M001/S01/T01 objective verification",
      rationale: "Unrelated active Waiver must survive a Milestone reopen.",
      grantedByActorType: "policy",
    });
  });
  executeAtFence("task.disposition.record", "fixture/milestone-reopen/task-disposition", (context) => {
    recordRequirementDisposition(context, {
      requirementId: "REQ-T02-CANCELLATION",
      disposition: "waived",
      waiverId: taskCancellationWaiverId,
      rationale: "The active Task cancellation Waiver is the current requirement disposition.",
    });
  });
  return basePath;
}

const validation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |\n| S02 | waived |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

async function prepareCompletedFixture(): Promise<string> {
  const basePath = makeBase();
  const validated = await handleValidateMilestone(validation, basePath, {
    invocation: invocation("fixture/milestone-reopen/validate"),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in validated), `validation fixture failed: ${"error" in validated ? validated.error : ""}`);
  completeMilestone({
    invocation: invocation("fixture/milestone-reopen/complete"),
    milestoneId: "M001",
    sourceRevision,
    closeout: {
      title: "Atomic reopen",
      oneLiner: "Completed before a verified regression.",
      narrative: "The completed Milestone is ready for a full-redo fixture.",
      successCriteriaResults: "Passed.",
      definitionOfDoneResults: "Passed.",
      requirementOutcomes: "Covered.",
      keyDecisions: [],
      keyFiles: [],
      lessonsLearned: [],
      followUps: "None.",
      deviations: "None.",
    },
  });
  return basePath;
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY milestone_id, item_kind, slice_id, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    waivers: rows("SELECT * FROM workflow_waivers ORDER BY project_revision, waiver_id"),
    dispositions: rows("SELECT * FROM workflow_requirement_dispositions ORDER BY project_revision"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision, projection_key"),
  };
}

function immutableHistory(throughRevision: number): Record<string, unknown> {
  return {
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    checkpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    dispositions: rows(`
      SELECT * FROM workflow_requirement_dispositions
      WHERE project_revision <= ${throughRevision}
      ORDER BY project_revision
    `),
    operations: rows(`
      SELECT * FROM workflow_operations
      WHERE resulting_revision <= ${throughRevision}
      ORDER BY resulting_revision
    `),
    events: rows(`
      SELECT * FROM workflow_domain_events
      WHERE project_revision <= ${throughRevision}
      ORDER BY project_revision, event_index
    `),
  };
}

function cleanup(): void {
  _setDomainOperationFaultForTest(null);
  sourceRevision = "";
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

async function rejectWithoutResidue(key: string, pattern: RegExp): Promise<void> {
  const before = durableSnapshot();
  await assert.rejects(async () => reopenMilestone(reopenInput(key)), pattern);
  assert.deepEqual(durableSnapshot(), before, "rejected reopen must leave exact zero residue");
}

function insertActiveAttempt(state: "claimed" | "running"): void {
  executeAtFence("attempt.claim", `fixture/milestone-reopen/attempt/${state}`, (context) => {
    const running = state === "running";
    db().prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
        attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token,
        claimed_at, started_at, ended_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ) VALUES (
        :attempt_id, :project_id, :lifecycle_id, 1, NULL,
        :attempt_state, NULL, :worker_id, :lease_token,
        '2026-07-14T00:01:00.000Z', :started_at, NULL,
        :operation_id, :project_revision, :authority_epoch,
        NULL, NULL, NULL
      )
    `).run({
      ":attempt_id": `reopen-attempt-${state}`,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId("task", "S01", "T01"),
      ":attempt_state": state,
      ":worker_id": running ? "worker-1" : null,
      ":lease_token": running ? 7 : null,
      ":started_at": running ? "2026-07-14T00:01:00.000Z" : null,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
}

function seedProgressedTransitiveDependent(): void {
  insertMilestone({ id: "M002", title: "Unprogressed bridge", status: "planned", depends_on: ["M001"] });
  insertMilestone({ id: "M003", title: "Progressed dependent", status: "active", depends_on: ["M002"] });
  executeAtFence("test.milestone-reopen.dependents", "fixture/milestone-reopen/dependents", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M003", lifecycleStatus: "in_progress",
    });
  });
}

function sabotageShadow(kind: "milestone" | "slice" | "task"): void {
  if (kind === "milestone") {
    db().prepare("UPDATE milestones SET status = 'active' WHERE id = 'M001'").run();
  } else if (kind === "slice") {
    db().prepare("UPDATE slices SET status = 'in_progress' WHERE milestone_id = 'M001' AND id = 'S01'").run();
  } else {
    db().prepare(`
      UPDATE tasks SET status = 'pending'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
  }
}

afterEach(cleanup);

test("Milestone reopen atomically resets the full hierarchy, revokes Waivers, and preserves history", async () => {
  await prepareCompletedFixture();
  const revisionBefore = Number(row("SELECT revision FROM project_authority").revision);
  const historyBefore = immutableHistory(revisionBefore);
  const waivedDispositionBefore = row(`
    SELECT * FROM workflow_requirement_dispositions
    WHERE requirement_id = 'REQ-T02-CANCELLATION'
  `);
  const taskCancellationWaiverId = String(waivedDispositionBefore.waiver_id);
  const sliceCancellationWaiverId = String(row(`
    SELECT waiver_id FROM workflow_waivers WHERE scope = 'slice:M001/S02'
  `).waiver_id);

  const result = reopenMilestone(reopenInput("milestone-reopen/direct/success"));

  assert.equal(result.status, "committed");
  assert.equal(result.canonicalStatus, "ready");
  assert.equal(result.legacyStatus, "active");
  assert.equal(result.isCurrent, true);
  assert.equal(result.resultingRevision, revisionBefore + 1);
  assert.deepEqual(rows(`
    SELECT lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id,
           lifecycle.lifecycle_status, lifecycle.last_operation_id,
           CASE lifecycle.item_kind
             WHEN 'milestone' THEN milestone.status
             WHEN 'slice' THEN slice.status
             ELSE task.status
           END AS legacy_status
    FROM workflow_item_lifecycles lifecycle
    LEFT JOIN milestones milestone
      ON lifecycle.item_kind = 'milestone' AND milestone.id = lifecycle.milestone_id
    LEFT JOIN slices slice
      ON lifecycle.item_kind = 'slice' AND slice.milestone_id = lifecycle.milestone_id
     AND slice.id = lifecycle.slice_id
    LEFT JOIN tasks task
      ON lifecycle.item_kind = 'task' AND task.milestone_id = lifecycle.milestone_id
     AND task.slice_id = lifecycle.slice_id AND task.id = lifecycle.task_id
    WHERE lifecycle.milestone_id = 'M001'
    ORDER BY lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id
  `), [
    { item_kind: "milestone", slice_id: null, task_id: null, lifecycle_status: "ready", last_operation_id: result.operationId, legacy_status: "active" },
    { item_kind: "slice", slice_id: "S01", task_id: null, lifecycle_status: "ready", last_operation_id: result.operationId, legacy_status: "in_progress" },
    { item_kind: "slice", slice_id: "S02", task_id: null, lifecycle_status: "ready", last_operation_id: result.operationId, legacy_status: "in_progress" },
    { item_kind: "task", slice_id: "S01", task_id: "T01", lifecycle_status: "ready", last_operation_id: result.operationId, legacy_status: "pending" },
    { item_kind: "task", slice_id: "S02", task_id: "T02", lifecycle_status: "ready", last_operation_id: result.operationId, legacy_status: "pending" },
  ]);
  assert.deepEqual(row(`
    SELECT waiver_status, ended_operation_id, ended_project_revision
    FROM workflow_waivers WHERE waiver_id = '${taskCancellationWaiverId}'
  `), {
    waiver_status: "revoked",
    ended_operation_id: result.operationId,
    ended_project_revision: result.resultingRevision,
  });
  assert.deepEqual(row(`
    SELECT waiver_status, ended_operation_id, ended_project_revision
    FROM workflow_waivers WHERE requirement_id = 'REQ-T01-OBSERVABILITY'
  `), {
    waiver_status: "active",
    ended_operation_id: null,
    ended_project_revision: null,
  });
  assert.deepEqual(
    [...result.revokedWaiverIds].sort(),
    [sliceCancellationWaiverId, taskCancellationWaiverId].sort(),
  );
  const taskDispositions = rows(`
    SELECT * FROM workflow_requirement_dispositions
    WHERE requirement_id = 'REQ-T02-CANCELLATION'
    ORDER BY project_revision
  `);
  assert.equal(taskDispositions.length, 2);
  assert.deepEqual(taskDispositions[0], waivedDispositionBefore, "reopen must not rewrite the waived disposition");
  const successorDisposition = taskDispositions[1]!;
  assert.deepEqual({
    disposition: successorDisposition.disposition,
    waiver_id: successorDisposition.waiver_id,
    supersedes_disposition_id: successorDisposition.supersedes_disposition_id,
    operation_id: successorDisposition.operation_id,
    project_revision: successorDisposition.project_revision,
    authority_epoch: successorDisposition.authority_epoch,
  }, {
    disposition: "unsatisfied",
    waiver_id: null,
    supersedes_disposition_id: waivedDispositionBefore.disposition_id,
    operation_id: result.operationId,
    project_revision: result.resultingRevision,
    authority_epoch: result.resultingAuthorityEpoch,
  });
  assert.deepEqual(result.supersedingDispositionIds, [successorDisposition.disposition_id]);
  assert.equal(Number(row(`
    SELECT (
      SELECT COUNT(*) FROM milestones WHERE id = 'M001' AND completed_at IS NOT NULL
    ) + (
      SELECT COUNT(*) FROM slices WHERE milestone_id = 'M001' AND completed_at IS NOT NULL
    ) + (
      SELECT COUNT(*) FROM tasks WHERE milestone_id = 'M001' AND completed_at IS NOT NULL
    ) AS count
  `).count), 0, "full-redo reopen must clear every compatibility completion timestamp");
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.reopen' AND operation_id = '${result.operationId}'
  `).count), 1);
  assert.deepEqual(row(`
    SELECT event_type, entity_type, entity_id FROM workflow_domain_events
    WHERE operation_id = '${result.operationId}'
  `), {
    event_type: "milestone.reopened",
    entity_type: "milestone",
    entity_id: "M001",
  });
  assert.deepEqual(row(`
    SELECT projection_key, projection_kind FROM workflow_projection_work
    WHERE enqueue_operation_id = '${result.operationId}'
  `), {
    projection_key: "lifecycle/m001",
    projection_kind: "milestone-lifecycle",
  });
  assert.deepEqual(
    immutableHistory(revisionBefore),
    historyBefore,
    "reopen must not rewrite execution, evidence, operation, or event history",
  );
});

test("adopted Milestone reopen handler fails closed without canonical invocation identity", async () => {
  const basePath = await prepareCompletedFixture();
  const before = durableSnapshot();

  const result = await handleReopenMilestone({ milestoneId: "M001" }, basePath);

  assert.deepEqual(result, {
    error: "adopted Milestone reopen requires canonical invocation identity",
  });
  assert.deepEqual(durableSnapshot(), before, "missing identity must leave exact zero residue");
});

test("legacy-closed Milestone handler fails closed when only descendants are adopted", async () => {
  const basePath = makeBase({ adoptMilestone: false });
  db().prepare(`
    UPDATE milestones SET status = 'complete', completed_at = '2026-07-14T00:05:00.000Z'
    WHERE id = 'M001'
  `).run();
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind = 'milestone'
  `).count), 0);
  assert.ok(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind != 'milestone'
  `).count) > 0);
  const before = durableSnapshot();

  const result = await handleReopenMilestone(
    { milestoneId: "M001", reason: "A verified regression requires a full Milestone redo." },
    basePath,
    invocation("milestone-reopen/handler/partial-adoption"),
  );

  assert.ok("error" in result, "partial lifecycle adoption must not fall through to the legacy cascade");
  assert.deepEqual(durableSnapshot(), before, "partial lifecycle adoption must leave exact zero residue");
});

test("adopted Milestone reopen handler returns and replays the canonical receipt", async () => {
  const basePath = await prepareCompletedFixture();
  const request = {
    milestoneId: "M001",
    reason: "A verified regression requires a full Milestone redo.",
    actorName: "milestone-reopen-handler-contract",
    triggerReason: "Verified post-completion regression",
  };
  const stableInvocation = invocation("milestone-reopen/handler/replay");

  const committed = await handleReopenMilestone(request, basePath, stableInvocation);
  assert.ok(!("error" in committed), `handler reopen failed: ${"error" in committed ? committed.error : ""}`);
  assert.ok(committed.operationId, "canonical handler result must expose its operation identity");
  assert.equal(typeof committed.resultingRevision, "number");
  assert.deepEqual(committed, {
    milestoneId: "M001",
    slicesReset: 2,
    tasksReset: 2,
    operationId: committed.operationId,
    resultingRevision: committed.resultingRevision,
    duplicate: false,
    current: true,
  });
  const canonicalLineage = {
    revision: row("SELECT revision FROM project_authority").revision,
    operations: row(`
      SELECT COUNT(*) AS count FROM workflow_operations
      WHERE operation_type = 'milestone.reopen' AND operation_id = '${committed.operationId}'
    `).count,
    events: row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.reopened' AND operation_id = '${committed.operationId}'
    `).count,
  };
  assert.deepEqual(
    { operations: canonicalLineage.operations, events: canonicalLineage.events },
    { operations: 1, events: 1 },
  );
  assert.equal(committed.resultingRevision, canonicalLineage.revision);

  const replayed = await handleReopenMilestone(request, basePath, stableInvocation);

  assert.ok(!("error" in replayed), `handler replay failed: ${"error" in replayed ? replayed.error : ""}`);
  assert.equal(replayed.resultingRevision, committed.resultingRevision);
  assert.deepEqual(replayed, {
    milestoneId: "M001",
    slicesReset: 2,
    tasksReset: 2,
    operationId: committed.operationId,
    resultingRevision: committed.resultingRevision,
    duplicate: true,
    current: true,
  });
  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: row(`
      SELECT COUNT(*) AS count FROM workflow_operations
      WHERE operation_type = 'milestone.reopen' AND operation_id = '${committed.operationId}'
    `).count,
    events: row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.reopened' AND operation_id = '${committed.operationId}'
    `).count,
  }, canonicalLineage, "handler replay must preserve one canonical operation and event");
});

test("Milestone reopen replays one receipt and conflicts on changed intent", async () => {
  await prepareCompletedFixture();
  const request = reopenInput("milestone-reopen/direct/replay");

  const committed = reopenMilestone(request);
  const afterCommit = durableSnapshot();
  const replayed = reopenMilestone(request);

  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(durableSnapshot(), afterCommit, "exact replay must add no lineage");
  assert.throws(() => reopenMilestone({
    ...request,
    reason: "Changed reason under the same execution identity.",
  }), /idempotency conflict/i);
  assert.deepEqual(durableSnapshot(), afterCommit, "changed reuse must leave exact zero residue");
});

test("Milestone reopen rolls back hierarchy, Waivers, events, and delivery work", async () => {
  await prepareCompletedFixture();
  const before = durableSnapshot();
  _setDomainOperationFaultForTest("after-mutation");

  assert.throws(
    () => reopenMilestone(reopenInput("milestone-reopen/fault/after-mutation")),
    /domain operation fault: after-mutation/i,
  );

  _setDomainOperationFaultForTest(null);
  assert.deepEqual(durableSnapshot(), before, "precommit failure must leave exact zero residue");
});

for (const state of ["claimed", "running"] as const) {
  test(`Milestone reopen rejects a ${state} descendant Attempt`, async () => {
    await prepareCompletedFixture();
    insertActiveAttempt(state);
    await rejectWithoutResidue(`milestone-reopen/attempt/${state}`, /active|attempt|claimed|running/i);
  });
}

test("Milestone reopen rejects a progressed transitive dependent", async () => {
  await prepareCompletedFixture();
  seedProgressedTransitiveDependent();
  await rejectWithoutResidue("milestone-reopen/dependent/transitive", /depend|downstream|M003/i);
});

for (const kind of ["milestone", "slice", "task"] as const) {
  test(`Milestone reopen rejects a ${kind} legacy/canonical mismatch`, async () => {
    await prepareCompletedFixture();
    sabotageShadow(kind);
    await rejectWithoutResidue(`milestone-reopen/mismatch/${kind}`, /canonical|legacy|shadow|mismatch/i);
  });
}

test("Milestone reopen rejects a matched nonterminal descendant", async () => {
  await prepareCompletedFixture();
  executeAtFence("task.reopen", "fixture/milestone-reopen/nonterminal", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    db().prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
  });
  await rejectWithoutResidue("milestone-reopen/nonterminal/task", /terminal|ready|incomplete/i);
});
