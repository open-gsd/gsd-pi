// Project/App: gsd-pi
// File Purpose: Stage canonical Task results and publish verified legacy completion projections.

import type { TaskRow } from "./db-task-slice-rows.js";
import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  completeLegacyTaskForVerifiedAttempt,
  readDomainOperationFence,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { requireExactMergedUatClosureEvidence } from "./exact-merged-uat-closure.js";
import {
  getTask,
  getSlice,
} from "./gsd-db.js";
import { renderPlanCheckboxes, renderTaskSummary } from "./markdown-renderer.js";
import { clearPathCache, resolveGsdPathContract, resolveTaskFile } from "./paths.js";
import {
  closeTaskQualityGates,
  type TaskQualityGateContent,
} from "./quality-gate-closure.js";
import {
  readLatestTaskAttempt,
  settleTaskAttempt,
  type StagedTaskCompletionMutation,
} from "./task-execution-domain-operation.js";
import {
  readTaskRecoveryRoute,
  type TaskRecoveryRouteSnapshot,
} from "./task-recovery-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
} from "./verification-source-integrity.js";
import { renderSummaryContent } from "./workflow-projections.js";

export interface TaskCompletionIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface StagedVerificationEvidence {
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
}

export interface StageTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskCompletionIdentity;
  completion: {
    oneLiner: string;
    narrative: string;
    verification: string;
    deviations: string;
    knownIssues: string;
    failureModes?: string;
    loadProfile?: string;
    negativeTests?: string;
    keyFiles: string[];
    keyDecisions: string[];
    blockerDiscovered: boolean;
    verificationEvidence: StagedVerificationEvidence[];
  };
}

export interface PublishVerifiedTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskCompletionIdentity;
  attemptId: string;
}

export interface StagedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  resultId: string;
  summaryPath: string;
  nextStage: "verify" | "route";
}

export interface PublishedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  summaryPath: string;
}

interface AttemptRow {
  attempt_id: string;
  lifecycle_id: string;
  kernel_checkpoint_id: string;
  next_stage: "verify" | "route";
  output_json: string;
}

export type TaskCompletionAuthority = "canonical" | "legacy";

function requireTask(input: TaskCompletionIdentity): TaskRow {
  const task = getTask(input.milestoneId, input.sliceId, input.taskId);
  if (!task) throw new Error("Task completion target is missing");
  return task;
}

