// Project/App: gsd-pi
// File Purpose: Auto-loop unit execution phase.

import { importExtensionModule } from "@gsd/pi-coding-agent";
import type { SidecarItem, AutoSession } from "./session.js";
import { resetEvidence, loadEvidenceFromDisk } from "../safety/evidence-collector.js";
import { captureRootDirtySnapshot } from "../root-write-leak-guard.js";
import {
  USER_DRIVEN_DEEP_UNITS,
  isAwaitingUserInput,
} from "../auto-post-unit.js";
import { lastAssistantText } from "../consent-question.js";
import { classifyProject } from "../detection.js";
import { debugLog } from "../debug-logger.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.js";
import { join } from "node:path";
import { logWarning, _resetLogs } from "../workflow-logger.js";
import {
  verifyExpectedArtifact,
  diagnoseExpectedArtifact,
  buildLoopRemediationSteps,
  refreshRecoveryDbForArtifact,
} from "../auto-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { isDbAvailable, getTask } from "../gsd-db.js";
import { getLatestForUnit } from "../db/unit-dispatches.js";
import { markWorkerStopping } from "../db/auto-workers.js";
import { releaseMilestoneLease } from "../db/milestone-leases.js";
import type { MinimalModelRegistry } from "../context-budget.js";
import { parseUnitId } from "../unit-id.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint } from "../safety/git-checkpoint.js";
import { resolveSafetyHarnessConfig } from "../safety/safety-harness.js";
import { getUnitWorkflowDispatchReadinessErrorForModel } from "../tool-contract.js";
import { prepareWorkflowMcpForProject } from "../workflow-mcp-auto-prep.js";
import {
  applyThinkingLevelForModel,
  floorThinkingLevelForUnit,
} from "../auto-model-selection.js";
import { isSuspiciousGhostCompletion } from "../auto-unit-closeout.js";
import { classifyError, isTransient } from "../error-classifier.js";
import { setCurrentPhase, clearCurrentPhase } from "../../shared/gsd-phase-state.js";
import { setAutoActiveStatus } from "../auto-dashboard.js";
import { runUnit } from "./run-unit.js";
import { verificationRetryKey } from "./verification-retry-policy.js";
import { validateSourceWriteWorktreeSafety } from "./worktree-safety-phase.js";
import { isTaskExecutionReadyForHostVerification } from "./task-execution-cutover.js";
import {
  isIsolatedWorktreeSession,
  _resolveCurrentUnitStartedAtForTest,
  emitCancelledUnitEnd,
  _buildCancelledUnitStopReason,
  _isPauseOriginCancelledResult,
  rememberRetryDispatch,
} from "./phase-helpers.js";
import type { IterationContext, IterationData, LoopState, PhaseResult } from "./types.js";
import { MAX_RECOVERY_CHARS } from "./types.js";

