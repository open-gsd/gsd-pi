// Project/App: gsd-pi
// File Purpose: Declarative auto-mode dispatch rules and dispatch resolver.

/**
 * Auto-mode Dispatch Table — declarative phase → unit mapping.
 *
 * Each rule maps a GSD state to the unit type, unit ID, and prompt builder
 * that should be dispatched. Rules are evaluated in order; the first match wins.
 *
 * This replaces the 130-line if-else chain in dispatchNextUnit with a
 * data structure that is inspectable, testable per-rule, and extensible
 * without modifying orchestration code.
 */

import type { GSDState, TaskIO } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import { renderLanguageDirectiveForPrompt } from "./preferences.js";
import type { MinimalModelRegistry } from "./context-budget.js";
import { extractUatType } from "./files.js";
import { getRewriteCount, loadActiveOverrides, recordRewriteAttempt, resolveAllOverrides } from "./overrides.js";
import { getUatBrowserToolSupportError, type UatType } from "./uat-policy.js";
import {
  isDbAvailable,
  getMilestoneSlices,
  getClosedSliceIds,
  getPendingGatesForTurn,
  markPendingGatesOmittedForTurn,
  insertAssessment,
  transaction,
  getSliceRunUatAssessment,
  hasSavedArtifact,
  hasUnitRecoveryBlock,
} from "./gsd-db.js";
import { readMilestone, readMilestoneSlices } from "./db/lifecycle-read.js";
import { readTaskLifecycleStatus } from "./task-execution-domain-operation.js";
import { getUatRetryAttempts, incrementUatRetryAttempts } from "./db/writers/runtime-control.js";
import { isAcceptableUatVerdict } from "./verdict-parser.js";

import {
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  relSliceFile,
  relMilestoneFile,
  buildMilestoneFileName,
} from "./paths.js";
import { existsSync } from "node:fs";
import { writeProjectionFileSync } from "./compat/compat-marker.js";
import { logWarning, logError } from "./workflow-logger.js";
import { dirname, join } from "node:path";
import { composeToolAffordanceReminder } from "./unit-context-composer.js";
import {
  buildDiscussMilestonePrompt,
  buildDiscussProjectPrompt,
  buildDiscussRequirementsPrompt,
  buildResearchProjectPrompt,
  buildResearchMilestonePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
  buildPlanSlicePrompt,
  buildRefineSlicePrompt,
  buildTaskRecoveryReplanPrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildValidateMilestonePrompt,
  buildReplanSlicePrompt,
  buildRunUatPrompt,
  buildReassessRoadmapPrompt,
  buildRewriteDocsPrompt,
  buildReactiveExecutePrompt,
  buildGateEvaluatePrompt,
  buildParallelResearchSlicesPrompt,
  checkNeedsReassessment,
  loadRoadmapCompletedSliceCandidates,
} from "./auto-prompts.js";
import { readPendingTaskRecoveryContext } from "./task-recovery-domain-operation.js";
import { readTerminalTaskRecoveryAbort } from "./artifact-verification.js";
import { checkNeedsRunUat, readSliceUatSpec } from "./uat-dispatch.js";
import { normalizeModelFieldConfig, resolveModelWithFallbacksForUnit, resolveThinkingLevelForUnit } from "./preferences-models.js";
import { resolveUokFlags } from "./uok/flags.js";
import { selectReactiveDispatchBatch } from "./uok/execution-graph.js";
import { getMilestonePipelineVariant } from "./milestone-scope-classifier.js";
import { isAutoActive } from "./auto.js";
// Host adapter explicitly: auto-dispatch runs in the extension host, and the
// ambient write-gate exports env-sniff the adapter per call (they are reserved
// for the workflow MCP child's dynamic-import surface).
import { hostWriteGateAdapter } from "./bootstrap/write-gate.js";
import { ensureWorkflowPreferencesCaptured } from "./planning-depth.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { resolveWorkflowMcpProjectRoot } from "./workflow-mcp.js";
import { getUnitWorkflowDispatchReadinessError } from "./tool-contract.js";
import { prepareBrowserDaemonForUat } from "./browser-daemon-auto-prep.js";
import {
  resolveDeepProjectSetupState,
  type DeepProjectSetupStage,
} from "./deep-project-setup-policy.js";
import {
  isSetupArtifactSaved,
  isWorkflowPreferencesCaptured,
  recordWorkflowPreferencesCaptured,
} from "./project-setup-facts.js";
import { annotateBackgroundable } from "./delegation-policy.js";
import { invalidateAllCaches } from "./cache.js";
import { insertMilestoneValidationGates } from "./milestone-validation-gates.js";
import { nativeHasChanges, nativeIsRepo, _resetHasChangesCache } from "./native-git-bridge.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import {
  captureMilestoneVerificationSourceRevision,
} from "./verification-source-integrity.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { isMilestoneLifecycleAdopted } from "./db/milestone-closeout-readiness.js";
import { readUnitBudget } from "./db/unit-dispatch-budgets.js";
import { hasStoredPreExecutionRetry, readStoredCommitRepairRetry } from "./db/unit-dispatch-retries.js";
import {
  grantMilestoneValidationWaiver,
  type MilestoneValidationWaiverReason,
} from "./milestone-validation-waiver-domain-operation.js";
import { detectWorktreeName } from "./worktree.js";
import { probeGitConflictState } from "./git-conflict-state.js";
import { runTurnGitAction } from "./git-service.js";
import { parseUnitId } from "./unit-id.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import { throwIfTransientProjectionLockError } from "./projection-root-errors.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type DispatchAction =
  | {
      action: "dispatch";
      unitType: string;
      unitId: string;
      prompt: string;
      pauseAfterDispatch?: boolean;
      /** Name of the matched dispatch rule from the unified registry (journal provenance). */
      matchedRule?: string;
      /**
       * True when the matched unit type has a `good` verdict in delegation-policy.ts.
       * Annotated in `resolveDispatch`. Consumers may use this to fork the prompt
       * to a background sub-agent; default behavior is unchanged (synchronous).
       */
      backgroundable?: boolean;
    }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error"; matchedRule?: string }
  | { action: "skip"; matchedRule?: string };

export interface DispatchContext {
  basePath: string;
  mid: string;
  midTitle: string;
  state: GSDState;
  prefs: GSDPreferences | undefined;
  session?: import("./auto/session.js").AutoSession;
  structuredQuestionsAvailable?: "true" | "false";
  /** Session model context window in tokens, forwarded to the budget engine's prompt builders. */
  sessionContextWindow?: number;
  /** Model registry forwarded to the budget engine so it can look up the configured executor model. */
  modelRegistry?: MinimalModelRegistry;
  /** Session model provider, used for provider-specific effective context windows. */
  sessionProvider?: string;
  /** Active tools in the current session, used for transport preflight checks. */
  activeTools?: string[];
  /** Registered tools in the current session, used for run-uat tools re-scoped at dispatch. */
  registeredTools?: string[];
  /** Session model base URL, used for transport preflight checks. */
  sessionBaseUrl?: string;
  /** Session model auth mode, used for transport preflight checks. */
  sessionAuthMode?: "apiKey" | "oauth" | "externalCli" | "none";
  /**
   * Preview mode (read-only `gsd headless ... query`): dispatch decisions are
   * computed exactly as in a real turn, but no rule may persist a dispatch
   * side effect (DB writes, file writes, counters, markers).
   */
  preview?: boolean;
}

type ReassessmentChecker = typeof checkNeedsReassessment;
type ResearchProjectPromptBuilder = typeof buildResearchProjectPrompt;

let reassessmentChecker: ReassessmentChecker = checkNeedsReassessment;
let researchProjectPromptBuilder: ResearchProjectPromptBuilder = buildResearchProjectPrompt;

