// Project/App: gsd-pi
// File Purpose: Auto-mode post-unit git, verification, projection, and hook processing.
/**
 * Post-unit processing for auto-loop — auto-commit, doctor run,
 * state rebuild, projection checks, DB tool closeout, hooks, triage, and
 * quick-task dispatch.
 *
 * Split into two functions called sequentially by auto-loop with
 * the verification gate between them:
 *   1. postUnitPreVerification() — closeout git for non-task units, doctor, state rebuild, worktree sync, artifact verification
 *   2. postUnitPostVerification() — post-verified task git, DB dual-write, hooks, triage, quick-tasks
 *
 * Extracted from the pre-loop agent_end handler in auto.ts.
 */

import type { ExtensionContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { logWarning, logError } from "./workflow-logger.js";
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import { isAwaitingUserInput } from "./consent-question.js";
import {
  resolveSliceFile,
  resolveSlicePath,
  relSlicePath,
  resolveTaskFile,
  resolveMilestoneFile,
  resolveTasksDir,
  resolveFile,
  relMilestoneFile,
  relSliceFile,
  relTaskFile,
  normalizeRealPath,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { rebuildState } from "./doctor.js";
import { parseUnitId } from "./unit-id.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import {
  runTurnGitAction,
  type TaskCommitContext,
  type TurnGitActionMode,
} from "./git-service.js";
import {
  verifyExpectedArtifact,
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  diagnoseExpectedArtifact,
  diagnoseWorktreeIntegrityFailure,
  writeReactiveExecuteBlocker,
} from "./auto-recovery.js";
import { regenerateIfMissing } from "./workflow-projections.js";
import { WorktreeStateProjection } from "./worktree-state-projection.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import { normalizeWorktreePathForCompare } from "./worktree-root.js";
import { isDbAvailable, getTask, getSlice, getMilestone, getMilestoneSlices, _getAdapter, getVerificationEvidence } from "./gsd-db.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { reopenTask } from "./task-lifecycle-domain-operation.js";
import { getWorkflowDatabasePath, refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { renderPlanCheckboxes, renderRoadmapFromDb, roadmapRenderMarksSliceDone } from "./markdown-renderer.js";
import { awaitWorkerResume, consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  acknowledgeRetryTrigger,
  consumeHookFailure,
  peekRetryTrigger,
  consumeGateBlock,
  isGateBlockPending,
  persistHookState,
  resolveHookArtifactPath,
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures, revertExecutorResolvedCaptures } from "./captures.js";
import { debugLog } from "./debug-logger.js";
import { runSafely } from "./auto-utils.js";
import {
  isMilestoneCloseoutSettled,
  runMilestoneCloseoutGitHub,
} from "./milestone-closeout.js";
import type { AutoSession, SidecarItem } from "./auto/session.js";
import { getEvidence, clearEvidenceFromDisk, isExecutionToolName } from "./safety/evidence-collector.js";
import { removeProjectionFileSync } from "./atomic-write.js";
import {
  validateFileChanges,
  effectiveFileChangeAllowlist,
  readCommittedHeadSha,
  type FileChangeAudit,
} from "./safety/file-change-validator.js";
import { crossReferenceEvidence, type ClaimedEvidence } from "./safety/evidence-cross-ref.js";
import { validateContent } from "./safety/content-validator.js";
import { resolveSafetyHarnessConfig } from "./safety/safety-harness.js";
import { resolveExpectedArtifactPath as resolveArtifactForContent } from "./auto-artifact-paths.js";
import { getIsolationMode, loadEffectiveGSDPreferences, type GSDPreferences } from "./preferences.js";
import { getSliceTasks } from "./gsd-db.js";
import { runPreExecutionChecks, type PreExecutionResult } from "./pre-execution-checks.js";
import { writePreExecutionEvidence, type PreExecutionCheckJSON } from "./verification-evidence.js";
import { ensureCodebaseMapFresh } from "./codebase-generator.js";
import { resolveUokFlags } from "./uok/flags.js";
import { UokGateRunner } from "./uok/gate-runner.js";
import { writeTurnGitTransaction } from "./uok/gitops.js";
import { isClosedStatus } from "./status-guards.js";
import { detectAbandonMilestone } from "./abandon-detect.js";
import { getPendingGate } from "./bootstrap/write-gate.js";
import { isDeterministicPolicyError, isToolInvocationError, isToolUnavailableError } from "./auto-tool-tracking.js";
import { formatConnectedStepStack, formatPostUnitStatusCard } from "./auto-status-message.js";
import {
  clearProjectResearchInflightMarker,
  finalizeProjectResearchTimeout,
} from "./project-research-policy.js";
import { validateArtifact } from "./schemas/validate.js";
import { verificationRetryKey } from "./auto/verification-retry-policy.js";
import { saveCustomVerifyRetryCounts } from "./auto/custom-verify-retry-store.js";
import { getLedger } from "./metrics.js";
import { getUnitCostSpikeAction, resolveUnitCostSpikeMultiplier } from "./auto-budget.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
} from "./task-execution-domain-operation.js";
import { recordFailureAndSelectRecovery } from "./task-recovery-domain-operation.js";
import { isTaskExecutionReadyForHostVerification } from "./auto/task-execution-cutover.js";
import { recaptureVerifiedSourceAfterDeferredCloseout } from "./auto/verified-source-recapture.js";
import {
  routeEvidenceCrossReferenceBlock,
  type EvidenceCrossReferenceBlockResult,
} from "./auto-verification.js";

export function resolveEvidenceRoutePresentation(
  routed: EvidenceCrossReferenceBlockResult | null,
  routeFailure: string | null,
): {
  recovery: { recoveryActionId?: string; resumeInstruction: string };
  exitInstruction: string;
} {
  let resumeInstruction = "resume with /gsd auto to retry evidence recovery routing";
  if (routed?.outcome === "abort") {
    resumeInstruction = `resume with /gsd recover ${routed.recoveryActionId}`;
  } else if (routed) {
    resumeInstruction = "resume with /gsd auto to re-run the task";
  }
  return {
    recovery: {
      ...(routed ? { recoveryActionId: routed.recoveryActionId } : {}),
      resumeInstruction,
    },
    exitInstruction: routed
      ? `Recovery routed (recoveryActionId: ${routed.recoveryActionId}); ${resumeInstruction}.`
      : `Recovery routing did not commit (${routeFailure ?? "unknown failure"}); ${resumeInstruction}.`,
  };
}

// ─── Path Comparison Helper ───────────────────────────────────────────────
/** Compare two paths for physical identity, tolerating trailing slashes and symlinks. */
function isSamePathLocal(a: string, b: string): boolean {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}

/** Stateless WorktreeStateProjection — methods are pure functions of MilestoneScope. */
const _worktreeProjection = new WorktreeStateProjection();

/** Maximum verification retry attempts before escalating to blocker placeholder (#2653). */
const MAX_VERIFICATION_RETRIES = 3;
const MAX_GIT_COMMIT_REMEDIATION_RETRIES = 2;
/** Keep failure toasts short while still showing concrete examples. */
const MAX_NOTIFICATION_DETAILS = 3;
const NOTIFICATION_BULLET = "•";

function isParallelResearchUnit(unitType: string, unitId: string): boolean {
  return unitType === "research-slice" && unitId.endsWith("/parallel-research");
}

function shouldAttemptPlanRegeneration(unitType: string, unitId: string): boolean {
  if (unitType === "triage-captures" || unitType === "quick-task") return false;
  if (isParallelResearchUnit(unitType, unitId)) return false;
  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  return !!mid && !!sid;
}

export const _shouldAttemptPlanRegenerationForTest = shouldAttemptPlanRegeneration;

export function maybeWriteParallelResearchCostSpikeBlocker(
  unitType: string,
  unitId: string,
  basePath: string,
  unitCostUsd: number,
  rollingAvgUsd: number,
): string | null {
  if (!isParallelResearchUnit(unitType, unitId)) return null;
  return writeBlockerPlaceholder(
    unitType,
    unitId,
    basePath,
    `Parallel slice research cost spike detected (${unitCostUsd.toFixed(2)} vs avg ${rollingAvgUsd.toFixed(2)}). ` +
      "Skipping the aggregate sentinel so dispatch can fall back to per-slice research.",
  );
}

export function resolveCloseoutGitAction(
  uokFlags: ReturnType<typeof resolveUokFlags>,
): TurnGitActionMode | null {
  return uokFlags.gitops ? uokFlags.gitopsTurnAction : null;
}

function agentEndMessagesIncludeToolCall(messages: unknown[] | undefined, toolName: string): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as { type?: unknown; name?: unknown };
      if (typed.type === "toolCall" && typed.name === toolName) return true;
    }
  }
  return false;
}

function agentEndMessagesIncludeSuccessfulToolResult(messages: unknown[] | undefined, toolName: string): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as { role?: unknown; toolName?: unknown; isError?: unknown };
    if (typed.role === "toolResult" && typed.toolName === toolName && typed.isError !== true) return true;
  }
  return false;
}

function agentEndMessagesMentionTool(messages: unknown[] | undefined, toolName: string): boolean {
  if (!Array.isArray(messages)) return false;
  try {
    return JSON.stringify(messages).includes(toolName);
  } catch {
    return false;
  }
}

function hasIncompleteMilestoneSlice(milestoneId: string): boolean {
  if (!isDbAvailable()) return false;
  return getMilestoneSlices(milestoneId).some((slice) => !isClosedStatus(slice.status));
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

/**
 * Structural tool match inside one activity JSONL entry (#2223). Only real
 * toolCall parts and toolResult messages count — the unit's own prompt is
 * persisted as a custom_message entry that names every tool, so text content
 * must never match.
 */
function activityEntryMentionsTool(rawEntry: unknown, toolName: string): boolean {
  const entry = rawEntry as { type?: unknown; message?: unknown } | null;
  if (!entry || entry.type !== "message" || !entry.message) return false;
  const message = entry.message as { role?: unknown; content?: unknown; toolName?: unknown };
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const typed = part as { type?: unknown; name?: unknown } | null;
      if (typed && typed.type === "toolCall" && typed.name === toolName) return true;
    }
  }
  return message.role === "toolResult" && message.toolName === toolName;
}

