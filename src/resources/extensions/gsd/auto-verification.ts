// Project/App: gsd-pi
// File Purpose: Post-unit verification gate for GSD auto-mode units.

/**
 * Post-unit verification gate for auto-mode.
 *
 * Runs typecheck/lint/test checks, captures runtime errors, performs
 * dependency audits, handles auto-fix retry logic, and writes
 * verification evidence JSON.
 *
 * Extracted from the pre-loop agent_end handler in auto.ts. Returns a
 * sentinel value instead of calling return/pauseAuto directly — the
 * caller checks the result and handles control flow.
 */

import type { ExtensionContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gsdProjectionRoot, legacyMilestonesDir, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "./paths.js";
import { resolveMilestoneValidationVerdict } from "./milestone-validation-verdict.js";
import { isMilestoneLifecycleAdopted } from "./db/milestone-closeout-readiness.js";
import { hasPendingMilestoneSubjectiveUat } from "./milestone-subjective-uat-domain-operation.js";
import { parseUnitId } from "./unit-id.js";
import {
  getMilestoneSlices,
  getSliceTasks,
  getTask,
  getTaskVerificationEvidence,
  isDbAvailable,
} from "./gsd-db.js";
import type { TaskRow } from "./db-task-slice-rows.js";
import { formatEscalationForDisplay, readEscalationArtifact } from "./escalation.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import type { GSDPreferences } from "./preferences-types.js";
import { isClosedStatus } from "./status-guards.js";
import {
  runVerificationGate,
  runVerificationGateForTargets,
  formatFailureContext,
  formatFailureSignature,
  captureRuntimeErrors,
  runDependencyAudit,
  hasQualifyingTaskEvidence,
} from "./verification-gate.js";
import type { VerificationTarget, TaskVerificationEvidence } from "./verification-gate.js";
import { writeVerificationJSON, type PostExecutionCheckJSON, type EvidenceJSON } from "./verification-evidence.js";
import { logWarning } from "./workflow-logger.js";
import { runPostExecutionChecks, type PostExecutionResult } from "./post-execution-checks.js";
import type { AutoSession } from "./auto/session.js";
import type { ErrorContext } from "./auto/types.js";
import type { VerificationResult as VerificationGateResult } from "./types.js";
import { join } from "node:path";
import { resolveUokFlags } from "./uok/flags.js";
import { UokGateRunner } from "./uok/gate-runner.js";
import { verificationRetryKey } from "./auto/verification-retry-policy.js";
import { decideVerificationVerdict, describeHostVerificationRationale } from "./verification-verdict.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import type { SliceRow } from "./db-task-slice-rows.js";
import { getSlice } from "./gsd-db.js";
import { getLedger } from "./metrics.js";
import { getUnitCostSpikeAction, resolveUnitCostSpikeMultiplier } from "./auto-budget.js";
import { formatPostUnitStatusCard } from "./auto-status-message.js";
import { detectWebApp } from "./web-app-uat.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
  type TaskExecutionAttemptSnapshot,
} from "./task-execution-domain-operation.js";
import { recordFailureAndSelectRecovery, type TaskRecoveryReceipt } from "./task-recovery-domain-operation.js";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
  type InvalidateTaskTechnicalPassInput,
  type RecordTaskTechnicalVerdictInput,
  type TaskTechnicalVerdictReceipt,
  type TaskTechnicalVerdictSnapshot,
} from "./task-verification-domain-operation.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
  verificationSourceChanged,
  type VerificationSourceSnapshot,
} from "./verification-source-integrity.js";

type TaskIdentity = { milestoneId: string; sliceId: string; taskId: string };
type VerificationAttemptSnapshot = Pick<
  TaskExecutionAttemptSnapshot,
  "attemptId" | "resultId" | "resultFailureClass" | "resultSummary" | "state" | "outcome" | "nextStage"
>;

export interface TaskVerificationAuthority {
  readLatestTaskAttempt(task: TaskIdentity): VerificationAttemptSnapshot | null;
  readTaskTechnicalVerdict(attemptId: string): TaskTechnicalVerdictSnapshot | null;
  recordTaskTechnicalVerdict(input: RecordTaskTechnicalVerdictInput): TaskTechnicalVerdictReceipt;
  invalidateTaskTechnicalPass(input: InvalidateTaskTechnicalPassInput): TaskTechnicalVerdictReceipt;
  routeTaskFailure: typeof recordFailureAndSelectRecovery;
}

export interface VerificationContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  taskAuthority?: TaskVerificationAuthority;
  runPostExecutionChecks?: typeof runPostExecutionChecks;
  runVerificationGate?: typeof runVerificationGate;
}

export type VerificationResult = "continue" | "retry" | "pause" | "abort";
type PauseAutoFn = (ctx?: ExtensionContext, pi?: ExtensionAPI, errorContext?: ErrorContext) => Promise<void>;

interface VerificationEvidenceLocation {
  dir: string;
  fileSliceId?: string;
}

const defaultTaskVerificationAuthority: TaskVerificationAuthority = {
  readLatestTaskAttempt,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
  invalidateTaskTechnicalPass,
  routeTaskFailure: recordFailureAndSelectRecovery,
};

function resolveVerificationEvidenceLocation(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): VerificationEvidenceLocation | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;

  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = mDir.startsWith(legacyBase + "/") || mDir.startsWith(legacyBase + "\\");
  if (!isLegacy) {
    return { dir: mDir, fileSliceId: sliceId };
  }

  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  return { dir: join(sDir, "tasks") };
}

function getCurrentUnitCostStats(unitId: string): { unitCostUsd: number; rollingAvgUsd: number } {
  const ledger = getLedger();
  if (!ledger || !Array.isArray(ledger.units) || ledger.units.length === 0) {
    return { unitCostUsd: 0, rollingAvgUsd: 0 };
  }
  let unitCostUsd = 0;
  let totalCost = 0;
  let totalUnits = 0;
  for (const unit of ledger.units) {
    const cost = typeof unit?.cost === "number" ? unit.cost : 0;
    if (!Number.isFinite(cost) || cost < 0) continue;
    totalCost += cost;
    totalUnits++;
    if (unit?.id === unitId) unitCostUsd += cost;
  }
  return {
    unitCostUsd,
    rollingAvgUsd: totalUnits > 0 ? totalCost / totalUnits : 0,
  };
}

function verificationFailureSummary(
  failedCommands: string[],
  fallback: string | null,
): string {
  if (failedCommands.length === 0) return fallback ?? "host verification policy";
  if (failedCommands.length <= 3) return failedCommands.join(", ");
  return `${failedCommands.slice(0, 3).join(", ")}... and ${failedCommands.length - 3} more`;
}

function recordDurableVerificationRetry(
  session: AutoSession,
  retryKey: string,
  failureContext: string,
): VerificationResult {
  if (!session.currentUnit) throw new Error("Task verification retry requires a current unit");
  if (session.pendingVerificationRetry?.unitId === session.currentUnit.id) return "retry";
  const attempt = (session.verificationRetryCount.get(retryKey) ?? 0) + 1;
  session.verificationRetryCount.set(retryKey, attempt);
  session.pendingVerificationRetry = {
    unitId: session.currentUnit.id,
    failureContext,
    attempt,
  };
  return "retry";
}