/**
 * Optional override for the reactive graph derivation step inside the
 * "executing → reactive-execute" rule. Production leaves this null so the rule
 * uses the real loadSliceTaskIO + deriveTaskGraph; tests inject a throwing
 * function to deterministically exercise the best-effort failure path
 * (auto-dispatch.ts:1494). The catch is otherwise unreachable because every
 * operation it wraps (loadSliceTaskIO, deriveTaskGraph) is
 * internally defensive.
 * @internal
 */
let _reactiveGraphDeriveFn: ((basePath: string, mid: string, sid: string) => Promise<TaskIO[]>) | null = null;

export function setReactiveGraphDeriveFnForTest(
  fn: ((basePath: string, mid: string, sid: string) => Promise<TaskIO[]>) | null,
): () => void {
  const previous = _reactiveGraphDeriveFn;
  _reactiveGraphDeriveFn = fn;
  return () => { _reactiveGraphDeriveFn = previous; };
}

function shouldBypassMilestoneDepthGateInAuto(prefs: GSDPreferences | undefined): boolean {
  return isAutoActive() && prefs?.planning_depth !== "deep";
}

export function setReassessmentCheckerForTest(checker: ReassessmentChecker): () => void {
  const previous = reassessmentChecker;
  reassessmentChecker = checker;
  return () => {
    reassessmentChecker = previous;
  };
}

export function setResearchProjectPromptBuilderForTest(builder: ResearchProjectPromptBuilder): () => void {
  const previous = researchProjectPromptBuilder;
  researchProjectPromptBuilder = builder;
  return () => {
    researchProjectPromptBuilder = previous;
  };
}

export interface DispatchRule {
  /** Human-readable name for debugging and test identification */
  name: string;
  /** Return a DispatchAction if this rule matches, null to fall through */
  match: (ctx: DispatchContext) => Promise<DispatchAction | null>;
}

export function commitPendingMilestoneCloseoutChanges(basePath: string, mid: string): DispatchAction | null {
  if (!nativeIsRepo(basePath)) return null;

  const conflictProbe = probeGitConflictState(basePath);
  if (conflictProbe.status === "unknown") {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: failed to evaluate unresolved Git conflicts. Resolve Git/worktree state manually before closing.`,
      level: "error",
    };
  }
  if (conflictProbe.status === "dirty" && conflictProbe.unmerged.length > 0) {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: unresolved Git conflicts detected in ${conflictProbe.unmerged.join(", ")}. Resolve conflicts before closing.`,
      level: "error",
    };
  }

  _resetHasChangesCache();
  if (!nativeHasChanges(basePath)) return null;

  const gitResult = runTurnGitAction({
    basePath,
    action: "commit",
    unitType: "complete-milestone-preflight",
    unitId: mid,
  });
  if (gitResult.status !== "ok") {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: failed to commit pending changes before closing: ${gitResult.error ?? "unknown git error"}.`,
      level: "warning",
    };
  }

  _resetHasChangesCache();
  if (nativeHasChanges(basePath)) {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: uncommitted changes remain after the pre-completion commit. Commit or stash before closing.`,
      level: "warning",
    };
  }

  return null;
}

export type DeepProjectStage =
  DeepProjectSetupStage;

export type DeepStageGate =
  | { status: "not-applicable"; stage: null; reason: string }
  | { status: "complete"; stage: null; reason: string }
  | { status: "pending"; stage: DeepProjectStage; reason: string }
  | { status: "blocked"; stage: DeepProjectStage; reason: string };

/**
 * UAT sign-off of a slice: the `run-uat` assessment row that
 * `gsd_uat_result_save` writes. A verdict line in a rendered ASSESSMENT or UAT
 * file is not a sign-off, and roadmap or backfill rows have another scope.
 */
export function readUatGateVerdict(
  mid: string,
  sliceId: string,
): { verdict: string; uatType: UatType | undefined } | null {
  const runUatAssessment = getSliceRunUatAssessment(mid, sliceId);
  if (!runUatAssessment?.status) return null;
  return {
    verdict: runUatAssessment.status,
    uatType: extractUatType(readSliceUatSpec(mid, sliceId)) ?? extractUatType(runUatAssessment.fullContent),
  };
}

/**
 * Deep planning mode: check whether any project-level stage gate
 * (workflow-preferences, discuss-project, discuss-requirements,
 * research-project) still has work pending.
 *
 * Used by the milestone-level discuss rules to yield to project-level
 * deep-mode rules when the project hasn't finished its setup interview.
 * Returns false in light mode (or when prefs absent) so the milestone
 * rules behave exactly as before.
 */
export function getDeepStageGate(
  prefs: GSDPreferences | undefined,
  basePath: string,
): DeepStageGate {
  return resolveDeepProjectSetupState(prefs, basePath);
}

export function hasPendingDeepStage(
  prefs: GSDPreferences | undefined,
  basePath: string,
): boolean {
  const gate = getDeepStageGate(prefs, basePath);
  return gate.status === "pending" || gate.status === "blocked";
}

export function shouldRunDeepProjectSetup(
  state: Pick<GSDState, "phase">,
  prefs: GSDPreferences | undefined,
  basePath: string,
  options: { hasSurvivorBranch?: boolean } = {},
): boolean {
  if (options.hasSurvivorBranch === true) return false;
  if (
    state.phase !== "pre-planning" &&
    state.phase !== "needs-discussion" &&
    state.phase !== "planning"
  ) {
    return false;
  }
  return hasPendingDeepStage(prefs, basePath);
}

function resolveArtifactBasePath(
  basePath: string,
  mid: string,
  session: import("./auto/session.js").AutoSession | undefined,
): string {
  if (
    session?.basePath &&
    session.currentMilestoneId &&
    milestoneIdsDispatchCompatible(session.currentMilestoneId, mid) &&
    existsSync(session.basePath)
  ) {
    return session.basePath;
  }

  return resolveCanonicalMilestoneRoot(basePath, mid);
}

function missingSliceStop(mid: string, phase: string): DispatchAction {
  return {
    action: "stop",
    reason: `${mid}: phase "${phase}" has no active slice — run /gsd doctor.`,
    level: "error",
  };
}

function isRegistryMilestoneComplete(state: GSDState, mid: string): boolean {
  return state.registry.some((milestone) =>
    milestone.id === mid && milestone.status === "complete"
  );
}

