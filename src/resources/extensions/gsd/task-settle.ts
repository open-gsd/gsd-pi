// Project/App: gsd-pi
// File Purpose: Operator Task settle — human-gated, dry-run-first reconciliation
// of a running Task Attempt whose executor is gone, plus optional lifecycle
// adopt after an interrupted Attempt or succeeded completion (#1749, #2018),
// the `blocker-accepted` operator closeout disposition (#2202), and the
// receipt-gated verification-paused reconcile (#2334).

import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  getAttemptResultCreatedAt,
  getPassingProofAttemptId,
  getTaskLegacyAndLifecycleStatus,
  getTaskRouteHead,
  hasTaskLifecycleRow,
  listRunningTaskAttempts,
  listVerificationPauseEventRows,
  type RunningTaskAttemptRow,
  type TaskRouteHeadRow,
} from "./db/lifecycle-queries.js";
import { isAutoWorkerLive } from "./db/auto-workers.js";
import {
  claimMilestoneLease,
  getMilestoneLease,
  releaseMilestoneLease,
} from "./db/milestone-leases.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  closeLegacyTaskAsBlockerAccepted,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { queryJournal } from "./journal.js";
import { TASK_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { publishVerifiedTaskCompletion } from "./task-completion-compatibility-adapter.js";
import {
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "./task-execution-domain-operation.js";
import { readTaskRecoveryRoute } from "./task-recovery-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";
import { renderStateProjection } from "./workflow-projections.js";

export interface TaskSettleTask {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface TaskSettleRow {
  attemptId: string;
  currentStatus: string;
  targetStatus: "interrupted";
  rationale: string;
  leaseHeld: boolean;
}

export interface TaskLifecycleReconcileRow {
  currentStatus: string;
  targetStatus: "paused" | "ready" | "completed";
  rationale: string;
}

export interface TaskSettleProof {
  attemptId: string | null;
  note: string;
}

export interface TaskPublicationPlanRow {
  attemptId: string;
  lifecycleStatus: string;
  legacyStatus: string;
  /** Recorded host Technical Verdict, or null when verification has not passed yet. */
  verdict: string | null;
  rationale: string;
}

export interface TaskSettlePlan {
  task: TaskSettleTask;
  rows: TaskSettleRow[];
  lifecycleRows: TaskLifecycleReconcileRow[];
  proof: TaskSettleProof | null;
  publication: TaskPublicationPlanRow | null;
}

export interface TaskSettleOptions {
  reconcileLifecycle?: boolean;
  /**
   * Operator command only: the project root whose journal can hold a
   * verification-pause receipt written before the receipt became a DB event.
   * Dispatch, the auto loop, and the agent tool never set this.
   */
  legacyJournalBasePath?: string;
}

type RunningAttemptRow = RunningTaskAttemptRow;

interface TaskLifecycleState {
  legacyStatus: string;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

function unitId(task: TaskSettleTask): string {
  return `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
}

function readRunningAttempts(task: TaskSettleTask): RunningAttemptRow[] {
  return listRunningTaskAttempts(task.milestoneId, task.sliceId, task.taskId);
}

function readLeaseHeld(row: RunningAttemptRow, milestoneId: string): boolean {
  if (!row.worker_id || row.milestone_lease_token === null) return false;
  const lease = getDb().prepare(`
    SELECT 1 AS held
    FROM milestone_leases
    WHERE milestone_id = :milestone_id
      AND worker_id = :worker_id
      AND fencing_token = :fencing_token
      AND status = 'held'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get({
    ":milestone_id": milestoneId,
    ":worker_id": row.worker_id,
    ":fencing_token": row.milestone_lease_token,
  });
  return lease !== undefined;
}

function canReclaimLease(row: RunningAttemptRow, milestoneId: string): boolean {
  if (!row.worker_id || row.milestone_lease_token === null) return false;
  if (isAutoWorkerLive(row.worker_id)) return false;
  const lease = getMilestoneLease(milestoneId);
  if (!lease || lease.fencing_token < row.milestone_lease_token) return false;
  return lease.status !== "held" || Date.parse(lease.expires_at) <= Date.now();
}

function claimRecoveryLease(
  row: RunningAttemptRow,
  milestoneId: string,
): { workerId: string; milestoneLeaseToken: number } | null {
  if (!canReclaimLease(row, milestoneId) || !row.worker_id || row.milestone_lease_token === null) {
    return null;
  }
  const claimed = claimMilestoneLease(row.worker_id, milestoneId);
  if (!claimed.ok) return null;
  if (claimed.token <= row.milestone_lease_token) {
    releaseMilestoneLease(row.worker_id, milestoneId, claimed.token);
    return null;
  }
  return { workerId: row.worker_id, milestoneLeaseToken: claimed.token };
}

function requireSingleRunningAttempt(task: TaskSettleTask): RunningAttemptRow | null {
  if (!hasTaskLifecycleRow(task.milestoneId, task.sliceId, task.taskId)) {
    throw new Error(
      `gsd_task_settle: unknown Task ${task.milestoneId}/${task.sliceId}/${task.taskId}`,
    );
  }
  const running = readRunningAttempts(task);
  if (running.length === 0) return null;
  if (running.length > 1) {
    throw new Error(
      `gsd_task_settle: ${task.milestoneId}/${task.sliceId}/${task.taskId} has ` +
      `${running.length} running Attempts; refusing to guess — settle them by Attempt id in the DB.`,
    );
  }
  return running[0];
}

function readTaskLifecycleState(task: TaskSettleTask): TaskLifecycleState {
  const state = getTaskLegacyAndLifecycleStatus(task.milestoneId, task.sliceId, task.taskId);
  if (!state) {
    throw new Error(`gsd_task_settle: unknown Task ${unitId(task)}`);
  }
  return {
    legacyStatus: String(state.task_status),
    lifecycleStatus: state.lifecycle_status
      ? String(state.lifecycle_status) as CanonicalLifecycleStatus
      : null,
  };
}

function readPassingProofAttempt(task: TaskSettleTask): string | null {
  return getPassingProofAttemptId(task.milestoneId, task.sliceId, task.taskId);
}

function planCompletionProof(
  task: TaskSettleTask,
  lifecycleRows: TaskLifecycleReconcileRow[],
): TaskSettleProof | null {
  if (!lifecycleRows.some((row) => row.targetStatus === "completed")) return null;
  const attemptId = readPassingProofAttempt(task);
  if (attemptId) {
    return {
      attemptId,
      note: `current passing Technical Verdict is on Attempt ${attemptId}`,
    };
  }
  return {
    attemptId: null,
    note: "no current passing Technical Verdict — gsd_slice_complete will still refuse until one is recorded",
  };
}

// ── verification-paused reconcile (#2334) ───────────────────────────────────
//
// A finalizer verification pause strands a succeeded Attempt: the legacy Task
// stays in_progress, no Attempt is running, and every operator route refuses.
// The sanctioned exit is a receipt-gated reconcile to ready — gated on the
// durable DB receipt the finalize pause branch records, so only the
// finalizer (never an operator hand-edit) can vouch for the pause. Failed
// verification never qualifies: the Attempt outcome must be succeeded.
// The journal line the finalizer also writes is a diagnostic, never proof —
// except once, in the operator command, for a Task paused before the receipt
// became a DB event: that line is imported as the DB event with source
// 'legacy-journal'.

const VERIFICATION_PAUSED_EVENT = "task.verification.paused";

interface VerificationPauseReceipt {
  ts: string;
  attemptId: string;
}

/**
 * Record the finalizer's verification pause as a Domain Operation event bound
 * to the Task's latest Attempt. Returns the Attempt id, or null when the Task
 * has no Attempt (nothing a receipt could vouch for).
 */
export function recordTaskVerificationPause(
  task: TaskSettleTask,
  source?: "legacy-journal",
): string | null {
  const latest = readLatestTaskAttempt(task);
  if (!latest) return null;
  const entityId = unitId(task);
  const idempotencyKey = `internal:auto:task.verification.pause:${latest.attemptId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType: "task.verification.pause",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {
      milestoneId: task.milestoneId,
      sliceId: task.sliceId,
      taskId: task.taskId,
      attemptId: latest.attemptId,
    },
  }, () => ({
    events: [{
      eventType: VERIFICATION_PAUSED_EVENT,
      entityType: "task",
      entityId,
      payload: { attemptId: latest.attemptId, ...(source ? { source } : {}) },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `lifecycle/${entityId}`.toLowerCase(),
      projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
      rendererVersion: "1",
    }],
  }));
  return latest.attemptId;
}

// The receipt must name the latest Attempt: a pause recorded for an earlier
// Attempt must never vouch for this settlement (a superseding Attempt re-owns
// the exit).
function readVerificationPauseReceipt(
  task: TaskSettleTask,
  attemptId: string | undefined,
): VerificationPauseReceipt | null {
  if (!attemptId) return null;
  const rows = listVerificationPauseEventRows(unitId(task), VERIFICATION_PAUSED_EVENT);
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { attemptId?: unknown };
    if (payload.attemptId === attemptId) return { ts: String(row.created_at), attemptId };
  }
  return null;
}

// The journal receipt of a pre-upgrade pause. A journal line has no Attempt
// id, so freshness binds it to the Attempt: a line written before the latest
// Attempt's Result belongs to an earlier pause.
function readLegacyJournalPauseReceipt(
  basePath: string,
  task: TaskSettleTask,
  attemptId: string,
): VerificationPauseReceipt | null {
  const settledAt = getAttemptResultCreatedAt(attemptId);
  const settledMs = settledAt ? Date.parse(settledAt) : NaN;
  if (Number.isNaN(settledMs)) return null;
  const unit = unitId(task);
  const latest = [
    ...queryJournal(basePath, { eventType: "verification-paused", unitId: unit }),
    ...queryJournal(basePath, { eventType: "post-unit-finalize-end", unitId: unit })
      .filter((entry) => entry.data?.["reason"] === "verification-pause"),
  ]
    .filter((entry) => Date.parse(entry.ts) >= settledMs)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1);
  return latest ? { ts: latest.ts, attemptId } : null;
}

function importLegacyJournalPauseReceipt(basePath: string, task: TaskSettleTask): void {
  if (requireSingleRunningAttempt(task) !== null || !isVerificationPausedCandidate(task)) return;
  const attemptId = readLatestTaskAttempt(task)?.attemptId;
  if (!attemptId || readVerificationPauseReceipt(task, attemptId)) return;
  if (readLegacyJournalPauseReceipt(basePath, task, attemptId)) {
    recordTaskVerificationPause(task, "legacy-journal");
  }
}

function isVerificationPausedCandidate(task: TaskSettleTask): boolean {
  const state = readTaskLifecycleState(task);
  if (normalizeLegacyLifecycleStatus(state.legacyStatus) !== "in_progress") return false;
  const latest = readLatestTaskAttempt(task);
  if (latest?.state !== "settled" || latest?.outcome !== "succeeded") return false;
  // An agent-owned unrecovered abort route owns the lineage — `/gsd recover`
  // is the sanctioned exit, never a lifecycle release (same fail-closed rule
  // as the #2417 publication door).
  const route = readTaskRecoveryRoute(latest.attemptId);
  if (route && route.recoveryOwner === "agent" && route.action === "abort" && !route.resumeAuthorized) {
    return false;
  }
  return true;
}

function targetCanonicalStatus(
  legacyStatus: string,
  verificationPaused: boolean,
): "ready" | "completed" {
  const normalized = normalizeLegacyLifecycleStatus(legacyStatus);
  if (normalized === "pending") return "ready";
  if (normalized === "completed") return "completed";
  if (normalized === "in_progress" && verificationPaused) return "ready";
  throw new Error(
    `gsd_task_settle: reconcileLifecycle only repairs a pending/complete mismatch ` +
    `after an interrupted Attempt or succeeded completion, or a receipt-gated ` +
    `verification-paused in-progress Task; tasks.status is ${legacyStatus}`,
  );
}

function lifecycleTransitionSteps(
  from: CanonicalLifecycleStatus,
  to: "ready" | "completed",
): Array<"paused" | "ready" | "completed"> {
  if (from === to) return [];
  if (to === "ready") {
    if (from === "in_progress") return ["paused", "ready"];
    if (from === "paused") return ["ready"];
  } else if (from === "in_progress") {
    return ["completed"];
  }
  throw new Error(
    `gsd_task_settle: cannot reconcile lifecycle ${from} → ${to} after an interrupted ` +
    `Attempt or succeeded completion`,
  );
}

function planLifecycleReconcile(
  task: TaskSettleTask,
  reason: string,
  hasRunningAttempt: boolean,
  verificationPaused: boolean,
  pauseReceipt: VerificationPauseReceipt | null,
): TaskLifecycleReconcileRow[] {
  const latest = readLatestTaskAttempt(task);
  const state = readTaskLifecycleState(task);
  const normalizedLegacy = normalizeLegacyLifecycleStatus(state.legacyStatus);
  const succeededCompletion = latest?.outcome === "succeeded" &&
    normalizedLegacy === "completed";
  if (
    !hasRunningAttempt &&
    latest?.outcome !== "interrupted" &&
    !succeededCompletion &&
    !(verificationPaused && pauseReceipt)
  ) {
    throw new Error(
      verificationPaused
        ? "gsd_task_settle: reconcileLifecycle of a verification-paused in-progress Task " +
          "requires the durable verification-pause receipt for its latest Attempt; none was found " +
          "(the receipt is recorded by the auto finalizer when verification pauses)"
        : "gsd_task_settle: reconcileLifecycle requires an interrupted Attempt or a succeeded " +
          "Attempt with tasks.status complete (settle the running Attempt first)",
    );
  }
  const receiptGated = verificationPaused && pauseReceipt !== null;
  const target = targetCanonicalStatus(state.legacyStatus, receiptGated);
  const fromStatus = state.lifecycleStatus;
  if (fromStatus === null) {
    throw new Error(`gsd_task_settle: Task ${unitId(task)} has no canonical lifecycle to reconcile`);
  }
  if (fromStatus === target) return [];
  const steps = lifecycleTransitionSteps(fromStatus, target);
  const rows: TaskLifecycleReconcileRow[] = [];
  let current: CanonicalLifecycleStatus = fromStatus;
  for (const next of steps) {
    rows.push({
      currentStatus: current,
      targetStatus: next,
      rationale: receiptGated
        ? `${reason} (verification-pause receipt ${pauseReceipt?.ts ?? "unknown"}; adopt ${target} to ` +
          "release the stranded in-progress Task for replan/cancel; SUMMARY projections and " +
          "tasks.status are left in place)"
        : `${reason} (adopt ${target} to match tasks.status=${state.legacyStatus}; ` +
          "SUMMARY projections are left in place)",
    });
    current = next;
  }
  return rows;
}

function applyLifecycleReconcile(
  invocation: ExecutionInvocation,
  task: TaskSettleTask,
  reason: string,
  rows: TaskLifecycleReconcileRow[],
): void {
  const entityId = unitId(task);
  for (const step of rows) {
    const idempotencyKey = `${invocation.idempotencyKey}:lifecycle:${step.targetStatus}`;
    const fence = readDomainOperationFence(idempotencyKey);
    executeDomainOperation({
      operationType: "task.lifecycle.reconcile",
      idempotencyKey,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: invocation.actorType,
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
      sourceTransport: invocation.sourceTransport,
      ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
      payload: {
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        from: step.currentStatus,
        to: step.targetStatus,
        reason,
      },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        lifecycleStatus: step.targetStatus,
      });
      return {
        events: [{
          eventType: "task.lifecycle.reconciled",
          entityType: "task",
          entityId,
          payload: {
            from: step.currentStatus,
            to: step.targetStatus,
            reason,
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        }],
      };
    });
  }
}

/**
 * Detect a durable success stranded before publication (#2417): the latest
 * Attempt is settled succeeded at the verify stage, no Attempt is running, the
 * Task is not terminal in either vocabulary, and no abort route head owns the
 * lineage. The vocabularies already agree on non-terminal here, so this is not
 * a reconcile case — the only sanctioned writer is the verified publication
 * pipeline. Returns null unless every structural predicate holds; evidence
 * gates (passing verdict, source parity, UAT closure) stay inside publication
 * and fail apply closed when unsatisfied.
 */
function planDurableSuccessPublication(task: TaskSettleTask): TaskPublicationPlanRow | null {
  const state = readTaskLifecycleState(task);
  const lifecycleStatus = state.lifecycleStatus;
  if (lifecycleStatus !== "ready" && lifecycleStatus !== "in_progress") return null;
  if (normalizeLegacyLifecycleStatus(state.legacyStatus) === "completed") return null;
  const latest = readLatestTaskAttempt(task);
  if (!latest || latest.state !== "settled" || latest.outcome !== "succeeded" || latest.nextStage !== "verify") {
    return null;
  }
  const route = readTaskRecoveryRoute(latest.attemptId);
  if (route && route.recoveryOwner === "agent" && route.action === "abort" && !route.resumeAuthorized) {
    return null;
  }
  const verdict = readTaskTechnicalVerdict(latest.attemptId);
  return {
    attemptId: latest.attemptId,
    lifecycleStatus,
    legacyStatus: state.legacyStatus,
    verdict: verdict?.verdict ?? null,
    rationale:
      `Attempt ${latest.attemptId} settled succeeded at the verify stage — apply runs the ` +
      "verified publication pipeline (lifecycle → completed, tasks.status → complete)",
  };
}

/**
 * Read-only settle plan: the exact Attempt and optional lifecycle rows an
 * apply would change, including publication of a stranded succeeded Attempt.
 * An apply is a no-op only when rows, lifecycle rows, and publication are empty.
 */
export function planTaskSettle(
  task: TaskSettleTask,
  reason: string,
  options: TaskSettleOptions = {},
): TaskSettlePlan {
  const attempt = requireSingleRunningAttempt(task);
  // #2334: a receipt-gated verification-paused reconcile takes precedence over
  // the #2417 publication door — the finalizer paused this unit before the
  // publication boundary, so the operator exit is replan/cancel, not publish.
  // A candidate without the durable receipt fails closed instead of silently
  // routing to publication: the pause must be proven, never assumed.
  const verificationPaused =
    attempt === null && options.reconcileLifecycle === true && isVerificationPausedCandidate(task);
  const latestAttemptId = verificationPaused ? readLatestTaskAttempt(task)?.attemptId : undefined;
  const pauseReceipt = readVerificationPauseReceipt(task, latestAttemptId)
    ?? (latestAttemptId && options.legacyJournalBasePath
      ? readLegacyJournalPauseReceipt(options.legacyJournalBasePath, task, latestAttemptId)
      : null);
  if (verificationPaused && !pauseReceipt) {
    throw new Error(
      "gsd_task_settle: reconcileLifecycle of a verification-paused in-progress Task " +
      "requires the durable verification-pause receipt for its latest Attempt; none was found " +
      "(the receipt is recorded by the auto finalizer when verification pauses)",
    );
  }
  const publication = attempt === null && !pauseReceipt
    ? planDurableSuccessPublication(task)
    : null;
  const lifecycleRows = options.reconcileLifecycle && !publication
    ? planLifecycleReconcile(task, reason, attempt !== null, verificationPaused, pauseReceipt)
    : [];
  const proof = planCompletionProof(task, lifecycleRows);
  if (!attempt) return { task, rows: [], lifecycleRows, proof, publication };
  const leaseHeld = readLeaseHeld(attempt, task.milestoneId);
  const rationale = leaseHeld
    ? reason
    : canReclaimLease(attempt, task.milestoneId)
      ? `${reason} (the orphaned Attempt's worker is gone and its milestone lease is ` +
        "expired or released — apply will reclaim it with a newer fencing token)"
      : `${reason} (warning: the Attempt's milestone lease is no longer held, but a live ` +
        "worker or replacement lease prevents safe recovery — apply will refuse)";
  return {
    task,
    rows: [{
      attemptId: attempt.attempt_id,
      currentStatus: "running",
      targetStatus: "interrupted",
      rationale,
      leaseHeld,
    }],
    lifecycleRows,
    proof,
    publication,
  };
}

/**
 * Settle the Task's one running Attempt as `interrupted`. The own-lease path
 * uses a plain attempt.settle (V47 dispatch-scope rule). If the owner is no
 * longer live and its lease is expired or released, the operator reclaims the
 * lease with a newer fencing token and uses attempt.interrupt (#1907). A live
 * owner or replacement lease remains fail-closed.
 *
 * Optional `reconcileLifecycle` then adopts ready/completed to match
 * tasks.status after an interrupted Attempt or succeeded completion, without
 * reopening or deleting SUMMARY projections (#1749).
 *
 * A durable success stranded before publication (#2417) is neither: apply
 * runs the verified publication pipeline, which re-adopts the lifecycle to
 * completed and completes the legacy Task row. Its evidence gates
 * (passing host Technical Verdict, source parity, UAT closure) stay
 * fail-closed; verification itself belongs to `/gsd auto`. A finalizer
 * verification pause (#2334) outranks that door: when the durable
 * verification-pause receipt exists for the unit, reconcileLifecycle plans
 * in_progress → paused → ready so replan/cancel become reachable — never
 * publication, and never for a failed verification.
 */
export async function applyTaskSettle(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
  basePath: string;
  reconcileLifecycle?: boolean;
  legacyJournalBasePath?: string;
}): Promise<TaskSettlePlan & {
  settled: boolean;
  reconciled: boolean;
  resultId?: string;
  published?: { attemptId: string; status: "committed" | "replayed"; summaryPath: string };
}> {
  if (input.reconcileLifecycle && input.legacyJournalBasePath) {
    importLegacyJournalPauseReceipt(input.legacyJournalBasePath, input.task);
  }
  const plan = planTaskSettle(input.task, input.reason, {
    reconcileLifecycle: input.reconcileLifecycle,
  });
  let settled = false;
  let resultId: string | undefined;
  if (plan.rows.length > 0) {
    const row = plan.rows[0];
    const attempt = requireSingleRunningAttempt(input.task);
    if (!attempt || attempt.attempt_id !== row.attemptId) {
      throw new Error("gsd_task_settle: running Attempt changed after the dry-run plan; retry the operation");
    }
    const recovery = row.leaseHeld
      ? null
      : claimRecoveryLease(attempt, input.task.milestoneId);
    if (!row.leaseHeld && !recovery) {
      throw new Error(
        `gsd_task_settle: Attempt ${row.attemptId} was claimed under a milestone lease that is ` +
        "no longer held, but a live worker or replacement lease prevents safe recovery. " +
        "Re-enter `/gsd auto` to recover under the current replacement lease.",
      );
    }
    try {
      const settlement = settleTaskAttempt({
        invocation: input.invocation,
        attemptId: row.attemptId,
        outcome: "interrupted",
        failureClass: "operator-settle",
        summary: input.reason,
        output: {
          operator: true,
          milestoneId: input.task.milestoneId,
          sliceId: input.task.sliceId,
          taskId: input.task.taskId,
          reason: input.reason,
        },
        ...(recovery ? { recovery: {
          workerId: recovery.workerId,
          milestoneLeaseToken: recovery.milestoneLeaseToken,
        } } : {}),
      });
      settled = true;
      resultId = settlement.resultId;
    } finally {
      if (recovery) {
        releaseMilestoneLease(
          recovery.workerId,
          input.task.milestoneId,
          recovery.milestoneLeaseToken,
        );
      }
    }
  }
  let lifecycleRows = plan.lifecycleRows;
  let proof = plan.proof;
  let reconciled = false;
  if (input.reconcileLifecycle && !plan.publication) {
    const after = planTaskSettle(input.task, input.reason, {
      reconcileLifecycle: true,
    });
    lifecycleRows = after.lifecycleRows;
    proof = after.proof;
    if (lifecycleRows.length > 0) {
      applyLifecycleReconcile(input.invocation, input.task, input.reason, lifecycleRows);
      reconciled = true;
    }
  }
  let published: { attemptId: string; status: "committed" | "replayed"; summaryPath: string } | undefined;
  if (plan.publication) {
    // The deterministic per-Attempt key makes a concurrent auto-mode
    // publication of the same success serialize through the same fenced
    // domain-operation seam instead of racing it.
    const publication = await publishVerifiedTaskCompletion({
      invocation: internalExecutionInvocation(`internal:auto:task.publish:${plan.publication.attemptId}`),
      basePath: input.basePath,
      task: input.task,
      attemptId: plan.publication.attemptId,
    });
    published = {
      attemptId: plan.publication.attemptId,
      status: publication.status,
      summaryPath: publication.summaryPath,
    };
  }
  if (settled || reconciled || published) await renderStateProjection(input.basePath);
  return {
    ...plan,
    lifecycleRows,
    proof,
    settled,
    reconciled,
    ...(resultId ? { resultId } : {}),
    ...(published ? { published } : {}),
  };
}

// ── blocker-accepted operator closeout (#2202) ──────────────────────────────
//
// A Task whose execute-task Attempt settled as failed/blocker-discovered at the
// route stage with no running Attempt has no supported closeout: replan rejects
// it (not closed), settle has nothing to settle, and resume only authorizes a
// repaired retry. The `blocker-accepted` disposition accepts the discovered
// blocker explicitly: it closes the Task as terminal `blocker-accepted` in both
// vocabularies, records the blocker provenance on the canonical plan, and
// consumes the route Kernel head with a terminal closeout decision so the
// historical failure can never be re-routed. It never fabricates success
// evidence and never satisfies verdict-gated completion.

export type TaskSettleDisposition = "blocker-accepted";

export interface TaskBlockerAcceptedRow {
  attemptId: string;
  resultId: string;
  /** The discovered-blocker summary carried by the failed Result. */
  blockerSummary: string;
  currentStatus: string;
  targetStatus: "blocker-accepted";
  lifecycleFrom: CanonicalLifecycleStatus;
  /** True when the route Kernel head is consumed with a closeout decision. */
  routeConsumed: boolean;
  supersededRecoveryActionId: string | null;
  blockerId: string | null;
  rationale: string;
}

export interface TaskBlockerAcceptedPlan {
  task: TaskSettleTask;
  /** Zero rows means an apply is a no-op (the disposition already committed). */
  rows: TaskBlockerAcceptedRow[];
  alreadyAccepted: boolean;
}

export interface TaskBlockerAcceptedApplyResult {
  task: TaskSettleTask;
  accepted: boolean;
  alreadyAccepted: boolean;
  attemptId: string | null;
  resultId: string | null;
  routeConsumed: boolean;
}

type RouteHeadRow = TaskRouteHeadRow;

function readRouteHead(task: TaskSettleTask): RouteHeadRow | null {
  return getTaskRouteHead(task.milestoneId, task.sliceId, task.taskId);
}

/**
 * Read-only disposition plan: the exact Attempt, lifecycle, legacy status, and
 * route-head transitions an apply would write. Guards fail closed with the
 * exact prerequisite and the supported next action.
 */
export function planBlockerAcceptedDisposition(
  task: TaskSettleTask,
  reason: string,
): TaskBlockerAcceptedPlan {
  const state = readTaskLifecycleState(task);
  if (state.lifecycleStatus === "blocker-accepted" || state.legacyStatus === "blocker-accepted") {
    return { task, rows: [], alreadyAccepted: true };
  }
  const running = readRunningAttempts(task);
  if (running.length > 0) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires no running Attempt for ${unitId(task)} — ` +
      "settle the running Attempt first (gsd_task_settle without settleDisposition).",
    );
  }
  if (state.lifecycleStatus !== "in_progress") {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the Task lifecycle in_progress; found ` +
      `${state.lifecycleStatus ?? "none"} for ${unitId(task)} — only an active Task with a ` +
      "discovered blocker can be closed by accepting the blocker.",
    );
  }
  const attempt = readLatestTaskAttempt(task);
  if (
    !attempt || attempt.state !== "settled" || attempt.outcome !== "failed" ||
    attempt.nextStage !== "route" || attempt.resultFailureClass !== "blocker-discovered"
  ) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the latest Attempt of ${unitId(task)} settled ` +
      `as failed/blocker-discovered at the route stage; found ` +
      `${attempt ? `${attempt.state}/${attempt.outcome ?? "no-result"}` : "no Attempt"} at ` +
      `${attempt?.nextStage ?? "no Kernel head"}${attempt?.resultFailureClass ? ` (${attempt.resultFailureClass})` : ""}. ` +
      "Repair-and-retry is the separate successor-Attempt path (gsd_task_recovery_resume).",
    );
  }
  if (!attempt.resultId) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the failed Result identity of Attempt ` +
      `${attempt.attemptId} for ${unitId(task)}; the Attempt has no Result to preserve.`,
    );
  }
  const head = readRouteHead(task);
  if (!head || head.next_stage !== "route" || head.attempt_id !== attempt.attemptId) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the route Kernel head of ${unitId(task)} on ` +
      `Attempt ${attempt.attemptId}; found ${head ? `next_stage ${head.next_stage}` : "no Kernel head"}. ` +
      "The disposition consumes the route head with a terminal closeout decision.",
    );
  }
  const route = readTaskRecoveryRoute(attempt.attemptId);
  return {
    task,
    rows: [{
      attemptId: attempt.attemptId,
      resultId: attempt.resultId,
      blockerSummary: attempt.resultSummary ?? "",
      currentStatus: state.legacyStatus,
      targetStatus: "blocker-accepted",
      lifecycleFrom: state.lifecycleStatus,
      routeConsumed: true,
      supersededRecoveryActionId: route?.recoveryActionId ?? null,
      blockerId: route?.blocker?.blockerId ?? null,
      rationale: reason,
    }],
    alreadyAccepted: false,
  };
}

/**
 * Apply the `blocker-accepted` disposition: one Domain Operation writes the
 * terminal `blocker-accepted` status to both vocabularies, the blocker
 * provenance event on the canonical plan, and the terminal closeout Kernel
 * decision that consumes the route head. A repeated applied run is a no-op.
 */
export function applyBlockerAcceptedDisposition(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
}): TaskBlockerAcceptedApplyResult {
  const plan = planBlockerAcceptedDisposition(input.task, input.reason);
  if (plan.alreadyAccepted || plan.rows.length === 0) {
    return {
      task: input.task,
      accepted: false,
      alreadyAccepted: true,
      attemptId: null,
      resultId: null,
      routeConsumed: false,
    };
  }
  const row = plan.rows[0];
  const entityId = unitId(input.task);
  const acceptedAt = new Date().toISOString();
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  executeDomainOperation({
    operationType: "task.settle.blocker-accepted",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      attemptId: row.attemptId,
      resultId: row.resultId,
      disposition: "blocker-accepted",
      rationale: input.reason,
    },
  }, (context) => {
    // Consume the route head first: the terminal closeout decision makes the
    // historical failure unreachable for recovery routing.
    const head = readRouteHead(input.task);
    if (!head || head.next_stage !== "route" || head.attempt_id !== row.attemptId) {
      throw new Error(
        `gsd_task_settle: the route Kernel head of ${entityId} changed after the dry-run plan; ` +
        "retry the operation",
      );
    }
    const closeout = appendKernelCheckpoint(context, {
      lifecycleId: head.lifecycle_id,
      attemptId: row.attemptId,
      nextStage: "closeout",
      previousKernelCheckpointId: head.kernel_checkpoint_id,
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      lifecycleStatus: "blocker-accepted",
    });
    closeLegacyTaskAsBlockerAccepted(context, input.task);
    return {
      events: [{
        eventType: "task.blocker.accepted",
        entityType: "task",
        entityId,
        payload: {
          disposition: "blocker-accepted",
          from: row.lifecycleFrom,
          to: "blocker-accepted",
          attemptId: row.attemptId,
          resultId: row.resultId,
          blockerSummary: row.blockerSummary,
          ...(row.supersededRecoveryActionId
            ? { supersededRecoveryActionId: row.supersededRecoveryActionId }
            : {}),
          ...(row.blockerId ? { blockerId: row.blockerId } : {}),
          rationale: input.reason,
          acceptedAt,
          closeoutKernelCheckpointId: closeout.kernelCheckpointId,
        },
        destinations: ["projection"],
      }],
      projections: [
        {
          projectionKey: `task.blocker.accepted/${entityId}`.toLowerCase(),
          projectionKind: "task-recovery",
          rendererVersion: "1",
        },
        {
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        },
      ],
    };
  });
  return {
    task: input.task,
    accepted: true,
    alreadyAccepted: false,
    attemptId: row.attemptId,
    resultId: row.resultId,
    routeConsumed: row.routeConsumed,
  };
}