const ZERO_TOOL_PROVIDER_ERROR_PREFIX_RE =
  /^(?:api error(?::|$|\s*\()|provider error(?::|$|\s*\()|request failed\b|(?:http\s*)?(?:429|500|502|503)\b|\b(?:econnreset|etimedout|econnrefused|epipe)\b|socket hang up\b|fetch failed\b|(?:network|connection|server) error(?::|$)|connection (?:reset|refused)(?::|$|\s+by\b)|dns\b.*(?:fail|error|timeout)|unexpected eof\b|stream idle timeout\b|partial response received\b|stream_exhausted\b|terminated(?::|$)|(?:connection|stream|request)\b.{0,40}\bterminated\b|other side closed\b|rate.?limit(?:ed| exceeded| reached| error)|too many requests\b|you(?:'ve| have) (?:hit|reached) your (?:\w+ )?limit\b|.*\b(?:usage|session|weekly|daily|monthly|quota) limit\b|limit\b.{0,40}\bresets?\b|out of extra usage\b|service.?unavailable\b|internal(?: server)? error(?::|$)|internal(?:[_-]server)?[_-]error\b|server[_-]error\b|(?:provider|server|api|model|codex|claude|openai|anthropic|gemini)\b.{0,80}\boverloaded\b|overloaded\b.{0,80}\b(?:provider|server|api|model)\b|context (?:window|length) exceed|context window exceed)/i;
const ZERO_TOOL_PROVIDER_ERROR_SIGNAL_RE =
  /(?:\b(?:http|status(?: code)?|code|error:)\s*(?:429|500|502|503)\b|\b(?:api|provider) error\s*[:(]?\s*(?:429|500|502|503)\b|\b(?:typeerror|error):\s*(?:fetch failed\b|socket hang up\b|terminated(?::|$)|connection (?:reset|refused)(?::|$|\s+by\b)|(?:network|connection|server) error(?::|$)|stream idle timeout\b|partial response received\b|unexpected eof\b)|\b(?:server_error|api_error|stream_exhausted(?:_without_result)?)\b|\b(?:econnreset|etimedout|econnrefused|epipe)\b|context (?:window|length) exceed|context window exceed)/i;
const ZERO_TOOL_PSEUDO_TOOL_CALL_RE =
  /<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>[\s\S]*?<\/tool_call>/i;
const ZERO_TOOL_PSEUDO_TOOL_CALL_SNIPPET_CHARS = 200;

function zeroToolMessageSnippet(message: string): string {
  const compact = message.trim().replace(/\s+/g, " ");
  if (compact.length <= ZERO_TOOL_PSEUDO_TOOL_CALL_SNIPPET_CHARS) return compact;
  return `${compact.slice(0, ZERO_TOOL_PSEUDO_TOOL_CALL_SNIPPET_CHARS - 3)}...`;
}

// Provider serialization drift: the model emitted a tool call as plain assistant
// text (`toolName<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`)
// instead of a structured tool call. Returns an operator-visible snippet when
// detected. Kept separate from error classification so a drift snippet is never
// conflated with an ErrorClass (which would force a fragile union whose
// narrowing the root and extensions tsconfigs disagree on).
function zeroToolPseudoToolCallSnippet(message: string): string | null {
  if (!ZERO_TOOL_PSEUDO_TOOL_CALL_RE.test(message)) return null;
  return zeroToolMessageSnippet(message);
}

function classifyZeroToolProviderMessage(message: string): ReturnType<typeof classifyError> | null {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (
    !firstLine ||
    (!ZERO_TOOL_PROVIDER_ERROR_PREFIX_RE.test(firstLine) &&
      !ZERO_TOOL_PROVIDER_ERROR_SIGNAL_RE.test(firstLine))
  ) return null;
  return classifyError(firstLine);
}

export const _classifyZeroToolProviderMessageForTest = classifyZeroToolProviderMessage;
export const _zeroToolPseudoToolCallSnippetForTest = zeroToolPseudoToolCallSnippet;

export function resolveDispatchRecoveryAttempts(
  unitRecoveryCount: Map<string, number>,
  unitType: string,
  unitId: string,
): number | undefined {
  return (unitRecoveryCount.get(`${unitType}/${unitId}`) ?? 0) > 0
    ? 0
    : undefined;
}

export function _shouldProceedWithInvalidRepoClassificationForTest(
  reason: string | undefined,
  hasGit: boolean,
): boolean {
  return reason === "missing .git" && hasGit;
}

function observeTaskPlan(s: AutoSession, unitType: string, unitId: string): void {
  if (unitType !== "execute-task") return;
  const { milestone, slice, task } = parseUnitId(unitId);
  if (!milestone || !slice || !task || !isDbAvailable()) return;
  try {
    const taskRow = getTask(milestone, slice, task);
    if (taskRow) s.sourceObservations.observePlanTask(taskRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning("prompt", `failed to preload source observations for ${unitId}: ${message}`);
  }
}

export function restoreTaskHostVerificationContext(
  ic: Pick<IterationContext, "s" | "prefs">,
  unitType: string,
  unitId: string,
): void {
  const { s, prefs } = ic;
  s.setCurrentUnit({
    type: unitType,
    id: unitId,
    startedAt: Date.now(),
    workspaceRoot: s.basePath,
  });
  observeTaskPlan(s, unitType, unitId);
  s.rootWriteBaseline = isIsolatedWorktreeSession(s)
    ? captureRootDirtySnapshot(s.originalBasePath)
    : null;

  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness as Record<string, unknown> | undefined,
  );
  if (!safetyConfig.enabled || !safetyConfig.evidence_collection) return;
  resetEvidence();
  const { milestone, slice, task } = parseUnitId(unitId);
  if (milestone && slice && task) {
    loadEvidenceFromDisk(s.basePath, milestone, slice, task);
  }
}

// ─── Session timeout auto-resume state ────────────────────────────────────────

let consecutiveSessionTimeouts = 0;
const MAX_SESSION_TIMEOUT_AUTO_RESUMES = 3;
/** Maximum zero-tool-call retries before pausing — context exhaustion is deterministic. */
const MAX_ZERO_TOOL_RETRIES = 1;

export function resetSessionTimeoutState(): void {
  consecutiveSessionTimeouts = 0;
}

/**
 * Phase 4: Unit execution — dispatch prompt, await agent_end, closeout, artifact verify.
 * Returns break or next with unitStartedAt for downstream phases.
 */
export async function runUnitPhase(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  sidecarItem?: SidecarItem,
): Promise<PhaseResult<{ unitStartedAt?: number; requestDispatchedAt?: number; retryAfterMs?: number }>> {
  const { ctx, pi, s, deps, prefs } = ic;
  const { unitType, unitId, prompt, state, mid } = iterData;

  debugLog("autoLoop", {
    phase: "unit-execution",
    iteration: ic.iteration,
    unitType,
    unitId,
  });

  const worktreeSafetyBlock = await validateSourceWriteWorktreeSafety(
    ic,
    unitType,
    unitId,
    mid,
    "unit-execution",
  );
  if (worktreeSafetyBlock) return worktreeSafetyBlock;

  // ── Project classification notice (#1833, #1843) ─────────────────────
  // Worktree Safety owns source-write root validity. Classification now only
  // shapes user/model guidance for valid roots.
  let projectClassification: ReturnType<typeof classifyProject> | null = null;
  if (s.basePath && unitType === "execute-task") {
    projectClassification = classifyProject(s.basePath);
    if (projectClassification.kind === "invalid-repo") {
      const msg = `Worktree health check failed: ${s.basePath} classified as invalid-repo (${projectClassification.reason}) — refusing to dispatch ${unitType} ${unitId}`;
      debugLog("runUnitPhase", { phase: "worktree-health-invalid-repo", basePath: s.basePath, classification: projectClassification });
      const hasGit = deps.existsSync(join(s.basePath, ".git"));
      if (_shouldProceedWithInvalidRepoClassificationForTest(projectClassification.reason, hasGit)) {
        ctx.ui.notify(
          `Warning: ${s.basePath} project classification could not confirm .git; assuming it has no project content yet — proceeding as greenfield project because worktree health reported .git present`,
          "warning",
        );
      } else {
        ctx.ui.notify(msg, "error");
        await deps.stopAuto(ctx, pi, msg);
        return { action: "break", reason: "worktree-invalid" };
      }
    }

    if (projectClassification.kind === "greenfield") {
      debugLog("runUnitPhase", { phase: "worktree-health-greenfield", basePath: s.basePath, classification: projectClassification });
      ctx.ui.notify(`Warning: ${s.basePath} has no project content yet — proceeding as greenfield project`, "warning");
    } else if (projectClassification.kind === "untyped-existing") {
      debugLog("runUnitPhase", { phase: "worktree-health-untyped-existing", basePath: s.basePath, classification: projectClassification });
      ctx.ui.notify(
        `Notice: ${s.basePath} has existing project content but no recognized tooling markers — using generic file-level workflow guidance`,
        "info",
      );
    }
  }

  // Detect retry and capture previous tier for escalation
  const isRetry = !!(
    s.currentUnit &&
    s.currentUnit.type === unitType &&
    s.currentUnit.id === unitId
  );
  const previousTier = s.currentUnitRouting?.tier;
  const dispatchKey = `${unitType}/${unitId}`;
  const nextDispatchCount = (s.unitDispatchCount.get(dispatchKey) ?? 0) + 1;

  // Status bar (widget + preconditions deferred until after model selection — see #2899)
  setAutoActiveStatus(ctx, s.stepMode ? "next" : "auto");
  if (mid)
    deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);

  // ── Safety harness: reset evidence + create checkpoint ──
  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness as Record<string, unknown> | undefined,
  );
  if (safetyConfig.enabled && safetyConfig.evidence_collection) {
    resetEvidence();
    // Restore persisted evidence so session-restart resumes don't produce
    // false-positive "no bash calls" warnings (Bug #4385).
    if (s.basePath && unitType === "execute-task") {
      const { milestone: eMid, slice: eSid, task: eTid } = parseUnitId(unitId);
      if (eMid && eSid && eTid) {
        loadEvidenceFromDisk(s.basePath, eMid, eSid, eTid);
      }
    }
  }
  // Only checkpoint code-executing units (not lifecycle/planning units)
  if (safetyConfig.enabled && safetyConfig.checkpoints && unitType === "execute-task") {
    s.checkpointSha = createCheckpoint(s.basePath, unitId);
    if (s.checkpointSha) {
      debugLog("runUnitPhase", { phase: "checkpoint-created", unitId, sha: s.checkpointSha.slice(0, 8) });
    }
  }

  // Prompt injection
  let finalPrompt = prompt;

  if (unitType === "execute-task") {
    projectClassification ??= classifyProject(s.basePath);
    if (projectClassification.kind === "untyped-existing") {
      const samples = projectClassification.contentFiles.slice(0, 8).join(", ") || "project files";
      finalPrompt +=
        "\n\n**Project classification:** Existing untyped project. No recognized build/tooling markers were detected, " +
        "so use generic file-level workflow guidance. Task plans and completion summaries must list every concrete " +
        `project file changed in \`files\` or \`expected_output\`. Detected content sample: ${samples}.`;
    }
  }

  if (s.pendingVerificationRetry && s.pendingVerificationRetry.unitId === unitId) {
    const retryCtx = s.pendingVerificationRetry;
    s.pendingVerificationRetry = null;
    const capped =
      retryCtx.failureContext.length > MAX_RECOVERY_CHARS
        ? retryCtx.failureContext.slice(0, MAX_RECOVERY_CHARS) +
          "\n\n[...failure context truncated]"
        : retryCtx.failureContext;
    finalPrompt = `**VERIFICATION FAILED — AUTO-FIX ATTEMPT ${retryCtx.attempt}**\n\nThe verification gate ran after your previous attempt and found failures. Fix these issues before completing the task.\n\n${capped}\n\n---\n\n${finalPrompt}`;
  }

  if (s.pendingCrashRecovery) {
    const capped =
      s.pendingCrashRecovery.length > MAX_RECOVERY_CHARS
        ? s.pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) +
          "\n\n[...recovery briefing truncated to prevent memory exhaustion]"
        : s.pendingCrashRecovery;
    finalPrompt = `${capped}\n\n---\n\n${finalPrompt}`;
    s.pendingCrashRecovery = null;
  } else if (nextDispatchCount > 1) {
    const diagnostic = deps.getDeepDiagnostic(s.basePath);
    if (diagnostic) {
      const cappedDiag =
        diagnostic.length > MAX_RECOVERY_CHARS
          ? diagnostic.slice(0, MAX_RECOVERY_CHARS) +
            "\n\n[...diagnostic truncated to prevent memory exhaustion]"
          : diagnostic;
      const retryInstruction =
        unitType === "execute-task"
          ? "The required artifact is `T##-SUMMARY.md`. Do NOT manually write this file. Call `gsd_task_complete` with `milestoneId`, `sliceId`, `taskId`, and the required completion fields. Do not re-run implementation work — call the tool."
          : "Fix whatever went wrong and make sure you write the required file this time.";
      finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${cappedDiag}\n\n${retryInstruction}\n\n---\n\n${finalPrompt}`;
    }
  }

  // Prompt char measurement
  s.lastPromptCharCount = finalPrompt.length;
  s.lastBaselineCharCount = undefined;
  if (deps.isDbAvailable()) {
    try {
      const { inlineGsdRootFile } = await importExtensionModule<typeof import("../auto-prompts.js")>(import.meta.url, "../auto-prompts.js");
      const [decisionsContent, requirementsContent, projectContent] =
        await Promise.all([
          inlineGsdRootFile(s.basePath, "decisions.md", "Decisions"),
          inlineGsdRootFile(s.basePath, "requirements.md", "Requirements"),
          inlineGsdRootFile(s.basePath, "project.md", "Project"),
        ]);
      s.lastBaselineCharCount =
        (decisionsContent?.length ?? 0) +
        (requirementsContent?.length ?? 0) +
        (projectContent?.length ?? 0);
    } catch (e) {
      logWarning("engine", "Baseline char count measurement failed", { error: String(e) });
    }
  }

  // Cache-optimize prompt section ordering
  try {
    finalPrompt = deps.reorderForCaching(finalPrompt);
  } catch (reorderErr) {
    const msg =
      reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
    logWarning("engine", "Prompt reorder failed", { error: msg });
  }

  // Select and apply model (with tier escalation on retry — normal units only)
  const prevUnitRouting = s.currentUnitRouting;
  const prevUnitModel = s.currentUnitModel;
  const prevDispatchedModelId = s.currentDispatchedModelId;
  const prevSessionModel = ctx.model;
  const prevSessionThinkingLevel = pi.getThinkingLevel();
  const modelResult = await deps.selectAndApplyModel(
    ctx,
    pi,
    unitType,
    unitId,
    s.basePath,
    prefs,
    s.verbose,
    s.autoModeStartModel,
    sidecarItem ? undefined : { isRetry, previousTier },
    undefined,
    s.manualSessionModelOverride,
    s.autoModeStartThinkingLevel,
  );
  s.currentUnitRouting =
    modelResult.routing as AutoSession["currentUnitRouting"];
  s.currentUnitModel =
    modelResult.appliedModel as AutoSession["currentUnitModel"];

  // Apply sidecar/pre-dispatch hook model override (takes priority over standard model selection)
  const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;
  if (hookModelOverride) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = deps.resolveModelId(hookModelOverride, availableModels, ctx.model?.provider);
    if (match) {
      const ok = await pi.setModel(match, { persist: false });
      if (ok) {
        // Apply the per-phase reasoning effort selectAndApplyModel resolved for
        // this unit — not the auto-start session snapshot — but route it through
        // the same floor + capability-clamp pipeline against the *hook* model
        // (ADR-026). The hook override can pick a different model family than the
        // one selectAndApplyModel clamped against, so re-clamping here prevents
        // sending an unsupported level; the floor fills in when no phase level
        // resolved so a hook-overridden execute-task still meets the floor.
        const hookThinkingBase = modelResult.appliedThinkingLevel
          ?? floorThinkingLevelForUnit(unitType, s.autoModeStartThinkingLevel);
        applyThinkingLevelForModel(pi, hookThinkingBase, match, ctx);
        s.currentUnitModel = match as AutoSession["currentUnitModel"];
        ctx.ui.notify(`Hook model override: ${match.provider}/${match.id}`, "info");
      } else {
        ctx.ui.notify(
          `Hook model "${hookModelOverride}" found but setModel failed. Using default.`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `Hook model "${hookModelOverride}" not found in available models. Falling back to current session model. ` +
        `Ensure the model is defined in models.json and has auth configured.`,
        "warning",
      );
    }
  }

  // Store the final dispatched model ID so the dashboard can read it (#2899).
  // This accounts for hook model overrides applied after selectAndApplyModel.
  s.currentDispatchedModelId = s.currentUnitModel
    ? `${(s.currentUnitModel as any).provider ?? ""}/${(s.currentUnitModel as any).id ?? ""}`
    : null;

  const compatibilityError = getUnitWorkflowDispatchReadinessErrorForModel({
    model: s.currentUnitModel as any,
    fallbackModel: ctx.model,
    getProviderAuthMode: (provider) => ctx.modelRegistry.getProviderAuthMode(provider),
    projectRoot: s.basePath,
    surface: "auto-mode",
    unitType,
    activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [],
  });
  const workflowMcpPrepModel = s.currentUnitModel;
  if (compatibilityError) {
    s.currentUnitRouting = prevUnitRouting;
    s.currentUnitModel = prevUnitModel;
    s.currentDispatchedModelId = prevDispatchedModelId;
    if (s.checkpointSha) {
      cleanupCheckpoint(s.basePath, unitId);
      s.checkpointSha = null;
    }
    if (prevSessionModel) {
      const ok = await pi.setModel(prevSessionModel, { persist: false });
      if (!ok) {
        ctx.ui.notify("Failed to restore previous session model after compatibility check failure.", "warning");
      }
      if (prevSessionThinkingLevel) {
        pi.setThinkingLevel(prevSessionThinkingLevel);
      }
    }

    const workflowMcpPrep = prepareWorkflowMcpForProject(ctx, s.basePath, workflowMcpPrepModel);
    if (workflowMcpPrep && workflowMcpPrep.status !== "unchanged") {
      const pauseMsg =
        "GSD workflow MCP config has been written. Restart Claude Code (or reload MCP servers), then run /gsd auto to continue.";
      ctx.ui.notify(pauseMsg, "warning");
      await deps.pauseAuto(ctx, pi, {
        category: "provider",
        isTransient: true,
        message: pauseMsg,
      });
      return { action: "break", reason: "workflow-capability" };
    }

    ctx.ui.notify(compatibilityError, "error");
    await deps.stopAuto(ctx, pi, compatibilityError);
    return { action: "break", reason: "workflow-capability" };
  }

  // Scope workflow-logger buffer to this unit so post-finalize drains are
  // per-unit. Without this, the module-level _buffer accumulates across every
  // unit in the same Node process (see workflow-logger.ts module header).
  _resetLogs();
  const unitStartedAt = Date.now();
  s.unitDispatchCount.set(dispatchKey, nextDispatchCount);
  s.setCurrentUnit({ type: unitType, id: unitId, startedAt: unitStartedAt, workspaceRoot: s.basePath });
  observeTaskPlan(s, unitType, unitId);
  s.rootWriteBaseline = isIsolatedWorktreeSession(s)
    ? captureRootDirtySnapshot(s.originalBasePath)
    : null;
  s.lastGitActionFailure = null;
  s.lastGitActionStatus = null;
  s.lastUnitAgentEndMessages = null;
  setCurrentPhase(unitType, {
    basePath: s.basePath,
    traceId: ic.flowId,
    turnId: `iter-${ic.iteration}`,
    causedBy: "unit-start",
  });
  s.lastToolInvocationError = null; // #2883: clear stale error from previous unit
  if (nextDispatchCount <= 1) {
    s.toolUnavailableRetries = 0;
  }
  const unitStartSeq = ic.nextSeq();
  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: unitStartSeq, eventType: "unit-start", data: { unitType, unitId } });
  deps.captureAvailableSkills();
  writeUnitRuntimeRecord(
    s.basePath,
    unitType,
    unitId,
    unitStartedAt,
    {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: unitStartedAt,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: resolveDispatchRecoveryAttempts(s.unitRecoveryCount, unitType, unitId),
    },
  );

  // Progress widget + preconditions — deferred to after model selection so the
  // widget's first render tick shows the correct model (#2899).
  deps.updateProgressWidget(ctx, unitType, unitId, state);
  deps.ensurePreconditions(unitType, unitId, s.basePath, state);

  // Start unit supervision
  deps.clearUnitTimeout();
  deps.startUnitSupervision({
    s,
    ctx,
    pi,
    unitType,
    unitId,
    prefs,
    buildSnapshotOpts: () => deps.buildSnapshotOpts(unitType, unitId),
    buildRecoveryContext: () => ({
      basePath: s.basePath,
      verbose: s.verbose,
      currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(),
      unitRecoveryCount: s.unitRecoveryCount,
    }),
    pauseAuto: deps.pauseAuto,
  });

  // Write preliminary lock (no session path yet — runUnit creates a new session).
  // Crash recovery can still identify the in-flight unit from this lock.
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
  );

  debugLog("autoLoop", {
    phase: "runUnit-start",
    iteration: ic.iteration,
    unitType,
    unitId,
  });
  const pausedBeforeRun = s.paused;
  const unitResult = await runUnit(
    ctx,
    pi,
    s,
    unitType,
    unitId,
    finalPrompt,
  );
  s.lastUnitAgentEndMessages = unitResult.event?.messages ?? null;
  debugLog("autoLoop", {
    phase: "runUnit-end",
    iteration: ic.iteration,
    unitType,
    unitId,
    status: unitResult.status,
  });

  if (
    unitResult.status === "completed" &&
    s.currentUnit &&
    (unitResult.event?.messages?.length ?? 0) === 0 &&
    isSuspiciousGhostCompletion(ctx, unitResult.requestDispatchedAt ?? s.currentUnit.startedAt)
  ) {
    const message =
      `${unitType} ${unitId} completed without assistant output or tool calls; treating as a stale ghost completion.`;
    debugLog("autoLoop", {
      phase: "ghost-completion",
      iteration: ic.iteration,
      unitType,
      unitId,
      elapsedMs: Date.now() - (unitResult.requestDispatchedAt ?? s.currentUnit.startedAt),
    });
    logWarning("engine", message);
    ctx.ui.notify(`${message} Pausing auto-mode before closeout side effects.`, "warning");
    await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, {
      message,
      category: "unknown",
      isTransient: true,
    });
    s.clearCurrentUnit();
    await deps.pauseAuto(ctx, pi);
    return { action: "break", reason: "ghost-completion" };
  }

  // Now that runUnit has called newSession(), the session file path is correct.
  const sessionFile = deps.getSessionFile(ctx);
  deps.updateSessionLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile,
  );
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile,
  );

  // The provider can fail after gsd_task_complete atomically staged success.
  // In that case execution is already durable and the canonical Attempt is at
  // `verify`; continue closeout instead of dispatching the implementation again.
  const resumeDurableTaskCloseout =
    unitResult.status === "cancelled" &&
    unitResult.errorContext?.category === "provider" &&
    unitResult.errorContext.isTransient === true &&
    isTaskExecutionReadyForHostVerification(unitType, unitId);
  if (resumeDurableTaskCloseout) {
    debugLog("autoLoop", {
      phase: "provider-error-after-durable-task-completion",
      unitType,
      unitId,
    });
    ctx.ui.notify(
      `Provider failed after ${unitType} ${unitId} durably recorded completion; resuming at host verification.`,
      "warning",
    );
  }

  if (unitResult.status === "cancelled" && !resumeDurableTaskCloseout) {
    if (_isPauseOriginCancelledResult(s.paused, unitResult.errorContext)) {
      if (!pausedBeforeRun) {
        const pauseContext = {
          message: "Auto-mode paused during unit setup",
          category: "aborted" as const,
          isTransient: true,
        };
        // pauseAuto normally owns coordination cleanup, but this setup race can
        // observe paused state without that cleanup path completing.
        const abandonedWorkerId = s.workerId;
        if (unitType === "plan-milestone" && abandonedWorkerId) {
          try {
            if (s.currentMilestoneId && s.milestoneLeaseToken) {
              releaseMilestoneLease(
                abandonedWorkerId,
                s.currentMilestoneId,
                s.milestoneLeaseToken,
              );
            }
          } catch (err) {
            logWarning("engine", `setup pause lease cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            markWorkerStopping(abandonedWorkerId);
          } catch (err) {
            logWarning("engine", `setup pause worker cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          s.workerId = null;
          s.milestoneLeaseToken = null;
        }
        await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
        await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, pauseContext);
        return { action: "break", reason: "pause-during-setup" };
      }
      debugLog("autoLoop", { phase: "cancelled-after-pause", unitType, unitId });
      return { action: "break", reason: "paused" };
    }

    const errorCategory = unitResult.errorContext?.category;
    if (
      errorCategory === "provider" &&
      unitResult.errorContext?.isTransient === true &&
      typeof unitResult.errorContext.retryAfterMs === "number" &&
      unitResult.errorContext.retryAfterMs > 0
    ) {
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      debugLog("autoLoop", {
        phase: "provider-credential-cooldown",
        unitType,
        unitId,
        retryAfterMs: unitResult.errorContext.retryAfterMs,
      });
      return {
        action: "retry",
        reason: "credential-cooldown",
        data: { retryAfterMs: unitResult.errorContext.retryAfterMs },
      };
    }
    // Provider-error pause: agent_end recovery normally pauses before this
    // branch. Provider readiness failures happen before dispatch, so pause here
    // if nothing upstream already did.
    if (errorCategory === "provider") {
      if (!s.paused) {
        const detail = unitResult.errorContext?.message ?? `Provider unavailable for ${unitType} ${unitId}`;
        const isTransient = Boolean(unitResult.errorContext?.isTransient);
        const retryAfterMs = unitResult.errorContext?.retryAfterMs ?? (isTransient ? 30_000 : undefined);
        await pauseAutoForProviderError(
          ctx.ui,
          detail,
          () => deps.pauseAuto(ctx, pi),
          {
            isRateLimit: false,
            isTransient,
            retryAfterMs,
            resume: isTransient
              ? () => {
                  void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
                    logWarning("engine", `Provider error auto-resume failed: ${err instanceof Error ? err.message : String(err)}`);
                  });
                }
              : undefined,
          },
        );
      }
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      debugLog("autoLoop", { phase: "exit", reason: "provider-pause", isTransient: unitResult.errorContext?.isTransient });
      return { action: "break", reason: "provider-pause" };
    }
    // Timeout category covers two distinct scenarios:
    //   1. Session creation timeout (120s) — transient, auto-resume with backoff
    //   2. Unit hard timeout (30min+) — stuck agent, pause for manual review
    // Transient session-failed covers recoverable newSession failures and should
    // pause instead of hard-stopping.
    // Structural errors (TypeError, is not a function) are NOT transient
    // and must hard-stop to avoid infinite retry loops.
    if (
      unitResult.errorContext?.isTransient &&
      errorCategory === "timeout"
    ) {
      const isSessionCreationTimeout = unitResult.errorContext.message?.includes("Session creation timed out");

      if (isSessionCreationTimeout) {
        consecutiveSessionTimeouts += 1;
        const baseRetryAfterMs = 30_000;
        const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, consecutiveSessionTimeouts - 1);
        const allowAutoResume = consecutiveSessionTimeouts <= MAX_SESSION_TIMEOUT_AUTO_RESUMES;

        if (!allowAutoResume) {
          ctx.ui.notify(
            `Session creation timed out ${consecutiveSessionTimeouts} consecutive times for ${unitType} ${unitId}. Pausing for manual review.`,
            "warning",
          );
        }

        debugLog("autoLoop", {
          phase: "session-timeout-pause",
          unitType, unitId,
          consecutiveSessionTimeouts,
          retryAfterMs,
          allowAutoResume,
        });

        const errorDetail = ` for ${unitType} ${unitId}`;
        await pauseAutoForProviderError(
          ctx.ui,
          errorDetail,
          () => deps.pauseAuto(ctx, pi),
          {
            isRateLimit: false,
            isTransient: allowAutoResume,
            retryAfterMs,
            resume: allowAutoResume
              ? () => {
                  void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    ctx.ui.notify(
                      `Session timeout recovery failed: ${message}`,
                      "error",
                    );
                  });
                }
              : undefined,
          },
        );
        await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
        await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
        return { action: "break", reason: "session-timeout" };
      }

      // Unit hard timeout (30min+): pause without auto-resume — stuck agent
      ctx.ui.notify(
        `Unit timed out for ${unitType} ${unitId} (supervision may have failed). Pausing auto-mode.`,
        "warning",
      );
      debugLog("autoLoop", { phase: "unit-hard-timeout-pause", unitType, unitId });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "unit-hard-timeout" };
    }
    if (
      unitResult.errorContext?.isTransient &&
      errorCategory === "session-failed"
    ) {
      ctx.ui.notify(
        `Session creation failed transiently for ${unitType} ${unitId}: ${unitResult.errorContext?.message ?? "unknown"}. Pausing auto-mode (recoverable).`,
        "warning",
      );
      debugLog("autoLoop", { phase: "session-start-transient-pause", unitType, unitId, category: errorCategory });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "session-timeout" };
    }
    if (
      unitResult.errorContext?.isTransient &&
      errorCategory === "aborted"
    ) {
      rememberRetryDispatch(s, { type: unitType, id: unitId }, iterData);
      writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit?.startedAt ?? Date.now(), {
        phase: "paused",
        lastProgressAt: Date.now(),
        lastProgressKind: "unit-aborted-pause",
      });
      ctx.ui.notify(
        `Unit ${unitType} ${unitId} was aborted (transient). Pausing auto-mode (recoverable).`,
        "warning",
      );
      debugLog("autoLoop", { phase: "unit-aborted-transient-pause", unitType, unitId, category: errorCategory });
      await deps.pauseAuto(ctx, pi, unitResult.errorContext);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "unit-aborted-pause" };
    }
    // All other cancelled states (structural errors, non-transient failures): hard stop
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        unitType,
        unitId,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(unitType, unitId),
      );
    }
    await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
    await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);

    const cancelledStop = _buildCancelledUnitStopReason(
      unitType,
      unitId,
      unitResult.errorContext,
    );
    ctx.ui.notify(cancelledStop.notifyMessage, "warning");
    await deps.stopAuto(ctx, pi, cancelledStop.stopReason);
    debugLog("autoLoop", { phase: "exit", reason: cancelledStop.loopReason });
    return { action: "break", reason: cancelledStop.loopReason };
  }

  // ── Immediate unit closeout (metrics, activity log, memory) ────────
  // Run right after runUnit() returns so telemetry is never lost to a
  // crash between iterations.
  // Guard: stopAuto() may have nulled s.currentUnit via s.reset() while
  // this coroutine was suspended at `await runUnit(...)` (#2939).
  if (s.currentUnit) {
    // Reset session timeout counter — any successful unit clears the slate
    consecutiveSessionTimeouts = 0;
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      unitType,
      unitId,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(unitType, unitId),
    );
  }

  // ── Zero tool-call guard (#1833, #2653) ──────────────────────────
  // Any unit that completes with 0 tool calls made no real progress —
  // likely context exhaustion where all tool calls errored out. Treat
  // as failed so the unit is retried in a fresh context instead of
  // silently passing through to artifact verification (which loops
  // forever when the unit never produced its artifact).
  {
    const currentLedger = deps.getLedger() as { units: Array<{ type: string; id: string; startedAt: number; toolCalls: number }> } | null;
    if (currentLedger?.units) {
      const lastUnit = [...currentLedger.units].reverse().find(
        (u: { type: string; id: string; startedAt: number; toolCalls: number }) => u.type === unitType && u.id === unitId && u.startedAt === _resolveCurrentUnitStartedAtForTest(s.currentUnit),
      );
      if (lastUnit && lastUnit.toolCalls === 0) {
        const lastAssistantMessage = lastAssistantText(s.lastUnitAgentEndMessages);
        const pseudoToolCallSnippet = zeroToolPseudoToolCallSnippet(lastAssistantMessage);
        if (pseudoToolCallSnippet) {
          debugLog("runUnitPhase", {
            phase: "zero-tool-serialization-drift",
            unitType,
            unitId,
            snippet: pseudoToolCallSnippet,
          });
          ctx.ui.notify(
            `${unitType} ${unitId} completed with 0 tool calls - provider serialization drift: model emitted pseudo-tool-call text. Snippet: ${pseudoToolCallSnippet}`,
            "error",
          );
          await deps.pauseAuto(ctx, pi);
          return { action: "break", reason: "zero-tool-serialization-drift" };
        }
        const providerErrorClass = classifyZeroToolProviderMessage(lastAssistantMessage);
        if (providerErrorClass && isTransient(providerErrorClass)) {
          const retryAfterMs = "retryAfterMs" in providerErrorClass ? providerErrorClass.retryAfterMs : 15_000;
          await pauseAutoForProviderError(
            ctx.ui,
            ` for ${unitType} ${unitId}`,
            () => deps.pauseAuto(ctx, pi),
            {
              isRateLimit: providerErrorClass.kind === "rate-limit",
              isTransient: true,
              retryAfterMs,
              resume: () => {
                void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
                  logWarning("engine", `Provider error auto-resume failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              },
            },
          );
          await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, {
            message: lastAssistantMessage.slice(0, 200),
            category: "provider",
            isTransient: true,
            retryAfterMs,
          });
          return {
            action: "break",
            reason: providerErrorClass.kind === "rate-limit" ? "rate-limit" : "api-timeout",
          };
        }
        if (USER_DRIVEN_DEEP_UNITS.has(unitType) && isAwaitingUserInput(s.lastUnitAgentEndMessages ?? undefined)) {
          debugLog("runUnitPhase", {
            phase: "zero-tool-calls-awaiting-user-input",
            unitType,
            unitId,
          });
        } else {
          const zeroToolKey = `${unitType}/${unitId}`;
          const attempt = (s.zeroToolRetryCount.get(zeroToolKey) ?? 0) + 1;
          debugLog("runUnitPhase", {
            phase: "zero-tool-calls",
            unitType,
            unitId,
            attempt,
            warning: "Unit completed with 0 tool calls — likely context exhaustion, marking as failed",
          });
          if (attempt > MAX_ZERO_TOOL_RETRIES) {
            s.zeroToolRetryCount.delete(zeroToolKey);
            ctx.ui.notify(
              `${unitType} ${unitId} completed with 0 tool calls — context exhaustion, pausing auto-mode after ${MAX_ZERO_TOOL_RETRIES} retry.`,
              "error",
            );
            await deps.pauseAuto(ctx, pi);
            return { action: "break", reason: "zero-tool-calls-exhausted" };
          }
          s.zeroToolRetryCount.set(zeroToolKey, attempt);
          ctx.ui.notify(
            `${unitType} ${unitId} completed with 0 tool calls — context exhaustion, will retry (attempt ${attempt}/${MAX_ZERO_TOOL_RETRIES})`,
            "warning",
          );
          return {
            action: "retry",
            reason: "zero-tool-calls",
            data: {
              unitStartedAt: _resolveCurrentUnitStartedAtForTest(s.currentUnit),
              requestDispatchedAt: unitResult.requestDispatchedAt,
            },
          };
        }
      }
    }
  }

  const skipArtifactVerification = unitType.startsWith("hook/") || unitType === "custom-step";
  const artifactVerified =
    skipArtifactVerification ||
    isTaskExecutionReadyForHostVerification(unitType, unitId) ||
    verifyExpectedArtifact(unitType, unitId, s.basePath);
  if (s.currentUnitRouting) {
    deps.recordOutcome(
      unitType,
      s.currentUnitRouting.tier as "light" | "standard" | "heavy",
      artifactVerified,
    );
  }
  if (artifactVerified) {
    s.unitDispatchCount.delete(dispatchKey);
    s.unitRecoveryCount.delete(`${unitType}/${unitId}`);
    s.zeroToolRetryCount.delete(dispatchKey);
  }

  // Write phase handoff anchor after successful research/planning completion
  const anchorPhases = new Set(["research-milestone", "research-slice", "plan-milestone", "plan-slice"]);
  if (artifactVerified && mid && anchorPhases.has(unitType)) {
    try {
      const { writePhaseAnchor } = await import("../phase-anchor.js");
      writePhaseAnchor(s.basePath, mid, {
        phase: unitType,
        milestoneId: mid,
        generatedAt: new Date().toISOString(),
        intent: `Completed ${unitType} for ${unitId}`,
        decisions: [],
        blockers: [],
        nextSteps: [],
      });
    } catch (err) { /* non-fatal — anchor is advisory */
      logWarning("engine", `phase anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const unitEndStatus =
    resumeDurableTaskCloseout
      ? "completed"
      : !artifactVerified && unitResult.status === "completed"
        ? "no-artifact"
        : unitResult.status;
  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitEndStatus, artifactVerified, ...(unitResult.errorContext ? { errorContext: unitResult.errorContext } : {}) }, causedBy: { flowId: ic.flowId, seq: unitStartSeq } });

  // ── Safety harness: checkpoint cleanup or rollback ──
  if (s.checkpointSha) {
    if (unitResult.status === "error" && safetyConfig.auto_rollback) {
      const rolled = rollbackToCheckpoint(s.basePath, unitId, s.checkpointSha);
      if (rolled) {
        ctx.ui.notify(`Rolled back to pre-unit checkpoint for ${unitId}`, "info");
        debugLog("runUnitPhase", { phase: "checkpoint-rollback", unitId });
      }
    } else if (unitResult.status === "error") {
      ctx.ui.notify(
        `Unit ${unitId} failed. Pre-unit checkpoint available at ${s.checkpointSha.slice(0, 8)}`,
        "warning",
      );
    } else {
      // Success — clean up checkpoint ref
      cleanupCheckpoint(s.basePath, unitId);
      debugLog("runUnitPhase", { phase: "checkpoint-cleaned", unitId });
    }
    s.checkpointSha = null;
  }

  if (unitEndStatus === "no-artifact" && unitType === "complete-slice") {
    let failedToolResult: { toolName?: unknown; content?: unknown } | undefined;
    const messages = s.lastUnitAgentEndMessages;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || typeof message !== "object") continue;
        const result = message as { role?: unknown; toolName?: unknown; isError?: unknown; content?: unknown };
        const toolName = typeof result.toolName === "string" ? result.toolName : "";
        if (
          result.role === "toolResult" &&
          result.isError === true &&
          (toolName.endsWith("gsd_slice_complete") || toolName.endsWith("gsd_complete_slice"))
        ) {
          failedToolResult = result;
          break;
        }
      }
    }
    const toolResultContent = failedToolResult?.content;
    const extractedToolError = typeof toolResultContent === "string"
      ? toolResultContent.trim()
      : Array.isArray(toolResultContent)
        ? toolResultContent
            .filter((part): part is { text: string } =>
              Boolean(part) && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
            .map(part => part.text)
            .join("\n")
            .trim()
        : null;
    const toolError = extractedToolError || (failedToolResult
      ? `${String(failedToolResult.toolName)} returned an error`
      : null);
    if (toolError) {
      const retryKey = verificationRetryKey(unitType, unitId);
      const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
      s.verificationRetryCount.set(retryKey, attempt);
      s.pendingVerificationRetry = {
        unitId,
        failureContext: `gsd_slice_complete failed without writing the slice completion artifacts:\n\n${toolError}`,
        attempt,
      };
      rememberRetryDispatch(s, { type: unitType, id: unitId }, iterData);
      ctx.ui.notify(
        `complete-slice ${unitId} returned a tool error without writing its artifacts. Retrying with the tool error context.`,
        "warning",
      );
      return {
        action: "retry",
        reason: "complete-slice-tool-error",
        data: {
          unitStartedAt: _resolveCurrentUnitStartedAtForTest(s.currentUnit),
          requestDispatchedAt: unitResult.requestDispatchedAt,
        },
      };
    }
  }

  return { action: "next", data: { unitStartedAt: _resolveCurrentUnitStartedAtForTest(s.currentUnit), requestDispatchedAt: unitResult.requestDispatchedAt } };
}