function normalizeMilestoneScope(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !MILESTONE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

function dispatchMilestoneIdentity(value: string | null | undefined): { baseId: string; hasSuffix: boolean } | null {
  const normalized = normalizeMilestoneScope(value);
  const match = normalized?.match(/^(M\d{3})(?:-[a-z0-9]{6})?$/);
  if (!match) return null;
  return { baseId: match[1]!, hasSuffix: normalized !== match[1] };
}

function isBareSuffixedMilestoneAlias(left: string, right: string): boolean {
  const leftId = dispatchMilestoneIdentity(left);
  const rightId = dispatchMilestoneIdentity(right);
  return Boolean(
    leftId &&
      rightId &&
      leftId.baseId === rightId.baseId &&
      leftId.hasSuffix !== rightId.hasSuffix,
  );
}

// Exported for the paused-session resume validation in auto.ts (#1643): the
// same bare-vs-suffixed normalization (#1317) that the dispatch mismatch guard
// applies must be used when deciding whether a paused milestone was superseded,
// or alias ids would false-mismatch and discard a legitimately resumable pause.
export function milestoneIdsDispatchCompatible(left: string, right: string): boolean {
  return left === right || isBareSuffixedMilestoneAlias(left, right);
}

function resolveDispatchMilestoneScope(
  ctx: DispatchContext,
): { id: string; source: string } | null {
  const sessionMilestone = normalizeMilestoneScope(ctx.session?.currentMilestoneId);
  if (sessionMilestone) return { id: sessionMilestone, source: "session.currentMilestoneId" };

  const sessionWorktree = normalizeMilestoneScope(
    ctx.session?.basePath ? detectWorktreeName(ctx.session.basePath) : null,
  );
  if (sessionWorktree) return { id: sessionWorktree, source: "session.basePath worktree" };

  const baseWorktree = normalizeMilestoneScope(detectWorktreeName(ctx.basePath));
  if (baseWorktree) return { id: baseWorktree, source: "basePath worktree" };

  return null;
}

function resolveEffectiveDispatchMilestoneId(
  ctx: DispatchContext,
  scopedMilestone: { id: string; source: string } | null,
): string {
  if (scopedMilestone && isBareSuffixedMilestoneAlias(ctx.mid, scopedMilestone.id)) {
    return dispatchMilestoneIdentity(scopedMilestone.id)?.hasSuffix ? scopedMilestone.id : ctx.mid;
  }

  const activeMid = ctx.state.activeMilestone?.id;
  if (activeMid && isBareSuffixedMilestoneAlias(ctx.mid, activeMid)) {
    return dispatchMilestoneIdentity(activeMid)?.hasSuffix ? activeMid : ctx.mid;
  }

  return ctx.mid;
}

function withEffectiveDispatchMilestone(ctx: DispatchContext, effectiveMid: string): DispatchContext {
  if (effectiveMid === ctx.mid) return ctx;
  const activeMilestone = ctx.state.activeMilestone;
  const state = activeMilestone && milestoneIdsDispatchCompatible(activeMilestone.id, effectiveMid)
    ? {
        ...ctx.state,
        activeMilestone: {
          ...activeMilestone,
          id: effectiveMid,
        },
      }
    : ctx.state;
  return { ...ctx, mid: effectiveMid, state };
}

/**
 * Ids of the milestone slices that are still open in the database. Empty when
 * every slice is closed, skipped or deferred, or when the DB is unavailable.
 * A slice SUMMARY file is a projection: it is not read here.
 */
export function findOpenSlices(mid: string): string[] {
  if (!isDbAvailable()) return [];
  return readMilestoneSlices(mid)
    .filter(s => !s.done)
    .map(s => s.id);
}

function recordAdoptedMilestoneValidationWaiver(
  basePath: string,
  milestoneId: string,
  reason: MilestoneValidationWaiverReason,
  prefs: GSDPreferences | undefined,
): { ok: true } | { ok: false; error: string } {
  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, milestoneId);
  const source = captureMilestoneVerificationSourceRevision(artifactBasePath, prefs);
  if (!source.ok) return source;
  const receipt = grantMilestoneValidationWaiver({
    invocation: internalExecutionInvocation(
      `internal:auto:milestone.validation.waive:${milestoneId}:${reason}:${source.sourceRevision}`,
      { actorId: "gsd-auto" },
    ),
    milestoneId,
    testedSourceRevision: source.sourceRevision,
    reason,
    policyId: "milestone-validation-waiver",
    policyVersion: "1",
  });
  const validationPath = join(
    artifactBasePath,
    relMilestoneFile(artifactBasePath, milestoneId, "VALIDATION"),
  );
  const content = [
    "---",
    "authorization: waived",
    "outcome: omitted",
    "skip_validation: true",
    `skip_validation_reason: ${reason}`,
    `source_revision: ${receipt.testedSourceRevision}`,
    "---",
    "",
    "# Milestone Validation (waived)",
    "",
    `Milestone validation was waived by the ${reason} policy.`,
    "",
  ].join("\n");
  try {
    writeProjectionFileSync(artifactBasePath, validationPath, content, [milestoneId]);
  } catch (error) {
    logWarning(
      "projection",
      `Milestone validation waiver projection failed for ${milestoneId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  invalidateAllCaches();
  return { ok: true };
}

// ─── Rewrite Circuit Breaker ──────────────────────────────────────────────

const MAX_REWRITE_ATTEMPTS = 3;

// ─── Run-UAT dispatch counter (per-slice) ────────────────────────────────
// Caps run-uat dispatches to prevent infinite replay when verification
// commands fail before writing a verdict (#3624).
// The counter is a database row (uat_retry_counters), shared by every worktree
// of the project. No file is read.
const MAX_UAT_ATTEMPTS = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when the verification_operational value indicates that no
 * operational verification is needed.  Covers common phrasings the planning
 * agent may use: "None", "None required", "N/A", "Not applicable", etc.
 *
 * @see https://github.com/open-gsd/gsd-pi/issues/2931
 */
export function isVerificationNotApplicable(value: string): boolean {
  const v = (value ?? "").toLowerCase().trim().replace(/[.\s]+$/, "");
  if (!v || v === "none") return true;
  return /^(?:none(?:[\s._\u2014-]+[\s\S]*)?|n\/?a(?:[\s._\u2014-]+[\s\S]*)?|not[\s._-]+(?:applicable|required|needed|provided)|no[\s._-]+operational[\s\S]*)$/i.test(v);
}

function readExecuteTaskTerminalAbort(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Extract<DispatchAction, { action: "stop" }> | null {
  if (!isDbAvailable()) return null;
  let terminalAbort: ReturnType<typeof readTerminalTaskRecoveryAbort>;
  try {
    terminalAbort = readTerminalTaskRecoveryAbort(milestoneId, sliceId, taskId);
  } catch (err) {
    return {
      action: "stop",
      reason: `Cannot dispatch execute-task ${milestoneId}/${sliceId}/${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      level: "error",
    };
  }
  if (!terminalAbort) return null;
  return {
    action: "stop",
    reason: `Cannot dispatch execute-task ${milestoneId}/${sliceId}/${taskId}: canonical Task Attempt recovery already aborted (recoveryActionId: ${terminalAbort.recoveryActionId}). Resume it with /gsd recover ${terminalAbort.recoveryActionId}.`,
    level: "error",
  };
}

// ─── Rules ────────────────────────────────────────────────────────────────

export const DISPATCH_RULES: DispatchRule[] = [
  {
    // ADR-011 Phase 2: pause-for-escalation must evaluate FIRST so phase-
    // agnostic rules (rewrite-docs gate, UAT checks, reassess) cannot bypass
    // the user's pending decision. Only fires for continueWithDefault=false
    // escalations (those set escalation_pending=1); awaiting-review artifacts
    // never enter the 'escalating-task' phase.
    name: "escalating-task → pause-for-escalation",
    match: async ({ state, mid }) => {
      if (state.phase !== "escalating-task") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      return {
        action: "stop",
        reason:
          state.nextAction ||
          `${mid}: task escalation awaits user resolution. Run /gsd escalate list to see pending items.`,
        level: "info",
      };
    },
  },
  {
    name: "rewrite-docs (override gate)",
    match: async ({ mid, midTitle, state, basePath, session, preview }) => {
      const pendingOverrides = loadActiveOverrides(basePath);
      if (pendingOverrides.length === 0) return null;
      if (getRewriteCount() >= MAX_REWRITE_ATTEMPTS) {
        // Preview: same fall-through decision, no override resolution persisted.
        if (!preview) resolveAllOverrides(basePath);
        return null;
      }
      if (!preview) recordRewriteAttempt(basePath);
      const unitId = state.activeSlice ? `${mid}/${state.activeSlice.id}` : mid;
      return {
        action: "dispatch",
        unitType: "rewrite-docs",
        unitId,
        prompt: await buildRewriteDocsPrompt(
          mid,
          midTitle,
          state.activeSlice,
          basePath,
          pendingOverrides,
        ),
      };
    },
  },
  {
    // ADR-048: the commit hook refused the changes of a task of this slice
    // after the task closed (#2119), and the retry is stored on the task's
    // dispatch row. State derivation does not select a closed task, so this
    // rule sends the task back to the executor before the slice moves on. It
    // reads the database only, so a restart selects the same unit as a live
    // process.
    name: "stored retry → execute-task (commit repair)",
    match: async ({ state, mid, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (!state.activeSlice) return null;
      const sid = state.activeSlice.id;
      const retry = readStoredCommitRepairRetry(mid, sid);
      const tid = retry ? parseUnitId(retry.unitId).task : undefined;
      if (!retry || !tid) return null;
      const terminalAbort = readExecuteTaskTerminalAbort(mid, sid, tid);
      if (terminalAbort) return terminalAbort;
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: retry.unitId,
        prompt: await buildExecuteTaskPrompt(
          mid,
          sid,
          state.activeSlice.title,
          tid,
          state.activeTask?.id === tid ? state.activeTask.title : tid,
          basePath,
          { sessionContextWindow, modelRegistry, sessionProvider },
        ),
      };
    },
  },
  {
    name: "summarizing → complete-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "summarizing") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "complete-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildCompleteSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "run-uat (post-completion)",
    match: async ({
      state,
      mid,
      basePath,
      prefs,
      sessionProvider,
      sessionAuthMode,
      activeTools,
      registeredTools,
      sessionBaseUrl,
      preview,
    }) => {
      const needsRunUat = await checkNeedsRunUat(
        basePath,
        mid,
        prefs,
        await loadRoadmapCompletedSliceCandidates(basePath, mid),
        { retryNonPass: state.phase === "completing-milestone" },
      );
      if (!needsRunUat) return null;
      const { sliceId, uatType } = needsRunUat;

      // Transport preflight: verify required MCP tools are actually connected
      // before consuming a retry attempt. Fixes tool-starved sessions burning
      // all MAX_UAT_ATTEMPTS before stopping (#477).
      const transportError = getUnitWorkflowDispatchReadinessError({
        provider: sessionProvider,
        projectRoot: basePath,
        surface: "auto-mode",
        unitType: "run-uat",
        authMode: sessionAuthMode,
        baseUrl: sessionBaseUrl,
        activeTools,
      });
      if (transportError) {
        return { action: "stop" as const, reason: transportError, level: "warning" as const };
      }
      const browserToolError = getUatBrowserToolSupportError({
        uatType,
        activeTools,
        registeredTools,
        milestoneId: mid,
        sliceId,
      });
      if (browserToolError) {
        return { action: "stop" as const, reason: browserToolError, level: "warning" as const };
      }
      const browserDaemonError = prepareBrowserDaemonForUat({
        uatType,
        sessionProvider,
        sessionAuthMode,
        sessionBaseUrl,
        projectRoot: resolveWorkflowMcpProjectRoot(basePath),
      });
      if (browserDaemonError) {
        return { action: "stop" as const, reason: browserDaemonError, level: "warning" as const };
      }

      // Cap run-uat dispatch attempts to prevent infinite replay (#3624).
      // Check before incrementing so an exhausted counter cannot create a
      // no-progress skip loop that starves later dispatch rules.
      const attempts = getUatRetryAttempts(mid, sliceId);
      if (attempts >= MAX_UAT_ATTEMPTS) {
        return {
          action: "stop" as const,
          reason: `Cannot dispatch run-uat for ${mid}/${sliceId}: retry limit reached after ${attempts} attempt(s) without a PASS assessment. Fix the underlying UAT/tool issue, reset the retry counter with /gsd doctor --fix, then rerun /gsd auto.`,
          level: "warning" as const,
        };
      }
      // Preview must not burn a retry attempt; the dispatch decision is shared.
      if (!preview) incrementUatRetryAttempts(mid, sliceId);
      return {
        action: "dispatch",
        unitType: "run-uat",
        unitId: `${mid}/${sliceId}`,
        prompt: await buildRunUatPrompt(
          mid,
          sliceId,
          relSliceFile(basePath, mid, sliceId, "UAT"),
          readSliceUatSpec(mid, sliceId),
          basePath,
        ),
        pauseAfterDispatch: !process.env.GSD_HEADLESS && uatType !== "artifact-driven" && uatType !== "browser-executable" && uatType !== "runtime-executable",
      };
    },
  },
  {
    name: "reassess-roadmap (post-completion)",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (prefs?.phases?.skip_reassess) return null;
      // Default reassess_after_slice to false per ADR-003 §4 — most reassess
      // units conclude "roadmap is fine" and burn a session for no change.
      // The plan-slice prompt now carries a reassessment preamble so the
      // next slice's planner does JIT roadmap verification at zero extra
      // cost. Opt-in via explicit `reassess_after_slice: true` (e.g.
      // burn-max profile) when you want the dedicated reassess session.
      const reassessEnabled = prefs?.phases?.reassess_after_slice ?? false;
      if (!reassessEnabled) return null;
      const needsReassess = await reassessmentChecker(basePath, mid, state);
      if (!needsReassess) return null;
      return {
        action: "dispatch",
        unitType: "reassess-roadmap",
        unitId: `${mid}/${needsReassess.sliceId}`,
        prompt: await buildReassessRoadmapPrompt(
          mid,
          midTitle,
          needsReassess.sliceId,
          basePath,
        ),
      };
    },
  },
  {
    name: "needs-discussion → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable, preview }) => {
      if (state.phase !== "needs-discussion") return null;
      // Deep mode bypass: yield to the project-level deep stage gates
      // (workflow-prefs, discuss-project, discuss-requirements,
      // research-project) when any of them still have
      // work pending. Without this guard, the milestone discuss rule wins
      // before the deep rules ever get a chance to fire.
      if (hasPendingDeepStage(prefs, basePath)) return null;
      // H6 fix (#4973): keep the non-deep auto-mode bypass, but do not
      // pre-verify deep planning's user-facing milestone approval gate.
      if (shouldBypassMilestoneDepthGateInAuto(prefs)) {
        if (!preview) hostWriteGateAdapter.markDepthVerified(mid, basePath);
      }
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable,
          { headless: !!process.env.GSD_HEADLESS },
        ),
        pauseAfterDispatch: !process.env.GSD_HEADLESS,
      };
    },
  },
  {
    // Deep mode stage gate: workflow preferences not yet captured.
    // This used to dispatch an agent unit, but the step is deterministic
    // defaults-writing. Keep it in-process so missing preferences cannot loop
    // on the same no-input unit until the liveness backstop trips.
    name: "deep: pre-planning (no workflow prefs) → workflow-preferences",
    match: async ({ state, basePath, prefs, preview }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      if (isWorkflowPreferencesCaptured()) return null; // already captured — fall through
      // Preview: report the same fall-through without writing the defaults.
      if (!preview) {
        ensureWorkflowPreferencesCaptured(basePath);
        // With no database the stage stays pending and is recorded on a later turn.
        if (isDbAvailable()) recordWorkflowPreferencesCaptured();
      }
      return null;
    },
  },
  {
    // Deep mode stage gate: no valid PROJECT artifact row in the database.
    // Fires only when planning_depth === "deep" and the PROJECT stage is not saved.
    // Project-level interview must complete before any milestone-level discussion.
    // Light mode (default) skips this rule entirely — falls through to milestone rules.
    name: "deep: pre-planning (no PROJECT) → discuss-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      if (isSetupArtifactSaved("project")) return null; // PROJECT saved — fall through
      return {
        action: "dispatch",
        unitType: "discuss-project",
        unitId: "PROJECT",
        prompt: await buildDiscussProjectPrompt(basePath, structuredQuestionsAvailable),
        pauseAfterDispatch: !process.env.GSD_HEADLESS,
      };
    },
  },
  {
    // Deep mode stage gate: no valid REQUIREMENTS artifact row in the database.
    // Fires only when planning_depth === "deep", the PROJECT stage is saved, and
    // the REQUIREMENTS stage is not.
    name: "deep: pre-planning (no REQUIREMENTS) → discuss-requirements",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      if (!isSetupArtifactSaved("project")) return null; // PROJECT not saved — earlier rule handles
      if (isSetupArtifactSaved("requirements")) return null; // REQUIREMENTS saved — fall through
      return {
        action: "dispatch",
        unitType: "discuss-requirements",
        unitId: "REQUIREMENTS",
        prompt: await buildDiscussRequirementsPrompt(basePath, structuredQuestionsAvailable),
        pauseAfterDispatch: !process.env.GSD_HEADLESS,
      };
    },
  },
  {
    // Deep mode parallel research.
    // Fires when planning_depth === "deep", the REQUIREMENTS stage is saved,
    // the recorded research decision is "research", and any of the 4 project
    // research files is missing. Spawns one orchestrator session that fans
    // out 4 parallel subagents (stack, features, architecture, pitfalls).
    // Skipped entirely when the user did not choose research.
    name: "deep: pre-planning (research approved, files missing) → research-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable, sessionProvider }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const gate = resolveDeepProjectSetupState(prefs, basePath);
      if (gate.status === "blocked" && gate.stage === "project-research") {
        return {
          action: "stop" as const,
          reason: gate.reason,
          level: "warning" as const,
        };
      }
      if (gate.status !== "pending" || gate.stage !== "project-research") return null;
      return {
        action: "dispatch",
        unitType: "research-project",
        unitId: "RESEARCH-PROJECT",
        prompt: await researchProjectPromptBuilder(basePath, structuredQuestionsAvailable, sessionProvider),
      };
    },
  },
  {
    name: "pre-planning (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable, preview }) => {
      if (state.phase !== "pre-planning") return null;
      if (isRegistryMilestoneComplete(state, mid)) return null;
      // The saved CONTEXT row is the discussion result; the file is not read.
      if (hasSavedArtifact(mid, null, "CONTEXT")) return null; // fall through to next rule
      if (prefs?.planning_depth === "deep") return null;
      // H6 fix (#4973): keep the non-deep auto-mode bypass, but do not
      // pre-verify deep planning's user-facing milestone approval gate.
      if (shouldBypassMilestoneDepthGateInAuto(prefs)) {
        if (!preview) hostWriteGateAdapter.markDepthVerified(mid, basePath);
      }
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable,
          { headless: !!process.env.GSD_HEADLESS },
        ),
        pauseAfterDispatch: !process.env.GSD_HEADLESS,
      };
    },
  },
  {
    name: "pre-planning (no research) → research-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "pre-planning") return null;
      // Phase skip: skip research when preference or profile says so
      if (prefs?.phases?.skip_research) return null;
      if (hasSavedArtifact(mid, null, "RESEARCH")) return null; // has research, fall through
      return {
        action: "dispatch",
        unitType: "research-milestone",
        unitId: mid,
        prompt: await buildResearchMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "pre-planning (has research) → plan-milestone",
    match: async ({ state, mid, midTitle, basePath, session }) => {
      if (state.phase !== "pre-planning") return null;
      const milestoneScope = session?.scope?.milestoneId === mid
        ? session.scope
        : scopeMilestone(createWorkspace(basePath), mid);
      return {
        action: "dispatch",
        unitType: "plan-milestone",
        unitId: mid,
        prompt: await buildPlanMilestonePrompt(
          mid,
          midTitle,
          basePath,
          milestoneScope,
        ),
      };
    },
  },
  {
    name: "planning (require_slice_discussion) → pause for discussion",
    match: async ({ state, mid, prefs }) => {
      if (state.phase !== "planning") return null;
      if (!prefs?.phases?.require_slice_discussion) return null;
      if (!state.activeSlice) return null;
      // Only pause if the slice has no saved CONTEXT row yet (discussion not done).
      if (hasSavedArtifact(mid, state.activeSlice.id, "CONTEXT")) return null; // discussion already done, proceed

      const closedSliceIds = getClosedSliceIds(mid);
      const justClosedSliceId = closedSliceIds[closedSliceIds.length - 1];
      let priorVerdictWarning = "";
      if (justClosedSliceId) {
        const prior = readUatGateVerdict(mid, justClosedSliceId);
        if (prior && !isAcceptableUatVerdict(prior.verdict, prior.uatType)) {
          priorVerdictWarning =
            ` Note: the slice just closed (${justClosedSliceId}) recorded a non-PASS UAT verdict (${prior.verdict.toUpperCase()}); review before continuing.`;
        }
      }

      return {
        action: "stop" as const,
        reason: `Slice ${state.activeSlice.id} requires discussion before planning (require_slice_discussion is enabled). Run /gsd discuss to discuss this slice, then /gsd auto to resume.${priorVerdictWarning}`,
        level: "warning" as const,
      };
    },
  },
  {
    // Keep this rule before the single-slice research rule so the multi-slice
    // path wins whenever 2+ slices are ready.
    name: "planning (multiple slices need research) → parallel-research-slices",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionProvider }) => {
      if (state.phase !== "planning") return null;
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research) return null;
      // #4781 phase 2: trivial-scope milestones skip dedicated slice research.
      // plan-slice absorbs the lightweight discovery a trivial deliverable
      // needs. Null result (DB unavailable / unknown) falls through to today's
      // behavior.
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;

      // DB-authoritative slice list (ADR-017): the ROADMAP projection is
      // never parsed for dispatch decisions. No DB / no rows → skip this rule.
      if (!isDbAvailable()) return null;
      const dbSlices = readMilestoneSlices(mid);
      if (dbSlices.length === 0) return null;

      // Find slices that need research (no saved RESEARCH row, dependencies
      // done in the DB). Milestone research informs slice research; it does
      // not satisfy the per-slice RESEARCH contract.
      const researchReadySlices: Array<{ id: string; title: string }> = [];
      const doneSliceIds = new Set(dbSlices.filter((slice) => slice.done).map((slice) => slice.id));

      for (const slice of dbSlices) {
        if (slice.done) continue;
        // Skip if already has research
        if (hasSavedArtifact(mid, slice.id, "RESEARCH")) continue;
        // Skip if dependencies aren't done
        if (!slice.depends.every((depId) => doneSliceIds.has(depId))) continue;

        researchReadySlices.push({ id: slice.id, title: slice.title });
      }

      // Only dispatch parallel if 2+ slices are ready
      if (researchReadySlices.length < 2) return null;

      // #4414: If a previous parallel-research attempt ended in a recorded
      // recovery block, skip this rule and fall through to per-slice research
      // (or other rules) rather than re-dispatching the same failing unit.
      if (hasUnitRecoveryBlock("research-slice", `${mid}/parallel-research`)) return null;

      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/parallel-research`,
        prompt: await buildParallelResearchSlicesPrompt(
          mid,
          midTitle,
          researchReadySlices,
          basePath,
          resolveModelWithFallbacksForUnit("subagent")?.primary,
          resolveThinkingLevelForUnit("subagent"),
          sessionProvider,
        ),
      };
    },
  },
  {
    name: "planning (no research) → research-slice",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionProvider }) => {
      if (state.phase !== "planning") return null;
      // Phase skip: skip research when preference or profile says so
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research)
        return null;
      // #4781 phase 2: trivial-scope milestones skip dedicated slice research.
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      if (hasSavedArtifact(mid, sid, "RESEARCH")) return null; // has research, fall through
      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildResearchSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          { sessionProvider },
        ),
      };
    },
  },
  {
    // ADR-011: sketch-then-refine. When `refining` phase fires, expand the
    // sketch into a full plan using the prior slice's SUMMARY and the current
    // codebase. If the user flipped `progressive_planning` off mid-milestone
    // while a slice is still `is_sketch=1`, fall through to a standard
    // plan-slice so the loop doesn't dead-end.
    //
    // Note on the flag-OFF downgrade: DB slice metadata is authoritative.
    // PLAN.md is only a projection, so plan-slice/refine-slice handlers must
    // explicitly clear `is_sketch` when a sketch becomes a full plan.
    name: "refining → refine-slice",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "refining") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;

      const progressiveOn = prefs?.phases?.progressive_planning === true;
      if (!progressiveOn) {
        // Graceful downgrade: treat the sketch as a normal slice needing a plan,
        // but forward the stored sketch_scope as a SOFT hint so the scope
        // signal isn't silently lost. The planner may expand beyond it.
        let softScopeHint = "";
        try {
          const { isDbAvailable, getSlice } = await import("./gsd-db.js");
          if (isDbAvailable()) {
            softScopeHint = getSlice(mid, sid)?.sketch_scope ?? "";
          }
        } catch {
          softScopeHint = "";
        }
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: await buildPlanSlicePrompt(
            mid, midTitle, sid, sTitle, basePath, undefined,
            { ...(softScopeHint ? { softScopeHint } : {}), sessionContextWindow, modelRegistry, sessionProvider },
          ),
        };
      }
      return {
        action: "dispatch",
        unitType: "refine-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildRefineSlicePrompt(
          mid, midTitle, sid, sTitle, basePath, undefined,
          { sessionContextWindow, modelRegistry, sessionProvider },
        ),
      };
    },
  },
  {
    name: "planning → plan-slice",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          undefined,
          { sessionContextWindow, modelRegistry, sessionProvider },
        ),
      };
    },
  },
  {
    // ADR-048: the pre-execution check refused the plan of this slice and the
    // retry is stored on the planner's dispatch row. The task rows of the
    // refused plan put the slice in a later phase, so this rule sends the slice
    // back to the planner before a gate or a task uses that plan. It reads the
    // database only, so a restart selects the same unit as a live process.
    name: "stored retry → plan-slice / refine-slice",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "evaluating-gates" && state.phase !== "executing") return null;
      if (!state.activeSlice) return null;
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const unitId = `${mid}/${sid}`;
      const unitType = (["plan-slice", "refine-slice"] as const)
        .find((type) => hasStoredPreExecutionRetry(type, unitId));
      if (!unitType) return null;
      const buildPrompt = unitType === "refine-slice" ? buildRefineSlicePrompt : buildPlanSlicePrompt;
      return {
        action: "dispatch",
        unitType,
        unitId,
        prompt: await buildPrompt(
          mid, midTitle, sid, sTitle, basePath, undefined,
          { sessionContextWindow, modelRegistry, sessionProvider },
        ),
      };
    },
  },
  {
    name: "evaluating-gates → gate-evaluate",
    match: async ({ state, mid, midTitle, basePath, prefs, preview }) => {
      if (state.phase !== "evaluating-gates") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;

      // Gate evaluation is opt-in via preferences
      const gateConfig = prefs?.gate_evaluation;
      if (!gateConfig?.enabled) {
        // Preview contract: a preview must not persist dispatch effects. The
        // skip decision is shared; only the omission write is suppressed
        // (#2230 — a headless query must not flip pending gates).
        if (!preview) markPendingGatesOmittedForTurn(mid, sid, "gate-evaluate");
        return { action: "skip" };
      }

      const pending = getPendingGatesForTurn(mid, sid, "gate-evaluate");
      if (pending.length === 0) return { action: "skip" };

      return {
        action: "dispatch",
        unitType: "gate-evaluate",
        unitId: `${mid}/${sid}/gates+${pending.map(g => g.gate_id).join(",")}`,
        prompt: await buildGateEvaluatePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          resolveModelWithFallbacksForUnit("subagent")?.primary,
          resolveThinkingLevelForUnit("subagent"),
        ),
      };
    },
  },
  {
    name: "replanning-slice → replan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "replanning-slice") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "replan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildReplanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "executing → replan-task recovery",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "executing" || !state.activeSlice || !state.activeTask) return null;
      if (!isDbAvailable()) return null;
      const sid = state.activeSlice.id;
      const tid = state.activeTask.id;
      const recovery = readPendingTaskRecoveryContext({
        milestoneId: mid,
        sliceId: sid,
        taskId: tid,
      });
      if (recovery?.action !== "replan" || recovery.replanCompleted) return null;
      return {
        action: "dispatch",
        unitType: "replan-task",
        unitId: `${mid}/${sid}/${tid}`,
        prompt: await buildTaskRecoveryReplanPrompt(
          mid,
          sid,
          state.activeSlice.title,
          tid,
          state.activeTask.title,
          basePath,
        ),
      };
    },
  },
  {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry, sessionProvider, preview }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return null; // fall through

      // Reactive dispatch is on by default when there are enough ready tasks to
      // benefit from parallelism. Users opt out explicitly via
      // `reactive_execution.enabled: false`. The downstream safety checks
      // (graph ambiguity, ready-task count, conflict-free selection) still gate
      // every actual dispatch, so the worst-case "default-on" outcome is the
      // same fall-through to sequential execution as before.
      const reactiveConfig = prefs?.reactive_execution;
      if (reactiveConfig?.enabled === false) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      if (hasUnitRecoveryBlock("reactive-execute", `${mid}/${sid}`)) return null;
      const maxParallel = reactiveConfig?.max_parallel ?? 2;
      // `subagent_model` accepts the phase-bucket object form (#1229); honor the
      // full primary→fallbacks chain in the dispatch prompt (the reactive
      // subagent model is embedded there rather than set as the session model).
      const subagentModelConfig = normalizeModelFieldConfig(reactiveConfig?.subagent_model)
        ?? resolveModelWithFallbacksForUnit("subagent");
      const subagentModel = subagentModelConfig?.primary;
      // Prefer the per-field `thinking` carried on `reactive_execution.subagent_model`'s
      // object form over the phase-bucket `subagent` level (#1269).
      const subagentThinking = subagentModelConfig?.thinking ?? resolveThinkingLevelForUnit("subagent");
      // Default-on safety threshold: only activate reactive dispatch when at
      // least N tasks are ready. Users who explicitly enabled reactive_execution
      // keep the legacy threshold of 2 (matches the prior "any parallelism is
      // better than none" intent). Default-on installs require >=3 to avoid
      // surprising users with parallelism on small slices.
      const minReadyTasksForReactive = reactiveConfig?.enabled === true ? 2 : 3;

      // Dry-run mode: max_parallel=1 means graph is derived and logged but
      // execution remains sequential
      if (maxParallel <= 1) return null;

      try {
        const {
          loadSliceTaskIO,
          deriveTaskGraph,
          isGraphAmbiguous,
          getReadyTasks,
          chooseNonConflictingSubset,
          graphMetrics,
        } = await import("./reactive-graph.js");

        const taskIO = _reactiveGraphDeriveFn
          ? await _reactiveGraphDeriveFn(basePath, mid, sid)
          : loadSliceTaskIO(mid, sid);
        if (taskIO.length < 2) return null; // single task, no point

        const graph = deriveTaskGraph(taskIO);

        // Ambiguous graph → fall through to sequential
        if (isGraphAmbiguous(graph)) return null;

        const completed = new Set(graph.filter((n) => n.done).map((n) => n.id));
        const readyIds = getReadyTasks(graph, completed, new Set());

        // Only activate reactive dispatch when enough tasks are ready.
        // Threshold is 2 when explicitly opted in, 3 when default-on.
        if (readyIds.length < minReadyTasksForReactive) return null;

        const uokFlags = resolveUokFlags(prefs);
        const selected = uokFlags.executionGraph
          ? selectReactiveDispatchBatch({
              graph,
              readyIds,
              maxParallel,
              inFlightOutputs: new Set(),
            }).selected
          : chooseNonConflictingSubset(
              readyIds,
              graph,
              maxParallel,
              new Set(),
            );
        if (selected.length <= 1) return null;

        // A batch subagent holds no Attempt, and only the running Attempt of
        // the host completes a Task that has a lifecycle row. Those Tasks run
        // one at a time through execute-task.
        if (selected.some((taskId) => readTaskLifecycleStatus({ milestoneId: mid, sliceId: sid, taskId }) !== null)) {
          return null;
        }

        // Log graph metrics for observability
        const metrics = graphMetrics(graph);
        process.stderr.write(
          `gsd-reactive: ${mid}/${sid} graph — tasks:${metrics.taskCount} edges:${metrics.edgeCount} ` +
          `ready:${metrics.readySetSize} dispatching:${selected.length} ambiguous:${metrics.ambiguous}\n`,
        );

        // Encode selected task IDs in unitId for artifact verification.
        // Format: M001/S01/reactive+T02,T03
        const batchSuffix = selected.join(",");

        return {
          action: "dispatch",
          unitType: "reactive-execute",
          unitId: `${mid}/${sid}/reactive+${batchSuffix}`,
          prompt: await buildReactiveExecutePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            selected,
            basePath,
            subagentModel,
            {
              sessionContextWindow,
              modelRegistry,
              sessionProvider,
              subagentThinking,
              subagentModelFallbacks: subagentModelConfig?.fallbacks,
            },
          ),
        };
      } catch (err) {
        // Non-fatal — fall through to sequential execution
        logError("dispatch", "reactive graph derivation failed", { error: (err as Error).message });
        return null;
      }
    },
  },
  {
    // The active task comes from the database, so the plan exists there. A
    // missing PLAN file is projection work: render it from the DB so the
    // execute-task prompt can inline it, then fall through. A missing file
    // never stops dispatch and never sends the slice back to planning.
    name: "executing → execute-task (render missing plan projection)",
    match: async ({ state, mid, basePath, session, preview }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const artifactBasePath = resolveArtifactBasePath(basePath, mid, session);
      // Preview must not write the projection; the decision is the same.
      if (preview || resolveSliceFile(artifactBasePath, mid, sid, "PLAN")) return null;
      try {
        const { renderPlanFromDb } = await import("./markdown-renderer.js");
        const rendered = await renderPlanFromDb(artifactBasePath, mid, sid);
        process.stderr.write(
          `gsd-projection-heal: re-rendered missing slice PLAN for ${mid}/${sid} from the DB at ${rendered.planPath}\n`,
        );
      } catch (err) {
        // A Windows sharing violation is transient contention, not a DB
        // projection gap. Preserve it as a typed throw so Recovery
        // Classification routes through the loop's existing retry budget.
        throwIfTransientProjectionLockError(err);
        logWarning(
          "dispatch",
          `slice PLAN re-render from DB failed for ${mid}/${sid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    },
  },
  {
    name: "executing → execute-task",
    match: async ({ state, mid, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "executing") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;

      if (!state.activeTask) return null;
      const tid = state.activeTask.id;
      const tTitle = state.activeTask.title;
      const terminalAbort = readExecuteTaskTerminalAbort(mid, sid, tid);
      if (terminalAbort) return terminalAbort;

      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: `${mid}/${sid}/${tid}`,
        prompt: await buildExecuteTaskPrompt(
          mid,
          sid,
          sTitle,
          tid,
          tTitle,
          basePath,
          { sessionContextWindow, modelRegistry, sessionProvider },
        ),
      };
    },
  },
  {
    name: "validating-milestone → validate-milestone",
    match: async (ctx) => {
      const { state, mid, midTitle, basePath, prefs, session, preview } = ctx;
      if (state.phase !== "validating-milestone") return null;

      const adoptedMilestone = isMilestoneLifecycleAdopted(mid);

      // Adopted validation reads canonical evidence. Legacy validation needs
      // every slice closed in the DB; a missing SUMMARY file does not block it.
      if (!adoptedMilestone) {
        const openSlices = findOpenSlices(mid);
        if (openSlices.length > 0) {
          return {
            action: "stop",
            reason: `Cannot validate milestone ${mid}: slices ${openSlices.join(", ")} are not closed in the database.`,
            level: "error",
          };
        }
      }

      // #4781 phase 2: trivial-scope milestones skip the dedicated validate
      // unit — complete-milestone's own verification steps (3/4/5 in the
      // closer prompt) are sufficient proof for contained deliverables.
      const trivialVariant = await getMilestonePipelineVariant(mid) === "trivial";

      // Adopted skips commit a canonical Waiver; legacy skips retain their
      // compatibility PASS assessment and projection.
      if (prefs?.phases?.skip_milestone_validation || trivialVariant) {
        const skipReason = trivialVariant ? "trivial-scope" : "preference";
        if (adoptedMilestone) {
          // Preview: skip the waiver commit but keep the downstream guarded
          // dispatch decision identical.
          if (!preview) {
            const waiver = recordAdoptedMilestoneValidationWaiver(
              basePath,
              mid,
              skipReason,
              prefs,
            );
            if (!waiver.ok) {
              return {
                action: "stop",
                reason: `Cannot waive milestone validation for ${mid}: ${waiver.error}`,
                level: "warning",
              };
            }
          }
          const { evaluateGuardedCompleteMilestoneDispatch } = await import("./milestone-closeout.js");
          // Preview suppressed the waiver write above; tell the guarded
          // evaluation to treat the would-be waiver as recorded so the
          // returned decision equals the real turn's (#2230).
          return evaluateGuardedCompleteMilestoneDispatch(ctx, { assumeValidationWaived: preview });
        }
        const artifactBasePath = resolveArtifactBasePath(basePath, mid, session);
        const projectRoot = resolveWorktreeProjectRoot(basePath, session?.originalBasePath);
        // Use relMilestoneFile for the layout-aware filename:
        //   legacy   → milestones/M001/M001-VALIDATION.md
        //   flat-phase → phases/01-slug/01-VALIDATION.md
        // When the milestone dir is only in the project root (worktree has none),
        // write to the project root so the artifact lands in the canonical location.
        let writeBase = projectRoot;
        if (resolveMilestonePath(artifactBasePath, mid) != null) writeBase = artifactBasePath;
        const validationPath = join(writeBase, relMilestoneFile(writeBase, mid, "VALIDATION"));
        const skipSource = trivialVariant
          ? "trivial-scope pipeline variant"
          : "`skip_milestone_validation` preference";
        const skipValidationReason = skipReason;
        const content = [
          "---",
          "verdict: pass",
          "skip_validation: true",
          `skip_validation_reason: ${skipValidationReason}`,
          "remediation_round: 0",
          "---",
          "",
          "# Milestone Validation (skipped)",
          "",
          `Milestone validation was skipped via ${skipSource}.`,
        ].join("\n");
        // Preview shares the skip decision; the VALIDATION projection and the
        // DB-backed pass rows are dispatch effects and are not persisted.
        if (preview) return { action: "skip" };
        // DB-backed state derivation keys off assessments, so the next loop
        // iteration advances to completing-milestone instead of re-entering
        // validating-milestone. The file is rendered from the committed row,
        // by the renderer that the validate tool and the full rebuild use.
        transaction(() => {
          insertAssessment({
            path: validationPath,
            milestoneId: mid,
            sliceId: null,
            taskId: null,
            status: "pass",
            scope: "milestone-validation",
            fullContent: content,
          });
          const gateSliceId = getMilestoneSlices(mid)[0]?.id;
          if (gateSliceId) {
            insertMilestoneValidationGates(
              mid,
              gateSliceId,
              "pass",
              new Date().toISOString(),
            );
          }
        });
        const { renderMilestoneValidation } = await import("./markdown-renderer.js");
        renderMilestoneValidation(writeBase, mid);
        invalidateAllCaches();
        return { action: "skip" };
      }
      return {
        action: "dispatch",
        unitType: "validate-milestone",
        unitId: mid,
        prompt: await buildValidateMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "completing-milestone → complete-milestone",
    match: async (ctx) => {
      const { evaluateCompleteMilestoneDispatch } = await import("./milestone-closeout.js");
      return evaluateCompleteMilestoneDispatch(ctx);
    },
  },
  {
    name: "complete → stop",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "complete") return null;
      if (mid && isDbAvailable()) {
        const milestone = readMilestone(mid);
        if (milestone && !milestone.closed) {
          return {
            action: "dispatch",
            unitType: "complete-milestone",
            unitId: mid,
            prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath),
          };
        }
        if (milestone) {
          const closeoutProof = proveMilestoneCloseout(mid, { refreshFromDisk: true });
          if (!closeoutProof.ok) {
            return {
              action: "stop",
              reason: formatCloseoutProofBlock(closeoutProof),
              level: "warning",
            };
          }
        }
      }
      return {
        action: "stop",
        reason: "All milestones complete.",
        level: "info",
      };
    },
  },
];