function replayAttemptId(
  idempotencyKey: string,
  task: TaskCompletionIdentity,
): string | undefined {
  const row = getDb().prepare(`
    SELECT result.attempt_id
    FROM workflow_operations operation
    JOIN workflow_attempt_results result
      ON result.operation_id = operation.operation_id
     AND result.project_id = operation.project_id
     AND result.project_revision = operation.resulting_revision
     AND result.authority_epoch = operation.resulting_authority_epoch
    JOIN workflow_execution_attempts attempt
      ON attempt.attempt_id = result.attempt_id
     AND attempt.lifecycle_id = result.lifecycle_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE operation.idempotency_key = :idempotency_key
      AND lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
  `).get({
    ":idempotency_key": idempotencyKey,
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  return row ? String(row["attempt_id"]) : undefined;
}

export interface TaskCompletionAuthorityOptions {
  /**
   * gsd_task_complete(blockerDiscovered: true): a blocker report is an
   * escalation channel, not a completion — it must always be recordable, even
   * when the supervisor already settled the Attempt out from under a surviving
   * session (#1973). When set, the running-attempt gate routes to the legacy
   * write path (a durable DB write that needs no Attempt) instead of throwing.
   */
  blockerReport?: boolean;
}

/**
 * Name the recorded recovery action and its sanctioned next move so a caller
 * never has to guess the recoveryActionId (#2267). Shared by the
 * running-attempt gate rejections and the canonical blocker receipt.
 */
export function recoveryRouteLever(route: TaskRecoveryRouteSnapshot): string {
  if (route.resumeAuthorized) {
    return ` Recovery action ${route.recoveryActionId} (${route.action}) already authorizes its successor — ` +
      "rerun `/gsd auto` to continue from the repair checkpoint.";
  }
  if (route.resumeEligibility?.eligible) {
    return ` Recovery action ${route.recoveryActionId} (${route.action}) is eligible for resume — ` +
      `call gsd_task_recovery_resume with recoveryActionId "${route.recoveryActionId}".`;
  }
  return ` Recovery action ${route.recoveryActionId} (${route.action}) is recorded for this Attempt.`;
}

/**
 * Describe the latest Attempt's settled state and any recorded recovery
 * action so a session rejected by the running-attempt gate learns the
 * sanctioned exit instead of a bare rejection (#1973). Best-effort: an empty
 * string when nothing useful can be read.
 */
function latestAttemptRecoveryContext(task: TaskCompletionIdentity): string {
  try {
    const attempt = readLatestTaskAttempt(task);
    if (!attempt) return "";
    const settled = attempt.state === "settled"
      ? ` settled with outcome=${attempt.outcome ?? "unknown"}${
        attempt.resultFailureClass ? ` failureClass=${attempt.resultFailureClass}` : ""}`
      : " still marked running";
    const route = readTaskRecoveryRoute(attempt.attemptId);
    const lever = route ? recoveryRouteLever(route) : "";
    return ` Latest Attempt ${attempt.attemptId} is${settled}.${lever}`;
  } catch {
    return "";
  }
}

export function resolveTaskCompletionAuthority(
  task: TaskCompletionIdentity,
  idempotencyKey?: string,
  options?: TaskCompletionAuthorityOptions,
): TaskCompletionAuthority {
  if (idempotencyKey && replayAttemptId(idempotencyKey, task)) return "canonical";
  if (idempotencyKey) {
    const conflictingOperation = getDb().prepare(`
      SELECT 1 AS present FROM workflow_operations
      WHERE idempotency_key = :idempotency_key
    `).get({ ":idempotency_key": idempotencyKey });
    if (conflictingOperation) {
      throw new Error("Task completion idempotency identity belongs to a different canonical operation");
    }
  }

  const lifecycle = getDb().prepare(`
    SELECT lifecycle.lifecycle_id,
           EXISTS (
             SELECT 1 FROM workflow_execution_attempts attempt
             WHERE attempt.lifecycle_id = lifecycle.lifecycle_id
               AND attempt.project_id = lifecycle.project_id
               AND attempt.attempt_state = 'running'
           ) AS has_running_attempt,
           EXISTS (
             SELECT 1
             FROM workflow_execution_attempts attempt
             JOIN milestone_leases lease
               ON lease.milestone_id = lifecycle.milestone_id
              AND lease.worker_id = attempt.worker_id
              AND lease.fencing_token = attempt.milestone_lease_token
              AND lease.status = 'held'
              AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE attempt.lifecycle_id = lifecycle.lifecycle_id
               AND attempt.project_id = lifecycle.project_id
               AND attempt.attempt_state = 'running'
           ) AS has_held_running_attempt
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;

  if (!lifecycle) {
    if (idempotencyKey) {
      throw new Error("Canonical Task completion lifecycle is missing for private invocation");
    }
    return "legacy";
  }
  if (Number(lifecycle["has_held_running_attempt"]) === 1) return "canonical";
  if (options?.blockerReport) return "legacy";
  if (Number(lifecycle["has_running_attempt"]) === 1) {
    throw new Error(
      "Canonical Task completion found an orphaned running Attempt whose milestone lease is no " +
      "longer held. Dry-run gsd_task_settle and apply it only if the lease is reported " +
      "reclaimable; otherwise re-enter `/gsd auto` to recover under the current lease." +
      latestAttemptRecoveryContext(task),
    );
  }
  throw new Error(
    "Canonical Task completion has no running Attempt to close. Re-enter `/gsd auto` to resume " +
    "the Task from its durable checkpoint." +
    latestAttemptRecoveryContext(task),
  );
}

function runningAttemptId(task: TaskCompletionIdentity): string {
  const attempt = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND attempt.attempt_state = 'running'
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!attempt) throw new Error("Task completion requires a running canonical Attempt");
  return String(attempt["attempt_id"]);
}

function buildStagedTaskCompletion(
  input: StageTaskCompletionInput,
  existing: TaskRow,
): StagedTaskCompletionMutation {
  const staged = {
    ...existing,
    status: "in_progress",
    completed_at: null,
    one_liner: input.completion.oneLiner,
    narrative: input.completion.narrative,
    verification_result: input.completion.verification,
    blocker_discovered: input.completion.blockerDiscovered,
    deviations: input.completion.deviations,
    known_issues: input.completion.knownIssues,
    key_files: input.completion.keyFiles,
    key_decisions: input.completion.keyDecisions,
    full_summary_md: "",
  } satisfies TaskRow;
  return {
    task: input.task,
    oneLiner: input.completion.oneLiner,
    narrative: input.completion.narrative,
    verificationResult: input.completion.verification,
    blockerDiscovered: input.completion.blockerDiscovered,
    deviations: input.completion.deviations,
    knownIssues: input.completion.knownIssues,
    keyFiles: input.completion.keyFiles,
    keyDecisions: input.completion.keyDecisions,
    fullSummaryMd: renderSummaryContent(
      staged,
      input.task.sliceId,
      input.task.milestoneId,
      input.completion.verificationEvidence,
    ),
    verificationEvidence: input.completion.verificationEvidence,
  };
}

async function renderTaskSummaryProjection(
  basePath: string,
  task: TaskCompletionIdentity,
): Promise<string> {
  try {
    const wroteSummary = await renderTaskSummary(
      basePath,
      task.milestoneId,
      task.sliceId,
      task.taskId,
    );
    if (!wroteSummary) throw new Error("summary projection write returned false");
  } catch (error) {
    throw new Error(`Task completion summary projection failed: ${(error as Error).message}`);
  }

  clearPathCache();
  const summaryPath = resolveTaskFile(
    basePath,
    task.milestoneId,
    task.sliceId,
    task.taskId,
    "SUMMARY",
  );
  if (!summaryPath) throw new Error("Task completion projection failed: summary path is missing");
  return summaryPath;
}

async function renderTaskSummaryProjections(
  basePath: string,
  task: TaskCompletionIdentity,
): Promise<string> {
  const contract = resolveGsdPathContract(basePath);
  const canonicalPath = await renderTaskSummaryProjection(contract.projectRoot, task);
  if (!contract.isWorktree || contract.workRoot === contract.projectRoot) return canonicalPath;
  return renderTaskSummaryProjection(contract.workRoot, task);
}

async function renderPublishedTaskCompletionProjections(
  basePath: string,
  task: TaskCompletionIdentity,
): Promise<string> {
  const summaryPath = await renderTaskSummaryProjections(basePath, task);
  try {
    const wrotePlan = await renderPlanCheckboxes(basePath, task.milestoneId, task.sliceId);
    if (!wrotePlan) throw new Error("plan projection write returned false");
  } catch (error) {
    throw new Error(`Task completion PLAN projection failed: ${(error as Error).message}`);
  }
  return summaryPath;
}

export async function stageTaskCompletion(
  input: StageTaskCompletionInput,
): Promise<StagedTaskCompletionReceipt> {
  const replayAttempt = replayAttemptId(input.invocation.idempotencyKey, input.task);
  const task = requireTask(input.task);
  const legacyClosed = ["complete", "done", "closed"].includes(task.status);
  if (legacyClosed && !replayAttempt) {
    throw new Error("A newly committed Task settlement cannot target an already-complete legacy Task");
  }
  const attemptId = replayAttempt ?? runningAttemptId(input.task);
  const blocked = input.completion.blockerDiscovered;
  const settlement = settleTaskAttempt({
    invocation: input.invocation,
    attemptId,
    outcome: blocked ? "failed" : "succeeded",
    failureClass: blocked ? "blocker-discovered" : "none",
    summary: input.completion.oneLiner,
    output: {
      narrative: input.completion.narrative,
      verification: input.completion.verification,
      verificationEvidence: input.completion.verificationEvidence.map((evidence) => ({
        command: evidence.command,
        exitCode: evidence.exitCode,
        verdict: evidence.verdict,
        durationMs: evidence.durationMs,
      })),
      blockerDiscovered: input.completion.blockerDiscovered,
      deviations: input.completion.deviations,
      knownIssues: input.completion.knownIssues,
      failureModes: input.completion.failureModes ?? "",
      loadProfile: input.completion.loadProfile ?? "",
      negativeTests: input.completion.negativeTests ?? "",
      keyFiles: input.completion.keyFiles,
      keyDecisions: input.completion.keyDecisions,
    },
    stagedTaskCompletion: buildStagedTaskCompletion(input, task),
  });

  // A blockerDiscovered staging must not project a SUMMARY at all (#1726):
  // the Attempt failed, so there is no completion to render.
  let summaryPath = "";
  if (!blocked) {
    summaryPath = await renderTaskSummaryProjections(input.basePath, input.task);
  }
  return {
    status: settlement.status,
    attemptId,
    resultId: settlement.resultId,
    summaryPath,
    nextStage: settlement.nextStage,
  };
}

function loadSucceededAttempt(input: PublishVerifiedTaskCompletionInput): AttemptRow {
  const attempt = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.lifecycle_id, checkpoint.kernel_checkpoint_id,
           checkpoint.next_stage, result.output_json
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = attempt.lifecycle_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = attempt.lifecycle_id
     AND criterion.project_id = attempt.project_id
     AND criterion.criterion_key = 'host-technical-verification'
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.lifecycle_id = attempt.lifecycle_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.project_id = attempt.project_id
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND lifecycle.lifecycle_status = 'in_progress'
      AND attempt.attempt_state = 'settled'
      AND result.outcome = 'succeeded'
      AND checkpoint.next_stage = 'verify'
      AND verdict.verdict = 'pass'
      AND evidence.observation = 'passed'
      AND evidence.source_revision = verdict.tested_source_revision
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts successor
        WHERE successor.supersedes_verdict_id = verdict.verdict_id
      )
  `).get({
    ":attempt_id": input.attemptId,
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
    ":task_id": input.task.taskId,
  }) as unknown as AttemptRow | undefined;
  if (!attempt) {
    throw new Error("Verified Task publication requires a succeeded Attempt with passing host Technical Verdict evidence");
  }
  return attempt;
}

function taskQualityGateContent(attempt: AttemptRow): TaskQualityGateContent {
  let output: unknown;
  try {
    output = JSON.parse(attempt.output_json);
  } catch {
    throw new Error("Verified Task publication requires a valid durable Attempt result");
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Verified Task publication requires an object-shaped durable Attempt result");
  }
  const record = output as Record<string, unknown>;
  const readField = (key: keyof TaskQualityGateContent): string => {
    const value = record[key];
    if (value === undefined) return "";
    if (typeof value !== "string") {
      throw new Error(`Verified Task publication found invalid ${key} in durable Attempt result`);
    }
    return value;
  };
  return {
    failureModes: readField("failureModes"),
    loadProfile: readField("loadProfile"),
    negativeTests: readField("negativeTests"),
  };
}

function publishCanonicalCompletion(
  input: PublishVerifiedTaskCompletionInput,
): "committed" | "replayed" {
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  const operation = executeDomainOperation({
    operationType: "task.completion.publish",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      task: {
        milestoneId: input.task.milestoneId,
        sliceId: input.task.sliceId,
        taskId: input.task.taskId,
      },
      attemptId: input.attemptId,
    },
  }, (context) => {
    const attempt = loadSucceededAttempt(input);
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      lifecycleStatus: "completed",
    });

    let previousCheckpointId = attempt.kernel_checkpoint_id;
    const remainingStages = ["route", "closeout", "settled"] as const;
    for (const nextStage of remainingStages) {
      const checkpoint = appendKernelCheckpoint(context, {
        lifecycleId: attempt.lifecycle_id,
        attemptId: attempt.attempt_id,
        nextStage,
        previousKernelCheckpointId: previousCheckpointId,
      });
      previousCheckpointId = checkpoint.kernelCheckpointId;
    }

    completeLegacyTaskForVerifiedAttempt(context, input.task);
    closeTaskQualityGates(input.task, taskQualityGateContent(attempt));

    const entityId = `${input.task.milestoneId}/${input.task.sliceId}/${input.task.taskId}`;
    return {
      events: [{
        eventType: "task.completion.published",
        entityType: "task",
        entityId,
        payload: { attemptId: input.attemptId },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `execution/${entityId}`.toLowerCase(),
        projectionKind: "task-execution",
        rendererVersion: "1",
      }],
    };
  });
  return operation.status;
}

