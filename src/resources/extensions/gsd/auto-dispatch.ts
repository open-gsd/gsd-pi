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
import { loadFile, extractUatType, loadActiveOverrides } from "./files.js";
import { getUatBrowserToolSupportError, type UatType } from "./uat-policy.js";
import {
  isDbAvailable,
  getMilestoneSlices,
  getMilestoneSliceSummaries,
  getClosedSliceIds,
  getPendingGatesForTurn,
  markPendingGatesOmittedForTurn,
  getMilestone,
  insertArtifact,
  insertAssessment,
  setSliceSketchFlag,
  transaction,
  getAssessment,
  getSliceRunUatAssessment,
} from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { extractVerdict, isAcceptableUatVerdict } from "./verdict-parser.js";

import {
  gsdRoot,
  resolveGsdPathContract,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  relTaskFile,
  relSliceFile,
  relMilestoneFile,
  buildMilestoneFileName,
  buildTaskFileName,
  gsdProjectionRoot,
} from "./paths.js";
import { validateArtifact } from "./schemas/validate.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { logWarning, logError } from "./workflow-logger.js";
import { dirname, join, sep } from "node:path";
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
import { isFlatPhaseMigrationInFlight } from "./flat-phase-migration.js";
import { composeToolAffordanceReminder } from "./unit-context-composer.js";
import {
  buildDiscussMilestonePrompt,
  buildDiscussProjectPrompt,
  buildDiscussRequirementsPrompt,
  buildResearchDecisionPrompt,
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
import { checkNeedsRunUat } from "./uat-dispatch.js";
import { normalizeModelFieldConfig, resolveModelWithFallbacksForUnit, resolveThinkingLevelForUnit } from "./preferences-models.js";
import { resolveUokFlags } from "./uok/flags.js";
import { selectReactiveDispatchBatch } from "./uok/execution-graph.js";
import { getMilestonePipelineVariant } from "./milestone-scope-classifier.js";
import { EXECUTION_ENTRY_PHASES, hasFinalizedMilestoneContext } from "./uok/plan-v2.js";
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
  PROJECT_RESEARCH_INFLIGHT_MARKER,
} from "./project-research-policy.js";
import {
  isWorkflowPrefsCaptured,
  resolveDeepProjectSetupState,
  type DeepProjectSetupStage,
} from "./deep-project-setup-policy.js";
import { annotateBackgroundable } from "./delegation-policy.js";
import { invalidateAllCaches } from "./cache.js";
import { insertMilestoneValidationGates } from "./milestone-validation-gates.js";
import { nativeHasChanges, nativeIsRepo, _resetHasChangesCache } from "./native-git-bridge.js";
import { debugLog, isDebugEnabled } from "./debug-logger.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import {
  captureMilestoneVerificationSourceRevision,
} from "./verification-source-integrity.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { isMilestoneLifecycleAdopted } from "./db/milestone-closeout-readiness.js";
import {
  grantMilestoneValidationWaiver,
  type MilestoneValidationWaiverReason,
} from "./milestone-validation-waiver-domain-operation.js";
import { detectWorktreeName } from "./worktree.js";
import { probeGitConflictState } from "./git-conflict-state.js";
import { runTurnGitAction } from "./git-service.js";
import { parseUnitId } from "./unit-id.js";
import { resolveExpectedArtifactPath, resolveExistingSliceResearchPath } from "./auto-artifact-paths.js";
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