import { getRegistry } from "./rule-registry.js";

/**
 * Prepend the configured response-language directive to a dispatched unit
 * prompt so auto-execution units respond in the language set in PREFERENCES.md
 * (#1210). No-op for non-dispatch actions or when no language is configured.
 */
function applyLanguageDirectiveToDispatch(
  action: DispatchAction,
  prefs: GSDPreferences | undefined,
): DispatchAction {
  if (action.action !== "dispatch" || !action.prompt) return action;
  const directive = renderLanguageDirectiveForPrompt(prefs);
  if (!directive) return action;
  if (action.prompt.startsWith(directive)) return action;
  return { ...action, prompt: `${directive}\n\n${action.prompt}` };
}

/**
 * Repeat the unit's allowed tool tokens at the very end of the dispatched prompt.
 *
 * `## Tool Surface` already carries this, but it lands ~4% into a 14K-character
 * prompt (measured on validate-milestone: offset 627, 13,731 characters after it)
 * and units kept reaching for `bash`, `gsd_uat_exec`, and subagent `"review"`
 * regardless. Applied at the dispatch seam so every unit gets it from one place,
 * rather than editing each prompt builder's tail.
 */
function appendToolAffordanceToDispatch(
  action: DispatchAction,
  basePath?: string,
  sessionProvider?: string,
): DispatchAction {
  if (action.action !== "dispatch" || !action.prompt || !action.unitType) return action;
  const reminder = composeToolAffordanceReminder(action.unitType, basePath, sessionProvider);
  if (!reminder || action.prompt.trimEnd().endsWith(reminder)) return action;
  return { ...action, prompt: `${action.prompt.trimEnd()}\n\n${reminder}` };
}

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Evaluate dispatch rules in order. Returns the first matching action,
 * or a "stop" action if no rule matches (unhandled phase).
 *
 * Delegates to the RuleRegistry when initialized; falls back to inline
 * loop over DISPATCH_RULES for backward compatibility (tests that import
 * resolveDispatch directly without registry initialization).
 */