function recordHostTechnicalVerdict(input: {
  context: VerificationContext;
  attempt: VerificationAttemptSnapshot;
  result: VerificationGateResult;
  verdict: RecordTaskTechnicalVerdictInput["verdict"];
  rationale: string;
  sourceBefore?: VerificationSourceSnapshot;
  sourceAfter?: VerificationSourceSnapshot;
  sourceError?: string;
}): TaskTechnicalVerdictReceipt {
  const { s } = input.context;
  const authority = input.context.taskAuthority ?? defaultTaskVerificationAuthority;
  if (!isTaskAttemptAwaitingVerification(input.attempt)) {
    throw new Error("Host verification requires the latest succeeded canonical Attempt at the verify stage");
  }
  const startedAtMs = Number.isFinite(input.result.timestamp) ? input.result.timestamp : Date.now();
  const durationMs = input.result.checks.reduce((total, check) => total + Math.max(0, check.durationMs), 0);
  const endedAtMs = startedAtMs + durationMs;
  const commands = input.result.checks.map((check) => check.command).filter(Boolean);
  const targetSourceRevisions = Object.fromEntries(
    (input.sourceBefore?.targets ?? []).map((target) => [target.targetId, target.revision]),
  );
  return authority.recordTaskTechnicalVerdict({
    invocation: internalExecutionInvocation(`internal:auto:attempt.verify:${input.attempt.attemptId}`),
    attemptId: input.attempt.attemptId,
    testedSourceRevision: input.sourceBefore?.aggregateRevision ?? "unavailable",
    verdict: input.verdict,
    rationale: input.rationale,
    evidence: {
      evidenceClass: "command",
      commandOrTool: commands.length > 0 ? commands.join(" && ") : "gsd-host-verification-policy",
      workingDirectory: s.basePath,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      exitCode: input.verdict === "pass" ? 0 : (input.result.checks.find((check) => check.exitCode !== 0)?.exitCode ?? 1),
      observation: input.verdict === "pass" ? "passed" : input.verdict === "fail" ? "failed" : "inconclusive",
      durableOutputRef: `db://host-verification/${input.attempt.attemptId}`,
      environment: {
        node: process.version,
        platform: process.platform,
        discoverySource: input.result.discoverySource,
        targetSourceRevisions,
        sourceRevisionAfter: input.sourceAfter?.aggregateRevision ?? "unavailable",
        sourceIntegrity: input.sourceError ?? "stable",
        ...(input.result.checks.some((check) => check.failureClass === "timeout")
          ? { failureClass: "timeout" }
          : {}),
      },
    },
  });
}

interface FailedVerdictIdentity {
  verdictId: string;
  evidenceId: string;
  verdict: "fail" | "inconclusive";
  rationale?: string;
}

function resolveVerificationTimeoutMs(prefs: GSDPreferences | undefined): number {
  const raw = prefs?.verification_timeout_ms;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

export const _resolveVerificationTimeoutMsForTest = resolveVerificationTimeoutMs;

function hostRecoveryRationale(
  verdict: FailedVerdictIdentity,
  extras?: { checkName?: string; observed?: string; expected?: string; nextAction?: string },
): string {
  return verdict.rationale ?? describeHostVerificationRationale({
    verdict: verdict.verdict,
    checkName: extras?.checkName ?? "host-verification",
    observed: extras?.observed ?? verdict.verdict,
    expected: extras?.expected ?? "pass",
    evidenceRef: `${verdict.evidenceId} (verdict ${verdict.verdictId})`,
    ...(extras?.nextAction ? { nextAction: extras.nextAction } : {}),
  });
}

function routeHostTechnicalFailure(
  authority: TaskVerificationAuthority,
  attempt: VerificationAttemptSnapshot,
  verdict: FailedVerdictIdentity,
  failureKind: "verification-failed" | "verification-drift" = "verification-failed",
  // A terminal abort is resumable by design via `gsd_task_recovery_resume`, but that
  // tool needs the exact recoveryActionId. Hand it back so the caller can surface it
  // on the finalize break reason instead of discarding it here (#1593).
  recordAbort?: (recoveryActionId: string) => void,
  // Invoked for EVERY routed decision (not just aborts) so callers that must
  // surface the sanctioned exit on the first pause — e.g. the safety
  // evidence-xref block (#1641) — can report the minted recoveryActionId.
  onRouted?: (recoveryActionId: string, action: TaskRecoveryReceipt["action"]) => void,
): "retry" | "abort" {
  if (!attempt.resultId) throw new Error("Host verification Attempt Result is missing");
  const routeInput = {
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${attempt.resultId}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind },
    summary: failureKind === "verification-drift"
      ? "Stored host verification pass no longer matches the current source"
      : `Host verification ${verdict.verdict} for ${verdict.verdictId}`,
    evidence: {
      verdictId: verdict.verdictId,
      evidenceId: verdict.evidenceId,
      verdict: verdict.verdict,
    },
    rationale: hostRecoveryRationale(verdict),
  } as const;
  // A response can be lost after its Domain Operation already committed (a
  // dropped connection, a fault injected between commit and return). Retrying
  // the identical idempotency key is safe: it either replays the committed
  // receipt or reproduces the same deterministic error.
  let recovery;
  try {
    recovery = authority.routeTaskFailure(routeInput);
  } catch {
    recovery = authority.routeTaskFailure(routeInput);
  }
  onRouted?.(recovery.recoveryActionId, recovery.action);
  switch (recovery.action) {
    case "retry":
    case "repair":
    case "remediate":
    case "replan":
      return "retry";
    case "abort": {
      if (recovery.status === "replayed" && recovery.resumeAuthorized) return "retry";
      recordAbort?.(recovery.recoveryActionId);
      return "abort";
    }
    default:
      throw new Error(`Unsupported agent recovery action ${recovery.action}`);
  }
}

export const _routeHostTechnicalFailureForTest = routeHostTechnicalFailure;

export interface EvidenceCrossReferenceBlockResult {
  recoveryActionId: string;
  action: TaskRecoveryReceipt["action"];
  outcome: "retry" | "abort";
}

/**
 * Settle a blocking safety evidence cross-reference mismatch through the
 * canonical verdict + route seam (#1641 / #1649).
 *
 * The safety harness detects a Task that claimed passing verification which the
 * recorded execution contradicts. Before this seam existed the blocking branch
 * was a pure read (notify → pause), which left the Attempt wedged at
 * settled/succeeded/verify forever: no recoveryActionId was minted, so
 * `gsd_task_recovery_resume` had no key to accept, and every resume replayed
 * the identical finalize sequence.
 *
 * This records the withheld verdict as a durable failing host Technical
 * Verdict (which advances the kernel checkpoint to the route stage, ending the
 * awaiting-verification wedge) and routes the failure through the same durable
 * recovery policy the verification gate uses — same idempotency key, same
 * classification — so any later gate pass over this Attempt replays rather
 * than conflicts.
 */
export function routeEvidenceCrossReferenceBlock(input: {
  attempt: VerificationAttemptSnapshot;
  basePath: string;
  mismatch: {
    command: string;
    claimedExitCode: number;
    actualExitCode: number | null;
    reason: string;
  };
  taskAuthority?: TaskVerificationAuthority;
}): EvidenceCrossReferenceBlockResult {
  const authority = input.taskAuthority ?? defaultTaskVerificationAuthority;
  const attempt = input.attempt;
  if (!isTaskAttemptAwaitingVerification(attempt)) {
    throw new Error("Evidence cross-reference block requires an Attempt awaiting verification");
  }
  const nowIso = new Date().toISOString();
  const recorded = authority.recordTaskTechnicalVerdict({
    invocation: internalExecutionInvocation(`internal:auto:safety-evidence-xref:${attempt.attemptId}`),
    attemptId: attempt.attemptId,
    testedSourceRevision: "unavailable",
    verdict: "fail",
    rationale: `Safety evidence cross-reference: ${input.mismatch.reason}`,
    evidence: {
      evidenceClass: "command",
      commandOrTool: input.mismatch.command || "gsd-safety-evidence-xref",
      workingDirectory: input.basePath,
      startedAt: nowIso,
      endedAt: nowIso,
      exitCode: input.mismatch.actualExitCode ?? 1,
      observation: "failed",
      durableOutputRef: `db://safety-evidence-xref/${attempt.attemptId}`,
      environment: {
        node: process.version,
        platform: process.platform,
        claimedExitCode: input.mismatch.claimedExitCode,
        // Machine-readable discriminator: this verdict was synthesized from an
        // evidence contradiction, not a host verification run (#1641).
        verificationPolicy: 'safety-evidence-xref',
      },
    },
  });
  let routed: { recoveryActionId: string; action: TaskRecoveryReceipt["action"] } | null = null;
  const outcome = routeHostTechnicalFailure(
    authority,
    attempt,
    {
      verdictId: recorded.verdictId,
      evidenceId: recorded.evidenceId,
      verdict: "fail",
      rationale: `Safety evidence cross-reference: ${input.mismatch.reason}`,
    },
    "verification-failed",
    undefined,
    (recoveryActionId, action) => {
      routed = { recoveryActionId, action };
    },
  );
  if (!routed) {
    throw new Error("Safety evidence cross-reference routing did not record a recovery action");
  }
  return {
    ...(routed as { recoveryActionId: string; action: TaskRecoveryReceipt["action"] }),
    outcome,
  };
}