function requireCurrentVerifiedSource(input: PublishVerifiedTaskCompletionInput): void {
  if (readDomainOperationFence(input.invocation.idempotencyKey).replay) return;

  const verdict = readTaskTechnicalVerdict(input.attemptId);
  if (!verdict || verdict.verdict !== "pass") {
    throw new Error("Verified Task publication requires a passing host Technical Verdict");
  }
  const preferences = loadEffectiveGSDPreferences(input.basePath)?.preferences;
  const task = getTask(input.task.milestoneId, input.task.sliceId, input.task.taskId);
  const slice = getSlice(input.task.milestoneId, input.task.sliceId);
  const resolved = resolveVerificationRepositoryTargets(input.basePath, preferences, task, slice);
  if (resolved.explicitTargetsRequested && resolved.repositories.length === 0) {
    throw new Error("Verified Task publication cannot resolve its verification target repositories");
  }
  const targets = resolved.repositories.length > 0
    ? resolved.repositories.map((repository) => ({ id: repository.id, cwd: repository.root }))
    : [{ id: "root", cwd: input.basePath }];
  const source = captureVerificationSourceSnapshot(targets);
  if (!source.ok) throw new Error(source.error);
  if (source.snapshot.aggregateRevision !== verdict.testedSourceRevision) {
    throw new Error("Verified Task publication source no longer matches its host verification evidence");
  }
  requireExactMergedUatClosureEvidence({
    basePath: input.basePath,
    task: input.task,
    verdict,
  });
}

export async function publishVerifiedTaskCompletion(
  input: PublishVerifiedTaskCompletionInput,
): Promise<PublishedTaskCompletionReceipt> {
  requireCurrentVerifiedSource(input);
  const status = publishCanonicalCompletion(input);
  const summaryPath = await renderPublishedTaskCompletionProjections(input.basePath, input.task);
  return {
    status,
    attemptId: input.attemptId,
    summaryPath,
  };
}