/**
 * ADR-048: a unit that used all its artifact verification retries holds the
 * `exhausted` mark on its dispatch row. It is not dispatched again, also after
 * a restart, until a reopen or a re-plan releases the mark.
 */
function isVerificationExhausted(ctx: DispatchContext, unitType: string, unitId: string): boolean {
  return readUnitBudget(
    ctx.session?.unclaimedUnitBudgets ?? new Map(),
    { unitType, unitId, kind: "exhausted" },
  ) > 0;
}

function verificationExhaustedReason(unitId: string): string {
  return `Unit ${unitId} used all its verification retries. Reopen or re-plan it to run it again.`;
}

export async function resolveDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction> {
  const scopedMilestone = resolveDispatchMilestoneScope(ctx);
  const effectiveMid = resolveEffectiveDispatchMilestoneId(ctx, scopedMilestone);
  const dispatchCtx = withEffectiveDispatchMilestone(ctx, effectiveMid);

  const activeMid = dispatchCtx.state.activeMilestone?.id;
  const isProjectSetupDispatch =
    dispatchCtx.mid === "PROJECT" &&
    !activeMid &&
    (
      dispatchCtx.state.phase === "pre-planning" ||
      dispatchCtx.state.phase === "needs-discussion" ||
      dispatchCtx.state.phase === "planning"
    );
  if (activeMid && !milestoneIdsDispatchCompatible(dispatchCtx.mid, activeMid)) {
    return {
      action: "stop",
      reason:
        `Dispatch milestone mismatch: context mid "${dispatchCtx.mid}" does not match active milestone "${activeMid}". ` +
        "This usually means a project-level deep setup pseudo-id leaked into milestone dispatch; rerun /gsd auto after setup state is reconciled.",
      level: "warning",
    };
  }

  if (
    !isProjectSetupDispatch &&
    scopedMilestone &&
    !milestoneIdsDispatchCompatible(dispatchCtx.mid, scopedMilestone.id)
  ) {
    return {
      action: "stop",
      reason:
        `Dispatch milestone mismatch: context mid "${dispatchCtx.mid}" does not match ${scopedMilestone.source} "${scopedMilestone.id}". ` +
        "The active worktree/session and derived project state disagree; recover, park, or discard the stranded milestone before continuing.",
      level: "warning",
    };
  }

  if (MILESTONE_ID_RE.test(dispatchCtx.mid)) {
    if (!isDbAvailable()) {
      return {
        action: "stop",
        reason: `Cannot dispatch milestone ${dispatchCtx.mid}: workflow DB is unavailable.`,
        level: "error",
      };
    }
    const milestone = readMilestone(dispatchCtx.mid);
    if (!milestone) {
      return {
        action: "stop",
        reason: `Cannot dispatch milestone ${dispatchCtx.mid}: milestone is missing from the workflow DB.`,
        level: "error",
      };
    }
    if (milestone.closed) {
      return {
        action: "stop",
        reason:
          `Milestone ${dispatchCtx.mid} is closed (status: ${milestone.status}); auto-mode will not reopen or recover it implicitly. ` +
          "Use an explicit reopen command before planning or executing more work for this milestone.",
        level: "warning",
      };
    }
  }

  let registry = null;
  try {
    registry = getRegistry();
  } catch (err) {
    // Direct tests and pre-registry compatibility callers use inline rules.
    logWarning("dispatch", `registry dispatch failed, falling back to inline rules: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (registry) {
    const action = annotateBackgroundable(await registry.evaluateDispatch(dispatchCtx));
    if (
      action.action === "dispatch" &&
      isVerificationExhausted(dispatchCtx, action.unitType, action.unitId)
    ) {
      return {
        action: "stop",
        reason: verificationExhaustedReason(action.unitId),
        level: "error",
      };
    }
    return applyLanguageDirectiveToDispatch(
      appendToolAffordanceToDispatch(action, dispatchCtx.basePath, dispatchCtx.sessionProvider),
      ctx.prefs,
    );
  }

  for (const rule of DISPATCH_RULES) {
    const result = await rule.match(dispatchCtx);
    if (result) {
      if (result.action !== "skip") result.matchedRule = rule.name;
      const action = annotateBackgroundable(result);
      if (
        action.action === "dispatch" &&
        isVerificationExhausted(dispatchCtx, action.unitType, action.unitId)
      ) {
        return {
          action: "stop",
          reason: verificationExhaustedReason(action.unitId),
          level: "error",
          matchedRule: rule.name,
        };
      }
      return applyLanguageDirectiveToDispatch(
        appendToolAffordanceToDispatch(action, dispatchCtx.basePath, dispatchCtx.sessionProvider),
        ctx.prefs,
      );
    }
  }

  // No rule matched — unhandled phase.
  // Use level "warning" so the loop pauses (resumable) instead of hard-stopping.
  // Hard-stop here was causing premature termination for transient phase gaps
  // (e.g. after reassessment modifies the roadmap and state needs re-derivation).
  return {
    action: "stop",
    reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
    level: "warning",
    matchedRule: "<no-match>",
  };
}


/** Exposed for testing — returns the rule names in evaluation order. */
export function getDispatchRuleNames(): string[] {
  return DISPATCH_RULES.map((r) => r.name);
}