function unitActivityMentionsTool(basePath: string, unitType: string, unitId: string, toolName: string): boolean {
  const safeUnitId = unitId.replace(/\//g, "-");
  const activityDir = join(basePath, ".gsd", "activity");
  if (!existsSync(activityDir)) return false;

  try {
    for (const entry of readdirSync(activityDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(`${unitType}-${safeUnitId}.jsonl`)) continue;
      const content = readFileSync(join(activityDir, entry.name), "utf-8");
      for (const line of content.split("\n")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (activityEntryMentionsTool(parsed, toolName)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function completeSliceReopenReplanHandoffDetected(
  s: AutoSession,
  agentEndMessages: unknown[] | undefined,
): boolean {
  if (s.currentUnit?.type !== "complete-slice") return false;
  const unitType = s.currentUnit.type;
  const unitId = s.currentUnit.id;
  return (
    agentEndMessagesIncludeSuccessfulToolResult(agentEndMessages, "gsd_task_reopen") ||
    agentEndMessagesIncludeToolCall(agentEndMessages, "gsd_task_reopen") ||
    unitActivityMentionsTool(s.basePath, unitType, unitId, "gsd_task_reopen") ||
    unitActivityMentionsTool(s.canonicalProjectRoot, unitType, unitId, "gsd_task_reopen")
  );
}

function completeSliceReplanSignalDetected(
  s: AutoSession,
  agentEndMessages: unknown[] | undefined,
): boolean {
  if (s.currentUnit?.type !== "complete-slice") return false;
  return (
    agentEndMessagesIncludeSuccessfulToolResult(agentEndMessages, "gsd_replan_slice") ||
    agentEndMessagesIncludeToolCall(agentEndMessages, "gsd_replan_slice") ||
    unitActivityMentionsTool(s.basePath, s.currentUnit.type, s.currentUnit.id, "gsd_replan_slice") ||
    unitActivityMentionsTool(s.canonicalProjectRoot, s.currentUnit.type, s.currentUnit.id, "gsd_replan_slice")
  );
}

function completeSliceValidReplanOutcomeDetected(
  s: AutoSession,
  agentEndMessages: unknown[] | undefined,
): boolean {
  if (s.currentUnit?.type !== "complete-slice") return false;
  const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
  if (!mid || !sid) return false;

  if (!completeSliceReplanSignalDetected(s, agentEndMessages)) return false;

  const replanPath = resolveSliceFile(s.basePath, mid, sid, "REPLAN");
  const canonicalReplanPath = resolveSliceFile(s.canonicalProjectRoot, mid, sid, "REPLAN");
  const hasReplanArtifact = (
    Boolean(replanPath && existsSync(replanPath)) ||
    Boolean(canonicalReplanPath && existsSync(canonicalReplanPath))
  );
  if (!hasReplanArtifact) return false;

  if (!isDbAvailable()) return true;
  const slice = getSlice(mid, sid);
  return Boolean(slice && !isClosedStatus(slice.status));
}

function formatPreExecutionCheckDetail(check: PreExecutionCheckJSON): string {
  const category = check.category?.trim() || "unknown category";
  const target = check.target?.trim() || "unknown target";
  const message = check.message.split(/\r?\n/, 1)[0]?.trim() || "No details provided";
  return `  ${NOTIFICATION_BULLET} [${category}] ${target}: ${message}`;
}

function formatPreExecutionFinding(check: PreExecutionCheckJSON): string {
  const category = check.category?.trim() || "unknown category";
  const target = check.target?.trim() || "unknown target";
  const message = check.message.split(/\r?\n/, 1)[0]?.trim() || "No details provided";
  return `[${category}] ${target}: ${message}`;
}

/** Guidance that only applies when checkVerificationCommands rejected a Verify command. */
const UNSAFE_VERIFY_COMMAND_GUIDANCE = [
  "Rewrite the slice plan so every task has safe, mechanically runnable Verify commands.",
  "Verify commands must not use shell pipes, redirects, semicolons, backticks, command substitution, output trimming, or grep regex alternation with \"|\".",
  "Use package scripts, node:test files, or separate simple commands joined only with \"&&\" when multiple checks are needed.",
];

function isUnsafeVerifyCommandCheck(check: PreExecutionCheckJSON): boolean {
  return check.category === "tool" && check.message.startsWith("Unsafe or non-runnable Verify command");
}

/**
 * Failure context for the re-dispatched planning unit. The findings lead so
 * the ledger summary (and the liveness-backstop wedge hint derived from it)
 * names the real blocker; the Verify-command guidance is appended only when
 * a Verify command was actually rejected.
 */
export function formatPreExecutionRetryContext(input: {
  unitType: string;
  unitId: string;
  verdictExcerpt: string;
  checks: PreExecutionCheckJSON[];
  evidencePath: string;
}): string {
  const findings = input.checks.length > 0
    ? input.checks.map((check) => `- ${formatPreExecutionFinding(check)}`).join("\n")
    : "- No specific findings captured";
  return [
    `Pre-execution checks failed after ${input.unitType} ${input.unitId}: ${input.verdictExcerpt}`,
    "Findings:",
    findings,
    ...(input.checks.some(isUnsafeVerifyCommandCheck) ? ["", ...UNSAFE_VERIFY_COMMAND_GUIDANCE] : []),
    "",
    `Evidence: ${input.evidencePath}`,
  ].join("\n");
}

const GIT_ACTION_FAILURE_LOG_REL_PATH = ".gsd/git-action-failures.log";
const DEFAULT_PER_UNIT_COST_CAP_USD = 5.0;
const MAX_PRE_EXEC_RETRIES = 2;

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

async function hasArtifactCostGuardAdvancedPastUnit(
  s: AutoSession,
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  prefs: GSDPreferences | undefined,
): Promise<boolean> {
  try {
    const state = await deriveState(s.canonicalProjectRoot);
    const activeMilestone = state.activeMilestone;
    if (!activeMilestone) return false;

    const { resolveDispatch } = await import("./auto-dispatch.js");
    const contextUsage = (ctx as any).sessionManager?.getContextUsage?.();
    const action = await resolveDispatch({
      basePath: s.basePath,
      mid: activeMilestone.id,
      midTitle: activeMilestone.title,
      state,
      prefs,
      session: s,
      sessionContextWindow: contextUsage?.contextWindow ?? (ctx as any).model?.contextWindow,
      sessionProvider: (ctx as any).model?.provider,
      modelRegistry: (ctx as any).modelRegistry,
    });

    return action.action !== "dispatch" || action.unitType !== unitType || action.unitId !== unitId;
  } catch (err) {
    debugLog("postUnit", {
      phase: "artifact-cost-guard-advance-check-failed",
      unitType,
      unitId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function persistGitActionFailure(basePath: string, action: TurnGitActionMode, message: string): string {
  const logPath = join(basePath, GIT_ACTION_FAILURE_LOG_REL_PATH);
  const logDir = join(basePath, ".gsd");
  const timestamp = new Date().toISOString();
  const body = message.trim() || "unknown git failure";
  const entry = `[${timestamp}] action=${action}\n${body}\n\n`;
  mkdirSync(logDir, { recursive: true });
  appendFileSync(logPath, entry, "utf-8");
  return logPath;
}

function gitCommitRemediationRetryKey(unitType: string, unitId: string): string {
  return `git-commit:${verificationRetryKey(unitType, unitId)}`;
}

/**
 * Shared by the legacy artifact ladder and the durable-authority branch so both
 * pause sites emit byte-identical messaging (#2883/#2131).
 */
function toolInvocationPauseMessage(unitType: string, errorMsg: string): string {
  return `Tool invocation/runtime failed for ${unitType}: ${errorMsg}. Retrying cannot resolve this deterministic failure — pausing auto-mode.`;
}

/**
 * DB-backed execute-task verification recovery is owned by the durable
 * authority (Attempt/Result/Verdict/Recovery rows) and the host verification
 * gate — not the legacy artifact retry ladder. Its shared retry key must not
 * be cleared by post-unit artifact verification (#1971).
 */
function isDurableVerificationTask(unitType: string): boolean {
  return unitType === "execute-task" && isDbAvailable();
}

function stripKnownIdPrefix(value: string | undefined | null, id: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) return raw.slice(id.length + 1).trim() || undefined;
  return raw;
}

function parseReactiveBatchTaskIds(unitId: string): string[] {
  const { task: batchPart } = parseUnitId(unitId);
  if (!batchPart?.startsWith("reactive+")) return [];

  const rawIds = batchPart
    .slice("reactive+".length)
    .split(",")
    .map((taskId) => taskId.trim().toUpperCase())
    .filter(Boolean);

  const unique = new Set<string>();
  for (const taskId of rawIds) {
    unique.add(taskId);
  }
  return [...unique];
}

function dedupePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function getPlannedKeyFiles(tasks: Array<
  { expected_output?: string[]; files?: string[]; key_files?: string[] }
>): string[] {
  return dedupePaths(
    tasks.flatMap((taskRow) => [
      ...(taskRow.expected_output ?? []),
      ...(taskRow.files ?? []),
      ...(taskRow.key_files ?? []),
    ]),
  );
}

export const _parseReactiveBatchTaskIdsForTest = parseReactiveBatchTaskIds;
export const _getPlannedKeyFilesForTest = getPlannedKeyFiles;

function resolveTaskArtifactPath(
  basePath: string,
  mid: string,
  sid: string,
  tid: string,
  suffix: string,
): string | null {
  const legacy = resolveTaskFile(basePath, mid, sid, tid, suffix);
  if (legacy) return legacy;
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (!slicePath) return null;
  const taskDir = resolveTasksDir(basePath, mid, sid) ?? slicePath;
  const file = resolveFile(taskDir, tid, suffix);
  return file ? join(taskDir, file) : null;
}

export async function handlePendingHookOutcome(
  { s, ctx, pi, pauseAuto }: Pick<PostUnitContext, "s" | "ctx" | "pi" | "pauseAuto">,
): Promise<"stopped" | null> {
  const trigger = peekRetryTrigger();
  if (!trigger && !isGateBlockPending()) return null;
  persistHookState(s.basePath);
  if (trigger) {
    ctx.ui.notify(
      `Hook requested retry of ${trigger.unitType} ${trigger.unitId} — resetting trigger unit state.`,
      "info",
    );
    try {
      const disposition = await prepareHookRetry(trigger, s.canonicalProjectRoot);
      if (disposition === "retry") {
        if (!s.orchestration) throw new Error("Hook retry requires an active orchestration session");
        await s.orchestration.retryActiveUnit({
          unitType: trigger.unitType,
          unitId: trigger.unitId,
        });
      }
      acknowledgeRetryTrigger(s.basePath);
    } catch (e) {
      debugLog("postUnitPostVerification", { phase: "retry-state-reset", error: String(e) });
      throw e;
    }
  }

  const gateBlock = consumeGateBlock();
  if (gateBlock) {
    const verdict = gateBlock.verdict ? ` verdict=${gateBlock.verdict};` : "";
    const artifact = gateBlock.artifact ? ` artifact=${gateBlock.artifact};` : "";
    const message =
      `Post-unit gate "${gateBlock.hookName}" blocked ${gateBlock.triggerUnitType} ${gateBlock.triggerUnitId} ` +
      (s.currentUnit ? `(detected on completion of ${s.currentUnit.type} ${s.currentUnit.id}):` : "(detected on resume):") +
      `${verdict}${artifact} ${gateBlock.reason}. Run /gsd status to inspect, then /gsd auto after recovery.`;
    ctx.ui.notify(message, "warning");
    await pauseAuto(ctx, pi);
    return "stopped";
  }
  return null;
}

type PendingHookRetry = NonNullable<ReturnType<typeof peekRetryTrigger>>;

function hookRetryIdempotencyKey(trigger: PendingHookRetry): string | null {
  if (trigger.completionOperationId) {
    return `internal:auto:hook-retry:${trigger.unitId}:operation:${trigger.completionOperationId}`;
  }
  if (trigger.legacyCompletedAt) {
    return `internal:auto:hook-retry:${trigger.unitId}:legacy:${trigger.legacyCompletedAt}`;
  }
  return null;
}

async function prepareHookRetry(
  trigger: PendingHookRetry,
  projectRoot: string,
): Promise<"retry" | "obsolete"> {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(trigger.unitId);
  if (trigger.unitType === "execute-task") {
    if (!mid || !sid || !tid) {
      throw new Error(`Hook retry execute-task identity is invalid: ${trigger.unitId}`);
    }
    const retryKey = hookRetryIdempotencyKey(trigger);
    if (!retryKey) {
      throw new Error(`Hook retry Task ${mid}/${sid}/${tid} has no canonical completion identity`);
    }
    const db = _getAdapter();
    if (!db) {
      throw new Error(`Hook retry Task ${mid}/${sid}/${tid} cannot be prepared: database unavailable`);
    }
    const task = getTask(mid, sid, tid);
    if (!task) throw new Error(`Hook retry Task ${mid}/${sid}/${tid} is missing`);
    const lifecycle = db.prepare(`
      SELECT lifecycle_status, last_operation_id
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task'
        AND milestone_id = :milestone_id
        AND slice_id = :slice_id
        AND task_id = :task_id
    `).get({
      ":milestone_id": mid,
      ":slice_id": sid,
      ":task_id": tid,
    });
    const preparedOperation = db.prepare(`
      SELECT operation_id
      FROM workflow_operations
      WHERE idempotency_key = :idempotency_key
    `).get({ ":idempotency_key": retryKey });
    const alreadyPrepared = task.status === "pending"
      && lifecycle?.["lifecycle_status"] === "ready"
      && typeof preparedOperation?.["operation_id"] === "string"
      && lifecycle["last_operation_id"] === preparedOperation["operation_id"];
    let reviewedCompletionIsCurrent = false;
    let currentCompletionIdentityIsKnown = false;
    if (trigger.completionOperationId) {
      currentCompletionIdentityIsKnown = task.status === "complete"
        && lifecycle?.["lifecycle_status"] === "completed"
        && typeof lifecycle["last_operation_id"] === "string"
        && lifecycle["last_operation_id"].length > 0;
      reviewedCompletionIsCurrent = task.status === "complete"
        && lifecycle?.["lifecycle_status"] === "completed"
        && lifecycle["last_operation_id"] === trigger.completionOperationId;
    } else if (trigger.legacyCompletedAt) {
      currentCompletionIdentityIsKnown = task.status === "complete"
        && !lifecycle
        && typeof task.completed_at === "string"
        && task.completed_at.length > 0;
      reviewedCompletionIsCurrent = task.status === "complete"
        && !lifecycle
        && task.completed_at === trigger.legacyCompletedAt;
    }
    if (!alreadyPrepared && !reviewedCompletionIsCurrent) {
      if (task.status === "complete" && !currentCompletionIdentityIsKnown) {
        throw new Error(`Hook retry Task ${mid}/${sid}/${tid} has no canonical completion identity`);
      }
      return "obsolete";
    }

    if (!alreadyPrepared) {
      reopenTask({
        invocation: internalExecutionInvocation(retryKey),
        task: { milestoneId: mid, sliceId: sid, taskId: tid },
        reason: `Post-unit hook requested retry of ${trigger.unitType} ${trigger.unitId}`,
      });
    }
    await renderPlanCheckboxes(projectRoot, mid, sid);

    const summaryPath = resolveTaskArtifactPath(projectRoot, mid, sid, tid, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) removeProjectionFileSync(summaryPath);
  }

  if (trigger.retryArtifact) {
    const retryArtifactPath = resolveHookArtifactPath(projectRoot, trigger.unitId, trigger.retryArtifact);
    if (existsSync(retryArtifactPath)) removeProjectionFileSync(retryArtifactPath);
  }
  invalidateAllCaches();
  return "retry";
}

function resolveVerificationFailureMarkerPath(
  unitType: string,
  unitId: string,
  basePath: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "complete-milestone": {
      const existing = resolveMilestoneFile(basePath, mid, "VERIFICATION-FAILED");
      if (existing) return existing;
      return join(basePath, relMilestoneFile(basePath, mid, "VERIFICATION-FAILED"));
    }
    case "complete-slice": {
      const existing = resolveSliceFile(basePath, mid, sid!, "VERIFICATION-FAILED");
      if (existing) return existing;
      return join(basePath, relSliceFile(basePath, mid, sid!, "VERIFICATION-FAILED"));
    }
    case "execute-task": {
      const existing = resolveTaskArtifactPath(basePath, mid, sid!, tid!, "VERIFICATION-FAILED");
      if (existing) return existing;
      return join(basePath, relTaskFile(basePath, mid, sid!, tid!, "VERIFICATION-FAILED"));
    }
    default:
      return null;
  }
}

async function buildTaskCommitContextForUnit(
  basePath: string,
  unitId: string,
): Promise<TaskCommitContext | undefined> {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) return undefined;

  const milestone = isDbAvailable() ? getMilestone(mid) : null;
  const slice = isDbAvailable() ? getSlice(mid, sid) : null;
  const task = isDbAvailable() ? getTask(mid, sid, tid) : null;
  let summary: ReturnType<typeof parseSummary> | null = null;

  const summaryPath = resolveTaskArtifactPath(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath) {
    try {
      const summaryContent = await loadFile(summaryPath);
      if (summaryContent) summary = parseSummary(summaryContent);
    } catch (e) {
      debugLog("postUnit", { phase: "task-summary-parse", error: String(e) });
    }
  }

  if (!summary && !task) return undefined;

  let ghIssueNumber: number | undefined;
  try {
    const { getTaskIssueNumberForCommit } = await import("../github-sync/sync.js");
    ghIssueNumber = getTaskIssueNumberForCommit(basePath, mid, sid, tid) ?? undefined;
  } catch (err) {
    logWarning("engine", `GitHub issue lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    taskId: `${sid}/${tid}`,
    taskDisplayId: tid,
    taskTitle:
      stripKnownIdPrefix(summary?.title, tid) ??
      stripKnownIdPrefix(task?.title, tid) ??
      tid,
    milestoneId: mid,
    milestoneTitle: stripKnownIdPrefix(milestone?.title, mid),
    sliceId: sid,
    sliceTitle: stripKnownIdPrefix(slice?.title, sid),
    oneLiner: summary?.oneLiner || task?.one_liner || undefined,
    keyFiles:
      summary?.frontmatter.key_files?.filter((f) => {
        const normalized = f.trim();
        return normalized.length > 0 &&
          !normalized.includes("{{") &&
          !/^(?:\(none\)|none\.?|n\/a)$/i.test(normalized);
      }) ??
      task?.key_files ??
      undefined,
    issueNumber: ghIssueNumber,
  };
}

async function buildReactiveTaskCommitContext(
  _basePath: string,
  unitId: string,
): Promise<TaskCommitContext | undefined> {
  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  if (!mid || !sid || !isDbAvailable()) return undefined;

  const batchTaskIds = parseReactiveBatchTaskIds(unitId);
  if (batchTaskIds.length === 0) return undefined;

  const milestone = getMilestone(mid);
  const slice = getSlice(mid, sid);
  const taskRows = batchTaskIds
    .map((tid) => getTask(mid, sid, tid))
    .filter((taskRow): taskRow is NonNullable<ReturnType<typeof getTask>> => taskRow !== null);

  const keyFiles = getPlannedKeyFiles(taskRows);
  if (taskRows.length === 0 || keyFiles.length === 0) return undefined;

  const taskLabel = taskRows.map((row) => row.id).join(",");

  return {
    taskId: `${sid}/${taskLabel}`,
    taskDisplayId: "reactive-batch",
    taskTitle: `Reactive batch: ${taskLabel}`,
    milestoneId: mid,
    milestoneTitle: stripKnownIdPrefix(milestone?.title, mid),
    sliceId: sid,
    sliceTitle: stripKnownIdPrefix(slice?.title, sid),
    oneLiner: `Reactive execute for ${taskLabel}`,
    keyFiles,
  };
}

async function runPostUnitGitHubSyncIfNeeded(
  basePath: string,
  unit: NonNullable<AutoSession["currentUnit"]>,
): Promise<void> {
  if (unit.type === "complete-milestone") return;
  await runSafely("postUnit", "github-sync", async () => {
    const { runGitHubSync } = await import("../github-sync/sync.js");
    await runGitHubSync(basePath, unit.type, unit.id);
  });
}

/** Enqueue a sidecar item (hook, triage, or quick-task) for the main loop to
 *  drain via runUnit. Logs the enqueue event and notifies the UI. */
function enqueueSidecar(
  s: AutoSession,
  ctx: ExtensionContext,
  entry: SidecarItem,
  debugExtra: Record<string, unknown>,
  notification?: string,
): "continue" {
  s.sidecarQueue.push(entry);
  debugLog("postUnitPostVerification", {
    phase: "sidecar-enqueue",
    kind: entry.kind,
    unitId: entry.unitId,
    ...debugExtra,
  });
  if (notification) ctx.ui.notify(notification, "info");
  return "continue";
}

export function _shouldDispatchTriageForTest(
  state: Pick<AutoSession, "stepMode" | "currentUnit">,
): boolean {
  return !state.stepMode &&
    !!state.currentUnit &&
    !state.currentUnit.type.startsWith("hook/") &&
    state.currentUnit.type !== "triage-captures" &&
    state.currentUnit.type !== "quick-task";
}

export function _shouldDispatchQuickTaskForTest(
  state: Pick<AutoSession, "stepMode" | "currentUnit" | "pendingQuickTasks">,
): boolean {
  return !state.stepMode &&
    state.pendingQuickTasks.length > 0 &&
    !!state.currentUnit &&
    state.currentUnit.type !== "quick-task";
}

export function _hasExecutionToolCallsInSessionForTest(entries: readonly unknown[]): boolean {
  for (const entry of entries) {
    const e = entry as any;
    if (e?.type === "toolCall" && isExecutionToolName(e?.name ?? e?.toolName)) {
      return true;
    }

    // Accept both session-manager entries ({type: "message", message}) and
    // bare agent-end messages ({role, content}) — the auto loop passes the
    // latter via opts.agentEndMessages.
    const msg = e?.type === "message" ? e?.message : e;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      if (isExecutionToolName(block?.toolName ?? block?.name)) return true;
    }
  }
  return false;
}

export function shouldDeferCloseoutGitAction(unitType: string): boolean {
  return unitType === "execute-task";
}

function reportFileChangeWarnings(
  ctx: ExtensionContext,
  audit: FileChangeAudit | null,
): void {
  if (!audit || audit.violations.length === 0) return;
  const warnings = audit.violations.filter(v => v.severity === "warning");
  for (const v of warnings) {
    logWarning("safety", `file-change: ${v.file} — ${v.reason}`);
  }
  if (warnings.length > 0) {
    ctx.ui.notify(
      `Safety: ${warnings.length} unexpected file change(s) outside task plan`,
      "warning",
    );
  }
}

function runExecuteTaskFileChangeSafety(
  s: AutoSession,
  ctx: ExtensionContext,
  fileChangeAllowlist: string[],
  headBeforeCloseout: string | null,
): void {
  if (s.currentUnit?.type !== "execute-task") return;
  const { milestone: sMid, slice: sSid, task: sTid } = parseUnitId(s.currentUnit.id);
  if (!sMid || !sSid || !sTid) return;

  try {
    const sliceTaskRows = isDbAvailable()
      ? getSliceTasks(sMid, sSid).filter((t) => isClosedStatus(t.status) || t.id === sTid)
      : [];

    if (sliceTaskRows.length > 0) {
      const expectedOutput = getPlannedKeyFiles(
        sliceTaskRows.map((taskRow) => ({
          expected_output: taskRow.expected_output,
          files: taskRow.files,
        })),
      );
      const plannedFiles = getPlannedKeyFiles(
        sliceTaskRows.map((taskRow) => ({ files: taskRow.files })),
      );
      reportFileChangeWarnings(
        ctx,
        validateFileChanges(s.basePath, expectedOutput, plannedFiles, fileChangeAllowlist, { headBeforeCloseout }),
      );
      return;
    }

    const taskRow = getTask(sMid, sSid, sTid);
    if (!taskRow) return;
    reportFileChangeWarnings(
      ctx,
      validateFileChanges(
        s.basePath,
        taskRow.expected_output ?? [],
        taskRow.files ?? [],
        fileChangeAllowlist,
        { headBeforeCloseout },
      ),
    );
  } catch (e) {
    debugLog("postUnit", { phase: "safety-file-change", error: String(e) });
  }
}

/** Unit types that only touch `.gsd/` internal state files (no code changes).
 *  Auto-commit is skipped for these — their state files are picked up by the
 *  next actual task commit via `smartStage()`. */
const LIFECYCLE_ONLY_UNITS = new Set([
  "research-milestone", "discuss-milestone", "discuss-slice", "plan-milestone",
  "validate-milestone", "research-slice", "plan-slice", "refine-slice",
  "replan-slice", "complete-slice", "run-uat",
  "reassess-roadmap", "rewrite-docs",
]);
import {
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  unitVerb,
  describeNextUnit,
  setAutoOutcomeWidget,
  type AutoOutcomeSurfaceSnapshot,
} from "./auto-dashboard.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { _resetHasChangesCache } from "./native-git-bridge.js";
import { autoCommitCurrentBranch } from "./worktree.js";

// ─── Rogue File Detection ──────────────────────────────────────────────────

export interface RogueFileWrite {
  path: string;
  unitType: string;
  unitId: string;
}

/**
 * Detect summary files written directly to disk without the LLM calling
 * the completion tool. A "rogue" file is one that exists on disk but has
 * no corresponding DB row with status "complete".
 *
 * This is a safety-net diagnostic (D003). Runtime detection never imports
 * markdown into the DB; explicit migration/import/recovery commands own that.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasNonEmptyFields(row: Record<string, any> | null, fields: string[]): boolean {
  if (!row) return false;
  return fields.some(f => String(row[f] || "").trim().length > 0);
}

const MILESTONE_PLANNING_FIELDS = ["title", "vision", "requirement_coverage", "boundary_map_markdown"];
const SLICE_PLANNING_FIELDS = ["title", "demo", "risk", "depends"];

export function detectRogueFileWrites(
  unitType: string,
  unitId: string,
  basePath: string,
): RogueFileWrite[] {
  if (!isDbAvailable()) return [];

  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  const rogues: RogueFileWrite[] = [];

  if (unitType === "execute-task") {
    if (!mid || !sid || !tid) return [];

    const summaryPath = resolveTaskArtifactPath(basePath, mid, sid, tid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];

    const dbRow = getTask(mid, sid, tid);
    if (!dbRow || dbRow.status !== "complete") {
      rogues.push({ path: summaryPath, unitType, unitId });
    }
  } else if (unitType === "complete-slice") {
    if (!mid || !sid) return [];

    const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];

    const dbRow = getSlice(mid, sid);
    if (!dbRow || dbRow.status !== "complete") {
      rogues.push({ path: summaryPath, unitType, unitId });
    }
  } else if (unitType === "plan-milestone") {
    if (!mid) return [];

    const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) return [];

    const dbRow = getMilestone(mid);
    const hasPlanningState = hasNonEmptyFields(dbRow, MILESTONE_PLANNING_FIELDS);

    if (!hasPlanningState) {
      rogues.push({ path: roadmapPath, unitType, unitId });
    }
  } else if (unitType === "plan-slice" || unitType === "refine-slice" || unitType === "replan-slice") {
    if (!mid || !sid) return [];

    const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
    if (!planPath || !existsSync(planPath)) return [];

    const dbRow = getSlice(mid, sid);
    const hasPlanningState = hasNonEmptyFields(dbRow, SLICE_PLANNING_FIELDS);

    if (!hasPlanningState) {
      rogues.push({ path: planPath, unitType, unitId });
    }

    // Also check for rogue REPLAN.md
    const replanPath = resolveSliceFile(basePath, mid, sid, "REPLAN");
    if (replanPath && existsSync(replanPath) && !hasPlanningState) {
      rogues.push({ path: replanPath, unitType, unitId });
    }
  } else if (unitType === "reassess-roadmap") {
    if (!mid) return [];

    const assessPath = resolveMilestoneFile(basePath, mid, "ROADMAP-ASSESSMENT");
    if (!assessPath || !existsSync(assessPath)) return [];

    // Assessment file exists on disk — check if DB knows about it via the artifacts table
    const adapter = _getAdapter();
    if (adapter) {
      const row = adapter.prepare(
        `SELECT 1 FROM artifacts WHERE path LIKE :pattern AND artifact_type = 'ASSESSMENT' LIMIT 1`,
      ).get({ ":pattern": `%${basename(assessPath)}` });
      if (!row) {
        rogues.push({ path: assessPath, unitType, unitId });
      }
    }
  } else if (unitType === "plan-task") {
    if (!mid || !sid || !tid) return [];

    const taskPlanPath = resolveTaskArtifactPath(basePath, mid, sid, tid, "PLAN");
    if (!taskPlanPath || !existsSync(taskPlanPath)) return [];

    const dbRow = getTask(mid, sid, tid);
    if (!dbRow) {
      rogues.push({ path: taskPlanPath, unitType, unitId });
    }
  }

  return rogues;
}

/**
 * Maximum number of times to retry a unit whose expected artifact is missing
 * after execution. Matches the bounded pattern used by runPostUnitVerification
 * in auto-verification.ts. Exceeding this limit pauses auto-mode instead of
 * looping indefinitely (#2007).
 */
export const MAX_ARTIFACT_VERIFICATION_RETRIES = 3;

function buildStepCompleteCallout(
  currentUnit?: NonNullable<AutoSession["currentUnit"]> | null,
): string {
  const isTask = currentUnit?.type === "execute-task";
  const completedLabel = currentUnit ? `${unitVerb(currentUnit.type)} ${currentUnit.id}` : "Step complete";
  return formatConnectedStepStack(`✓ GSD ${isTask ? "Task" : "Step"} Complete`, completedLabel);
}

export const STEP_COMPLETE_FALLBACK_MESSAGE = buildStepCompleteCallout();

export function buildStepCompleteMessage(nextState: import("./types.js").GSDState): string | null {
  if (nextState.phase === "complete") {
    return null;
  }
  return buildStepCompleteCallout();
}

function buildStepCompleteMessageForUnit(
  nextState: import("./types.js").GSDState,
  currentUnit?: NonNullable<AutoSession["currentUnit"]> | null,
): string | null {
  if (nextState.phase === "complete") {
    return null;
  }
  return buildStepCompleteCallout(currentUnit);
}

export function buildStepCompleteOutcome(
  nextState: import("./types.js").GSDState,
  currentUnit?: NonNullable<AutoSession["currentUnit"]> | null,
): AutoOutcomeSurfaceSnapshot | null {
  if (nextState.phase === "complete") {
    return null;
  }
  const next = describeNextUnit(nextState);
  return {
    status: "step",
    title: "Step complete",
    detail: `Next: ${next.label}.`,
    unitLabel: currentUnit ? `${unitVerb(currentUnit.type)} ${currentUnit.id}` : null,
    nextAction: "Advance one step, or resume automatic mode.",
    commands: ["/gsd next", "/gsd auto", "/gsd status for overview"],
  };
}

export function setStepCompleteSurface(
  ctx: ExtensionContext,
  nextState: import("./types.js").GSDState,
  currentUnit?: NonNullable<AutoSession["currentUnit"]> | null,
): string | null {
  const outcome = buildStepCompleteOutcome(nextState, currentUnit);
  if (!outcome) {
    return null;
  }
  if (ctx.hasUI && typeof ctx.ui?.setWidget === "function") {
    ctx.ui.setWidget("gsd-progress", undefined);
  }
  setAutoOutcomeWidget(ctx, outcome);
  return buildStepCompleteMessageForUnit(nextState, currentUnit);
}

export function setStepCompleteFallbackSurface(
  ctx: ExtensionContext,
  currentUnit?: NonNullable<AutoSession["currentUnit"]> | null,
): string {
  if (ctx.hasUI && typeof ctx.ui?.setWidget === "function") {
    ctx.ui.setWidget("gsd-progress", undefined);
  }
  setAutoOutcomeWidget(ctx, {
    status: "step",
    title: "Step complete",
    detail: "State refresh failed after the unit completed.",
    unitLabel: currentUnit ? `${unitVerb(currentUnit.type)} ${currentUnit.id}` : null,
    nextAction: "Inspect state, then advance one step or resume automatic mode.",
    commands: ["/gsd status for overview", "/gsd next", "/gsd auto"],
  });
  return buildStepCompleteCallout(currentUnit);
}

/**
 * Decide whether step mode should stop at the step wizard after a unit finishes.
 *
 * @param currentUnitType The just-finished unit type, such as "execute-task" or
 *   "complete-milestone"; may be null/undefined when no current unit is known.
 * @param phaseAfterUnit The freshly derived next phase, such as "executing" or
 *   "complete"; may be null/undefined if state derivation failed.
 * @returns true to show the step wizard; false to keep the loop running so
 *   terminal milestone completion can reach the merge/finalization path.
 */
export function shouldReturnStepWizardAfterUnit(
  currentUnitType: string | null | undefined,
  phaseAfterUnit: string | null | undefined,
): boolean {
  return currentUnitType !== "complete-milestone" && phaseAfterUnit !== "complete";
}

export interface PreVerificationOpts {
  skipSettleDelay?: boolean;
  skipWorktreeSync?: boolean;
  agentEndMessages?: unknown[];
}

export type PreVerificationResult =
  | "dispatched"
  | "continue"
  | "retry"
  | "evidence-xref-blocked";

export interface PostUnitContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  buildSnapshotOpts: (unitType: string, unitId: string) => CloseoutOptions & Record<string, unknown>;
  lockBase: () => string;
  stopAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI, reason?: string) => Promise<void>;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  updateProgressWidget: (ctx: ExtensionContext, unitType: string, unitId: string, state: import("./types.js").GSDState) => void;
}

export const USER_DRIVEN_DEEP_UNITS = new Set([
  "discuss-project",
  "discuss-requirements",
  "discuss-milestone",
  "research-decision",
]);
export { isAwaitingUserInput } from "./consent-question.js";

function artifactValidationKind(unitType: string): "project" | "requirements" | null {
  if (unitType === "discuss-project") return "project";
  if (unitType === "discuss-requirements") return "requirements";
  return null;
}

const TASK_COMPLETION_TOOL_NAMES = new Set(["gsd_task_complete", "gsd_complete_task"]);

/**
 * Verify-after-write receipt check (#1714/#1761): a run-uat or
 * validate-milestone unit may only complete when its save actually persisted.
 * Returns null when the durable receipt exists, else an error naming the
 * missing artifact and the owning save tool.
 */
function missingDurableSaveReceipt(unitType: string, unitId: string): string | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter();
  if (!db) return null;
  if (unitType === "run-uat") {
    const { milestone, slice } = parseUnitId(unitId);
    const row = db.prepare(`
      SELECT status FROM quality_gates
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id
        AND gate_id = 'UAT' AND (task_id = '' OR task_id IS NULL)
    `).get({ ":milestone_id": milestone, ":slice_id": slice }) as Record<string, unknown> | undefined;
    if (!row) {
      return `Artifact verification failed: UAT verdict for ${unitId} was not durably persisted (no quality_gates UAT row). Re-call gsd_uat_result_save with the existing evidence.`;
    }
    return null;
  }
  if (unitType === "validate-milestone") {
    const { milestone } = parseUnitId(unitId);
    const row = db.prepare(`
      SELECT 1 AS present FROM assessments
      WHERE milestone_id = :milestone_id AND scope = 'milestone-validation'
      LIMIT 1
    `).get({ ":milestone_id": milestone });
    if (!row) {
      return `Artifact verification failed: milestone validation verdict for ${milestone} was not durably persisted (no milestone-validation assessment row). Re-run gsd_validate_milestone.`;
    }
    return null;
  }
  return null;
}

function hasTaskCompletionToolCall(agentEndMessages?: unknown[] | null): boolean {
  if (!Array.isArray(agentEndMessages)) return false;
  for (const rawMessage of agentEndMessages) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const message = rawMessage as { content?: unknown };
    if (!Array.isArray(message.content)) continue;
    for (const rawPart of message.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as { type?: unknown; name?: unknown };
      if (part.type !== "toolCall") continue;
      const name = String(part.name ?? "").toLowerCase();
      if (TASK_COMPLETION_TOOL_NAMES.has(name)) {
        return true;
      }
    }
  }
  return false;
}

function describeArtifactVerificationFailure(
  unitType: string,
  unitId: string,
  basePath: string,
  agentEndMessages?: unknown[] | null,
): string {  const worktreeFailure = diagnoseWorktreeIntegrityFailure(basePath);
  if (worktreeFailure) {
    return `${worktreeFailure} Unit: ${unitType} ${unitId}.`;
  }

  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
  if (!artifactPath) {
    return `Artifact verification failed: ${unitType} "${unitId}" has no resolvable artifact path.`;
  }
  const relPath = relative(normalizeRealPath(basePath), artifactPath);
  if (!existsSync(artifactPath)) {
    const completionToolHint = unitType === "execute-task" && !hasTaskCompletionToolCall(agentEndMessages)
      ? " No completion tool call detected (`gsd_task_complete`/alias)."
      : "";
    const saveToolHint =
      unitType === "run-uat"
        ? " Re-call gsd_uat_result_save."
        : unitType === "validate-milestone"
          ? " Re-run gsd_validate_milestone."
          : "";
    return `Artifact verification failed: ${relPath} was not found on disk after unit execution${expected ? ` (${expected})` : ""}.${completionToolHint}${saveToolHint}`;
  }

  const validationKind = artifactValidationKind(unitType);
  if (validationKind) {
    const result = validateArtifact(artifactPath, validationKind);
    if (!result.ok) {
      const errors = result.errors
        .slice(0, MAX_NOTIFICATION_DETAILS)
        .map((error) => `${error.code}: ${error.message}`)
        .join("; ");
      return `Artifact verification failed: ${relPath} exists but is invalid${errors ? ` (${errors})` : ""}.`;
    }
  }

  return `Artifact verification failed: ${relPath} exists but did not satisfy the ${unitType} completion contract${expected ? ` (${expected})` : ""}.`;
}
export const _describeArtifactVerificationFailureForTest = describeArtifactVerificationFailure;
export const _missingDurableSaveReceiptForTest = missingDurableSaveReceipt;

async function repairCompleteSliceRoadmapProjection(
  unitType: string,
  unitId: string,
  basePath: string,
): Promise<boolean> {
  if (unitType !== "complete-slice") return false;

  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  if (!mid || !sid) return false;

  const slice = getSlice(mid, sid);
  if (!slice || !isClosedStatus(slice.status)) return false;

  const artifactBase = resolveCanonicalMilestoneRoot(basePath, mid);
  const summaryPath = resolveExpectedArtifactPath(unitType, unitId, artifactBase);
  const uatPath = resolveSliceFile(artifactBase, mid, sid, "UAT");
  if (!summaryPath || !existsSync(summaryPath) || !uatPath || !existsSync(uatPath)) {
    return false;
  }

  // Stale-render detection (ADR-017): the DB already says the slice is closed;
  // this only checks whether the rendered ROADMAP projection reflects it, to
  // decide whether a repair re-render is needed.
  const roadmapPath = resolveMilestoneFile(artifactBase, mid, "ROADMAP");
  if (roadmapPath && existsSync(roadmapPath)) {
    try {
      if (roadmapRenderMarksSliceDone(readFileSync(roadmapPath, "utf-8"), sid)) {
        return false;
      }
    } catch (err) {
      logWarning(
        "projection",
        `complete-slice roadmap parse failed before repair for ${mid}/${sid}: ${(err as Error).message}`,
      );
    }
  }

  await renderRoadmapFromDb(artifactBase, mid);
  return true;
}

export async function autoCommitUnit(
  basePath: string,
  unitType: string,
  unitId: string,
  ctx?: ExtensionContext,
): Promise<string | null> {
  try {
    const prefs = loadEffectiveGSDPreferences()?.preferences;
    const uokFlags = resolveUokFlags(prefs);
    if (!uokFlags.gitops) {
      return null;
    }

    let taskContext: TaskCommitContext | undefined;

    if (unitType === "execute-task") {
      taskContext = await buildTaskCommitContextForUnit(basePath, unitId);
    } else if (unitType === "reactive-execute") {
      taskContext = await buildReactiveTaskCommitContext(basePath, unitId);
    }

    _resetHasChangesCache();

    if (LIFECYCLE_ONLY_UNITS.has(unitType)) {
      return null;
    }

    const commitMsg = autoCommitCurrentBranch(basePath, unitType, unitId, taskContext);
    if (commitMsg) {
      ctx?.ui.notify(formatPostUnitStatusCard("✓ Commit", commitMsg.split("\n")[0]), "info");
    }
    return commitMsg;
  } catch (e) {
    debugLog("postUnit", { phase: "auto-commit", error: String(e) });
    ctx?.ui.notify(`Auto-commit failed: ${String(e).split("\n")[0]}`, "warning");
    return null;
  }
}

/**
 * Execute the turn-level git action (commit, snapshot, or status-only).
 *
 * @param opts.softFailure - Defaults to false. When true, retry git failures,
 * warn, and continue only for transient git failures. Deterministic task
 * commit hook failures are routed through task remediation instead.
 */
async function runCloseoutGitAction(
  pctx: PostUnitContext,
  unit: NonNullable<AutoSession["currentUnit"]>,
  opts?: { softFailure?: boolean },
): Promise<"continue" | "retry" | "dispatched"> {
  const { s, ctx, pi, pauseAuto } = pctx;
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  const turnAction = resolveCloseoutGitAction(uokFlags);
  const traceId = s.currentTraceId ?? `turn:${unit.startedAt}`;
  const turnId = s.currentTurnId ?? `${unit.type}/${unit.id}/${unit.startedAt}`;

  s.lastGitActionFailure = null;
  s.lastGitActionStatus = null;

  if (!turnAction) {
    debugLog("postUnit", {
      phase: "git-action-skipped",
      reason: "gitops-disabled",
      unitType: unit.type,
      unitId: unit.id,
    });
    return "continue";
  }

  try {
    let taskContext: TaskCommitContext | undefined;
    let targetRepositories: string[] | undefined;

    if (turnAction === "commit" && unit.type === "execute-task") {
      taskContext = await buildTaskCommitContextForUnit(s.basePath, unit.id);
      const { milestone: mid, slice: sid, task: tid } = parseUnitId(unit.id);
      if (mid && sid && tid && isDbAvailable()) {
        targetRepositories = getTask(mid, sid, tid)?.target_repositories;
      }
    } else if (turnAction === "commit" && unit.type === "reactive-execute") {
      taskContext = await buildReactiveTaskCommitContext(s.basePath, unit.id);
      const { milestone: mid, slice: sid } = parseUnitId(unit.id);
      if (mid && sid && isDbAvailable()) {
        const repositories = new Set<string>();
        for (const tid of parseReactiveBatchTaskIds(unit.id)) {
          const taskRow = getTask(mid, sid, tid);
          for (const repoId of taskRow?.target_repositories ?? []) {
            repositories.add(repoId);
          }
        }
        if (repositories.size > 0) {
          targetRepositories = [...repositories];
        }
      }
    }

    // Invalidate the nativeHasChanges cache before auto-commit (#1853).
    // The cache has a 10-second TTL and is keyed by basePath. A stale
    // `false` result causes autoCommit to skip staging entirely.
    _resetHasChangesCache();

    const skipLifecycleCommit =
      turnAction === "commit" && LIFECYCLE_ONLY_UNITS.has(unit.type);

    if (skipLifecycleCommit) {
      debugLog("postUnit", {
        phase: "git-action-skipped",
        reason: "lifecycle-only-unit",
        unitType: unit.type,
        unitId: unit.id,
      });
    } else {
      const maxAttempts = opts?.softFailure ? 3 : 1;
      let gitResult = runTurnGitAction({
        basePath: s.basePath,
        action: turnAction,
        unitType: unit.type,
        unitId: unit.id,
        taskContext,
        targetRepositories,
      });
      for (
        let attempt = 1;
        gitResult.status === "failed" && gitResult.failureClass === "transient" && attempt < maxAttempts;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        gitResult = runTurnGitAction({
          basePath: s.basePath,
          action: turnAction,
          unitType: unit.type,
          unitId: unit.id,
          taskContext,
          targetRepositories,
        });
      }

      if (uokFlags.gitops) {
        writeTurnGitTransaction({
          basePath: s.basePath,
          traceId,
          turnId,
          unitType: unit.type,
          unitId: unit.id,
          stage: "publish",
          action: turnAction,
          push: uokFlags.gitopsTurnPush,
          status: gitResult.status,
          error: gitResult.error,
          metadata: {
            basePath: s.basePath,
            dirty: gitResult.dirty,
            dirtyRepositories: gitResult.dirtyRepositories,
            commitMessage: gitResult.commitMessage,
            commitMessages: gitResult.commitMessages,
            commitErrors: gitResult.commitErrors,
            failureClass: gitResult.failureClass,
            skippedRepositories: gitResult.skippedRepositories,
            snapshotLabel: gitResult.snapshotLabel,
          },
        });
      }

      if (gitResult.status === "failed") {
        s.lastGitActionFailure = gitResult.error ?? `git ${turnAction} failed`;
        s.lastGitActionStatus = "failed";
        const fullError = gitResult.error ?? "unknown error";
        const failureLogPath = persistGitActionFailure(s.basePath, turnAction, fullError);
        if (uokFlags.gitops && uokFlags.gates) {
          const parsed = parseUnitId(unit.id);
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "closeout-git-action",
            type: "closeout",
            execute: async () => ({
              outcome: "fail",
              failureClass: "git",
              rationale: `turn git action "${turnAction}" failed`,
              findings: fullError,
            }),
          });
          await gateRunner.run("closeout-git-action", {
            basePath: s.basePath,
            traceId,
            turnId,
            milestoneId: parsed.milestone ?? undefined,
            sliceId: parsed.slice ?? undefined,
            taskId: parsed.task ?? undefined,
            unitType: unit.type,
            unitId: unit.id,
          });
        }

        const failureMsg = `Git ${turnAction} failed: ${fullError.split("\n")[0]} (full details: ${failureLogPath})`;
        debugLog("postUnit", {
          phase: opts?.softFailure ? "git-action-failed-soft" : "git-action-failed-blocking",
          action: turnAction,
          error: fullError,
          failureClass: gitResult.failureClass,
          failureLogPath,
        });
        const hasPartialCommits = Object.keys(gitResult.commitMessages ?? {}).length > 0;
        if (
          opts?.softFailure &&
          turnAction === "commit" &&
          unit.type === "execute-task" &&
          gitResult.failureClass === "hook-content" &&
          !hasPartialCommits
        ) {
          const retryKey = gitCommitRemediationRetryKey(unit.type, unit.id);
          const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
          if (attempt <= MAX_GIT_COMMIT_REMEDIATION_RETRIES) {
            s.verificationRetryCount.set(retryKey, attempt);
            s.pendingVerificationRetry = {
              unitId: unit.id,
              failureContext:
                "Git commit failed after task verification. The commit hook rejected the staged task changes; " +
                "fix the reported issue and complete the task again so GSD can retry the commit.\n\n" +
                fullError,
              signature: `git-commit:${attempt}:${fullError}`,
              attempt,
            };
            ctx.ui.notify(
              `Git ${turnAction} failed: ${fullError.split("\n")[0]}. Retrying task remediation (attempt ${attempt}/${MAX_GIT_COMMIT_REMEDIATION_RETRIES}).`,
              "warning",
            );
            debugLog("postUnit", {
              phase: "git-action-remediation-retry",
              action: turnAction,
              unitType: unit.type,
              unitId: unit.id,
              attempt,
              failureLogPath,
            });
            return "retry";
          }

          s.pendingVerificationRetry = null;
          s.verificationRetryCount.delete(retryKey);
          ctx.ui.notify(
            `Git ${turnAction} failed after ${MAX_GIT_COMMIT_REMEDIATION_RETRIES} remediation attempts: ${fullError.split("\n")[0]} (full details: ${failureLogPath}). Pausing auto-mode.`,
            "error",
          );
          await pauseAuto(ctx, pi);
          return "dispatched";
        }
        if (opts?.softFailure && gitResult.failureClass === "transient") {
          ctx.ui.notify(failureMsg, "warning");
          return "continue";
        }
        ctx.ui.notify(failureMsg, "error");
        await pauseAuto(ctx, pi);
        return "dispatched";
      }

      s.lastGitActionStatus = "ok";
      s.verificationRetryCount.delete(gitCommitRemediationRetryKey(unit.type, unit.id));
      s.verificationRetryFailureHashes.delete(verificationRetryKey(unit.type, unit.id));

      if (turnAction === "commit" && gitResult.commitMessage) {
        ctx.ui.notify(formatPostUnitStatusCard("✓ Commit", gitResult.commitMessage.split("\n")[0]), "info");
      } else if (turnAction === "snapshot" && gitResult.snapshotLabel) {
        ctx.ui.notify(formatPostUnitStatusCard("✓ Snapshot", gitResult.snapshotLabel), "info");
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    s.lastGitActionFailure = message;
    s.lastGitActionStatus = "failed";
    debugLog("postUnit", { phase: "git-action", error: message, action: turnAction });
    ctx.ui.notify(`Git ${turnAction} failed: ${message.split("\n")[0]}`, opts?.softFailure ? "warning" : "error");
    if (opts?.softFailure) {
      return "continue";
    }
    if (uokFlags.gitops) {
      await pauseAuto(ctx, pi);
      return "dispatched";
    }
  }

  return "continue";
}

/**
 * Pre-verification processing: parallel worker signal check, cache invalidation,
 * auto-commit, doctor run, state rebuild, worktree sync, artifact verification.
 *
 * Returns:
 * - "dispatched" — a signal caused stop/pause
 * - "continue" — proceed normally
 * - "retry" — artifact verification failed, s.pendingVerificationRetry set for loop re-iteration
 * - "evidence-xref-blocked" — blocking safety evidence mismatch; the Attempt was
 *   routed through the canonical recovery seam (s.lastSafetyBlockRecovery carries
 *   the recoveryActionId) and auto-mode paused. The finalize break must NOT enter
 *   the verified-task publication boundary (#1641 / #1642 / #1649).
 */
export async function postUnitPreVerification(pctx: PostUnitContext, opts?: PreVerificationOpts): Promise<PreVerificationResult> {
  const { s, ctx, pi, stopAuto, pauseAuto } = pctx;

  // ── Parallel worker signal check ──
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    const signal = consumeSignal(s.basePath, milestoneLock);
    if (signal) {
      if (signal.signal === "stop") {
        await stopAuto(ctx, pi);
        return "dispatched";
      }
      if (signal.signal === "pause") {
        // A worker `pause` is a *temporary* coordination request: the docs
        // contract (docs/user-docs/parallel-orchestration.md) is "finish current
        // unit, wait" followed by a matching `resume`. Only the interactive
        // dashboard runtime owns a resumer — unattended `gsd headless auto` does
        // not — so a terminal pauseAuto() here strands the worker at exit 10
        // (BLOCKED) after its first unit, with nothing able to lift it (#1273).
        // Wait for the coordinator to resume (or stop) us instead. If no resumer
        // lifts the pause within the window, degrade to in-process serialization
        // and continue the dispatch loop rather than halting the run forever.
        const resumeOutcome = await awaitWorkerResume(s.basePath, milestoneLock);
        if (resumeOutcome === "stop") {
          await stopAuto(ctx, pi);
          return "dispatched";
        }
        if (resumeOutcome === "timeout") {
          logWarning(
            "parallel",
            `pause signal for ${milestoneLock} was not resumed (no headless resumer, #1273); continuing dispatch`,
          );
        }
        // "resume" or "timeout": fall through and continue post-unit processing.
      }
    }
  }

  // Invalidate all caches
  invalidateAllCaches();

  // Small delay to let files settle (skipped for sidecars where latency matters more)
  if (!opts?.skipSettleDelay) {
    await new Promise(r => setTimeout(r, 100));
  }

  const dbPath = getWorkflowDatabasePath();
  if (isDbAvailable() && dbPath && dbPath !== ":memory:") {
    const refreshed = refreshWorkflowDatabaseFromDisk();
    if (!refreshed) {
      logWarning("db", "post-unit database refresh failed; derived state may be stale");
    }
  }

  // Turn-level git action (commit | snapshot | status-only)
  if (s.currentUnit) {
    const unit = s.currentUnit;
    if (shouldDeferCloseoutGitAction(unit.type)) {
      debugLog("postUnit", {
        phase: "git-action-deferred-until-verification",
        unitType: unit.type,
        unitId: unit.id,
      });
    } else {
      const gitActionResult = await runCloseoutGitAction(pctx, unit);
      if (gitActionResult === "dispatched") {
        return "dispatched";
      }
      if (gitActionResult === "retry") {
        return "retry";
      }
    }

    // Prune dead bg-shell processes
    await runSafely("postUnit", "prune-bg-shell", async () => {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    });

    // Tear down browser between units to prevent Chrome process accumulation (#1733)
    await runSafely("postUnit", "browser-teardown", async () => {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
        debugLog("postUnit", { phase: "browser-teardown", status: "closed" });
      }
    });

    // Keep the on-disk STATE.md aligned with the live derived state after
    // ordinary unit completion, before any worktree state is synced back.
    await runSafely("postUnit", "state-rebuild", async () => {
      await rebuildState(s.basePath);
    });

    // Sync worktree state back to project root (skipped for lightweight sidecars)
    if (!opts?.skipWorktreeSync && s.originalBasePath && !isSamePathLocal(s.originalBasePath, s.basePath)) {
      await runSafely("postUnit", "worktree-sync", () => {
        let scope = s.scope;
        if (!scope && s.currentMilestoneId) {
          try {
            scope = scopeMilestone(createWorkspace(s.basePath), s.currentMilestoneId);
          } catch {
            // Non-fatal: scope construction can fail on synthetic test paths;
            // skipping the projection mirrors the prior path-string variant's
            // early-return behaviour for missing milestone/path inputs.
            scope = null;
          }
        }
        if (scope) _worktreeProjection.projectWorktreeToRoot(scope);
      });
    }

    // Rewrite-docs completion
    if (s.currentUnit.type === "rewrite-docs") {
      await runSafely("postUnit", "rewrite-docs-resolve", async () => {
        // Detect abandon/descope overrides BEFORE resolving them (#3490).
        // If an override is about abandoning the milestone, park it so the
        // state engine skips it. Without this, rewrite-docs only edits
        // markdown but the DB still has the milestone as active.
        try {
          const { loadActiveOverrides } = await import("./files.js");
          const overrides = await loadActiveOverrides(s.basePath);
          const decision = detectAbandonMilestone(overrides, s.currentMilestoneId);
          if (decision.shouldPark && s.currentMilestoneId) {
            const { parkMilestone } = await import("./milestone-actions.js");
            const parked = parkMilestone(s.basePath, s.currentMilestoneId, decision.reason);
            if (parked) {
              ctx.ui.notify(`Milestone ${s.currentMilestoneId} parked: "${decision.reason}"`, "info");
            } else {
              // Park refused: milestone directory missing, milestone already
              // completed (SUMMARY present), or PARKED.md already exists.
              // resolveAllOverrides below will still consume the override —
              // surface this loudly so the user notices state drift rather
              // than silently losing the abandon directive.
              const msg = `Abandon detected for ${s.currentMilestoneId} but park refused (milestone is completed, already parked, or missing). Override will be resolved anyway — verify state is correct.`;
              logError("engine", msg);
              ctx.ui.notify(msg, "warning");
            }
          }
        } catch (err) {
          logError("engine", `abandon-detect failed: ${(err as Error).message}`);
          ctx.ui.notify(`Abandon detection failed — check logs. Overrides will still be resolved.`, "warning");
        }

        await resolveAllOverrides(s.basePath);
        // Reset both disk and in-memory counters. Disk counter is authoritative
        // (survives restarts); in-memory is kept in sync for the current session.
        const { setRewriteCount } = await import("./auto-dispatch.js");
        setRewriteCount(s.basePath, 0);
        s.rewriteAttemptCount = 0;
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      });
    }

    // Reactive state cleanup on slice completion
    if (s.currentUnit.type === "complete-slice") {
      await runSafely("postUnit", "reactive-state-cleanup", async () => {
        const { milestone: mid, slice: sid } = parseUnitId(unit.id);
        if (mid && sid) {
          const { clearReactiveState } = await import("./reactive-graph.js");
          clearReactiveState(s.basePath, mid, sid);
        }
      });

      // #4765 — slice-cadence collapse. When `git.collapse_cadence: "slice"`
      // is set, squash-merge the slice's commits from the milestone branch
      // onto main right here, so orphan risk shrinks from milestone-size to
      // slice-size. Only runs in worktree isolation mode — the feature needs
      // a milestone branch to squash from.
      let sliceMergeStopped = false;
      await runSafely("postUnit", "slice-cadence-merge", async () => {
        const prefsResult = loadEffectiveGSDPreferences(s.basePath);
        const prefs = prefsResult?.preferences;
        const { getCollapseCadence, mergeSliceToMain } = await import("./slice-cadence.js");
        if (getCollapseCadence(prefs) !== "slice") return;
        if (getIsolationMode(s.originalBasePath || s.basePath) !== "worktree") return;
        if (s.isolationDegraded) return;

        const projectRoot = s.originalBasePath || s.basePath;
        const { milestone: mid, slice: sid } = parseUnitId(unit.id);
        if (!mid || !sid) return;

        // Record the milestone start SHA before the first slice merge, so
        // resquashMilestoneOnMain has a target at milestone completion.
        // Resolve main branch dynamically — hard-coding "main" breaks repos
        // that use "master" or a custom default branch.
        if (!s.milestoneStartShas.has(mid)) {
          try {
            const { nativeDetectMainBranch } = await import("./native-git-bridge.js");
            const mainBranch = nativeDetectMainBranch(projectRoot);
            const { execFileSync } = await import("node:child_process");
            const sha = execFileSync("git", ["rev-parse", mainBranch], {
              cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8",
            }).trim();
            if (sha) s.milestoneStartShas.set(mid, sha);
          } catch (err) {
            logWarning("engine", `slice-cadence: failed to record milestone start SHA: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        try {
          const result = mergeSliceToMain(projectRoot, mid, sid);
          if (result.skipped) {
            logWarning("engine", `slice-cadence: merge skipped for ${sid} — ${result.skippedReason}`);
            return;
          }
          ctx.ui.notify(
            `slice-cadence: ${sid} merged to main (${result.durationMs}ms).`,
            "info",
          );
        } catch (err) {
          const { MergeConflictError } = await import("./git-service.js");
          if (err instanceof MergeConflictError) {
            ctx.ui.notify(
              `slice-cadence merge conflict in ${sid}: ${err.conflictedFiles.join(", ")}. ` +
              `Resolve manually on main and run \`/gsd auto\` to resume.`,
              "error",
            );
            // Stop auto AND signal the outer postUnit flow to exit early.
            // Without the flag, subsequent hooks (triage,
            // DB writes) would keep running against a conflicted main
            // checkout after the loop was already told to stop.
            await stopAuto(ctx, pi, `slice-merge-conflict on ${sid}`);
            sliceMergeStopped = true;
            return;
          }
          logError("engine", `slice-cadence merge failed for ${sid}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // Non-conflict failures (dirty main, rev-walk error, etc.) can
          // leave the checkout in an unexpected state. Stop auto-mode so
          // the next slice doesn't dispatch on top of it.
          await stopAuto(ctx, pi, `slice-merge-error on ${sid}`);
          sliceMergeStopped = true;
        }
      });
      // Exit early after stopAuto so the rest of post-unit processing
      // (triage, hook dispatch, DB writes) doesn't run
      // against a conflicted main checkout. Return "dispatched" to match
      // the convention used by other stop/pauseAuto paths in this function
      // (see signal handling earlier: stop/pause also return "dispatched").
      if (sliceMergeStopped) return "dispatched";
    }

    // Post-triage: execute actionable resolutions
    if (s.currentUnit.type === "triage-captures") {
      try {
        const { executeTriageResolutions } = await import("./triage-resolution.js");
        const state = await deriveState(s.canonicalProjectRoot);
        const mid = state.activeMilestone?.id ?? "";
        const sid = state.activeSlice?.id ?? "";

        // executeTriageResolutions handles defer milestone creation even
        // without an active milestone/slice (the "all milestones complete"
        // scenario from #1562). inject/replan/quick-task still require mid+sid.
        // Phase C: write to canonical project root. copyPlanningArtifacts
        // has been deleted, so triage writes land where readers consult.
        const triageResult = executeTriageResolutions(s.canonicalProjectRoot, mid, sid);

        if (triageResult.injected > 0) {
          ctx.ui.notify(
            `Triage: injected ${triageResult.injected} task${triageResult.injected === 1 ? "" : "s"} into ${sid} plan.`,
            "info",
          );
        }
        if (triageResult.replanned > 0) {
          ctx.ui.notify(
            `Triage: replan trigger written for ${sid} — next dispatch will enter replanning.`,
            "info",
          );
        }
        if (triageResult.deferredMilestones > 0) {
          ctx.ui.notify(
            `Triage: created ${triageResult.deferredMilestones} deferred milestone director${triageResult.deferredMilestones === 1 ? "y" : "ies"}.`,
            "info",
          );
        }
        if (triageResult.quickTasks.length > 0) {
          for (const qt of triageResult.quickTasks) {
            s.pendingQuickTasks.push(qt);
          }
          ctx.ui.notify(
            `Triage: ${triageResult.quickTasks.length} quick-task${triageResult.quickTasks.length === 1 ? "" : "s"} queued for execution.`,
            "info",
          );
        }
        for (const action of triageResult.actions) {
          logWarning("engine", `triage resolution: ${action}`);
        }
      } catch (err) {
        logError("engine", "triage resolution failed", { error: (err as Error).message });
      }
    }

    let blockingContentViolation: string | null = null;

    // ── Safety harness: post-unit validation ──
    try {
      const { loadEffectiveGSDPreferences } = await import("./preferences.js");
      const prefs = loadEffectiveGSDPreferences()?.preferences;
      const safetyConfig = resolveSafetyHarnessConfig(
        prefs?.safety_harness as Record<string, unknown> | undefined,
      );

      if (safetyConfig.enabled) {
        const { milestone: sMid, slice: sSid, task: sTid } = parseUnitId(s.currentUnit.id);

        // Evidence cross-reference (execute-task only)
        // Only compare against concrete command evidence persisted by the task
        // completion tool. A prose Verify field can be satisfied later by the
        // host verification gate, so it is not enough to accuse the unit.
        if (safetyConfig.evidence_cross_reference && s.currentUnit.type === "execute-task") {
          try {
            const actual = getEvidence();
            if (sMid && sSid && sTid && isDbAvailable()) {
              const attempt = readLatestTaskAttempt({
                milestoneId: sMid,
                sliceId: sSid,
                taskId: sTid,
              });
              if (isTaskAttemptAwaitingVerification(attempt)) {
                const claimedEvidence: ClaimedEvidence[] = getVerificationEvidence(sMid, sSid, sTid)
                  .map((row) => ({
                    command: row.command,
                    exitCode: row.exit_code,
                    verdict: row.verdict,
                    createdAt: row.created_at,
                  }))
                  .filter((row) => typeof row.command === "string" && row.command.trim().length > 0);
                const mismatches = crossReferenceEvidence(claimedEvidence, actual);

                for (const mismatch of mismatches) {
                  const logMessage = `evidence-xref: ${mismatch.reason}`;
                  if (mismatch.severity === "error") {
                    logError("safety", logMessage);
                  } else {
                    logWarning("safety", logMessage);
                  }
                }

                const missingCommandMismatches = mismatches.filter((mismatch) => (
                  mismatch.severity === "warning" && mismatch.actual === null
                ));
                if (missingCommandMismatches.length > 0) {
                  const entries = Array.isArray(opts?.agentEndMessages)
                    ? opts.agentEndMessages
                    : (ctx.sessionManager?.getEntries?.() ?? []);
                  const hasSessionExecutionCalls = _hasExecutionToolCallsInSessionForTest(entries);
                  if (hasSessionExecutionCalls) {
                    debugLog("postUnit", {
                      phase: "safety-evidence-xref",
                      taskId: sTid,
                      suppressedWarning: "evidence-empty-but-session-has-exec-calls",
                    });
                  } else {
                    logWarning("safety", `evidence mismatch: ${missingCommandMismatches.length} claimed command(s) not found in recorded execution calls`);
                    ctx.ui.notify(
                      `Safety: task ${sTid} claimed ${missingCommandMismatches.length} command(s) not found in recorded execution calls`,
                      "warning",
                    );
                  }
                }

                const blockingMismatch = mismatches.find((mismatch) => mismatch.severity === "error");
                if (blockingMismatch) {
                  // #1641 / #1649: a safety refusal must carry its sanctioned exit.
                  // Settle the withheld verdict and route the Attempt through the
                  // canonical recovery seam so a recoveryActionId exists, the
                  // awaiting-verification wedge ends, and the operator has a
                  // supported way out — instead of a pure read that replays the
                  // identical blocking pause on every resume.
                  let routed: EvidenceCrossReferenceBlockResult | null = null;
                  let routeFailure: string | null = null;
                  try {
                    routed = routeEvidenceCrossReferenceBlock({
                      attempt,
                      basePath: s.basePath,
                      mismatch: {
                        command: blockingMismatch.claimed.command,
                        claimedExitCode: blockingMismatch.claimed.exitCode,
                        actualExitCode: blockingMismatch.actual?.exitCode ?? null,
                        reason: blockingMismatch.reason,
                      },
                    });
                  } catch (routeError) {
                    routeFailure = routeError instanceof Error ? routeError.message : String(routeError);
                    debugLog("postUnit", {
                      phase: "safety-evidence-xref-route",
                      error: routeFailure,
                    });
                  }
                  const routePresentation = resolveEvidenceRoutePresentation(routed, routeFailure);
                  s.lastSafetyBlockRecovery = routePresentation.recovery;
                  // Clear the persisted evidence file on the blocked path too, so a
                  // retry cross-references fresh execution instead of replaying the
                  // same stale rows indefinitely (#1641).
                  try {
                    clearEvidenceFromDisk(s.basePath, sMid, sSid, sTid);
                  } catch (clearError) {
                    debugLog("postUnit", { phase: "safety-evidence-clear", error: String(clearError) });
                  }
                  const mismatchDetail =
                    `"${blockingMismatch.claimed.command.slice(0, 80)}" — ${blockingMismatch.reason}`;
                  ctx.ui.notify(
                    `Safety: task ${sTid} claimed passing verification that failed in recorded execution (${mismatchDetail}). ${routePresentation.exitInstruction}`,
                    "error",
                  );
                  // Commit the unit's work before pausing so the blocked Attempt
                  // is never resumed against an uncommitted tree (#1649). The
                  // Attempt is already settled and routed above, so a git
                  // closeout that pauses on its own still exits through the
                  // safety break reason carrying the recoveryActionId.
                  const gitActionResult = await runCloseoutGitAction(pctx, s.currentUnit);
                  if (gitActionResult === "dispatched") {
                    return "evidence-xref-blocked";
                  }
                  await pauseAuto(ctx, pi);
                  return "evidence-xref-blocked";
                }
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-evidence-xref", error: String(e) });
          }
        }

        // Content validation (plan-slice, plan-milestone)
        if (safetyConfig.content_validation) {
          try {
            const artifactPath = resolveArtifactForContent(s.currentUnit.type, s.currentUnit.id, s.basePath);
            const contentViolations = validateContent(s.currentUnit.type, artifactPath);
            for (const v of contentViolations) {
              if (v.severity === "error") {
                blockingContentViolation ??= v.reason;
                logError("safety", `content: ${v.reason}`);
                ctx.ui.notify(`Content validation: ${v.reason}`, "error");
              } else {
                logWarning("safety", `content: ${v.reason}`);
                ctx.ui.notify(`Content validation: ${v.reason}`, "warning");
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-content-validation", error: String(e) });
          }
        }

        // Clear persisted evidence file now that post-unit processing is complete
        // (Bug #4385 — prevents stale evidence from affecting retries of same unit ID).
        if (safetyConfig.evidence_collection && s.currentUnit.type === "execute-task" && sMid && sSid && sTid) {
          try {
            clearEvidenceFromDisk(s.basePath, sMid, sSid, sTid);
          } catch (e) {
            debugLog("postUnit", { phase: "safety-evidence-clear", error: String(e) });
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "safety-harness", error: String(e) });
    }

    // Artifact verification
    const verificationBasePath = s.currentUnit.workspaceRoot ?? s.basePath;
    let triggerArtifactVerified = false;
    let durableReceiptFailure: string | null = null;
    if (!s.currentUnit.type.startsWith("hook/")) {
      try {
        triggerArtifactVerified =
          isTaskExecutionReadyForHostVerification(s.currentUnit.type, s.currentUnit.id) ||
          verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, verificationBasePath);
        if (triggerArtifactVerified) {
          invalidateAllCaches();
        }
      } catch (e) {
        debugLog("postUnit", { phase: "artifact-verify", error: String(e) });
      }

      // Verify-after-write (#1714/#1761): a run-uat or validate-milestone unit
      // whose save never persisted is an explicit unit error, not a silent pass.
      if (
        triggerArtifactVerified &&
        (s.currentUnit.type === "run-uat" || s.currentUnit.type === "validate-milestone")
      ) {
        durableReceiptFailure = missingDurableSaveReceipt(s.currentUnit.type, s.currentUnit.id);
        if (durableReceiptFailure) {
          triggerArtifactVerified = false;
          debugLog("postUnit", {
            phase: "durable-save-receipt-missing",
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id,
            reason: durableReceiptFailure,
          });
        }
      }

      try {
        const repairedRoadmapProjection = await repairCompleteSliceRoadmapProjection(
          s.currentUnit.type,
          s.currentUnit.id,
          s.basePath,
        );
        if (repairedRoadmapProjection) {
          triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
          if (triggerArtifactVerified) {
            invalidateAllCaches();
          }
          debugLog("postUnit", {
            phase: "complete-slice-roadmap-projection-repaired",
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id,
          });
        }
      } catch (e) {
        debugLog("postUnit", { phase: "complete-slice-roadmap-projection-repair", error: String(e) });
      }

      // If verification failed, attempt to regenerate missing projection files
      // from DB data before giving up (e.g. research-slice produces PLAN from engine).
      if (!triggerArtifactVerified) {
        if (s.currentUnit.type === "complete-milestone") {
          try {
            const { milestone: mid } = parseUnitId(s.currentUnit.id);
            if (mid) {
              const settled = await isMilestoneCloseoutSettled(mid, verificationBasePath);
              if (settled) {
                triggerArtifactVerified = true;
                invalidateAllCaches();
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "artifact-verify-settle-db", error: String(e) });
          }
        }
      }

      if (
        !triggerArtifactVerified &&
        s.currentUnit.type === "validate-milestone" &&
        (
          agentEndMessagesIncludeSuccessfulToolResult(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesIncludeToolCall(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesMentionTool(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.basePath, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.canonicalProjectRoot, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          hasRoadmapReassessmentArtifact(s.basePath, parseUnitId(s.currentUnit.id).milestone) ||
          hasRoadmapReassessmentArtifact(s.canonicalProjectRoot, parseUnitId(s.currentUnit.id).milestone)
        )
      ) {
        const { milestone: mid } = parseUnitId(s.currentUnit.id);
        if (mid && (
          agentEndMessagesIncludeSuccessfulToolResult(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesMentionTool(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.basePath, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.canonicalProjectRoot, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          hasIncompleteMilestoneSlice(mid) ||
          hasRoadmapReassessmentArtifact(s.basePath, mid) ||
          hasRoadmapReassessmentArtifact(s.canonicalProjectRoot, mid)
        )) {
          triggerArtifactVerified = true;
          invalidateAllCaches();
          debugLog("postUnit", {
            phase: "validate-milestone-reassessment-invalidated-validation",
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id,
            milestoneId: mid,
          });
        }
      }

      if (!triggerArtifactVerified) {
        try {
          const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
          if (mid && sid && shouldAttemptPlanRegeneration(s.currentUnit.type, s.currentUnit.id)) {
            // Phase C: write to the canonical project root (#5236 scope)
            // so non-symlinked worktrees no longer maintain a separate
            // local .gsd/ projection. copyPlanningArtifacts has been
            // deleted; reads + writes converge at projectRoot.
            const regenerated = await regenerateIfMissing(s.canonicalProjectRoot, mid, sid, "PLAN");
            if (regenerated) {
              // Re-check after regeneration
              triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.canonicalProjectRoot);
              if (triggerArtifactVerified) {
                invalidateAllCaches();
              }
            }
          }
        } catch (e) {
          debugLog("postUnit", { phase: "regenerate-projection", error: String(e) });
        }
      }

      if (s.currentUnit.type === "research-project") {
        try {
          clearProjectResearchInflightMarker(s.basePath);
        } catch (e) {
          debugLog("postUnit", { phase: "research-project-inflight-cleanup", error: String(e) });
        }
      }

      if (
        !triggerArtifactVerified &&
        s.currentUnit.type === "validate-milestone" &&
        (
          agentEndMessagesIncludeSuccessfulToolResult(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesIncludeToolCall(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesMentionTool(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.basePath, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.canonicalProjectRoot, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          hasRoadmapReassessmentArtifact(s.basePath, parseUnitId(s.currentUnit.id).milestone) ||
          hasRoadmapReassessmentArtifact(s.canonicalProjectRoot, parseUnitId(s.currentUnit.id).milestone)
        )
      ) {
        const { milestone: mid } = parseUnitId(s.currentUnit.id);
        if (mid && (
          agentEndMessagesIncludeSuccessfulToolResult(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          agentEndMessagesMentionTool(opts?.agentEndMessages, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.basePath, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          unitActivityMentionsTool(s.canonicalProjectRoot, s.currentUnit.type, s.currentUnit.id, "gsd_reassess_roadmap") ||
          hasIncompleteMilestoneSlice(mid) ||
          hasRoadmapReassessmentArtifact(s.basePath, mid) ||
          hasRoadmapReassessmentArtifact(s.canonicalProjectRoot, mid)
        )) {
          triggerArtifactVerified = true;
          invalidateAllCaches();
          debugLog("postUnit", {
            phase: "validate-milestone-reassessment-invalidated-validation",
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id,
            milestoneId: mid,
          });
        }
      }

      if (!triggerArtifactVerified && s.currentUnit.type === "research-project") {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        const outcome = finalizeProjectResearchTimeout(
          verificationBasePath,
          "Project research unit ended before all required dimensions produced durable files.",
        );
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, verificationBasePath);
        if (triggerArtifactVerified) {
          invalidateAllCaches();
          ctx.ui.notify(
            outcome.kind === "partial-blockers"
              ? "Project research finished partially; wrote blockers for missing dimensions and advancing without rerunning all scouts."
              : "Project research artifacts are now terminal.",
            "warning",
          );
        } else {
          ctx.ui.notify(
            "Project research produced no usable research files; wrote PROJECT-RESEARCH-BLOCKER.md and continuing fail-closed.",
            "error",
          );
          return "continue";
        }
      }

      if (blockingContentViolation && triggerArtifactVerified) {
        triggerArtifactVerified = false;
        debugLog("postUnit", {
          phase: "content-validation-blocked-artifact",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          reason: blockingContentViolation,
        });
      }

      // When artifact verification fails for a unit type that has a known expected
      // artifact, ask the caller to retry so it re-dispatches with failure context
      // instead of blindly re-dispatching the same unit (#1571).
      // Retries are capped at MAX_ARTIFACT_VERIFICATION_RETRIES to prevent
      // unbounded loops (#2007).
      //
      // Pre-checks short-circuit retry for known-unrecoverable failures:
      // - User-input waits in deep setup: pause instead of retrying or writing
      //   placeholders while the agent is waiting for approval.
      // - Deterministic policy rejection (#4973): structural write-gate failure
      //   that will recur on every retry, so surface a blocker without retrying.
      // - DB infra failure (#2517): completion tool returned db_unavailable, so
      //   the artifact was never written. Retrying can never succeed.
      // - Tool invocation error (#2883/#3595): malformed JSON args or queued
      //   user message — retry will produce the same failure.
      // - DB-backed Tasks: Attempt, Result, Verdict, and Recovery rows own the
      //   recovery decision; this legacy artifact ladder must not compete.
      //   Exception (#2131): the durable authority never sees the tool
      //   invocation record, so a deterministic failure (e.g. a schema-rejected
      //   gsd_task_complete) would be cleared and retried with unchanged inputs
      //   until the liveness backstop wedges. The recorded #2883 classification
      //   fires before the clear; transient tool-unavailable errors still defer.
      //
      // User-driven deep setup prompts may ask for approval before the final
      // root artifact write. If a premature write hits the write gate in the
      // same turn, the user wait is the meaningful state; pause instead of
      // writing a placeholder over PROJECT/REQUIREMENTS.
      if (!triggerArtifactVerified && isDurableVerificationTask(s.currentUnit.type)) {
        // #2131: the durable authority never receives the invocation record, so
        // a deterministic failure recorded here must pause before the clear
        // below — otherwise it is retried with unchanged inputs until the
        // liveness backstop wedges. Other recorded classes (transient
        // tool-unavailable, deterministic policy gates, queued-user skips)
        // keep the deferral.
        const invocationError = s.lastToolInvocationError;
        if (
          invocationError
          && isToolInvocationError(invocationError)
          && !isDeterministicPolicyError(invocationError)
          && !isToolUnavailableError(invocationError)
        ) {
          debugLog("postUnit", { phase: "tool-invocation-error-pause", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: invocationError });
          ctx.ui.notify(toolInvocationPauseMessage(s.currentUnit.type, invocationError), "error");
          s.lastToolInvocationError = null;
          await pauseAuto(ctx, pi);
          return "dispatched";
        }
        const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
        if (s.pendingVerificationRetry?.unitId === s.currentUnit.id) {
          s.pendingVerificationRetry = null;
        }
        s.lastToolInvocationError = null;
        s.toolUnavailableRetries = 0;
        // Deliberately keep verificationRetryCount / verificationRetryFailureHashes:
        // the host verification gate's auto-fix counter shares this key and must
        // stay attempt-independent (per unit + failure). Deleting it here reset
        // the bound to "attempt 1/2" on every new Attempt, so exhaustion was
        // never visibly reached (#1971). The gate clears both itself on
        // pass/pause/abort.
        s.exhaustedVerificationUnits.delete(retryKey);
        saveCustomVerifyRetryCounts(s, {
          logFailure: err => debugLog("postUnit", {
            phase: "save-verify-retries-failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        });
        debugLog("postUnit", {
          phase: "task-artifact-recovery-deferred-to-durable-authority",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
        });
      } else if (!triggerArtifactVerified && USER_DRIVEN_DEEP_UNITS.has(s.currentUnit.type) && isAwaitingUserInput(opts?.agentEndMessages)) {
        debugLog("postUnit", {
          phase: "artifact-verify-awaiting-user",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
        });
        ctx.ui.notify(
          `${s.currentUnit.type} ${s.currentUnit.id} is waiting for your input — pausing auto-mode instead of retrying the missing artifact.`,
          "info",
        );
        s.lastToolInvocationError = null;
        await pauseAuto(ctx, pi);
        return "dispatched";
      } else if (!triggerArtifactVerified && getPendingGate(verificationBasePath)) {
        const pendingGateId = getPendingGate(verificationBasePath);
        debugLog("postUnit", {
          phase: "artifact-verify-pending-depth-gate",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          pendingGateId,
        });
        ctx.ui.notify(
          `${s.currentUnit.type} ${s.currentUnit.id} is waiting for depth confirmation (${pendingGateId}) — pausing auto-mode.`,
          "info",
        );
        s.lastToolInvocationError = null;
        await pauseAuto(ctx, pi);
        return "dispatched";
      } else if (!triggerArtifactVerified && s.lastToolInvocationError && isDeterministicPolicyError(s.lastToolInvocationError)) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        const planningBlocked = s.currentUnit.type === "plan-milestone";
        debugLog("postUnit", { phase: "deterministic-policy-error-placeholder", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError });
        const reason = `Deterministic policy rejection for ${s.currentUnit.type} "${s.currentUnit.id}": ${s.lastToolInvocationError}. Retrying cannot resolve this gate — ${planningBlocked ? "recording a fail-closed planning blocker" : "writing blocker placeholder to advance pipeline"}.`;
        s.lastToolInvocationError = null;
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        writeBlockerPlaceholder(s.currentUnit.type, s.currentUnit.id, s.basePath, reason);
        ctx.ui.notify(
          planningBlocked
            ? `${s.currentUnit.type} ${s.currentUnit.id} — deterministic policy rejection, recorded planning blocker and paused (no work marked complete)`
            : `${s.currentUnit.type} ${s.currentUnit.id} — deterministic policy rejection, wrote blocker placeholder (no retries)`,
          planningBlocked ? "error" : "warning",
        );
        if (planningBlocked) {
          await pauseAuto(ctx, pi);
          return "dispatched";
        }
        // Fall through to "continue" — do NOT enter the retry or db-unavailable paths.
      } else if (!triggerArtifactVerified && diagnoseWorktreeIntegrityFailure(verificationBasePath)) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        const worktreeFailure = diagnoseWorktreeIntegrityFailure(verificationBasePath)!;
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        debugLog("postUnit", {
          phase: "worktree-integrity-failure",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          basePath: verificationBasePath,
        });
        ctx.ui.notify(
          `${worktreeFailure} Retry ${s.currentUnit.id} after repair.`,
          "error",
        );
        await pauseAuto(ctx, pi);
        return "dispatched";
      } else if (
        !triggerArtifactVerified &&
        completeSliceReopenReplanHandoffDetected(s, opts?.agentEndMessages)
      ) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        debugLog("postUnit", {
          phase: "artifact-verify-complete-slice-handoff",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
        });
        ctx.ui.notify(
          `complete-slice ${s.currentUnit.id} intentionally handed off via reopen/replan; continuing orchestration instead of retrying closeout.`,
          "warning",
        );
        return "continue";
      } else if (
        !triggerArtifactVerified &&
        completeSliceValidReplanOutcomeDetected(s, opts?.agentEndMessages)
      ) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        debugLog("postUnit", {
          phase: "artifact-verify-complete-slice-replan-outcome",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
        });
        ctx.ui.notify(
          `complete-slice ${s.currentUnit.id} produced a valid replan outcome; continuing orchestration instead of retrying closeout.`,
          "warning",
        );
        return "continue";
      } else if (
        !triggerArtifactVerified &&
        !isDbAvailable() &&
        !completeSliceReplanSignalDetected(s, opts?.agentEndMessages)
      ) {
        debugLog("postUnit", { phase: "artifact-verify-skip-db-unavailable", unitType: s.currentUnit.type, unitId: s.currentUnit.id });
        const dbSkipDiag = diagnoseExpectedArtifact(s.currentUnit.type, s.currentUnit.id, verificationBasePath);
        ctx.ui.notify(
          `Artifact missing for ${s.currentUnit.type} ${s.currentUnit.id} — DB unavailable, skipping retry.${dbSkipDiag ? ` Expected: ${dbSkipDiag}` : ""}`,
          "error",
        );
      } else if (!triggerArtifactVerified) {
        if (s.lastToolInvocationError && isToolUnavailableError(s.lastToolInvocationError)) {
          // Tool-unavailable is transient: the workflow MCP server registers
          // its surface asynchronously, so a Unit's first call can race the
          // registration. Retry with escalating delay, bounded at 3 attempts.
          // ponytail: MAX constant so the guard, log, and display all agree
          const MAX_TOOL_UNAVAIL_RETRIES = 3;
          if (s.toolUnavailableRetries >= MAX_TOOL_UNAVAIL_RETRIES) {
            debugLog("postUnit", { phase: "tool-unavailable-exhausted", unitType: s.currentUnit.type, unitId: s.currentUnit.id, retries: s.toolUnavailableRetries });
            ctx.ui.notify(
              `Tool unavailable for ${s.currentUnit.type} after ${MAX_TOOL_UNAVAIL_RETRIES} retries: ${s.lastToolInvocationError}. MCP server may not be starting — pausing auto-mode.`,
              "error",
            );
            s.lastToolInvocationError = null;
            await pauseAuto(ctx, pi);
            return "dispatched";
          }
          s.toolUnavailableRetries++;
          // Exponential backoff starting at 10s (10s, 20s, 40s capped at 45s). MCP server
          // startup can take tens of seconds; a 1s/2s/3s linear delay re-dispatches before
          // the server finishes connecting, causing a stuck loop. See #817.
          const delayMs = Math.min(10_000 * Math.pow(2, s.toolUnavailableRetries - 1), 45_000);
          debugLog("postUnit", { phase: "tool-unavailable-retry", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError, attempt: s.toolUnavailableRetries, delayMs });
          ctx.ui.notify(
            `Tool unavailable for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Waiting ${delayMs}ms for MCP server — retry ${s.toolUnavailableRetries}/${MAX_TOOL_UNAVAIL_RETRIES}.`,
            "warning",
          );
          s.lastToolInvocationError = null;
          await new Promise(r => setTimeout(r, delayMs));
        } else if (s.lastToolInvocationError) {
          const isUserSkip = /queued user message/i.test(s.lastToolInvocationError);
          const errMsg = isUserSkip
            ? `Tool skipped for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Queued user message interrupted the turn — pausing auto-mode.`
            : toolInvocationPauseMessage(s.currentUnit.type, s.lastToolInvocationError);
          debugLog("postUnit", { phase: "tool-invocation-error-pause", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError });
          ctx.ui.notify(errMsg, "error");
          s.lastToolInvocationError = null;
          await pauseAuto(ctx, pi);
          return "dispatched";
        }

        const hasExpectedArtifact = resolveExpectedArtifactPath(s.currentUnit.type, s.currentUnit.id, verificationBasePath) !== null;
        if (hasExpectedArtifact) {
          const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
          const verificationFailureMarker = resolveVerificationFailureMarkerPath(s.currentUnit.type, s.currentUnit.id, s.basePath);
          if (verificationFailureMarker && existsSync(verificationFailureMarker)) {
            s.pendingVerificationRetry = null;
            s.verificationRetryCount.delete(retryKey);
            s.verificationRetryFailureHashes.delete(retryKey);
            debugLog("postUnit", {
              phase: "artifact-verify-failure-marker-detected",
              unitType: s.currentUnit.type,
              unitId: s.currentUnit.id,
              markerPath: verificationFailureMarker,
            });
            ctx.ui.notify(
              `${s.currentUnit.type} ${s.currentUnit.id} declined closeout (see ${relative(s.basePath, verificationFailureMarker)}). Pausing for human review.`,
              "error",
            );
            await pauseAuto(ctx, pi);
            return "dispatched";
          }
          const prefs = loadEffectiveGSDPreferences(s.canonicalProjectRoot)?.preferences;
          const perUnitCapUsd =
            typeof prefs?.per_unit_cost_cap_usd === "number" && Number.isFinite(prefs.per_unit_cost_cap_usd) && prefs.per_unit_cost_cap_usd > 0
              ? prefs.per_unit_cost_cap_usd
              : DEFAULT_PER_UNIT_COST_CAP_USD;
          const { unitCostUsd, rollingAvgUsd } = getCurrentUnitCostStats(s.currentUnit.id);
          if (unitCostUsd >= perUnitCapUsd) {
            s.pendingVerificationRetry = null;
            s.verificationRetryCount.delete(retryKey);
            s.verificationRetryFailureHashes.delete(retryKey);
            ctx.ui.notify(
              `Unit ${s.currentUnit.id} hit per-unit cap $${perUnitCapUsd.toFixed(2)} — pausing auto-mode.`,
              "error",
            );
            await pauseAuto(ctx, pi);
            return "dispatched";
          }
          if (getUnitCostSpikeAction(unitCostUsd, rollingAvgUsd, resolveUnitCostSpikeMultiplier(prefs)) === "pause") {
            const advancedPastUnit = await hasArtifactCostGuardAdvancedPastUnit(
              s,
              ctx,
              s.currentUnit.type,
              s.currentUnit.id,
              prefs,
            );
            if (advancedPastUnit) {
              s.pendingVerificationRetry = null;
              s.verificationRetryCount.delete(retryKey);
              s.verificationRetryFailureHashes.delete(retryKey);
              debugLog("postUnit", {
                phase: "artifact-cost-spike-continue-after-advance",
                unitType: s.currentUnit.type,
                unitId: s.currentUnit.id,
                unitCostUsd,
                rollingAvgUsd,
              });
              ctx.ui.notify(
                `Unit ${s.currentUnit.id} cost spike detected (${unitCostUsd.toFixed(2)} vs avg ${rollingAvgUsd.toFixed(2)}) after state advanced; continuing closeout.`,
                "warning",
              );
              return "continue";
            }
            const parallelBlocker = maybeWriteParallelResearchCostSpikeBlocker(
              s.currentUnit.type,
              s.currentUnit.id,
              verificationBasePath,
              unitCostUsd,
              rollingAvgUsd,
            );
            if (parallelBlocker) {
              s.pendingVerificationRetry = null;
              s.verificationRetryCount.delete(retryKey);
              s.verificationRetryFailureHashes.delete(retryKey);
              ctx.ui.notify(
                `Unit ${s.currentUnit.id} cost spike detected (${unitCostUsd.toFixed(2)} vs avg ${rollingAvgUsd.toFixed(2)}) — wrote parallel blocker and pausing auto-mode.`,
                "error",
              );
              await pauseAuto(ctx, pi);
              return "dispatched";
            }
            ctx.ui.notify(
              `Unit ${s.currentUnit.id} cost spike detected (${unitCostUsd.toFixed(2)} vs avg ${rollingAvgUsd.toFixed(2)}) during artifact verification retry; keeping verification failure as the authoritative blocker.`,
              "warning",
            );
          }
          const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
          // A missing durable save receipt names the artifact and the owning
          // save tool (#1761 O-4); everything else keeps the artifact ladder.
          const failureDetails = durableReceiptFailure ?? describeArtifactVerificationFailure(
            s.currentUnit.type,
            s.currentUnit.id,
            verificationBasePath,
            s.lastUnitAgentEndMessages,
          );
          if (attempt > MAX_ARTIFACT_VERIFICATION_RETRIES) {
            if (s.currentUnit.type === "reactive-execute") {
              const recovery = writeReactiveExecuteBlocker(
                s.currentUnit.id,
                verificationBasePath,
                failureDetails,
              );
              if (recovery) {
                s.pendingVerificationRetry = null;
                s.verificationRetryCount.delete(retryKey);
                s.verificationRetryFailureHashes.delete(retryKey);
                invalidateAllCaches();
                debugLog("postUnit", {
                  phase: "reactive-execute-blocker-recovery",
                  unitType: s.currentUnit.type,
                  unitId: s.currentUnit.id,
                  blockerPath: recovery.blockerPath,
                  completedTaskIds: recovery.completedTaskIds,
                  skippedTaskIds: recovery.skippedTaskIds,
                });
                ctx.ui.notify(
                  `${failureDetails} Wrote reactive blocker and advanced: ${recovery.completedTaskIds.length} complete, ${recovery.skippedTaskIds.length} skipped.`,
                  "warning",
                );
                return "continue";
              }
            }
            s.exhaustedVerificationUnits.add(retryKey);
            saveCustomVerifyRetryCounts(s, { logFailure: err => debugLog("postUnit", { phase: "save-verify-retries-failed", error: err instanceof Error ? err.message : String(err) }) });
            debugLog("postUnit", { phase: "artifact-verify-exhausted", unitType: s.currentUnit.type, unitId: s.currentUnit.id, attempt });
            ctx.ui.notify(
              `${failureDetails} Pausing auto-mode after ${MAX_ARTIFACT_VERIFICATION_RETRIES} retries.`,
              "error",
            );
            await pauseAuto(ctx, pi);
            return "dispatched";
          }
          s.verificationRetryCount.set(retryKey, attempt);
          saveCustomVerifyRetryCounts(s, { logFailure: err => debugLog("postUnit", { phase: "save-verify-retries-failed", error: err instanceof Error ? err.message : String(err) }) });
          s.pendingVerificationRetry = {
            unitId: s.currentUnit.id,
            failureContext: failureDetails,
            attempt,
          };
          debugLog("postUnit", { phase: "artifact-verify-retry", unitType: s.currentUnit.type, unitId: s.currentUnit.id, attempt });
          ctx.ui.notify(
            `${failureDetails} Retrying (attempt ${attempt}/${MAX_ARTIFACT_VERIFICATION_RETRIES}).`,
            "warning",
          );
          return "retry";
        }
      }

      // Verification succeeded — clear the retry counter so a future failure
      // of the same unit gets a full retry budget instead of the stale count.
      if (triggerArtifactVerified) {
        const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
        if (s.pendingVerificationRetry?.unitId === s.currentUnit.id) {
          s.pendingVerificationRetry = null;
        }
        s.toolUnavailableRetries = 0;
        // For a DB-backed execute-task, artifact readiness only proves the
        // Attempt staged a Result at the verify stage — the host verification
        // gate has not run yet. Its auto-fix retry counter shares this key and
        // must stay attempt-independent (per unit + failure): every
        // gsd_task_complete creates a NEW Attempt, so clearing here reset the
        // bound to "attempt 1/2" on each retry and exhaustion was never
        // visibly reached (#1971). The gate clears both on pass/pause/abort.
        if (!isDurableVerificationTask(s.currentUnit.type)) {
          s.verificationRetryCount.delete(retryKey);
          s.verificationRetryFailureHashes.delete(retryKey);
        }
        s.exhaustedVerificationUnits.delete(retryKey);
        saveCustomVerifyRetryCounts(s, { logFailure: err => debugLog("postUnit", { phase: "save-verify-retries-failed", error: err instanceof Error ? err.message : String(err) }) });

        if (s.currentUnit.type === "complete-milestone") {
          const { milestone: mid } = parseUnitId(s.currentUnit.id);
          if (mid) {
            await runMilestoneCloseoutGitHub(s.basePath, mid);
          }
        }
      }
    } else {
      // Hook unit completed — no additional processing needed
    }
  }

  if (s.currentUnit && !s.currentUnit.type.startsWith("hook/")) {
    await runPostUnitGitHubSyncIfNeeded(s.basePath, s.currentUnit);
  }

  return "continue";
}

/**
 * Post-verification processing: DB dual-write, post-unit hooks, triage
 * capture dispatch, quick-task dispatch.
 *
 * Sidecar work (hooks, triage, quick-tasks) is enqueued on `s.sidecarQueue`
 * for the main loop to drain via `runUnit()`.
 *
 * Returns:
 * - "continue" — proceed to sidecar drain / normal dispatch
 * - "step-wizard" — step mode, show wizard instead
 * - "retry" — verification/pre-execution/git remediation failed; retry the unit with injected failure context
 * - "stopped" — stopAuto/pauseAuto was called
 */
export async function postUnitPostVerification(pctx: PostUnitContext): Promise<"continue" | "step-wizard" | "retry" | "stopped"> {
  const { s, ctx, pi, buildSnapshotOpts, lockBase, stopAuto, pauseAuto, updateProgressWidget } = pctx;

  if (s.currentUnit) {
    if (shouldDeferCloseoutGitAction(s.currentUnit.type)) {
      const headBeforeCloseout = readCommittedHeadSha(s.basePath);
      const gitActionResult = await runCloseoutGitAction(pctx, s.currentUnit, { softFailure: true });
      if (gitActionResult === "dispatched") {
        return "stopped";
      }
      if (gitActionResult === "retry") {
        return "retry";
      }
      if (
        recaptureVerifiedSourceAfterDeferredCloseout({
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          basePath: s.basePath,
        }) === "retry"
      ) {
        return "retry";
      }
      try {
        const prefs = loadEffectiveGSDPreferences()?.preferences;
        const safetyConfig = resolveSafetyHarnessConfig(
          prefs?.safety_harness as Record<string, unknown> | undefined,
        );
        if (safetyConfig.enabled && safetyConfig.file_change_validation) {
          const fileChangeAllowlist = effectiveFileChangeAllowlist(
            safetyConfig.file_change_allowlist,
            (prefs?.git as { manage_gitignore?: boolean } | undefined)?.manage_gitignore,
          );
          runExecuteTaskFileChangeSafety(s, ctx, fileChangeAllowlist, headBeforeCloseout);
        }
      } catch (e) {
        debugLog("postUnit", { phase: "safety-file-change", error: String(e) });
      }
    }

    try {
      const codebasePrefs = loadEffectiveGSDPreferences()?.preferences?.codebase;
      const refresh = ensureCodebaseMapFresh(
        s.basePath,
        codebasePrefs
          ? {
              excludePatterns: codebasePrefs.exclude_patterns,
              maxFiles: codebasePrefs.max_files,
              collapseThreshold: codebasePrefs.collapse_threshold,
            }
          : undefined,
        { force: true, ttlMs: 0 },
      );
      if (refresh.status === "generated" || refresh.status === "updated") {
        debugLog("postUnit", {
          phase: "codebase-refresh",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          status: refresh.status,
          fileCount: refresh.fileCount,
          reason: refresh.reason,
        });
      }
    } catch (e) {
      logWarning("engine", `CODEBASE refresh failed: ${(e as Error).message}`);
    }
  }

  // ── Post-unit hooks ──
  // A `criticality: blocking` hook is a gate, not a side effect: it must
  // complete — or pause for manual recovery — before the next unit is
  // selected, in auto mode and step mode alike (#2194). Step mode skips
  // non-blocking hooks, so it dispatches with a blocking-only filter.
  if (s.currentUnit) {
    // Persist while a synchronously-set gate block is still pending so the
    // pause is durable: resume restores the block and re-arms the blocked
    // hook instead of selecting past the failed gate (#2194).
    const hookUnit = checkPostUnitHooks(s.currentUnit.type, s.currentUnit.id, s.basePath, { blockingOnly: s.stepMode });
    persistHookState(s.basePath);
    if (hookUnit) {
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }

      return enqueueSidecar(
        s, ctx,
        { kind: "hook", unitType: hookUnit.unitType, unitId: hookUnit.unitId, prompt: hookUnit.prompt, model: hookUnit.model },
        { hookName: hookUnit.hookName },
      );
    }

    const hookFailure = consumeHookFailure();
    if (hookFailure) {
      ctx.ui.notify(
        `Post-unit hook ${hookFailure.hookName} failed for ${hookFailure.unitId}: ${hookFailure.reason}. Pausing auto-mode.`,
        "warning",
      );
      await pauseAuto(ctx, pi);
      return "stopped";
    }

    if (await handlePendingHookOutcome(pctx)) return "stopped";
  }

  // ── Fast-path stop detection (#3487) ──
  // Before waiting for triage, check if any PENDING captures contain explicit
  // stop/halt language. If so, pause immediately — don't wait for triage.
  if (s.currentUnit && s.currentUnit.type !== "triage-captures") {
    try {
      const pending = loadPendingCaptures(s.basePath);
      // Match only when the capture text starts with a stop/halt directive word,
      // or the entire text is short and dominated by such a word. This avoids
      // false positives on captures like "add a pause button" or "stop the timer
      // from re-rendering" — those are feature descriptions, not halt directives.
      const STOP_PATTERN = /^(stop|halt|abort|don'?t continue|pause|cease)\b/i;
      const stopCapture = pending.find(c => STOP_PATTERN.test(c.text.trim()));
      if (stopCapture) {
        ctx.ui.notify(
          `Stop directive detected in pending capture ${stopCapture.id}: "${stopCapture.text}" — pausing auto-mode.`,
          "warning",
        );
        debugLog("postUnit", { phase: "fast-stop", captureId: stopCapture.id });
        await pauseAuto(ctx, pi);
        return "stopped";
      }
    } catch (e) {
      debugLog("postUnit", { phase: "fast-stop-error", error: String(e) });
    }
  }

  // ── Capture protection: revert executor-silenced captures (#3487) ──
  // Non-triage agents can write **Status:** resolved to CAPTURES.md, bypassing
  // the triage pipeline. Revert those to pending before the triage check.
  if (
    s.currentUnit &&
    s.currentUnit.type !== "triage-captures"
  ) {
    try {
      const reverted = revertExecutorResolvedCaptures(s.basePath);
      if (reverted > 0) {
        debugLog("postUnit", { phase: "capture-protection", reverted });
        ctx.ui.notify(
          `Reverted ${reverted} capture${reverted === 1 ? "" : "s"} silenced by executor — re-queuing for triage.`,
          "warning",
        );
      }
    } catch (e) {
      debugLog("postUnit", { phase: "capture-protection-error", error: String(e) });
    }
  }

  // ── Pre-execution checks (after plan-slice or ADR-011 refine-slice completes) ──
  // Both emit the same PLAN.md + task artifacts via gsd_plan_slice, so the
  // same structural validation applies to both.
  if (
    s.currentUnit &&
    (s.currentUnit.type === "plan-slice" || s.currentUnit.type === "refine-slice")
  ) {
    const currentUnit = s.currentUnit;
    const preExecPost = { action: "none" as "none" | "retry" | "pause" };
    await runSafely("postUnitPostVerification", "pre-execution-checks", async () => {
      const prefs = loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);
      try {
        // Check preferences — respect enhanced_verification and enhanced_verification_pre
        const enhancedEnabled = prefs?.enhanced_verification !== false; // default true
        const preEnabled = prefs?.enhanced_verification_pre !== false;  // default true

        if (!enhancedEnabled || !preEnabled) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "disabled by preferences",
          });
          return;
        }

        // Parse the unit ID to get milestone/slice IDs
        const { milestone: mid, slice: sid } = parseUnitId(currentUnit.id);
        if (!mid || !sid) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "could not parse milestone/slice from unit ID",
          });
          return;
        }

        // Get tasks for this slice from DB
        const tasks = getSliceTasks(mid, sid);
        if (tasks.length === 0) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "no tasks found for slice",
          });
          return;
        }

        const strictMode = prefs?.enhanced_verification_strict === true;

        // Run pre-execution checks against s.basePath — the actual checkout
        // where prior-slice files were created.  In worktree isolation,
        // s.canonicalProjectRoot is the project root and lacks files that a
        // prior slice wrote to the worktree but hasn't merged to main yet.
        const preExecutionBasePath = s.basePath;
        const result: PreExecutionResult = await runPreExecutionChecks(tasks, preExecutionBasePath, {
          canonicalProjectRoot: s.canonicalProjectRoot,
        });

        // Log summary to stderr in existing verification output format
        const emoji = result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
        process.stderr.write(
          `gsd-pre-exec: ${emoji} Pre-execution checks ${result.status} for ${mid}/${sid} (${result.durationMs}ms)\n`,
        );

        // Log individual check results
        for (const check of result.checks) {
          const checkEmoji = check.passed ? "✓" : check.blocking ? "✗" : "⚠";
          process.stderr.write(
            `gsd-pre-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}\n`,
          );
        }

        // Write evidence JSON to slice artifacts directory
        const slicePath = resolveSlicePath(s.canonicalProjectRoot, mid, sid);
        const evidenceFileName = `${sid}-PRE-EXEC-VERIFY.json`;
        let evidencePath = join(relSlicePath(s.canonicalProjectRoot, mid, sid), evidenceFileName);
        if (slicePath) {
          writePreExecutionEvidence(result, slicePath, mid, sid);
          evidencePath = relative(s.canonicalProjectRoot, join(slicePath, evidenceFileName)) || evidenceFileName;
        }

        if (uokFlags.gates) {
          const failedChecks = result.checks
            .filter((check) => !check.passed)
            .map((check) => `[${check.category}] ${check.target}: ${check.message}`);
          const warnEscalated = result.status === "warn" && strictMode;
          const blockingFailure = result.status === "fail" || warnEscalated;
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "pre-execution-checks",
            type: "input",
            execute: async () => ({
              outcome: blockingFailure ? "fail" : "pass",
              failureClass: result.status === "fail" ? "input" : warnEscalated ? "policy" : "none",
              rationale: blockingFailure
                ? `pre-execution checks ${result.status}${warnEscalated ? " (strict)" : ""}`
                : "pre-execution checks passed",
              findings: failedChecks.join("\n"),
            }),
          });
          await gateRunner.run("pre-execution-checks", {
            basePath: s.basePath,
            traceId: `pre-execution:${currentUnit.id}`,
            turnId: currentUnit.id,
            milestoneId: mid,
            sliceId: sid,
            unitType: currentUnit.type,
            unitId: currentUnit.id,
          });
        }

        const beginPreExecRepair = (
          checks: PreExecutionCheckJSON[],
          verdictExcerpt: string,
          heading: string,
        ): "retry" | "pause" => {
          const findings = checks.map(formatPreExecutionFinding);
          const details = checks.slice(0, MAX_NOTIFICATION_DETAILS).map(formatPreExecutionCheckDetail).join("\n");
          const suffix = checks.length > MAX_NOTIFICATION_DETAILS
            ? `\n  ${NOTIFICATION_BULLET} ...and ${checks.length - MAX_NOTIFICATION_DETAILS} more`
            : "";
          const evidenceNote = `\nSee ${evidencePath} for full details.`;
          const retryKey = currentUnit.id;
          const attempt = (s.preExecRetryCount.get(retryKey) ?? 0) + 1;

          s.lastPreExecFailure = {
            unitId: currentUnit.id,
            blockingFindings: findings,
            verdictExcerpt,
          };
          s.preExecRetryCount.set(retryKey, attempt);

          if (attempt >= MAX_PRE_EXEC_RETRIES) {
            s.pendingVerificationRetry = null;
            ctx.ui.notify(
              `${heading}\n${details}${suffix}${evidenceNote}\nPlanner repair failed after ${attempt} consecutive pre-exec failures; pausing for human review.`,
              "error",
            );
            return "pause";
          }

          s.pendingVerificationRetry = {
            unitId: currentUnit.id,
            failureContext: formatPreExecutionRetryContext({
              unitType: currentUnit.type,
              unitId: currentUnit.id,
              verdictExcerpt,
              checks,
              evidencePath,
            }),
            attempt,
          };
          ctx.ui.notify(
            `${heading}\n${details}${suffix}${evidenceNote}\nRetrying planning with this failure context.`,
            "warning",
          );
          return "retry";
        };

        // Notify UI — surface actionable details (#4259)
        if (result.status === "fail") {
          const blockingChecks = result.checks.filter(c => !c.passed && c.blocking);
          const blockingCount = blockingChecks.length;
          preExecPost.action = beginPreExecRepair(
            blockingChecks,
            `status=${result.status}; ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} detected`,
            `Pre-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found`,
          );
        } else if (result.status === "warn") {
          // Strict mode: treat warnings as blocking
          if (prefs?.enhanced_verification_strict === true) {
            const warnChecks = result.checks.filter(c => !c.passed);
            preExecPost.action = beginPreExecRepair(
              warnChecks,
              `status=${result.status} (strict mode); ${warnChecks.length} warning${warnChecks.length === 1 ? "" : "s"} treated as blocking`,
              `Pre-execution warnings blocked execution in strict mode: ${warnChecks.length} warning${warnChecks.length === 1 ? "" : "s"} found`,
            );
          } else {
            ctx.ui.notify(
              `Pre-execution checks passed with warnings`,
              "warning",
            );
          }
        }

        // Reset the retry counter once checks are non-blocking. A successful
        // repair should not make a later unrelated failure hit the cap early.
        if (preExecPost.action === "none") {
          s.preExecRetryCount.delete(currentUnit.id);
          if (s.lastPreExecFailure?.unitId === currentUnit.id) {
            s.lastPreExecFailure = null;
          }
        }

        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          status: result.status,
          checkCount: result.checks.length,
          durationMs: result.durationMs,
        });
      } catch (preExecError) {
        // Fail-closed: if runPreExecutionChecks throws, pause auto-mode instead of silently continuing
        const errorMessage = preExecError instanceof Error ? preExecError.message : String(preExecError);
        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          error: errorMessage,
          failClosed: true,
        });
        logError("engine", `gsd-pre-exec: Pre-execution checks threw an error: ${errorMessage}`);
        ctx.ui.notify(
          `Pre-execution checks error: ${errorMessage} — pausing for human review`,
          "error",
        );
        if (uokFlags.gates && s.currentUnit) {
          const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "pre-execution-checks",
            type: "input",
            execute: async () => ({
              outcome: "manual-attention",
              failureClass: "manual-attention",
              rationale: "pre-execution checks threw before completion",
              findings: errorMessage,
            }),
          });
          await gateRunner.run("pre-execution-checks", {
            basePath: s.basePath,
            traceId: `pre-execution:${s.currentUnit.id}`,
            turnId: s.currentUnit.id,
            milestoneId: mid ?? undefined,
            sliceId: sid ?? undefined,
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id,
          });
        }
        preExecPost.action = "pause";
      }
    });

    // Check for blocking failures after runSafely completes
    if (preExecPost.action === "retry") {
      debugLog("postUnitPostVerification", {
        phase: "pre-execution-checks",
        retrying: true,
        reason: "planner-owned failures detected",
      });
      return "retry";
    }
    if (preExecPost.action === "pause") {
      debugLog("postUnitPostVerification", {
        phase: "pre-execution-checks",
        pausing: true,
        reason: "pre-execution repair exhausted or checker errored",
      });
      await pauseAuto(ctx, pi);
      return "stopped";
    }
  }

  // ── Triage check ──
  if (_shouldDispatchTriageForTest(s)) {
    try {
      if (hasPendingCaptures(s.basePath)) {
        const pending = loadPendingCaptures(s.basePath);
        if (pending.length > 0) {
          const readRoot = s.canonicalProjectRoot;
          const state = await deriveState(readRoot);
          const mid = state.activeMilestone?.id;
          const sid = state.activeSlice?.id;

          if (mid && sid) {
            let currentPlan = "";
            let roadmapContext = "";
            const planFile = resolveSliceFile(readRoot, mid, sid, "PLAN");
            if (planFile) currentPlan = (await loadFile(planFile)) ?? "";
            const roadmapFile = resolveMilestoneFile(readRoot, mid, "ROADMAP");
            if (roadmapFile) roadmapContext = (await loadFile(roadmapFile)) ?? "";

            const capturesList = pending.map(c =>
              `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
            ).join("\n");

            const prompt = loadPrompt("triage-captures", {
              pendingCaptures: capturesList,
              currentPlan: currentPlan || "(no active slice plan)",
              roadmapContext: roadmapContext || "(no active roadmap)",
            });

            if (s.currentUnit) {
              await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
            }

            const triageUnitId = `${mid}/${sid}/triage`;
            return enqueueSidecar(
              s, ctx,
              { kind: "triage", unitType: "triage-captures", unitId: triageUnitId, prompt },
              { pendingCount: pending.length },
              `Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`,
            );
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "triage-check", error: String(e) });
    }
  }

  // ── Quick-task dispatch ──
  if (_shouldDispatchQuickTaskForTest(s)) {
    try {
      const capture = s.pendingQuickTasks.shift()!;
      const { buildQuickTaskPrompt } = await import("./triage-resolution.js");
      const { markCaptureExecuted } = await import("./captures.js");
      const prompt = buildQuickTaskPrompt(capture);

      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
      }

      markCaptureExecuted(s.basePath, capture.id);

      const qtUnitId = `${s.currentMilestoneId}/${capture.id}`;
      return enqueueSidecar(
        s, ctx,
        { kind: "quick-task", unitType: "quick-task", unitId: qtUnitId, prompt, captureId: capture.id },
        { captureId: capture.id },
        `Executing quick-task: ${capture.id} — "${capture.text}"`,
      );
    } catch (e) {
      debugLog("postUnit", { phase: "quick-task-dispatch", error: String(e) });
    }
  }

  // Step mode → show wizard instead of dispatch.
  // Without this notify(), /gsd next finishes a unit and silently exits the
  // loop, leaving the user with no next-step command.
  if (s.stepMode) {
    let phaseAfterUnit: string | null = null;
    try {
      const nextState = await deriveState(s.canonicalProjectRoot);
      phaseAfterUnit = nextState.phase;
      const message = setStepCompleteSurface(ctx, nextState, s.currentUnit);
      if (message) ctx.ui.notify(message, "info");
    } catch (e) {
      debugLog("postUnit", { phase: "step-wizard-notify", error: String(e) });
      ctx.ui.notify(setStepCompleteFallbackSurface(ctx, s.currentUnit), "info");
    }
    return shouldReturnStepWizardAfterUnit(s.currentUnit?.type, phaseAfterUnit)
      ? "step-wizard"
      : "continue";
  }

  return "continue";
}