function resolveExistingExpectedArtifact(
  unitType: string,
  unitId: string,
  basePath: string,
): string | null {
  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  return artifactPath && existsSync(artifactPath) ? artifactPath : null;
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
 * operation it wraps (loadSliceTaskIO, deriveTaskGraph, saveReactiveState) is
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

export async function readUatGateVerdict(
  basePath: string,
  mid: string,
  sliceId: string,
): Promise<{ verdict: string; uatType: UatType | undefined } | null> {
  const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT");
  const assessmentFile = resolveSliceFile(basePath, mid, sliceId, "ASSESSMENT");

  const uatContent = uatFile ? await loadFile(uatFile) : null;
  const uatType = uatContent ? extractUatType(uatContent) : undefined;

  const assessmentContent = assessmentFile ? await loadFile(assessmentFile) : null;
  if (assessmentContent) {
    // `reassess-roadmap` writes roadmap-scoped assessments to the same
    // S##-ASSESSMENT artifact path; those verdicts must not be treated as UAT.
    const assessmentRow = getAssessment(relSliceFile(basePath, mid, sliceId, "ASSESSMENT"));
    const assessmentScope = typeof assessmentRow?.["scope"] === "string"
      ? String(assessmentRow["scope"]).trim().toLowerCase()
      : "";
    if (assessmentScope === "roadmap") {
      return null;
    }

    // Backfilled assessments (#1258) are placeholders created during milestone
    // validation for completed slices that never produced a real UAT ASSESSMENT
    // (e.g. artifact-driven UAT that was never dispatched). Their fabricated
    // verdict must not be treated as a genuine UAT sign-off — otherwise "never
    // checked" is silently read as "passed". Skip the placeholder and fall
    // through to the authoritative run-uat DB row (which stays null unless a
    // real UAT was actually recorded).
    if (assessmentScope !== BACKFILL_ASSESSMENT_SCOPE) {
      const assessmentVerdict = extractVerdict(assessmentContent);
      if (assessmentVerdict) {
        return {
          verdict: assessmentVerdict,
          uatType: uatType ?? extractUatType(assessmentContent),
        };
      }
    }
  }

  if (uatContent) {
    const legacyUatVerdict = extractVerdict(uatContent);
    if (legacyUatVerdict) {
      return { verdict: legacyUatVerdict, uatType };
    }
  }

  // ADR-017 DB fallback: when the ASSESSMENT markdown is missing or orphaned
  // from its canonical path (e.g. after a milestone artifact-layout migration
  // moves slice artifacts from `phases/…` to `milestones/…`), consult the
  // authoritative assessments table by (mid, slice) identity instead of path.
  // `gsd_uat_result_save` always writes this row, so it is the source of truth.
  const runUatAssessment = getSliceRunUatAssessment(mid, sliceId);
  if (runUatAssessment?.status) {
    return {
      verdict: runUatAssessment.status,
      uatType: uatType ?? extractUatType(runUatAssessment.fullContent),
    };
  }

  return null;
}

/**
 * Deep planning mode: check whether any project-level stage gate
 * (workflow-preferences, discuss-project, discuss-requirements,
 * research-decision, research-project) still has work pending.
 *
 * Used by the milestone-level discuss rules to yield to project-level
 * deep-mode rules when the project hasn't finished its setup interview.
 * Returns false in light mode (or when prefs absent) so the milestone
 * rules behave exactly as before.
 */
export function getDeepStageGate(
  prefs: GSDPreferences | undefined,
  basePath: string,
  preview = false,
): DeepStageGate {
  return resolveDeepProjectSetupState(prefs, basePath, preview);
}

export function hasPendingDeepStage(
  prefs: GSDPreferences | undefined,
  basePath: string,
  preview = false,
): boolean {
  const gate = getDeepStageGate(prefs, basePath, preview);
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

/**
 * True when the slice's tasks live inside the slice plan file itself —
 * flat-phase phases/ layout with task checkboxes, or a renderPlanFromDb
 * `<tasks>` block — rather than as per-task PLAN files under tasks/.
 */
function slicePlanHasEmbeddedTasks(basePath: string, mid: string, sid: string): boolean {
  const slicePlanPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (!slicePlanPath || !existsSync(slicePlanPath)) return false;
  const content = readFileSync(slicePlanPath, "utf-8");
  const phasesRoot = join(gsdProjectionRoot(basePath), "phases");
  const isPhasesSlicePlan = slicePlanPath.startsWith(`${phasesRoot}${sep}`);
  const hasTaskCheckboxes = /^-\s+\[[ xX]\]\s+\*\*[\w.]+/m.test(content);
  return content.includes("<tasks>") || (isPhasesSlicePlan && hasTaskCheckboxes);
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

function hasMilestonePassedDiscuss(basePath: string, mid: string): boolean {
  if (!isDbAvailable()) return false;
  const slices = getMilestoneSlices(mid);
  for (const slice of slices) {
    const planPath = resolveSliceFile(basePath, mid, slice.id, "PLAN");
    if (planPath && existsSync(planPath)) return true;
  }
  return hasImplementationArtifacts(basePath, mid) === "present";
}

/**
 * Check for milestone slices missing SUMMARY files.
 * Returns array of missing slice IDs, or empty array if all present or DB unavailable.
 *
 * Excludes skipped slices (intentionally summary-less) and legacy-complete
 * slices whose DB status is authoritative even without on-disk SUMMARY (#3620).
 */
export function findMissingSummaries(basePath: string, mid: string): string[] {
  if (!isDbAvailable()) return [];
  const slices = getMilestoneSlices(mid);
  // Skipped slices never produce SUMMARYs; legacy-complete slices may lack them
  const CLOSED_STATUSES = new Set(["skipped", "complete", "done"]);
  return slices
    .filter(s => !CLOSED_STATUSES.has(s.status))
    .filter(s => {
      const summaryPath = resolveSliceFile(basePath, mid, s.id, "SUMMARY");
      return !summaryPath || !existsSync(summaryPath);
    })
    .map(s => s.id);
}

function stringField(row: Record<string, unknown> | null, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function stripGsdPrefix(path: string): string {
  return path.startsWith(".gsd/") ? path.slice(".gsd/".length) : path;
}

// Scope marker for assessments fabricated by the milestone-validation backfill
// (#1258). It keeps these placeholders distinguishable from genuine `run-uat`
// sign-offs so `readUatGateVerdict` never mistakes "never checked" for "passed".
const BACKFILL_ASSESSMENT_SCOPE = "backfill";

function persistSliceAssessmentBackfill(
  assessmentRelPath: string,
  mid: string,
  sliceId: string,
  content: string,
  fabricated: boolean,
): void {
  const artifactPath = stripGsdPrefix(assessmentRelPath);
  const existingAssessment =
    getAssessment(assessmentRelPath) ??
    getAssessment(artifactPath);
  // A newly fabricated placeholder is filed under a distinct scope; a pre-existing
  // on-disk ASSESSMENT keeps its real scope (default `run-uat`) so genuine
  // sign-offs are still honored.
  const scope = fabricated
    ? BACKFILL_ASSESSMENT_SCOPE
    : stringField(existingAssessment, "scope") ?? "run-uat";
  const status = stringField(existingAssessment, "status") ??
    extractVerdict(content)?.toLowerCase() ??
    "unknown";

  transaction(() => {
    insertArtifact({
      path: artifactPath,
      artifact_type: "ASSESSMENT",
      milestone_id: mid,
      slice_id: sliceId,
      task_id: null,
      full_content: content,
    });
    if (!getAssessment(assessmentRelPath)) {
      insertAssessment({
        path: assessmentRelPath,
        milestoneId: mid,
        sliceId,
        taskId: null,
        status,
        scope,
        fullContent: content,
      });
    }
  });
}

function backfillMissingAssessmentsFromSummaries(basePath: string, mid: string): void {
  // DB-authoritative (ADR-017): no markdown fallback. Without DB rows there
  // is nothing to backfill.
  if (!isDbAvailable()) return;
  // Canonical closed vocabulary (complete/done/skipped/closed) — a skipped or
  // closed slice with a SUMMARY gets the same assessment backfill treatment.
  for (const sliceId of getClosedSliceIds(mid)) {
    const summaryPath = resolveSliceFile(basePath, mid, sliceId, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) continue;

    const assessmentPath = resolveSliceFile(basePath, mid, sliceId, "ASSESSMENT")
      ?? join(basePath, relSliceFile(basePath, mid, sliceId, "ASSESSMENT"));
    if (!assessmentPath) continue;

    const assessmentRelPath = relSliceFile(basePath, mid, sliceId, "ASSESSMENT");
    const now = new Date().toISOString();
    const didCreateAssessment = !existsSync(assessmentPath);
    const content = didCreateAssessment ? [
      "---",
      `sliceId: ${sliceId}`,
      "verdict: PASS",
      // Distinguishing marker (#1258): this ASSESSMENT was fabricated to satisfy
      // the per-slice artifact requirement, NOT produced by a real UAT run. It
      // must not be read as a genuine UAT sign-off.
      "backfilled: true",
      "verified: false",
      `date: ${now}`,
      "---",
      "",
      `# Assessment — ${sliceId}`,
      "",
      "Auto-created during milestone validation because this completed slice had a SUMMARY but no ASSESSMENT artifact.",
      "This is a placeholder: no UAT was executed for this slice, so its verdict is not an independent sign-off.",
      "No additional reassessment changes were detected in this backfill step.",
      "",
    ].join("\n") : readFileSync(assessmentPath, "utf-8");

    if (isDbAvailable()) {
      try {
        persistSliceAssessmentBackfill(assessmentRelPath, mid, sliceId, content, didCreateAssessment);
      } catch (err) {
        logWarning("dispatch", `failed to backfill assessment DB rows for ${mid}/${sliceId}: ${(err as Error).message}`);
      }
    }

    if (didCreateAssessment) {
      atomicWriteSync(assessmentPath, content, "utf-8");
    }
  }
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
    atomicWriteSync(validationPath, content, "utf-8");
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

// ─── Disk-persisted rewrite attempt counter ──────────────────────────────────
// The counter must survive session restarts (crash recovery, pause/resume,
// step-mode). Storing it on the in-memory session object caused the circuit
// breaker to never trip — see https://github.com/open-gsd/gsd-pi/issues/2203
function rewriteCountPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "rewrite-count.json");
}

export function getRewriteCount(basePath: string): number {
  try {
    const data = JSON.parse(readFileSync(rewriteCountPath(basePath), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export function setRewriteCount(basePath: string, count: number): void {
  const filePath = rewriteCountPath(basePath);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: new Date().toISOString() }) + "\n");
}

// ─── Run-UAT dispatch counter (per-slice) ────────────────────────────────
// Caps run-uat dispatches to prevent infinite replay when verification
// commands fail before writing a verdict (#3624).
const MAX_UAT_ATTEMPTS = 3;

function uatCountPath(basePath: string, mid: string, sid: string): string {
  return join(resolveGsdPathContract(basePath).projectGsd, "runtime", `uat-count-${mid}-${sid}.json`);
}

export function getUatCount(basePath: string, mid: string, sid: string): number {
  try {
    const data = JSON.parse(readFileSync(uatCountPath(basePath, mid, sid), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export function incrementUatCount(basePath: string, mid: string, sid: string): number {
  const count = getUatCount(basePath, mid, sid) + 1;
  const filePath = uatCountPath(basePath, mid, sid);
  mkdirSync(join(resolveGsdPathContract(basePath).projectGsd, "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: new Date().toISOString() }) + "\n");
  return count;
}

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
      const pendingOverrides = await loadActiveOverrides(basePath);
      if (pendingOverrides.length === 0) return null;
      const count = getRewriteCount(basePath);
      if (count >= MAX_REWRITE_ATTEMPTS) {
        // Preview: same fall-through decision, no override resolution or
        // counter reset persisted.
        if (!preview) {
          const { resolveAllOverrides } = await import("./files.js");
          await resolveAllOverrides(basePath);
          setRewriteCount(basePath, 0);
        }
        return null;
      }
      if (!preview) setRewriteCount(basePath, count + 1);
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
    // #4671 — Recovery path for execution-entry phases with missing CONTEXT.md.
    //
    // Once `deriveStateFromDb` returns an execution-entry phase (executing /
    // summarizing / validating-milestone / completing-milestone), the
    // pre-planning guard at `pre-planning (no context) → discuss-milestone`
    // no longer fires. The plan-v2 gate correctly detects the missing context
    // but can only block — it cannot redispatch. Without this rule the
    // milestone is stuck until `/gsd doctor heal` repairs it (and heal
    // historically missed this check too).
    //
    // Fire BEFORE the execution-entry phase rules so we redispatch to
    // `discuss-milestone` instead of hitting the plan-v2 gate.
    name: "execution-entry phase (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, session, prefs, structuredQuestionsAvailable, preview }) => {
      if (!EXECUTION_ENTRY_PHASES.has(state.phase)) return null;
      if (!MILESTONE_ID_RE.test(mid)) return null;
      if (isRegistryMilestoneComplete(state, mid)) return null;
      // Resolve discuss/context artifacts against the active session worktree,
      // mirroring the executing rules below. For a suffixed-worktree milestone
      // the CONTEXT and slice plans live under the worktree, not the project
      // root; checking the raw project-root basePath misreads the milestone as
      // "never discussed" and re-dispatches discuss-milestone after task
      // closeout instead of continuing execution (#1317).
      const artifactBasePath = resolveArtifactBasePath(basePath, mid, session);
      // The layout migration moves .gsd/milestones/ aside before rendering
      // .gsd/phases/, so mid-flight the slice plans exist in neither layout.
      // A dispatch landing in that window reads "never discussed" and re-plans a
      // milestone that is already fully planned in the DB, discarding the plan.
      // Startup dispatch races the migration on every run, so decline to decide
      // while the layout is converting; the next iteration sees a settled tree.
      // Scoped to a migration actually in flight — a settled legacy project must
      // still reach this rule (#4671).
      if (isFlatPhaseMigrationInFlight(artifactBasePath)) return null;
      if (hasMilestonePassedDiscuss(artifactBasePath, mid)) return null;
      // Align with the plan-v2 gate's lookup semantics: whitespace-only counts
      // as missing, and an auto worktree may fall back to GSD_PROJECT_ROOT.
      if (hasFinalizedMilestoneContext(artifactBasePath, mid)) return null;
      // H6 fix (#4973): non-deep auto-mode has no human to answer the
      // depth-verification question, so pre-marking avoids a write-gate
      // deadlock. Deep planning is still user-driven even inside auto-mode,
      // so it must wait for explicit approval instead of taking this bypass.
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
      const attempts = getUatCount(basePath, mid, sliceId);
      if (attempts >= MAX_UAT_ATTEMPTS) {
        return {
          action: "stop" as const,
          reason: `Cannot dispatch run-uat for ${mid}/${sliceId}: retry limit reached after ${attempts} attempt(s) without a PASS assessment. Fix the underlying UAT/tool issue, reset the retry counter with /gsd doctor --fix, then rerun /gsd auto.`,
          level: "warning" as const,
        };
      }
      // Preview must not burn a retry attempt; the dispatch decision is shared.
      if (!preview) incrementUatCount(basePath, mid, sliceId);
      const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT")!;
      const uatContent = await loadFile(uatFile);
      return {
        action: "dispatch",
        unitType: "run-uat",
        unitId: `${mid}/${sliceId}`,
        prompt: await buildRunUatPrompt(
          mid,
          sliceId,
          relSliceFile(basePath, mid, sliceId, "UAT"),
          uatContent ?? "",
          basePath,
        ),
        pauseAfterDispatch: !process.env.GSD_HEADLESS && uatType !== "artifact-driven" && uatType !== "browser-executable" && uatType !== "runtime-executable",
      };
    },
  },
  {
    name: "uat-verdict-gate (non-PASS observed; closeout enforces)",
    match: async ({ mid, basePath, prefs }) => {
      // Only applies when UAT dispatch is enabled
      if (!prefs?.uat_dispatch) return null;

      // DB-authoritative (ADR-017): closed slices come from the DB only; the
      // ROADMAP projection is never parsed for gate decisions.
      if (!isDbAvailable()) return null;
      for (const sliceId of getClosedSliceIds(mid)) {
        const result = await readUatGateVerdict(basePath, mid, sliceId);
        if (!result) continue;
        const { verdict, uatType } = result;

        if (!isAcceptableUatVerdict(verdict, uatType)) {
          // Observe non-PASS verdicts without hard-stopping auto-mode. Allow
          // progression so follow-up slices can remediate, while
          // complete-milestone still enforces manual UAT PASS sign-off before closure.
          continue;
        }
      }
      return null;
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
      // research-decision, research-project) when any of them still have
      // work pending. Without this guard, the milestone discuss rule wins
      // before the deep rules ever get a chance to fire.
      if (hasPendingDeepStage(prefs, basePath, preview)) return null;
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
      if (isWorkflowPrefsCaptured(basePath)) return null; // already captured — fall through
      // Preview: report the same fall-through without writing the defaults.
      if (!preview) ensureWorkflowPreferencesCaptured(basePath);
      return null;
    },
  },
  {
    // Deep mode stage gate: PROJECT.md missing or invalid.
    // Fires only when planning_depth === "deep" and PROJECT.md is missing/invalid.
    // Project-level interview must complete before any milestone-level discussion.
    // Light mode (default) skips this rule entirely — falls through to milestone rules.
    name: "deep: pre-planning (no PROJECT) → discuss-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (existsSync(projectPath) && validateArtifact(projectPath, "project").ok) return null; // PROJECT.md valid — fall through
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
    // Deep mode stage gate: REQUIREMENTS.md missing or invalid.
    // Fires only when planning_depth === "deep", PROJECT.md is valid, and
    // REQUIREMENTS.md is missing/invalid.
    // Falls through in light mode or when REQUIREMENTS.md already exists and is valid.
    name: "deep: pre-planning (no REQUIREMENTS) → discuss-requirements",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (!existsSync(projectPath) || !validateArtifact(projectPath, "project").ok) return null; // PROJECT.md missing/invalid — earlier rule handles
      const requirementsPath = join(gsdRoot(basePath), "REQUIREMENTS.md");
      if (existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok) return null; // REQUIREMENTS.md valid — fall through
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
    // Deep mode research gate: capture user's research decision.
    // Fires after discuss-requirements (REQUIREMENTS.md exists) when no decision
    // marker has been written yet. Asks one yes/no question via ask_user_questions
    // and writes .gsd/runtime/research-decision.json. Downstream research-project
    // rule reads the marker to decide whether to fan out 4 parallel research subagents.
    // Light mode skips entirely.
    name: "deep: pre-planning (no research decision) → research-decision",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable, preview }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const gate = resolveDeepProjectSetupState(prefs, basePath, preview);
      if (gate.status !== "pending" || gate.stage !== "research-decision") return null;
      return {
        action: "dispatch",
        unitType: "research-decision",
        unitId: "RESEARCH-DECISION",
        prompt: await buildResearchDecisionPrompt(basePath, structuredQuestionsAvailable),
      };
    },
  },
  {
    // Deep mode parallel research.
    // Fires when planning_depth === "deep", REQUIREMENTS.md exists,
    // research-decision marker says "research", and any of the 4 project
    // research files is missing. Spawns one orchestrator session that fans
    // out 4 parallel subagents (stack, features, architecture, pitfalls).
    // Skipped entirely when user chose "skip" at the research-decision gate.
    name: "deep: pre-planning (research approved, files missing) → research-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable, sessionProvider, preview }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const gate = resolveDeepProjectSetupState(prefs, basePath, preview);
      if (gate.status === "blocked" && gate.stage === "project-research") {
        return {
          action: "stop" as const,
          reason: gate.reason,
          level: "warning" as const,
        };
      }
      if (gate.status !== "pending" || gate.stage !== "project-research") return null;
      // Idempotency guard: one orchestrator owns the project research fan-out
      // until guided-research-project.md deletes this marker during closeout.
      const runtimeDir = join(gsdRoot(basePath), "runtime");
      const inflightMarkerPath = join(runtimeDir, PROJECT_RESEARCH_INFLIGHT_MARKER);
      const researchInFlightStop = {
        action: "stop" as const,
        reason:
          "Project research is already in progress. Wait for it to finish, or clear `.gsd/runtime/research-project-inflight` if the prior run crashed.",
        level: "info" as const,
      };
      if (existsSync(inflightMarkerPath)) return researchInFlightStop;
      // Preview: the in-flight marker is a dispatch effect — report the
      // dispatch without claiming the fan-out.
      if (!preview) {
        mkdirSync(runtimeDir, { recursive: true });
        try {
          writeFileSync(
            inflightMarkerPath,
            JSON.stringify({ started: new Date().toISOString() }) + "\n",
            { encoding: "utf-8", flag: "wx" },
          );
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
            return researchInFlightStop;
          }
          throw err;
        }
      }
      try {
        const prompt = await researchProjectPromptBuilder(basePath, structuredQuestionsAvailable, sessionProvider);
        return {
          action: "dispatch",
          unitType: "research-project",
          unitId: "RESEARCH-PROJECT",
          prompt,
        };
      } catch (err) {
        try {
          // Preview never created the marker — unlinking could delete one a
          // concurrent dispatch just created (#2230).
          if (!preview && existsSync(inflightMarkerPath)) unlinkSync(inflightMarkerPath);
        } catch (cleanupErr) {
          logWarning(
            "dispatch",
            `failed to remove research-project in-flight marker after prompt assembly error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
        throw err;
      }
    },
  },
  {
    name: "pre-planning (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, session, structuredQuestionsAvailable, preview }) => {
      if (state.phase !== "pre-planning") return null;
      if (isRegistryMilestoneComplete(state, mid)) return null;
      const contextBasePath = resolveWorktreeProjectRoot(basePath, session?.originalBasePath);
      const contextFile =
        resolveMilestoneFile(basePath, mid, "CONTEXT") ??
        (contextBasePath !== basePath ? resolveMilestoneFile(contextBasePath, mid, "CONTEXT") : null);
      const hasContext = !!(contextFile && (await loadFile(contextFile)));
      if (hasContext) return null; // fall through to next rule
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
      const researchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      if (researchFile) return null; // has research, fall through
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
    match: async ({ state, mid, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (!prefs?.phases?.require_slice_discussion) return null;
      if (!state.activeSlice) return null;
      // Only pause if the slice has no context file yet (discussion not done).
      // resolveSliceFile returns null when the file does not exist on disk,
      // but cachedReaddir could return a stale hit — verify with existsSync
      // so the guard is defence-in-depth and the contract is explicit at the
      // call site.
      const sliceContextFile = resolveSliceFile(basePath, mid, state.activeSlice.id, "CONTEXT");
      if (sliceContextFile && existsSync(sliceContextFile)) return null; // discussion already done, proceed

      const closedSliceIds = getClosedSliceIds(mid);
      const justClosedSliceId = closedSliceIds[closedSliceIds.length - 1];
      let priorVerdictWarning = "";
      if (justClosedSliceId) {
        const prior = await readUatGateVerdict(basePath, mid, justClosedSliceId);
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
      const dbSlices = getMilestoneSliceSummaries(mid);
      if (dbSlices.length === 0) return null;

      // Find slices that need research (no RESEARCH file, dependencies done).
      // Milestone research informs slice research; it does not satisfy the
      // per-slice RESEARCH artifact contract.
      const researchReadySlices: Array<{ id: string; title: string }> = [];

      for (const slice of dbSlices) {
        if (slice.done) continue;
        // Skip if already has research
        if (resolveExistingSliceResearchPath(basePath, mid, slice.id)) continue;
        // Skip if dependencies aren't done (check for SUMMARY files)
        const depsComplete = slice.depends.every((depId) =>
          !!resolveExistingExpectedArtifact("complete-slice", `${mid}/${depId}`, basePath),
        );
        if (!depsComplete) continue;

        researchReadySlices.push({ id: slice.id, title: slice.title });
      }

      // Only dispatch parallel if 2+ slices are ready
      if (researchReadySlices.length < 2) return null;

      // #4414: If a previous parallel-research attempt escalated to a blocker
      // placeholder, skip this rule and fall through to per-slice research
      // (or other rules) rather than re-dispatching the same failing unit.
      const parallelBlocker =
        resolveExistingExpectedArtifact("research-slice", `${mid}/parallel-research`, basePath) ??
        resolveMilestoneFile(basePath, mid, "PARALLEL-BLOCKER");
      if (parallelBlocker) return null;

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
      if (resolveExistingSliceResearchPath(basePath, mid, sid)) return null; // has research, fall through
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
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry, sessionProvider, preview }) => {
      if (state.phase !== "refining") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;

      // Crash recovery: if PLAN exists but DB still says sketch, heal and
      // skip so the next loop re-derives phase from corrected DB state.
      if (isDbAvailable()) {
        const planFile = resolveSliceFile(basePath, mid, sid, "PLAN");
        if (planFile && existsSync(planFile)) {
          // Preview shares the skip decision; only the heal write is
          // suppressed.
          if (!preview) setSliceSketchFlag(mid, sid, false);
          return { action: "skip" };
        }
      }

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
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, sessionProvider, session }) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      // #4551: Consume any persisted pre-exec failure for this slice so the
      // re-dispatched prompt includes the exact blocked references. Clear the
      // field immediately after reading to prevent stale context leaking into
      // a later, unrelated plan-slice run.
      const unitId = `${mid}/${sid}`;
      let priorPreExecFailure: { blockingFindings: string[]; verdictExcerpt: string } | undefined;
      if (session?.lastPreExecFailure?.unitId === unitId) {
        // beginPreExecRepair owns the retry cap and pauses for human review.
        // If the user resumes, always give the planner the persisted findings;
        // stopping here would discard the exact repair signal pause preserved.
        priorPreExecFailure = {
          blockingFindings: session.lastPreExecFailure.blockingFindings,
          verdictExcerpt: session.lastPreExecFailure.verdictExcerpt,
        };
        session.lastPreExecFailure = null;
      }
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId,
        prompt: await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          undefined,
          { sessionContextWindow, modelRegistry, sessionProvider, priorPreExecFailure },
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
      if (resolveSliceFile(basePath, mid, sid, "REACTIVE-BLOCKER")) return null;
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
          : await loadSliceTaskIO(basePath, mid, sid);
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

        // Log graph metrics for observability
        const metrics = graphMetrics(graph);
        process.stderr.write(
          `gsd-reactive: ${mid}/${sid} graph — tasks:${metrics.taskCount} edges:${metrics.edgeCount} ` +
          `ready:${metrics.readySetSize} dispatching:${selected.length} ambiguous:${metrics.ambiguous}\n`,
        );

        // Persist dispatched batch so verification and recovery can check
        // exactly which tasks were sent. Preview reports the batch without
        // persisting it.
        if (!preview) {
          const { saveReactiveState } = await import("./reactive-graph.js");
          saveReactiveState(basePath, mid, sid, {
            sliceId: sid,
            completed: [...completed],
            dispatched: selected,
            graphSnapshot: metrics,
            updatedAt: new Date().toISOString(),
          });
        }

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
    name: "executing → execute-task (recover missing task plan → plan-slice)",
    match: async ({ state, mid, midTitle, basePath, session, sessionContextWindow, modelRegistry, sessionProvider, preview }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const tid = state.activeTask.id;
      const unitId = `${mid}/${sid}`;
      const artifactBasePath = resolveArtifactBasePath(basePath, mid, session);

      // Guard: if the slice plan exists but the individual task plan files are
      // missing, the planner created S##-PLAN.md with task entries but never
      // wrote the tasks/ directory files. Dispatch plan-slice to regenerate
      // them rather than hard-stopping — fixes the infinite-loop described in
      // issue #909. Flat-phase layout embeds tasks in the slice plan file, so
      // skip recovery when tasks are embedded (<tasks> block or task checkboxes in phases/ plan).
      const taskPlanPath = resolveTaskFile(artifactBasePath, mid, sid, tid, "PLAN");
      // tasksEmbeddedInSlicePlan is true when tasks live inside the slice plan
      // (flat-phase phases/ layout with task checkboxes or renderPlanFromDb <tasks> block).
      const tasksEmbeddedInSlicePlan = slicePlanHasEmbeddedTasks(artifactBasePath, mid, sid);
      const projectionTaskPlanPath = join(
        gsdProjectionRoot(artifactBasePath),
        "milestones",
        mid,
        "slices",
        sid,
        "tasks",
        buildTaskFileName(tid, "PLAN"),
      );
      if (
        (!taskPlanPath || !existsSync(taskPlanPath)) &&
        !existsSync(projectionTaskPlanPath) &&
        !tasksEmbeddedInSlicePlan
      ) {
        // #1640: a fresh worktree created after an incomplete-milestone
        // teardown starts with no .gsd markdown (the tree is gitignored), even
        // though the authoritative DB rows for the active slice survive. The
        // DB is the single source of truth and the PLAN projection is always
        // re-renderable from it, so heal the gap here instead of stopping
        // (#1520) or burning plan-slice retries (#909). renderPlanFromDb
        // resolves the existing descriptor dir via resolveMilestonePath /
        // targetSliceFile, so the heal lands beside the phase's other
        // artifacts rather than at a hardcoded canonical path.
        let planRenderError: string | null = null;
        if (!resolveSliceFile(artifactBasePath, mid, sid, "PLAN")) {
          if (preview) {
            // Preview: the re-render is a PLAN projection write. Mirror the
            // failure-free outcome read-only: renderPlanFromDb writes only
            // after the slice and its active tasks resolve from the DB, and
            // its rendered plan always carries a <tasks> block — so a real
            // turn would restore the PLAN, see embedded tasks, and fall
            // through to the normal execute-task rule (#2230). Otherwise the
            // render would throw and reach the same replan decision below.
            const { getSlice, getSliceTasks } = await import("./gsd-db.js");
            if (
              isDbAvailable() &&
              getSlice(mid, sid) &&
              getSliceTasks(mid, sid).some((task) => task.status !== "skipped")
            ) {
              session?.missingTaskPlanRetryCount?.delete(unitId);
              return null;
            }
          } else {
            try {
              const { renderPlanFromDb } = await import("./markdown-renderer.js");
              const rendered = await renderPlanFromDb(artifactBasePath, mid, sid);
              process.stderr.write(
                `gsd-projection-heal: re-rendered missing slice PLAN for ${unitId} from the DB at ${rendered.planPath}\n`,
              );
            } catch (err) {
              // A Windows sharing violation is transient contention, not a DB
              // projection gap. Preserve it as a typed throw so Recovery
              // Classification routes through the loop's existing retry budget.
              throwIfTransientProjectionLockError(err);
              // Fail loud below: a DB that genuinely lacks the slice rows is a
              // real error, and the stop diagnosis reports it verbatim.
              planRenderError = err instanceof Error ? err.message : String(err);
              logWarning(
                "dispatch",
                `slice PLAN re-render from DB failed for ${unitId}: ${planRenderError}`,
              );
            }
            if (slicePlanHasEmbeddedTasks(artifactBasePath, mid, sid)) {
              session?.missingTaskPlanRetryCount?.delete(unitId);
              // PLAN restored — fall through to the normal execute-task rule.
              return null;
            }
          }
        }
        // #1520: if the slice plan with embedded tasks exists at the original
        // project root but not in the active worktree, the root→worktree state
        // projection is broken or stale. Re-planning the slice cannot repair a
        // projection gap — it would burn both retries and then misreport the
        // failure as "missing task plans". Stop immediately with an accurate
        // diagnosis instead. When the root plan is also absent or carries no
        // embedded tasks, the #909 replan recovery below still applies.
        const originalRoot = session?.originalBasePath;
        if (
          originalRoot &&
          originalRoot !== artifactBasePath &&
          slicePlanHasEmbeddedTasks(originalRoot, mid, sid)
        ) {
          session?.missingTaskPlanRetryCount?.delete(unitId);
          return {
            action: "stop",
            reason: `${unitId}: the slice plan with embedded tasks exists at the project root but is missing from the active worktree, and re-rendering it from the workflow database failed${planRenderError ? ` (${planRenderError})` : ""} — re-planning cannot fix a projection gap. Run /gsd rebuild markdown to restore projections from the authoritative DB, then run /gsd auto to resume.`,
            level: "error",
          };
        }
        const MAX_MISSING_TASK_PLAN_RETRIES = 2;
        const retryCount = session?.missingTaskPlanRetryCount?.get(unitId) ?? 0;
        if (retryCount >= MAX_MISSING_TASK_PLAN_RETRIES) {
          session?.missingTaskPlanRetryCount?.delete(unitId);
          return {
            action: "stop",
            reason: `Missing task-plan recovery failed ${retryCount} times for ${unitId} - manual intervention required. Task plan ${tid} is still missing after regenerating the slice plan. Fix the task-plan files manually, then run /gsd auto to resume.`,
            level: "error",
          };
        }
        session?.missingTaskPlanRetryCount?.set(unitId, retryCount + 1);
        if (isDebugEnabled()) {
          const expectedTaskPlanPath = join(artifactBasePath, relTaskFile(artifactBasePath, mid, sid, tid, "PLAN"));
          const originalProjectRoot = session?.originalBasePath || basePath;
          const activeMilestoneWorktreePath = session?.basePath || basePath;
          const expectedTaskPlanExists = existsSync(expectedTaskPlanPath);
          debugLog("dispatch-missing-task-plan-recovery", {
            selectedDispatchRule: "executing → execute-task (recover missing task plan → plan-slice)",
            basePathUsedForArtifactChecks: artifactBasePath,
            milestoneRoot: artifactBasePath,
            originalProjectRoot,
            activeMilestoneWorktreePath,
            hasRootWorktreeMismatch: originalProjectRoot !== activeMilestoneWorktreePath,
            expectedTaskPlanPath,
            projectionTaskPlanPath,
            expectedTaskPlanExists,
            // Retained for compatibility with existing diagnostic parsers.
            artifactExists: expectedTaskPlanExists,
            projectionArtifactExists: existsSync(projectionTaskPlanPath),
          });
        }
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId,
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
      }

      session?.missingTaskPlanRetryCount?.delete(unitId);
      return null;
    },
  },
  {
    name: "executing → execute-task",
    match: async ({ state, mid, basePath, session, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "executing") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const retryUnitId = session?.pendingVerificationRetry?.unitId;
      if (retryUnitId) {
        const { milestone: retryMid, slice: retrySid, task: retryTid } = parseUnitId(retryUnitId);
        if (retryMid === mid && retrySid === sid && retryTid) {
          const retryAbort = readExecuteTaskTerminalAbort(retryMid, retrySid, retryTid);
          if (retryAbort) return retryAbort;
          const retryTitle = state.activeTask?.id === retryTid
            ? state.activeTask.title
            : retryTid;
          return {
            action: "dispatch",
            unitType: "execute-task",
            unitId: retryUnitId,
            prompt: await buildExecuteTaskPrompt(
              mid,
              sid,
              sTitle,
              retryTid,
              retryTitle,
              basePath,
              { sessionContextWindow, modelRegistry, sessionProvider },
            ),
          };
        }
      }

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

      // Legacy validation still consumes SUMMARY projections. Adopted validation
      // reads canonical evidence and cannot be blocked by a missing projection.
      if (!adoptedMilestone) {
        const missingSlices = findMissingSummaries(basePath, mid);
        if (missingSlices.length > 0) {
          return {
            action: "stop",
            reason: `Cannot validate milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. These slices may have been skipped.`,
            level: "error",
          };
        }
      }

      // #6225: validation requires per-slice ASSESSMENT artifacts (MV02), but
      // the default auto path can complete all slices without creating them.
      // Backfill no-change assessments for completed slices that already have
      // SUMMARY evidence before dispatching validate-milestone. Preview skips
      // the backfill writes; the dispatch decision below is unaffected.
      if (!adoptedMilestone && !preview) backfillMissingAssessmentsFromSummaries(basePath, mid);

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
        const mDir = resolveMilestonePath(artifactBasePath, mid) ??
          (projectRoot !== artifactBasePath ? resolveMilestonePath(projectRoot, mid) : null);
        if (!mDir) {
          return {
            action: "stop",
            reason: `Cannot skip milestone validation for ${mid}: milestone artifacts are missing under ${artifactBasePath}. Run /gsd doctor before resuming auto-mode.`,
            level: "warning",
          };
        }
        // Use relMilestoneFile for the layout-aware filename:
        //   legacy   → milestones/M001/M001-VALIDATION.md
        //   flat-phase → phases/01-slug/01-VALIDATION.md
        // When the milestone dir is only in the project root (worktree has none),
        // write to the project root so the artifact lands in the canonical location.
        const writeBase = resolveMilestonePath(artifactBasePath, mid) != null ? artifactBasePath : projectRoot;
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
        atomicWriteSync(validationPath, content, "utf-8");
        try {
          // DB-backed state derivation keys off assessments, not only the file
          // projection. Persist the skipped validation there too so the next
          // loop iteration advances to completing-milestone instead of
          // re-entering validating-milestone.
          if (isDbAvailable()) {
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
          }
        } catch (err) {
          try {
            removeProjectionFileSync(validationPath);
          } catch (unlinkErr) {
            logWarning(
              "dispatch",
              `failed to remove skipped validation file after DB write failure for ${mid}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
            );
          }
          throw err;
        }
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
        const milestone = getMilestone(mid);
        if (milestone && !isClosedStatus(milestone.status)) {
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
    const milestone = getMilestone(dispatchCtx.mid);
    if (!milestone) {
      return {
        action: "stop",
        reason: `Cannot dispatch milestone ${dispatchCtx.mid}: milestone is missing from the workflow DB.`,
        level: "error",
      };
    }
    if (isClosedStatus(milestone.status)) {
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
      dispatchCtx.session?.exhaustedVerificationUnits?.has(`${action.unitType}:${action.unitId}`)
    ) {
      return {
        action: "stop",
        reason: `Unit ${action.unitId} exhausted verification retries this session.`,
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
        dispatchCtx.session?.exhaustedVerificationUnits?.has(`${action.unitType}:${action.unitId}`)
      ) {
        return {
          action: "stop",
          reason: `Unit ${action.unitId} exhausted verification retries this session.`,
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