function invalidateStoredHostPass(
  authority: TaskVerificationAuthority,
  attempt: VerificationAttemptSnapshot,
  verdict: TaskTechnicalVerdictSnapshot,
  currentSourceRevision: string,
  workingDirectory: string,
): TaskTechnicalVerdictReceipt {
  const now = new Date().toISOString();
  return authority.invalidateTaskTechnicalPass({
    invocation: internalExecutionInvocation(`internal:auto:attempt.verify-drift:${verdict.verdictId}`),
    attemptId: attempt.attemptId,
    supersedesVerdictId: verdict.verdictId,
    rationale: describeHostVerificationRationale({
      verdict: "inconclusive",
      checkName: "gsd-source-integrity",
      observed: `current source ${currentSourceRevision}`,
      expected: `stored passing source ${verdict.testedSourceRevision}`,
      evidenceRef: `db://host-verification/${attempt.attemptId}/source-drift`,
      nextAction: "To become conclusive, re-run host verification against the current source, or restore the stored revision.",
    }),
    evidence: {
      evidenceClass: "command",
      commandOrTool: "gsd-source-integrity",
      workingDirectory,
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      observation: "inconclusive",
      durableOutputRef: `db://host-verification/${attempt.attemptId}/source-drift`,
      environment: {
        node: process.version,
        platform: process.platform,
        sourceRevisionBefore: verdict.testedSourceRevision,
        sourceRevisionAfter: currentSourceRevision,
      },
    },
  });
}

function resolveVerificationTargets(
  basePath: string,
  prefs: GSDPreferences | undefined,
  task: TaskRow | null,
  slice: SliceRow | null,
): VerificationTarget[] {
  const resolved = resolveVerificationRepositoryTargets(basePath, prefs, task, slice);
  for (const id of resolved.missingRepositoryIds) {
    logWarning("engine", `verification: requested repository "${id}" not found`);
  }
  return resolved.repositories.map((repo) => ({
    id: repo.id,
    cwd: repo.root,
    // Top-level verification commands override per-repo defaults.
    preferenceCommands: prefs?.verification_commands?.length
      ? undefined
      : repo.verification,
  }));
}

function hasExplicitVerificationTargets(task: TaskRow | null, slice: SliceRow | null): boolean {
  return Boolean(task?.target_repositories?.length || slice?.target_repositories?.length);
}

function messagesMentionTool(messages: unknown[] | null | undefined, toolName: string): boolean {
  if (!Array.isArray(messages)) return false;
  try {
    return JSON.stringify(messages).includes(toolName);
  } catch {
    return false;
  }
}

function unitActivityMentionsTool(basePath: string, unitType: string, unitId: string, toolName: string): boolean {
  const safeUnitId = unitId.replace(/\//g, "-");
  const activityDir = join(basePath, ".gsd", "activity");
  if (!existsSync(activityDir)) return false;

  try {
    for (const entry of readdirSync(activityDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(`${unitType}-${safeUnitId}.jsonl`)) continue;
      if (readFileSync(join(activityDir, entry.name), "utf-8").includes(toolName)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasRoadmapReassessmentArtifact(basePath: string, milestoneId: string): boolean {
  const slicesDir = join(basePath, ".gsd", "milestones", milestoneId, "slices");
  if (!existsSync(slicesDir)) return false;

  try {
    for (const entry of readdirSync(slicesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(slicesDir, entry.name, `${entry.name}-ASSESSMENT.md`))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasReassessmentEvidence(s: AutoSession, milestoneId: string): boolean {
  if (!s.currentUnit) return false;
  const toolName = "gsd_reassess_roadmap";
  const roots = [...new Set([s.basePath, s.canonicalProjectRoot].filter(Boolean))];
  return messagesMentionTool(s.lastUnitAgentEndMessages, toolName)
    || roots.some((root) => unitActivityMentionsTool(root, s.currentUnit!.type, s.currentUnit!.id, toolName))
    || roots.some((root) => hasRoadmapReassessmentArtifact(root, milestoneId));
}


/**
 * Post-unit guard for `validate-milestone` units (#4094).
 *
 * When validate-milestone writes verdict=needs-attention, human review is
 * required and auto-mode must pause. When it writes verdict=needs-remediation,
 * the agent is expected to also call gsd_reassess_roadmap in the same turn to
 * add remediation slices. If they don't, the state machine re-derives
 * `phase: validating-milestone` indefinitely (all slices still complete +
 * verdict still needs-remediation), wasting ~3 dispatches before the stuck
 * detector fires.
 *
 * This guard fires immediately on the first occurrence: if VALIDATION.md
 * verdict is needs-remediation and no incomplete slices exist for the
 * milestone, pause the auto-loop with a clear blocker.
 */
async function runValidateMilestonePostCheck(
  vctx: VerificationContext,
  pauseAuto: PauseAutoFn,
): Promise<VerificationResult> {
  const { s, ctx, pi } = vctx;
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  const persistMilestoneValidationGate = async (
    outcome: "pass" | "fail" | "retry" | "manual-attention",
    failureClass: "none" | "verification" | "manual-attention",
    rationale: string,
    findings = "",
    milestoneId?: string,
  ): Promise<void> => {
    if (!uokFlags.gates || !s.currentUnit) return;
    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: "milestone-validation-post-check",
      type: "verification",
      execute: async () => ({
        outcome,
        failureClass,
        rationale,
        findings,
      }),
    });
    await gateRunner.run("milestone-validation-post-check", {
      basePath: s.basePath,
      traceId: `validation-post-check:${s.currentUnit.id}`,
      turnId: s.currentUnit.id,
      milestoneId,
      unitType: s.currentUnit.type,
      unitId: s.currentUnit.id,
    });
  };

  if (!s.currentUnit) return "continue";

  const { milestone: mid } = parseUnitId(s.currentUnit.id);
  if (!mid) return "continue";

  const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
  const clearValidationRetry = (): void => {
    s.pendingVerificationRetry = null;
    s.verificationRetryCount.delete(retryKey);
    s.verificationRetryFailureHashes.delete(retryKey);
  };

  const setToolFailureRetry = (message: string): VerificationResult => {
    const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
    s.verificationRetryCount.set(retryKey, attempt);
    s.pendingVerificationRetry = {
      unitId: s.currentUnit!.id,
      failureContext: message,
      attempt,
    };
    return "retry";
  };

  const reassessmentInvalidatedValidation = async (): Promise<boolean> => {
    if (!hasReassessmentEvidence(s, mid)) return false;
    const incompleteSliceCount = await countIncompleteSlices(s.canonicalProjectRoot, mid);
    const hasAssessmentArtifact = [s.basePath, s.canonicalProjectRoot]
      .some((root) => hasRoadmapReassessmentArtifact(root, mid));
    return incompleteSliceCount > 0 || hasAssessmentArtifact;
  };

  const verdict = await resolveMilestoneValidationVerdict(s.basePath, mid);
  if (!verdict) {
    if (isMilestoneLifecycleAdopted(mid) && hasPendingMilestoneSubjectiveUat(mid)) {
      await persistMilestoneValidationGate(
        "manual-attention",
        "manual-attention",
        "subjective UAT requires an authenticated user response",
        `Milestone ${mid} has an open subjective UAT question`,
        mid,
      );
      await pauseAuto(ctx, pi, {
        message: `Milestone ${mid} is waiting for a genuine subjective UAT decision.`,
        category: "unknown",
      });
      return "pause";
    }
    if (await reassessmentInvalidatedValidation()) {
      clearValidationRetry();
      return "continue";
    }
    return setToolFailureRetry(
      "You must call gsd_validate_milestone to persist the validation results. No current canonical validation result exists in the database.",
    );
  }
  if (verdict === "needs-attention") {
    const canonicalValidation = isMilestoneLifecycleAdopted(mid);
    // A needs-attention verdict is a legitimate, stable outcome — not a
    // technical failure. Canonical validation gets one bounded re-validation
    // (the evidence may be stale); when the verdict recurs, pause for human
    // review instead of retrying until the liveness backstop wedges.
    if (canonicalValidation && (s.verificationRetryCount.get(retryKey) ?? 0) < 1) {
      await persistMilestoneValidationGate(
        "retry",
        "verification",
        "canonical objective validation needs fresh agent-owned verification",
        `Milestone ${mid} validation returned needs-attention`,
        mid,
      );
      return setToolFailureRetry(
        `Milestone ${mid} canonical validation needs fresh objective evidence. Repair or rerun verification, then call gsd_validate_milestone again.`,
      );
    }
    clearValidationRetry();
    ctx.ui.notify(
      `Milestone ${mid} validation returned verdict=needs-attention. Pausing for human review.`,
      "error",
    );
    process.stderr.write(
      [
        `validate-milestone: pausing — verdict=needs-attention for ${mid}.`,
        `Review details with /gsd status.`,
        `After fixing the issue, run /gsd validate-milestone.`,
        canonicalValidation
          ? `Canonical validation cannot be overridden with /gsd verdict; re-validate with current evidence.`
          : `To accept the finding, run /gsd verdict pass --rationale "why this is okay".`,
        `To defer it, run /gsd park ${mid}.`,
        "",
      ].join("\n"),
    );
    await persistMilestoneValidationGate(
      "manual-attention",
      "manual-attention",
      "needs-attention verdict requires human review",
      `Milestone ${mid} validation returned needs-attention`,
      mid,
    );
    await pauseAuto(ctx, pi, {
      message: `Milestone ${mid} validation needs attention.`,
      category: "unknown",
    });
    return "pause";
  }

  if (verdict !== "needs-remediation") {
    await persistMilestoneValidationGate(
      "pass",
      "none",
      `milestone validation verdict is ${verdict}; no remediation loop risk`,
      "",
      mid,
    );
    return "continue";
  }

  const incompleteSliceCount = await countIncompleteSlices(s.basePath, mid);

  // If any non-closed slices exist, the agent successfully queued remediation
  // work — proceed normally. The state machine will execute those slices and
  // re-validate per the #3596/#3670 fix.
  if (incompleteSliceCount > 0) {
    await persistMilestoneValidationGate(
      "pass",
      "none",
      `remediation slices present (${incompleteSliceCount}); validation can continue`,
      "",
      mid,
    );
    return "continue";
  }

  if (isMilestoneLifecycleAdopted(mid)) {
    await persistMilestoneValidationGate(
      "retry",
      "verification",
      "canonical remediation remains agent-owned until remediation work is queued",
      `No incomplete slices found for ${mid} while verdict=needs-remediation`,
      mid,
    );
    return setToolFailureRetry(
      `Milestone ${mid} needs remediation. Call gsd_reassess_roadmap to add remediation slices, then re-run validation.`,
    );
  }

  ctx.ui.notify(
    `Milestone ${mid} validation returned verdict=needs-remediation but no remediation slices were added. Pausing for human review.`,
    "error",
  );
  process.stderr.write(
    `validate-milestone: pausing — verdict=needs-remediation with no incomplete slices for ${mid}. ` +
      `The agent must call gsd_reassess_roadmap to add remediation slices before re-validation.\n`,
  );
  await persistMilestoneValidationGate(
    "manual-attention",
    "manual-attention",
    "needs-remediation verdict without queued remediation slices",
    `No incomplete slices found for ${mid} while verdict=needs-remediation`,
    mid,
  );
  await pauseAuto(ctx, pi, {
    message: `Milestone ${mid} validation needs remediation but no remediation slices were added.`,
    category: "unknown",
  });
  return "pause";
}

/**
 * Count slices for a milestone that are not in a closed status.
 * DB-backed projects are authoritative (#4094 peer review); falls back to
 * roadmap parsing only when the DB is unavailable.
 */
async function countIncompleteSlices(_basePath: string, milestoneId: string): Promise<number> {
  // DB-authoritative (ADR-017): no markdown fallback. DB unavailable or no
  // rows means "unknown" — do not pause.
  if (!isDbAvailable()) return 1;
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return 1;
  return slices.filter((slice) => !isClosedStatus(slice.status)).length;
}

type BlockerDiscoveredAttempt = VerificationAttemptSnapshot & {
  state: "settled";
  outcome: "failed";
  nextStage: "route";
  resultFailureClass: "blocker-discovered";
};

/**
 * Mirror of the cutover's `isNewlyRecordedBlocker` predicate
 * (auto/task-execution-cutover.ts): gsd_task_complete stages a
 * blockerDiscovered report as a settled failed Attempt classified
 * `blocker-discovered`, and the cutover deliberately passes it through as a
 * completed unit instead of routing it — so it reaches this gate with no
 * succeeded Attempt to verify.
 */
function isBlockerDiscoveredAttempt(
  attempt: VerificationAttemptSnapshot | null,
): attempt is BlockerDiscoveredAttempt {
  return attempt?.state === "settled" &&
    attempt.outcome === "failed" &&
    attempt.nextStage === "route" &&
    attempt.resultFailureClass === "blocker-discovered";
}

/**
 * Pause message for a staged blocker (#2148): surface the blocker description
 * and, when the ADR-011 escalation artifact exists and is unresolved, its
 * question/options/recommendation. The artifact is opt-in
 * (phases.mid_execution_escalation), so the attempt's staged summary is the
 * always-available fallback.
 */
function describeBlockerPause(
  milestoneId: string,
  sliceId: string,
  taskId: string,
  attempt: VerificationAttemptSnapshot,
): string {
  const lines = [
    `Task ${milestoneId}/${sliceId}/${taskId} reported a discovered blocker; host verification cannot run without a succeeded canonical Attempt (attempt ${attempt.attemptId}).`,
  ];
  if (attempt.resultSummary) {
    lines.push(`Blocker: ${attempt.resultSummary}`);
  }
  if (isDbAvailable()) {
    const artifactPath = getTask(milestoneId, sliceId, taskId)?.escalation_artifact_path;
    const artifact = artifactPath ? readEscalationArtifact(artifactPath) : null;
    if (artifact && !artifact.respondedAt) {
      lines.push("", formatEscalationForDisplay(artifact));
    }
  }
  lines.push("Auto-mode is paused. Resolve the blocker (see /gsd escalate list), then resume with /gsd auto.");
  return lines.join("\n");
}

/**
 * Run the verification gate for the current execute-task unit.
 * Returns:
 * - "continue" — host-owned verification passed, proceed normally
 * - "retry" — durable recovery selected another agent attempt
 * - "pause" — a non-recovery verification boundary requires human input
 * - "abort" — durable agent recovery is exhausted
 */
export async function runPostUnitVerification(
  vctx: VerificationContext,
  pauseAuto: PauseAutoFn,
): Promise<VerificationResult> {
  const { s, ctx, pi } = vctx;

  if (!s.currentUnit) {
    return "continue";
  }

  if (s.currentUnit.type === "validate-milestone") {
    return await runValidateMilestonePostCheck(vctx, pauseAuto);
  }

  if (s.currentUnit.type !== "execute-task") {
    return "continue";
  }

  // Capture the recoveryActionId of a terminal abort so the finalize break reason can
  // print it — it is the only key `gsd_task_recovery_resume` accepts (#1593). Reset per
  // verification pass so a stale id from an earlier unit can never be reported.
  s.lastTaskRecoveryAbortId = null;
  const recordAbort = (recoveryActionId: string) => {
    s.lastTaskRecoveryAbortId = recoveryActionId;
  };

  let recoverableAttempt: VerificationAttemptSnapshot | null = null;
  let recoverableAuthority: TaskVerificationAuthority | null = null;
  let canonicalVerdictWriteStarted = false;
  try {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(s.currentUnit.id);
    if (!mid || !sid || !tid) {
      throw new Error("Host verification requires a canonical Task identity");
    }
    const taskAuthority = vctx.taskAuthority ?? defaultTaskVerificationAuthority;
    const latestAttempt = taskAuthority.readLatestTaskAttempt({
      milestoneId: mid,
      sliceId: sid,
      taskId: tid,
    });
    if (isBlockerDiscoveredAttempt(latestAttempt)) {
      // #2148: a staged blocker is a sanctioned terminal state — the Attempt
      // settles as failed/blocker-discovered by design and the cutover passes
      // it through, so throwing here wedged auto-mode into the ADR-047
      // liveness backstop with no in-engine exit. Pause with the escalation
      // surfaced instead; the operator resolves and resumes with /gsd auto.
      await pauseAuto(ctx, pi, {
        message: describeBlockerPause(mid, sid, tid, latestAttempt),
        category: "unknown",
      });
      return "pause";
    }
    if (latestAttempt?.state !== "settled" || latestAttempt.outcome !== "succeeded") {
      throw new Error("Host verification requires the latest succeeded canonical Attempt at the verify stage");
    }
    recoverableAttempt = latestAttempt;
    recoverableAuthority = taskAuthority;
    const replayedVerdict = taskAuthority.readTaskTechnicalVerdict(latestAttempt.attemptId);
    const replayedRecovery = replayedVerdict && replayedVerdict.verdict !== "pass"
      ? routeHostTechnicalFailure(taskAuthority, latestAttempt, {
        verdictId: replayedVerdict.verdictId,
        evidenceId: replayedVerdict.evidenceId,
        verdict: replayedVerdict.verdict,
        rationale: describeHostVerificationRationale({
          verdict: replayedVerdict.verdict,
          checkName: "stored-host-verdict",
          observed: replayedVerdict.verdict,
          expected: "pass",
          evidenceRef: `${replayedVerdict.evidenceId} (verdict ${replayedVerdict.verdictId})`,
          nextAction: replayedVerdict.verdict === "inconclusive"
            ? "To become conclusive, inspect that evidence and resume with matching verification."
            : undefined,
        }),
      }, replayedVerdict.supersedesVerdictId ? "verification-drift" : "verification-failed", recordAbort)
      : null;
    if (!replayedRecovery && !isTaskAttemptAwaitingVerification(latestAttempt)) {
      throw new Error("Host verification requires the latest succeeded canonical Attempt at the verify stage");
    }
    const effectivePrefs = loadEffectiveGSDPreferences();
    const prefs = effectivePrefs?.preferences;
    const uokFlags = resolveUokFlags(prefs);
    const autoFixEnabled = prefs?.verification_auto_fix !== false;
    const maxRetries =
      typeof prefs?.verification_max_retries === "number"
        ? prefs.verification_max_retries
        : 2;
    const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);

    if (replayedRecovery === "abort") {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      return "abort";
    }
    if (replayedRecovery === "retry") {
      return recordDurableVerificationRetry(
        s,
        retryKey,
        `Stored host verification verdict is ${replayedVerdict?.verdict}`,
      );
    }

    // Read task plan verify field
    let taskPlanVerify: string | undefined;
    let taskRow: TaskRow | null = null;
    let sliceRow: SliceRow | null = null;
    // Structured evidence staged by gsd_task_complete for this Task (#1591).
    let taskEvidence: TaskVerificationEvidence[] = [];
    if (mid && sid && tid) {
      if (isDbAvailable()) {
        taskRow = getTask(mid, sid, tid);
        sliceRow = getSlice(mid, sid);
        taskPlanVerify = taskRow?.verify;
        taskEvidence = getTaskVerificationEvidence(mid, sid, tid);
      }
      // When DB unavailable, taskPlanVerify stays undefined — gate runs without task-specific checks
    }

    const verificationTargets = resolveVerificationTargets(s.basePath, prefs, taskRow, sliceRow);
    const explicitVerificationTargetsRequested = hasExplicitVerificationTargets(taskRow, sliceRow);
    const unresolvedExplicitTargets = explicitVerificationTargetsRequested && verificationTargets.length === 0;
    if (unresolvedExplicitTargets) {
      logWarning("engine", "verification: explicit target_repositories requested but no repositories resolved");
    }
    const sourceTargets = verificationTargets.length > 0
      ? verificationTargets.map((target) => ({ id: target.id, cwd: target.cwd }))
      : [{ id: "root", cwd: s.basePath }];
    const sourceBeforeResult = captureVerificationSourceSnapshot(sourceTargets);
    if (replayedVerdict) {
      if (
        sourceBeforeResult.ok &&
        replayedVerdict.testedSourceRevision.startsWith("sha256:") &&
        sourceBeforeResult.snapshot.aggregateRevision === replayedVerdict.testedSourceRevision
      ) {
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        s.pendingVerificationRetry = null;
        return "continue";
      }
      const failureContext = sourceBeforeResult.ok
        ? "Stored passing host verdict does not match the current verification source"
        : sourceBeforeResult.error;
      logWarning("engine", failureContext);
      ctx.ui.notify(failureContext, "error");
      const invalidated = invalidateStoredHostPass(
        taskAuthority,
        latestAttempt,
        replayedVerdict,
        sourceBeforeResult.ok ? sourceBeforeResult.snapshot.aggregateRevision : "unavailable",
        s.basePath,
      );
      const recovery = routeHostTechnicalFailure(taskAuthority, latestAttempt, {
        verdictId: invalidated.verdictId,
        evidenceId: invalidated.evidenceId,
        verdict: "inconclusive",
        rationale: describeHostVerificationRationale({
          verdict: "inconclusive",
          checkName: "gsd-source-integrity",
          observed: failureContext,
          expected: "source matching the stored passing verdict",
          evidenceRef: `${invalidated.evidenceId} (verdict ${invalidated.verdictId})`,
          nextAction: "To become conclusive, re-run host verification against the current source, or restore the stored revision.",
        }),
      }, "verification-drift", recordAbort);
      if (recovery === "abort") return "abort";
      return recordDurableVerificationRetry(s, retryKey, failureContext);
    }
    let result: VerificationGateResult;
    if (unresolvedExplicitTargets) {
      result = {
        passed: false,
        checks: [{
          command: "gsd-verification-targets",
          exitCode: 1,
          stdout: "",
          stderr: "Explicit verification targets were requested but no repositories resolved",
          durationMs: 0,
        }],
        discoverySource: "none",
        timestamp: Date.now(),
      };
    } else if (!sourceBeforeResult.ok) {
      result = {
        passed: false,
        checks: [{
          command: "gsd-source-snapshot",
          exitCode: 1,
          stdout: "",
          stderr: sourceBeforeResult.error,
          durationMs: 0,
        }],
        discoverySource: "none",
        timestamp: Date.now(),
      };
    } else if (verificationTargets.length <= 1) {
      result = (vctx.runVerificationGate ?? runVerificationGate)({
        cwd: verificationTargets[0]?.cwd ?? s.basePath,
        preferenceCommands: prefs?.verification_commands ?? verificationTargets[0]?.preferenceCommands,
        taskPlanVerify,
        taskEvidence,
        commandTimeoutMs: resolveVerificationTimeoutMs(prefs),
      });
    } else {
      result = runVerificationGateForTargets({
        targets: verificationTargets,
        preferenceCommands: prefs?.verification_commands,
        taskPlanVerify,
        taskEvidence,
        commandTimeoutMs: resolveVerificationTimeoutMs(prefs),
      });
    }

    // Capture runtime errors
    if (sourceBeforeResult.ok) {
      const runtimeErrors = await captureRuntimeErrors();
      if (runtimeErrors.length > 0) {
        result.runtimeErrors = runtimeErrors;
        if (runtimeErrors.some((e) => e.blocking)) {
          result.passed = false;
        }
      }

      // Dependency audit
      const auditWarnings = runDependencyAudit(s.basePath);
      if (auditWarnings.length > 0) {
        result.auditWarnings = auditWarnings;
        process.stderr.write(
          `verification-gate: ${auditWarnings.length} audit warning(s)\n`,
        );
        for (const w of auditWarnings) {
          process.stderr.write(`  [${w.severity}] ${w.name}: ${w.title}\n`);
        }
      }
    }

    const verdict = decideVerificationVerdict(s.currentUnit.type, result, {
      hasQualifyingEvidence: hasQualifyingTaskEvidence(taskEvidence),
    });
    // #2209: a command-not-found check is a platform fault, not a requirement
    // failure. When qualifying task evidence proves the task, the verdict
    // passes and downstream branches treat the gate as passed.
    const unrunnableCheck = result.checks.find((check) => check.failureClass === "command-not-found");
    const unrunnablePause = unrunnableCheck && !verdict.passed;
    if (!verdict.passed) {
      result.passed = false;
    } else if (verdict.reason === "passed-via-task-evidence") {
      result.passed = true;
    }

    if (verdict.reason === "execution-fault") {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      const message = `Verification gate execution fault: ${verdict.failureContext}`;
      ctx.ui.notify(message, "error");
      process.stderr.write(`verification-gate: pausing — ${verdict.failureContext}\n`);
      await pauseAuto(ctx, pi, {
        message,
        category: "unknown",
      });
      return "pause";
    }

    if (uokFlags.gates) {
      const gateRunner = new UokGateRunner();
      gateRunner.register({
        id: "verification-gate",
        type: "verification",
        execute: async () => ({
          outcome: unrunnablePause ? "manual-attention" : result.passed ? "pass" : "fail",
          failureClass: unrunnablePause
            ? "manual-attention"
            : result.runtimeErrors?.some((e) => e.blocking)
            ? "execution"
            : "verification",
          rationale: result.passed
            ? "verification checks passed"
            : unrunnablePause
              ? verdict.failureContext
              : verdict.reason === "no-host-checks"
                ? "no runnable host-owned verification checks discovered"
                : "verification checks failed",
          findings: result.passed
            ? ""
            : verdict.failureContext || formatFailureContext(result),
        }),
      });

      await gateRunner.run("verification-gate", {
        basePath: s.basePath,
        traceId: `verification:${s.currentUnit.id}`,
        turnId: s.currentUnit.id,
        milestoneId: mid ?? undefined,
        sliceId: sid ?? undefined,
        taskId: tid ?? undefined,
        unitType: s.currentUnit.type,
        unitId: s.currentUnit.id,
      });
    }

    // Auto-fix retry preferences
    if (result.checks.length > 0) {
      const passCount = result.checks.filter((c) => c.exitCode === 0).length;
      const total = result.checks.length;
      if (result.passed) {
        ctx.ui.notify(formatPostUnitStatusCard("✓ Verification Gate", `${passCount}/${total} checks passed`));
      } else if (unrunnablePause) {
        ctx.ui.notify(formatPostUnitStatusCard("⚠ Verification Gate", verdict.failureContext), "warning");
      } else {
        const failures = result.checks.filter((c) => c.exitCode !== 0);
        const failNames = failures.map((f) => f.command).join(", ");
        ctx.ui.notify(formatPostUnitStatusCard("✕ Verification Gate", `FAILED — ${failNames}`));
        process.stderr.write(
          `verification-gate: ${total - passCount}/${total} checks failed\n`,
        );
        for (const f of failures) {
          process.stderr.write(`  ${f.command} exited ${f.exitCode}\n`);
          if (f.stderr)
            process.stderr.write(`  stderr: ${f.stderr.slice(0, 500)}\n`);
        }
      }
    }

    // Log blocking runtime errors
    if (result.runtimeErrors?.some((e) => e.blocking)) {
      const blockingErrors = result.runtimeErrors.filter((e) => e.blocking);
      process.stderr.write(
        `verification-gate: ${blockingErrors.length} blocking runtime error(s) detected\n`,
      );
      for (const err of blockingErrors) {
        process.stderr.write(
          `  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}\n`,
        );
      }
    }

    // Write verification evidence JSON
    const attempt = s.verificationRetryCount.get(retryKey) ?? 0;
    const browserUatContinuation =
      verdict.reason === "no-host-checks" &&
      detectWebApp(s.basePath) &&
      !result.runtimeErrors?.some((error) => error.blocking) &&
      isTaskAttemptAwaitingVerification(latestAttempt);
    // ── Post-execution checks (run after main verification passes for execute-task units) ──
    let postExecChecks: PostExecutionCheckJSON[] | undefined;
    let postExecBlockingFailure = false;
    let postExecFailureSummary: string | null = null;
    let postExecInfrastructureError: string | null = null;

    if (result.passed && mid && sid && tid) {
      // Check preferences — respect enhanced_verification and enhanced_verification_post
      const enhancedEnabled = prefs?.enhanced_verification !== false; // default true
      const postEnabled = prefs?.enhanced_verification_post !== false; // default true

      if (enhancedEnabled && postEnabled && isDbAvailable()) {
        try {
          // Reuse the already-loaded task row for post-execution checks.
          if (taskRow && taskRow.key_files && taskRow.key_files.length > 0) {
            // Get all tasks in the slice
            const allTasks = getSliceTasks(mid, sid);
            // Filter to prior completed tasks (status = 'complete' or 'done', before current task)
            const priorTasks = allTasks.filter(
              (t: TaskRow) =>
                (t.status === "complete" || t.status === "done") &&
                t.id !== tid &&
                t.sequence < taskRow.sequence
            );

            // Run post-execution checks
            const postExecResult: PostExecutionResult = (vctx.runPostExecutionChecks ?? runPostExecutionChecks)(
              taskRow,
              priorTasks,
              s.basePath
            );

            // Store checks for evidence JSON
            postExecChecks = postExecResult.checks;

            // Log summary to stderr with gsd-post-exec: prefix
            const emoji =
              postExecResult.status === "pass"
                ? "✅"
                : postExecResult.status === "warn"
                  ? "⚠️"
                  : "❌";
            process.stderr.write(
              `gsd-post-exec: ${emoji} Post-execution checks ${postExecResult.status} for ${mid}/${sid}/${tid} (${postExecResult.durationMs}ms)\n`
            );

            // Log individual check results
            for (const check of postExecResult.checks) {
              const checkEmoji = check.passed
                ? "✓"
                : check.blocking
                  ? "✗"
                  : "⚠";
              process.stderr.write(
                `gsd-post-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}\n`
              );
            }

            if (uokFlags.gates) {
              const strictMode = prefs?.enhanced_verification_strict === true;
              const warnEscalated = postExecResult.status === "warn" && strictMode;
              const blockingFailure = postExecResult.status === "fail" || warnEscalated;
              const findings = postExecResult.checks
                .filter((check) => !check.passed)
                .map((check) => `[${check.category}] ${check.target}: ${check.message}`)
                .join("\n");
              const gateRunner = new UokGateRunner();
              gateRunner.register({
                id: "post-execution-checks",
                type: "artifact",
                execute: async () => ({
                  outcome: blockingFailure ? "fail" : "pass",
                  failureClass: postExecResult.status === "fail"
                    ? "artifact"
                    : warnEscalated
                      ? "policy"
                      : "none",
                  rationale: blockingFailure
                    ? `post-execution checks ${postExecResult.status}${warnEscalated ? " (strict)" : ""}`
                    : "post-execution checks passed",
                  findings,
                }),
              });
              await gateRunner.run("post-execution-checks", {
                basePath: s.basePath,
                traceId: `verification:${s.currentUnit.id}`,
                turnId: s.currentUnit.id,
                milestoneId: mid,
                sliceId: sid,
                taskId: tid,
                unitType: s.currentUnit.type,
                unitId: s.currentUnit.id,
              });
            }

            // Check for blocking failures
            if (postExecResult.status === "fail") {
              postExecBlockingFailure = true;
              const blockingCount = postExecResult.checks.filter(
                (c) => !c.passed && c.blocking
              ).length;
              const firstBlockingFailure = postExecResult.checks.find(
                (c) => !c.passed && c.blocking
              );
              if (firstBlockingFailure) {
                postExecFailureSummary =
                  `[${firstBlockingFailure.category}] ${firstBlockingFailure.target}: ${firstBlockingFailure.message}`;
              }
              ctx.ui.notify(
                `Post-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found`,
                "error"
              );
            } else if (postExecResult.status === "warn") {
              ctx.ui.notify(
                `Post-execution checks passed with warnings`,
                "warning"
              );
              // Strict mode: treat warnings as blocking
              if (prefs?.enhanced_verification_strict === true) {
                postExecBlockingFailure = true;
                const firstWarning = postExecResult.checks.find(
                  (c) => (!c.passed && !c.blocking) || (c.passed && c.category === "pattern")
                );
                if (firstWarning) {
                  postExecFailureSummary =
                    `[${firstWarning.category}] ${firstWarning.target}: ${firstWarning.message}`;
                }
              }
            }
          }
        } catch (postExecErr) {
          postExecInfrastructureError = postExecErr instanceof Error
            ? postExecErr.message
            : String(postExecErr);
          postExecFailureSummary = `Post-execution checks could not complete: ${postExecInfrastructureError}`;
          logWarning("engine", `gsd-post-exec: infrastructure error — ${postExecInfrastructureError}`);
          ctx.ui.notify(postExecFailureSummary, "error");
        }
      }
    }

    // Update result.passed based on post-execution checks
    if (postExecBlockingFailure || postExecInfrastructureError) {
      result.passed = false;
    }
    if (postExecInfrastructureError) {
      result.checks.push({
        command: "gsd-post-execution-checks",
        exitCode: 1,
        stdout: "",
        stderr: postExecInfrastructureError,
        durationMs: 0,
      });
    }

    const sourceAfterResult = sourceBeforeResult.ok
      ? captureVerificationSourceSnapshot(sourceTargets)
      : sourceBeforeResult;
    let sourceError = sourceBeforeResult.ok ? undefined : sourceBeforeResult.error;
    if (sourceBeforeResult.ok && !sourceAfterResult.ok) {
      sourceError = sourceAfterResult.error;
    } else if (
      sourceBeforeResult.ok &&
      sourceAfterResult.ok &&
      verificationSourceChanged(sourceBeforeResult.snapshot, sourceAfterResult.snapshot)
    ) {
      sourceError = "Verification target source changed while host checks were running";
    }
    if (sourceError) {
      result.passed = false;
      result.checks.push({
        command: "gsd-source-integrity",
        exitCode: 1,
        stdout: "",
        stderr: sourceError,
        durationMs: 0,
      });
    }
    const hostTechnicalPassed =
      !sourceError &&
      !postExecInfrastructureError &&
      (result.passed || browserUatContinuation);
    const hostTechnicalVerdict: RecordTaskTechnicalVerdictInput["verdict"] =
      unrunnablePause || sourceError || postExecInfrastructureError
        ? "inconclusive"
        : hostTechnicalPassed
          ? "pass"
          : "fail";
    let durableRecovery: "retry" | "abort" | null = null;
    if (mid && sid && tid) {
      let rationale = verdict.failureContext || postExecFailureSummary || formatFailureContext(result) ||
        "Host-owned technical verification failed.";
      if (sourceError) {
        rationale = sourceError;
      } else if (postExecInfrastructureError) {
        rationale = postExecFailureSummary ?? postExecInfrastructureError;
      } else if (hostTechnicalPassed) {
        rationale = browserUatContinuation
          ? "Canonical executor Result succeeded; browser-facing behavior continues to automated slice UAT."
          : "All host-owned technical verification checks passed.";
      }
      if (!unrunnablePause) {
        canonicalVerdictWriteStarted = true;
        const recordedVerdict = recordHostTechnicalVerdict({
          context: vctx,
          attempt: latestAttempt,
          result,
          verdict: hostTechnicalVerdict,
          rationale,
          ...(sourceBeforeResult.ok ? { sourceBefore: sourceBeforeResult.snapshot } : {}),
          ...(sourceAfterResult.ok ? { sourceAfter: sourceAfterResult.snapshot } : {}),
          ...(sourceError ? { sourceError } : {}),
        });
        canonicalVerdictWriteStarted = false;
        if (hostTechnicalVerdict !== "pass") {
          const failingCheck = result.checks.find((check) => check.failureClass === "timeout")
            ?? result.checks.find((check) => check.exitCode !== 0);
          durableRecovery = routeHostTechnicalFailure(taskAuthority, latestAttempt, {
            verdictId: recordedVerdict.verdictId,
            evidenceId: recordedVerdict.evidenceId,
            verdict: hostTechnicalVerdict,
            rationale: describeHostVerificationRationale({
              verdict: hostTechnicalVerdict,
              checkName: failingCheck?.command ?? "host-verification",
              observed: failingCheck?.failureClass === "timeout"
                ? `timeout after ${failingCheck.durationMs}ms (exit ${failingCheck.exitCode})`
                : failingCheck
                  ? `exit ${failingCheck.exitCode}`
                  : rationale,
              expected: "exit 0 / pass",
              evidenceRef: `db://host-verification/${latestAttempt.attemptId} (verdict ${recordedVerdict.verdictId})`,
              nextAction: hostTechnicalVerdict === "inconclusive"
                ? "To become conclusive, restore a stable source snapshot and matching evidence, then resume."
                : failingCheck?.failureClass === "timeout"
                  ? "Raise verification_timeout_ms if this command is expected to run longer."
                  : undefined,
            }),
          }, "verification-failed", recordAbort);
        }
      }

      try {
        const evidenceLocation = resolveVerificationEvidenceLocation(s.basePath, mid, sid);
        if (evidenceLocation) {
          if (postExecChecks && postExecChecks.length > 0) {
            writeVerificationJSONWithPostExec(
              result,
              evidenceLocation.dir,
              tid,
              s.currentUnit.id,
              postExecChecks,
              postExecBlockingFailure ? attempt + 1 : undefined,
              postExecBlockingFailure ? maxRetries : undefined,
              evidenceLocation.fileSliceId,
            );
          } else {
            const nextAttempt = attempt + 1;
            const includeRetryMetadata =
              !result.passed &&
              !unrunnablePause &&
              !browserUatContinuation &&
              autoFixEnabled &&
              nextAttempt <= maxRetries;
            writeVerificationJSON(
              result,
              evidenceLocation.dir,
              tid,
              s.currentUnit.id,
              includeRetryMetadata ? nextAttempt : undefined,
              includeRetryMetadata ? maxRetries : undefined,
              evidenceLocation.fileSliceId,
            );
          }
        }
      } catch (evidenceErr) {
        logWarning("engine", `verification-evidence write error: ${(evidenceErr as Error).message}`);
      }
    }

    // Emit Layer 2 verify_result event with the final, post-exec verdict so hooks
    // see the authoritative pass/fail and the complete set of failures.
    try {
      const { emitVerifyResult } = await import("./hook-emitter.js");
      const checkFailures = result.checks
        .filter((c) => c.exitCode !== 0)
        .map((c) => ({
          kind: "gate" as const,
          message: `${c.command} exited ${c.exitCode}${c.stderr ? `: ${c.stderr.slice(0, 200)}` : ""}`,
        }));
      const runtimeFailures = (result.runtimeErrors ?? [])
        .filter((e) => e.blocking)
        .map((e) => ({
          kind: "other" as const,
          message: `[${e.source}] ${e.message.slice(0, 200)}`,
        }));
      const postExecFailures = (postExecChecks ?? [])
        .filter((c) => !c.passed)
        .map((c) => ({
          kind: "other" as const,
          message: `[${c.category}] ${c.target}: ${c.message}`,
        }));
      await emitVerifyResult({
        passed: result.passed,
        failures: [...checkFailures, ...runtimeFailures, ...postExecFailures],
        unitType: s.currentUnit.type,
        unitId: s.currentUnit.id,
        cwd: s.basePath,
      });
    } catch (hookErr) {
      logWarning("engine", `verify_result hook emission failed: ${(hookErr as Error).message}`);
    }

    // ── Auto-fix retry logic ──
    if (unrunnablePause) {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      process.stderr.write(
        `${verdict.failureContext}. Install the command or update the verify command, then resume.\n`,
      );
      await pauseAuto(ctx, pi, {
        message: verdict.failureContext,
        category: "unknown",
      });
      return "pause";
    } else if (hostTechnicalPassed) {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      if (browserUatContinuation) {
        ctx.ui.notify(
          "No task-level command was available; the canonical executor Result passed and browser-facing behavior will continue to automated slice UAT.",
          "warning",
        );
      }
      return "continue";
    } else if (durableRecovery === "abort") {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      return "abort";
    } else if (durableRecovery === "retry") {
      if (s.pendingVerificationRetry?.unitId === s.currentUnit.id) return "retry";
      const { unitCostUsd, rollingAvgUsd } = getCurrentUnitCostStats(s.currentUnit.id);
      if (getUnitCostSpikeAction(unitCostUsd, rollingAvgUsd, resolveUnitCostSpikeMultiplier(prefs)) === "pause") {
        ctx.ui.notify(
          `Unit ${s.currentUnit.id} cost spike detected (${unitCostUsd.toFixed(2)} vs avg ${rollingAvgUsd.toFixed(2)}) during verification retry; keeping verification failure as the authoritative blocker.`,
          "warning",
        );
      }
      const nextAttempt = attempt + 1;
      const failureContext = postExecFailureSummary || verdict.failureContext || formatFailureContext(result);
      const failureSignature = formatFailureSignature(result);
      s.verificationRetryCount.set(retryKey, nextAttempt);
      s.pendingVerificationRetry = {
        unitId: s.currentUnit.id,
        failureContext,
        ...(failureSignature ? { signature: failureSignature } : {}),
        attempt: nextAttempt,
      };
      const failedCmds = result.checks
        .filter((c) => c.exitCode !== 0)
        .map((c) => c.command);
      const cmdSummary = verificationFailureSummary(failedCmds, postExecFailureSummary);
      ctx.ui.notify(
        `Verification failed (${cmdSummary}) — auto-fix attempt ${nextAttempt}/${Math.max(maxRetries, nextAttempt)}`,
        "warning",
      );
      // Return "retry" — the autoLoop while loop will re-iterate with the retry context
      return "retry";
    }
    throw new Error("Failed host verification is missing its durable recovery action");
  } catch (err) {
    const message = (err as Error).message;
    logWarning("engine", `verification-gate error: ${message}`);
    ctx.ui.notify(
      `Verification gate errored before producing an authoritative verdict: ${message}`,
      "error",
    );
    if (!recoverableAttempt || !recoverableAuthority) throw err;
    const storedVerdict = recoverableAuthority.readTaskTechnicalVerdict(recoverableAttempt.attemptId);
    if (canonicalVerdictWriteStarted && !storedVerdict) throw err;
    if (storedVerdict) {
      if (storedVerdict.verdict === "pass") return "continue";
      const recovery = routeHostTechnicalFailure(recoverableAuthority, recoverableAttempt, {
        verdictId: storedVerdict.verdictId,
        evidenceId: storedVerdict.evidenceId,
        verdict: storedVerdict.verdict,
        rationale: describeHostVerificationRationale({
          verdict: storedVerdict.verdict,
          checkName: "host-verification",
          observed: message,
          expected: "a completed host verdict",
          evidenceRef: `${storedVerdict.evidenceId} (verdict ${storedVerdict.verdictId})`,
          nextAction: storedVerdict.verdict === "inconclusive"
            ? "To become conclusive, re-run host verification after the gate error is resolved."
            : undefined,
        }),
      }, storedVerdict.supersedesVerdictId ? "verification-drift" : "verification-failed", recordAbort);
      if (recovery === "abort") return "abort";
      const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
      return recordDurableVerificationRetry(s, retryKey, message);
    }
    const recorded = recordHostTechnicalVerdict({
      context: vctx,
      attempt: recoverableAttempt,
      result: {
        passed: false,
        checks: [{
          command: "gsd-host-verification",
          exitCode: 1,
          stdout: "",
          stderr: message,
          durationMs: 0,
        }],
        discoverySource: "none",
        timestamp: Date.now(),
      },
      verdict: "inconclusive",
      rationale: describeHostVerificationRationale({
        verdict: "inconclusive",
        checkName: "gsd-host-verification",
        observed: message,
        expected: "a completed host verdict",
        evidenceRef: `db://host-verification/${recoverableAttempt.attemptId}`,
        nextAction: "To become conclusive, re-run host verification after the gate error is resolved.",
      }),
      sourceError: message,
    });
    const recovery = routeHostTechnicalFailure(recoverableAuthority, recoverableAttempt, {
      verdictId: recorded.verdictId,
      evidenceId: recorded.evidenceId,
      verdict: "inconclusive",
      rationale: describeHostVerificationRationale({
        verdict: "inconclusive",
        checkName: "gsd-host-verification",
        observed: message,
        expected: "a completed host verdict",
        evidenceRef: `${recorded.evidenceId} (verdict ${recorded.verdictId})`,
        nextAction: "To become conclusive, re-run host verification after the gate error is resolved.",
      }),
    }, "verification-failed", recordAbort);
    if (recovery === "abort") return "abort";
    const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
    return recordDurableVerificationRetry(s, retryKey, message);
  }
}

/**
 * Write verification evidence JSON with post-execution checks included.
 * This is a variant of writeVerificationJSON that adds the postExecutionChecks field.
 */
function writeVerificationJSONWithPostExec(
  result: VerificationGateResult,
  tasksDir: string,
  taskId: string,
  unitId: string,
  postExecutionChecks: PostExecutionCheckJSON[],
  retryAttempt?: number,
  maxRetries?: number,
  sliceId?: string,
): void {
  mkdirSync(tasksDir, { recursive: true });

  const evidence: EvidenceJSON = {
    schemaVersion: 1,
    taskId,
    unitId: unitId ?? taskId,
    timestamp: result.timestamp,
    passed: result.passed,
    discoverySource: result.discoverySource,
    checks: result.checks.map((check) => ({
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      verdict: check.exitCode === 0 ? "pass" : "fail",
    })),
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    postExecutionChecks,
  };

  if (result.runtimeErrors && result.runtimeErrors.length > 0) {
    evidence.runtimeErrors = result.runtimeErrors.map(e => ({
      source: e.source,
      severity: e.severity,
      message: e.message,
      blocking: e.blocking,
    }));
  }

  if (result.auditWarnings && result.auditWarnings.length > 0) {
    evidence.auditWarnings = result.auditWarnings.map(w => ({
      name: w.name,
      severity: w.severity,
      title: w.title,
      url: w.url,
      fixAvailable: w.fixAvailable,
    }));
  }

  const fileName = sliceId ? `${sliceId}-${taskId}-VERIFY.json` : `${taskId}-VERIFY.json`;
  const filePath = join(tasksDir, fileName);
  writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
}
