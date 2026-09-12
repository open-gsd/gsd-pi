/**
 * GSD Guided Flow — Smart Entry Wizard
 *
 * One function: showSmartEntry(). Reads state from disk, shows a contextual
 * wizard via showNextAction(), and dispatches through GSD-WORKFLOW.md.
 * No execution state, no hooks, no tools — the LLM does the rest.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { showNextAction } from "../shared/tui.js";
import {
  notifyDiscussNeedsInteractiveMenu,
  notifySmartEntryNeedsInteractiveMenu,
  requiresInteractiveMenu,
  isInteractiveCommandContext,
} from "./command-feedback.js";
import { loadFile, saveFile } from "./files.js";
import { isDbAvailable, getMilestone, getMilestoneSlices, insertMilestone } from "./gsd-db.js";
import { parseRoadmapSlices } from "./roadmap-slices.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  buildCompleteSlicePrompt,
  buildDiscussMilestonePrompt,
  buildExecuteTaskPrompt,
  buildPlanMilestonePrompt,
  buildPlanSlicePrompt,
  buildSkillActivationBlock,
  capPreamble,
} from "./auto-prompts.js";
import { deriveState, isGhostMilestone } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { startAutoDetached } from "./auto.js";
import { clearLock } from "./crash-recovery.js";
import {
  assessInterruptedSession,
  formatInterruptedSessionRunningMessage,
  formatInterruptedSessionSummary,
} from "./interrupted-session.js";
import { listUnitRuntimeRecords, clearUnitRuntimeRecord, isInFlightRuntimePhase } from "./unit-runtime.js";
import { resolveExpectedArtifactPath } from "./auto.js";
import { gsdHome } from "./gsd-home.js";
import {
  gsdRoot, milestonesDir, legacyMilestonesDir, resolveMilestoneFile,
  resolveSliceFile, resolveSlicePath, resolveGsdRootFile, relGsdRootFile,
  relMilestoneFile, relSliceFile, relSlicePath, clearPathCache,
} from "./paths.js";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { removeProjectionTreeSync } from "./atomic-write.js";
import { readSessionLockData, isSessionLockProcessAlive } from "./session-lock.js";
import { nativeAddAll, nativeCommit, nativeHasCommittedHead, nativeIsRepo, nativeInit } from "./native-git-bridge.js";
import { isInheritedRepo } from "./repo-identity.js";
import { ensureGitignore, ensurePreferences, untrackRuntimeFiles } from "./gitignore.js";
import { getIsolationMode, loadEffectiveGSDPreferences, renderLanguageDirectiveForPrompt } from "./preferences.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { resolveUokFlags } from "./uok/flags.js";
import { ensurePlanV2Graph, isMissingFinalizedContextResult } from "./uok/plan-v2.js";
import { detectProjectState, hasGsdBootstrapArtifacts } from "./detection.js";
import { isFutureMilestoneStatus } from "./status-guards.js";
import { showProjectInit, offerMigration } from "./init-wizard.js";
import { validateDirectory } from "./validate-directory.js";
import { showConfirm } from "../shared/tui.js";
import { debugLog } from "./debug-logger.js";
import { findMilestoneIds, clearReservedMilestoneIds, normalizeDiscussTarget } from "./milestone-ids.js";
import { nextMilestoneIdReserved } from "./milestone-id-reservation.js";
export { nextMilestoneIdReserved } from "./milestone-id-reservation.js";
import { parkMilestone, discardMilestone } from "./milestone-actions.js";
import {
  buildCloseoutMenuActions,
  buildIdleMenuSummary,
  getPrimaryCloseoutRecommendation,
  handleCloseoutChoice,
  loadCloseoutContext,
} from "./closeout-wizard.js";
import {
  buildRequirementsBacklogDiscussContext,
  countUnmappedActiveRequirements,
  showRequirementsBacklogReview,
} from "./requirements-backlog.js";
import { selectAndApplyModel, getRegisteredToolSnapshot } from "./auto-model-selection.js";
import { DISCUSS_TOOLS_ALLOWLIST } from "./constants.js";
import {
  detectWorkflowMcpLaunchConfig,
  resolveWorkflowMcpProjectRoot,
  supportsStructuredQuestions,
} from "./workflow-mcp.js";
import { usesWorkflowMcpTransport } from "./question-transport.js";
import {
  getCachedWorkflowMcpProbe,
  probeAndCacheWorkflowMcp,
  warmWorkflowMcpProbeInBackground,
  workflowMcpProbeAdvertisesSurface,
  WORKFLOW_MCP_PROBE_TIMEOUT_MS,
} from "./workflow-mcp-readiness-cache.js";
import { probeCoversRequiredWorkflowTools } from "./tool-surface-readiness.js";
import { getRequiredWorkflowToolsForUnit } from "./unit-tool-contracts.js";
import { isWorkflowToolSurfaceName } from "./workflow-tool-surface.js";
import { getUnitWorkflowDispatchReadinessErrorForModel } from "./tool-contract.js";
import {
  runPreparation,
  formatCodebaseBrief,
  formatPriorContextBrief,
} from "./preparation.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { countPlanMilestoneRoadmapSlices } from "./artifact-verification.js";
import { createWorkspace, scopeMilestone, type MilestoneScope } from "./workspace.js";
import { clearPendingGate, extractDepthVerificationMilestoneId, getPendingGate } from "./bootstrap/write-gate.js";
import {
  _getPendingAutoStart,
  clearPendingAutoStart,
  deletePendingAutoStart,
  getDiscussionMilestoneId,
  hasPendingAutoStart,
  setPendingAutoStart,
} from "./pending-auto-start.js";
import { clearGuidedUnitContext, setGuidedUnitContext } from "./guided-unit-context.js";
import { checkAutoStartAfterDiscuss, scheduleAutoStartAfterIdle } from "./discussion-handoff.js";
import { resolveSubagentRoleForProvider } from "./subagent-role-resolver.js";
export {
  maybeHandleEmptyIntentTurn,
  maybeHandleReadyPhraseWithoutFiles,
  resetEmptyTurnCounter,
} from "./guided-unit-completion.js";

export {
  _getPendingAutoStart,
  clearPendingAutoStart,
  getDiscussionMilestoneId,
  setPendingAutoStart,
} from "./pending-auto-start.js";
export { checkAutoStartAfterDiscuss } from "./discussion-handoff.js";

/**
 * Cap on how many quarantined file paths are listed by name in the self-heal
 * notification before collapsing the rest into a "…and N more" summary line
 * -- purely a display limit (e.g. a mass-rebuild quarantining 90 files
 * shouldn't dump 90 lines into one notification), not a meaningful count.
 */
const MAX_QUARANTINED_PATHS_SHOWN = 5;

/**
 * Format the self-heal auto-rebuild success notification, including a note
 * about any quarantined pre-rebuild bytes. rebuildMarkdownProjectionsFromDb
 * already preserves externally-edited content into .gsd/quarantine/projections/
 * before overwriting it with the DB's rendered version, but the auto-rebuild
 * notification previously never mentioned this — a user could lose track of
 * richer hand-authored content that got silently replaced with a sparser
 * DB-derived render, with no visible pointer to where the original bytes went.
 */
export function formatMarkdownSelfHealNotification(rebuild: {
  rendered: number;
  errors: readonly string[];
  quarantined: number;
  quarantinedPaths: readonly string[];
}): { message: string; level: "info" | "warning" } {
  const quarantineNote = rebuild.quarantined > 0
    ? `\n${rebuild.quarantined} file(s) had content that differed from the last DB-rendered version — `
      + `the pre-rebuild bytes were preserved, not discarded, under:\n`
      + rebuild.quarantinedPaths.slice(0, MAX_QUARANTINED_PATHS_SHOWN).map((p) => `  ${p}`).join("\n")
      + (rebuild.quarantinedPaths.length > MAX_QUARANTINED_PATHS_SHOWN
        ? `\n  …and ${rebuild.quarantinedPaths.length - MAX_QUARANTINED_PATHS_SHOWN} more`
        : "")
      + "\nReview those files before assuming the rebuilt markdown is complete — "
      + "the DB row may be sparser than what was quarantined."
    : "";
  const message = `Self-heal: rebuilt markdown projections from the authoritative DB `
    + `(${rebuild.rendered} rendered${rebuild.errors.length > 0 ? `, ${rebuild.errors.length} error(s)` : ""}).`
    + quarantineNote;
  const level = rebuild.errors.length > 0 || rebuild.quarantined > 0 ? "warning" : "info";
  return { message, level };
}

export function shouldSkipGitBootstrapAfterInit(result: { gitEnabled?: boolean }): boolean {
  return result.gitEnabled === false;
}

// ─── Re-exports (preserve public API for existing importers) ────────────────
export {
  MILESTONE_ID_RE, generateMilestoneSuffix, nextMilestoneId,
  extractMilestoneSeq, parseMilestoneId, milestoneIdSort,
  maxMilestoneNum, findMilestoneIds,
  reserveMilestoneId, claimReservedId, getReservedMilestoneIds, clearReservedMilestoneIds,
} from "./milestone-ids.js";
export {
  showQueue, handleQueueReorder, showQueueAdd,
  buildExistingMilestonesContext,
} from "./guided-flow-queue.js";
import { logWarning } from "./workflow-logger.js";
import { deleteRuntimeKv } from "./db/runtime-kv.js";
import { PAUSED_SESSION_KV_KEY } from "./interrupted-session.js";
import {
  clearMarkdownAutoRebuildBackoff,
  recordMarkdownAutoRebuildFailure,
  shouldAttemptMarkdownAutoRebuild,
} from "./markdown-auto-rebuild-backoff.js";
import { buildWorkflowDispatchContent } from "./workflow-protocol.js";
import { isFullGsdToolSurfaceRequested, restoreGsdWorkflowTools, scopeGsdWorkflowToolsForDispatch } from "./bootstrap/register-hooks.js";
import {
  resolveActiveTaskChoiceRoute,
  type ActiveTaskChoice,
} from "./smart-entry-routing.js";

export { resolveGuidedExecuteLaunchMode } from "./smart-entry-routing.js";

export interface HeadlessMilestoneCreationOptions {
  startAutoAfterReady?: boolean;
}

export const _scheduleAutoStartAfterIdleForTest = scheduleAutoStartAfterIdle;

// ─── Scope-based validator wrappers ──────────────────────────────────────────
// These thin wrappers accept a MilestoneScope so callers that already hold a
// pinned scope never have to re-derive (basePath, milestoneId) separately.
// The underlying implementations in auto-recovery.ts / auto-artifact-paths.ts /
// state.ts remain the default for non-scope-specific units.

/**
 * Scope-based overload of verifyExpectedArtifact.
 * Uses scope.workspace.projectRoot as the authoritative base path, making
 * the check immune to cwd-drift and worktree-path divergence.
 */
export function verifyExpectedArtifactForScope(
  scope: MilestoneScope,
  unitType: string,
  unitId: string,
): boolean {
  if (
    unitId === scope.milestoneId &&
    (unitType === "discuss-milestone" || unitType === "plan-milestone")
  ) {
    // Layout-aware scope paths use resolveMilestoneFile; clear stale dir listings
    // primed before discuss/plan wrote CONTEXT.md or ROADMAP.md (see checkAutoStartAfterDiscuss).
    clearPathCache();
  }
  if (
    unitId === scope.milestoneId &&
    unitType === "discuss-milestone"
  ) {
    const path = resolveExpectedArtifactPathForScope(scope, unitType, unitId);
    return path ? existsSync(path) : false;
  }
  if (unitId === scope.milestoneId && unitType === "plan-milestone") {
    const path = resolveExpectedArtifactPathForScope(scope, unitType, unitId);
    return verifyScopedPlanMilestoneArtifact(path, unitType, unitId);
  }
  return verifyExpectedArtifact(unitType, unitId, scope.workspace.projectRoot);
}

function verifyScopedPlanMilestoneArtifact(
  path: string | null,
  unitType: string,
  unitId: string,
): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    const roadmapContent = readFileSync(path, "utf-8");
    if (countPlanMilestoneRoadmapSlices(roadmapContent) === 0) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap has zero slices at ${path}`);
      return false;
    }
    return true;
  } catch (err) {
    logWarning("recovery", `plan-milestone roadmap verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Scope-based overload of resolveExpectedArtifactPath.
 * Returns the canonical absolute path (or null) using the scope's projectRoot.
 */
export function resolveExpectedArtifactPathForScope(
  scope: MilestoneScope,
  unitType: string,
  unitId: string,
): string | null {
  if (unitId === scope.milestoneId) {
    if (unitType === "discuss-milestone") return scope.contextFile();
    if (unitType === "plan-milestone") return scope.roadmapFile();
  }
  return resolveExpectedArtifactPath(unitType, unitId, scope.workspace.projectRoot);
}

async function runQuickTaskChoice(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Run /gsd quick <task> for small bounded work, or /gsd do <task> for natural-language routing.", "info");
    return;
  }

  const task = (await ctx.ui.input("Quick task", "Describe the small task to run with /gsd quick"))?.trim();
  if (!task) {
    ctx.ui.notify("Quick task cancelled.", "info");
    return;
  }

  const { handleQuick } = await import("./quick.js");
  await handleQuick(task, ctx, pi);
}

export interface LaunchNextMilestoneDiscussOptions {
  /** When true, force backlog-aware discuss even if no unmapped requirements remain. */
  mapRequirementsBacklog?: boolean;
}

async function dispatchDiscussForNextMilestoneWithBacklog(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  nextId: string,
): Promise<void> {
  const backlogContext = buildRequirementsBacklogDiscussContext(nextId);
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const basePrompt = await buildDiscussMilestonePrompt(
    nextId,
    `New milestone ${nextId}`,
    basePath,
    structuredQuestionsAvailable,
    {
      commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): milestone context from discuss`),
      includeContextMode: false,
      fastPathInstruction: [
        "> **Requirements backlog active.**",
        "> Map unmapped active requirements to this milestone before finalizing context.",
        "> Confirm ownership with the user when scope is ambiguous.",
      ].join("\n"),
    },
  );
  const prompt = backlogContext ? `${basePrompt}\n\n${backlogContext}` : basePrompt;
  await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone", { basePath });
}

export async function launchNextMilestoneDiscuss(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  stepMode: boolean,
  options: LaunchNextMilestoneDiscussOptions = {},
): Promise<void> {
  const milestoneIds = findMilestoneIds(basePath);
  const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
  const hasUnmappedBacklog = countUnmappedActiveRequirements() > 0;
  const useBacklogDiscuss = options.mapRequirementsBacklog === true || hasUnmappedBacklog;

  if (useBacklogDiscuss) {
    setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
    await dispatchDiscussForNextMilestoneWithBacklog(ctx, pi, basePath, nextId);
    return;
  }

  await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, stepMode, `New milestone ${nextId}.`);
}

/**
 * Scope-based overload of isGhostMilestone.
 * Binds basePath and milestoneId from the scope, ensuring path resolution
 * uses the canonical project root regardless of the cwd at call time.
 */
export function isGhostMilestoneByScope(scope: MilestoneScope): boolean {
  return isGhostMilestone(scope.workspace.projectRoot, scope.milestoneId);
}

function needsPlanV2Gate(state: GSDState): boolean {
  return state.phase === "executing"
    || state.phase === "summarizing"
    || state.phase === "validating-milestone"
    || state.phase === "completing-milestone";
}

type PlanV2GateDecision = "pass" | "recover-missing-context" | "block";

function runPlanV2Gate(
  ctx: ExtensionContext,
  basePath: string,
  state: GSDState,
): PlanV2GateDecision {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  if (!uokFlags.planV2 || !needsPlanV2Gate(state)) return "pass";
  const compiled = ensurePlanV2Graph(basePath, state);
  if (!compiled.ok) {
    if (isMissingFinalizedContextResult(compiled)) {
      return "recover-missing-context";
    }
    const reason = compiled.reason ?? "plan-v2 compilation failed";
    ctx.ui.notify(
      `Plan gate failed-closed: ${reason}. Complete plan/discuss artifacts before execution.\n\nIf this keeps happening, try: /gsd doctor heal`,
      "error",
    );
    return "block";
  }
  return "pass";
}

export const _needsPlanV2GateForTest = needsPlanV2Gate;
export const _runPlanV2GateForTest = runPlanV2Gate;

export function _roadmapHasParseableSlicesForTest(
  roadmapContent: string | null | undefined,
): boolean {
  if (!roadmapContent) return false;
  return parseRoadmapSlices(roadmapContent).length > 0;
}

// ─── Commit Instruction Helpers ──────────────────────────────────────────────

/** Build commit instruction for planning prompts. .gsd/ is managed externally and always gitignored. */
function buildDocsCommitInstruction(_message: string): string {
  return "Do not commit planning artifacts — .gsd/ is managed externally.";
}

// ─── Auto-start after discuss ─────────────────────────────────────────────────

interface PendingDeepProjectSetupEntry {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  basePath: string;
  step?: boolean;
  createdAt: number;
  sessionId?: string;
  currentUnitType?: string;
  currentUnitId?: string;
}

const pendingDeepProjectSetupMap = new Map<string, PendingDeepProjectSetupEntry>();
const USER_DRIVEN_DEEP_SETUP_UNITS = new Set([
  "discuss-project",
  "discuss-requirements",
  "research-decision",
]);
export const FOREGROUND_DEEP_SETUP_RULE_NAMES = new Set([
  "deep: pre-planning (no workflow prefs) → workflow-preferences",
  "deep: pre-planning (no PROJECT) → discuss-project",
  "deep: pre-planning (no REQUIREMENTS) → discuss-requirements",
  "deep: pre-planning (no research decision) → research-decision",
]);
const LEGACY_DEEP_SETUP_PSEUDO_MILESTONE_DIRS = new Set([
  "PROJECT",
  "REQUIREMENTS",
  "RESEARCH-DECISION",
  "RESEARCH-PROJECT",
  "WORKFLOW-PREFS",
]);
const FOREGROUND_DEEP_SETUP_QUESTION_POLICY = `## Foreground Deep Setup Question Policy

This stage is running inside the foreground \`/gsd new-project --deep\` interview. Ask user questions in plain chat only.

- Do NOT call \`ask_user_questions\`, \`AskUserQuestion\`, or ToolSearch to discover user-input tools.
- Ask one focused round, then stop and wait for the user's normal chat response.`;

function hasNestedFileOrSymlink(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && hasNestedFileOrSymlink(join(dir, entry.name))) return true;
  }
  return false;
}

function clearEmptyLegacyDeepSetupPseudoMilestones(basePath: string, entries: string[], dir?: string): string[] {
  // These are LEGACY pseudo-milestone dirs — prefer legacyMilestonesDir (milestones/)
  // when it exists; caller may also supply the dir directly.
  const legacyDir = legacyMilestonesDir(basePath);
  const mDir = dir ?? (existsSync(legacyDir) ? legacyDir : milestonesDir(basePath));
  const remaining: string[] = [];
  for (const entry of entries) {
    if (!LEGACY_DEEP_SETUP_PSEUDO_MILESTONE_DIRS.has(entry)) {
      remaining.push(entry);
      continue;
    }

    const entryPath = join(mDir, entry);
    try {
      if (hasNestedFileOrSymlink(entryPath)) {
        remaining.push(entry);
        continue;
      }
      removeProjectionTreeSync(entryPath);
      logWarning("guided", `Self-heal: removed empty legacy deep setup pseudo-milestone directory ${entry}`);
    } catch (err) {
      remaining.push(entry);
      logWarning("guided", `legacy deep setup pseudo-milestone cleanup failed for ${entry}: ${(err as Error).message}`);
    }
  }
  return remaining;
}

export function clearPendingDeepProjectSetup(basePath?: string): void {
  if (basePath) {
    pendingDeepProjectSetupMap.delete(basePath);
  } else {
    pendingDeepProjectSetupMap.clear();
  }
}

function _getPendingDeepProjectSetup(basePath?: string): PendingDeepProjectSetupEntry | null {
  if (basePath) return pendingDeepProjectSetupMap.get(basePath) ?? null;
  if (pendingDeepProjectSetupMap.size === 1) return pendingDeepProjectSetupMap.values().next().value!;
  return null;
}

function getDeepSetupSessionId(ctx: ExtensionContext | undefined): string | undefined {
  return ctx?.sessionManager?.getSessionId?.();
}

function _getPendingDeepProjectSetupForContext(
  ctx: ExtensionContext | undefined,
  basePath?: string,
): PendingDeepProjectSetupEntry | null {
  if (basePath) {
    const direct = pendingDeepProjectSetupMap.get(basePath);
    if (direct) return direct;
  }
  if (!ctx) return _getPendingDeepProjectSetup();

  const sessionId = getDeepSetupSessionId(ctx);
  if (sessionId) {
    const matches = [...pendingDeepProjectSetupMap.values()].filter(entry => entry.sessionId === sessionId);
    if (matches.length === 1) return matches[0]!;
  }

  const matches = [...pendingDeepProjectSetupMap.values()].filter(entry => entry.ctx === ctx);
  return matches.length === 1 ? matches[0]! : null;
}

export function getPendingDeepProjectSetupUnitForContext(
  ctx: ExtensionContext | undefined,
  basePath?: string,
): { unitType: string; unitId: string } | null {
  const entry = _getPendingDeepProjectSetupForContext(ctx, basePath);
  if (!entry?.currentUnitType || !entry.currentUnitId) return null;
  return {
    unitType: entry.currentUnitType,
    unitId: entry.currentUnitId,
  };
}

export async function startDeepProjectSetupForeground(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  step?: boolean,
): Promise<void> {
  const entry: PendingDeepProjectSetupEntry = {
    ctx,
    pi,
    basePath,
    step,
    createdAt: Date.now(),
    sessionId: getDeepSetupSessionId(ctx),
  };
  pendingDeepProjectSetupMap.set(basePath, entry);
  await dispatchNextDeepProjectSetupStage(entry);
}

export async function checkDeepProjectSetupAfterTurn(
  _event: { messages: any[] },
  ctx?: ExtensionContext,
  basePath?: string,
): Promise<boolean> {
  const entry = _getPendingDeepProjectSetupForContext(ctx, basePath);
  if (!entry) return false;

  if (entry.currentUnitType && entry.currentUnitId) {
    // TODO(C-future): PendingDeepProjectSetupEntry does not carry a MilestoneScope
    // because deep-project-setup units span non-milestone unit types (discuss-project,
    // discuss-requirements, etc.).  Migrate to verifyExpectedArtifactForScope once
    // PendingDeepProjectSetupEntry is extended with a scope field.
    const artifactReady = verifyExpectedArtifact(entry.currentUnitType, entry.currentUnitId, entry.basePath);
    if (!artifactReady) {
      return false;
    }
  }

  // R2: a depth-verification gate is still pending — the LLM emitted the
  // confirmation question (via ask_user_questions or plain chat) but the user
  // has not approved yet. Returning false keeps the entry in the
  // pendingDeepProjectSetupMap so the next user message can resume.
  const pendingGateId = getPendingGate(entry.basePath);
  if (pendingGateId) {
    return false;
  }

  return dispatchNextDeepProjectSetupStage(entry);
}

async function dispatchNextDeepProjectSetupStage(entry: PendingDeepProjectSetupEntry): Promise<boolean> {
  invalidateAllCaches();
  const prefs = loadEffectiveGSDPreferences(entry.basePath)?.preferences;
  const { DISPATCH_RULES, hasPendingDeepStage } = await import("./auto-dispatch.js");

  if (!hasPendingDeepStage(prefs, entry.basePath)) {
    pendingDeepProjectSetupMap.delete(entry.basePath);
    scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
    return true;
  }

  const state = await deriveState(entry.basePath);
  const dispatchCtx = {
    basePath: entry.basePath,
    mid: "PROJECT",
    midTitle: "Project setup",
    state,
    prefs,
    // Claude Code currently surfaces workflow-MCP question calls as tool-request
    // UI that can be cancelled outside the normal chat flow. During the
    // foreground deep project setup interview, keep user input in plain chat so
    // `/gsd new-project --deep` cannot bounce through cancelled tool requests.
    structuredQuestionsAvailable: "false" as const,
  };
  let result: Awaited<ReturnType<(typeof DISPATCH_RULES)[number]["match"]>> = null;
  for (const rule of DISPATCH_RULES) {
    // Only evaluate foreground setup gates here. Later deep rules such as
    // research-project have dispatch-time side effects (e.g. claiming an
    // inflight marker) and must be left to auto-mode once the interview is
    // complete.
    if (!FOREGROUND_DEEP_SETUP_RULE_NAMES.has(rule.name)) continue;
    result = await rule.match(dispatchCtx);
    if (result) break;
  }

  if (!result || result.action !== "dispatch") {
    if (result?.action === "stop") {
      entry.ctx.ui.notify(result.reason, result.level);
    } else if (hasPendingDeepStage(prefs, entry.basePath)) {
      pendingDeepProjectSetupMap.delete(entry.basePath);
      scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
      return true;
    }
    return false;
  }

  if (!USER_DRIVEN_DEEP_SETUP_UNITS.has(result.unitType)) {
    pendingDeepProjectSetupMap.delete(entry.basePath);
    scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
    return true;
  }

  entry.currentUnitType = result.unitType;
  entry.currentUnitId = result.unitId;
  entry.createdAt = Date.now();
  await dispatchWorkflow(
    entry.pi,
    `${result.prompt}\n\n${FOREGROUND_DEEP_SETUP_QUESTION_POLICY}`,
    "gsd-run",
    entry.ctx,
    result.unitType,
    { basePath: entry.basePath },
  );
  return true;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type UIContext = ExtensionContext;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface DispatchWorkflowOptions {
  basePath?: string;
  deps?: {
    loadPreferences?: typeof loadEffectiveGSDPreferences;
    selectModel?: typeof selectAndApplyModel;
    getDispatchReadinessError?: typeof getUnitWorkflowDispatchReadinessErrorForModel;
  };
}

export function resolveGuidedDispatchProjectRoot(basePath?: string): string {
  return basePath ?? process.cwd();
}

/**
 * Wait until the workflow MCP server is reachable and advertising its tool
 * surface. Returns failure details when timed out, or null when ready (or MCP
 * is not the transport). Called inside dispatchWorkflow() so every guided-flow
 * dispatch path is gated automatically.
 */
const MCP_READINESS_TIMEOUT_MS = 15_000;
const MCP_READINESS_POLL_MS = 200;

export interface WorkflowMcpReadinessFailure {
  server: string;
  error?: string;
}

async function awaitWorkflowMcpReadiness(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  basePath: string,
  options: {
    unitType?: string;
    timeoutMs?: number;
    pollMs?: number;
    probeTimeoutMs?: number;
    probe?: typeof probeAndCacheWorkflowMcp;
  } = {},
): Promise<WorkflowMcpReadinessFailure | null> {
  const provider = ctx.model?.provider;
  const authMode = provider ? ctx.modelRegistry.getProviderAuthMode(provider) : undefined;
  if (!usesWorkflowMcpTransport(authMode, ctx.model?.baseUrl)) return null;

  const projectRoot = resolveWorkflowMcpProjectRoot(basePath);
  const launch = detectWorkflowMcpLaunchConfig(projectRoot);
  if (!launch) return null;

  const requiredTools = options.unitType
    ? getRequiredWorkflowToolsForUnit(options.unitType).filter(isWorkflowToolSurfaceName)
    : [];
  const coversExpectedSurface = (tools: readonly string[]) =>
    requiredTools.length > 0
      ? probeCoversRequiredWorkflowTools(tools, requiredTools)
      : workflowMcpProbeAdvertisesSurface(tools);

  const serverPrefix = `mcp__${launch.name}__`;
  const systemPrompt = () => typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
  const systemPromptCoversExpectedSurface = () => {
    const prompt = systemPrompt();
    return requiredTools.length > 0
      ? requiredTools.every((tool) => prompt.includes(`${serverPrefix}${tool}`))
      : prompt.includes(serverPrefix);
  };
  const sessionAlreadyReady = () =>
    coversExpectedSurface(getRegisteredToolSnapshot(pi)) ||
    systemPromptCoversExpectedSurface();
  if (sessionAlreadyReady()) return null;

  if (coversExpectedSurface(getCachedWorkflowMcpProbe(projectRoot)?.tools ?? [])) {
    return null;
  }

  const probe = options.probe ?? probeAndCacheWorkflowMcp;
  const probeTimeoutMs = options.probeTimeoutMs ?? WORKFLOW_MCP_PROBE_TIMEOUT_MS;

  ctx.ui.setStatus("gsd-step", `Waiting for ${launch.name} MCP server…`);
  let lastError: string | undefined;
  const deadline = Date.now() + (options.timeoutMs ?? MCP_READINESS_TIMEOUT_MS);
  const pollMs = options.pollMs ?? MCP_READINESS_POLL_MS;
  while (Date.now() < deadline) {
    if (sessionAlreadyReady()) {
      ctx.ui.setStatus("gsd-step", "");
      return null;
    }

    const result = await probe(projectRoot, { timeoutMs: probeTimeoutMs });
    if (result.ok && coversExpectedSurface(result.tools)) {
      ctx.ui.setStatus("gsd-step", "");
      return null;
    }
    lastError = result.error;

    await new Promise((r) => setTimeout(r, pollMs));
  }
  ctx.ui.setStatus("gsd-step", "");
  return lastError ? { server: launch.name, error: lastError } : { server: launch.name };
}

export const _awaitWorkflowMcpReadinessForTest = awaitWorkflowMcpReadiness;

/**
 * Read GSD-WORKFLOW.md and dispatch it to the LLM with a contextual note.
 * This is the only way the wizard triggers work — everything else is the LLM's job.
 *
 * When a unitType is provided, resolves the user's model preference for that
 * phase (e.g., models.planning → "plan-milestone", models.discuss → "discuss-milestone") and applies it before
 * dispatching. This ensures guided-flow dispatches respect the same
 * per-phase model preferences that auto-mode uses.
 */
async function dispatchWorkflow(
  pi: ExtensionAPI,
  note: string,
  customType = "gsd-run",
  ctx?: ExtensionContext,
  unitType?: string,
  options?: DispatchWorkflowOptions,
): Promise<void> {
  const resolvedOptions = options ?? {};
  const projectRoot = resolveGuidedDispatchProjectRoot(resolvedOptions.basePath);
  const loadPreferences = resolvedOptions.deps?.loadPreferences ?? loadEffectiveGSDPreferences;
  const selectModel = resolvedOptions.deps?.selectModel ?? selectAndApplyModel;
  const getDispatchReadinessError = resolvedOptions.deps?.getDispatchReadinessError
    ?? getUnitWorkflowDispatchReadinessErrorForModel;

  // Route through the dynamic routing pipeline (complexity classification,
  // tier downgrade, fallback chains) — same path as auto-mode dispatches (#2958).
  if (ctx && unitType) {
    const prefs = loadPreferences(projectRoot)?.preferences;
    const result = await selectModel(
      ctx, pi, unitType, /* unitId */ "", projectRoot,
      prefs, /* verbose */ false, /* autoModeStartModel */ null,
      /* retryContext */ undefined, /* isAutoMode */ false,
    );
    if (result.appliedModel) {
      debugLog("guided-flow-model-applied", {
        unitType,
        model: `${result.appliedModel.provider}/${result.appliedModel.id}`,
        routing: result.routing,
      });
    }

    const compatibilityError = getDispatchReadinessError({
      model: result.appliedModel,
      fallbackModel: ctx.model,
      getProviderAuthMode: (provider) => ctx.modelRegistry.getProviderAuthMode(provider),
      projectRoot,
      surface: "guided flow",
      unitType,
      // Guided flow starts the MCP workflow server as part of dispatch, so the
      // parent session's activeTools doesn't include MCP tools yet. The MCP
      // launch config check (detectWorkflowMcpLaunchConfig) is the right gate
      // here — not whether MCP tools are pre-registered in the parent session.
    });
    if (compatibilityError) {
      ctx.ui.notify(compatibilityError, "error");
      return;
    }

    // ── Live MCP readiness gate ────────────────────────────────────────
    // Units with required workflow tools must not dispatch until the MCP
    // surface covers that exact contract; otherwise the model can race into
    // "No such tool available" before recovery sees a clean readiness error.
    warmWorkflowMcpProbeInBackground(projectRoot);
    const requiredWorkflowTools = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
    const strictBlocking = requiredWorkflowTools.length > 0
      && (process.env.GSD_GUIDED_MCP_BLOCKING ?? "").trim() !== "0";
    if (strictBlocking) {
      // If the workflow MCP server is configured but still connecting, wait
      // for it instead of dispatching into a child session that will abort.
      const readinessFailure = await awaitWorkflowMcpReadiness(pi, ctx, projectRoot, { unitType });
      if (readinessFailure) {
        const detail = readinessFailure.error ? ` ${readinessFailure.error}` : "";
        ctx.ui.notify(
          `GSD workflow server "${readinessFailure.server}" did not connect in time.${detail} ` +
          `Run \`/gsd mcp check ${readinessFailure.server}\` for details.`,
          "warning",
        );
        return;
      }
    }
  }

  // Scope tools for guided workflow turns (#2949, token-consumption savings).
  // Providers with grammar-based constrained decoding (xAI/Grok) return
  // "Grammar is too complex" when the combined tool schema is too large.
  // Guided workflow turns only need the active unit's tool surface; strip
  // unrelated GSD tools and broad non-GSD tools for this queued turn, then
  // restore so the narrowed surface does not leak into future dispatches.
  let savedTools: ReturnType<typeof scopeGsdWorkflowToolsForDispatch> = null;

  try {
    const currentTools = pi.getActiveTools();
    savedTools = {
      tools: currentTools,
      visibleSkills: typeof pi.getVisibleSkills === "function" ? pi.getVisibleSkills() : undefined,
      restoreVisibleSkills: typeof pi.setVisibleSkills === "function",
    };
    if (unitType?.startsWith("discuss-") && !isFullGsdToolSurfaceRequested()) {
      // Keep all non-GSD tools (builtins, other extensions) and only the
      // GSD tools on the discuss allowlist.
      const scopedTools = currentTools.filter(
        (t) => !t.startsWith("gsd_") || DISCUSS_TOOLS_ALLOWLIST.includes(t),
      );
      pi.setActiveTools(scopedTools);
      const scopedState = scopeGsdWorkflowToolsForDispatch(pi, unitType);
      savedTools = {
        tools: currentTools,
        visibleSkills: scopedState?.visibleSkills ?? savedTools.visibleSkills,
        restoreVisibleSkills: scopedState?.restoreVisibleSkills ?? savedTools.restoreVisibleSkills,
      };
      debugLog("discuss-tool-scoping", {
        unitType,
        before: currentTools.length,
        after: pi.getActiveTools().length,
        removed: currentTools.length - pi.getActiveTools().length,
      });
    } else {
      savedTools = scopeGsdWorkflowToolsForDispatch(pi, unitType) ?? savedTools;
    }

    const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
    const workflow = readFileSync(workflowPath, "utf-8");

    if (unitType) setGuidedUnitContext(projectRoot, unitType);
    try {
      await pi.sendMessage(
        {
          customType,
          content: buildWorkflowDispatchContent({ workflow, workflowPath, task: note }),
          display: false,
        },
        { triggerTurn: true },
      );
    } catch (err) {
      clearGuidedUnitContext(projectRoot);
      throw err;
    }
  } finally {
    // Restore full tool/skill surface after the turn completes. Awaiting
    // sendMessage ensures scoped skills stay in _baseSystemPrompt through
    // before_agent_start (#3628, skill token savings).
    restoreGsdWorkflowTools(pi, savedTools);
  }
}

export const _dispatchWorkflowForTest = dispatchWorkflow;

export function getDiscussableFutureMilestones<T extends { id: string; status: string }>(
  registry: T[],
  activeMilestoneId?: string | null,
): T[] {
  return registry.filter((m) =>
    m.id !== activeMilestoneId && m.status !== "complete" && m.status !== "parked",
  );
}

function findDiscussTargetMilestone(
  registry: GSDState["registry"],
  milestoneId: string,
): GSDState["registry"][number] | undefined {
  return registry.find((m) => m.id === milestoneId || m.id.startsWith(`${milestoneId}-`));
}

function getStructuredQuestionsAvailability(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
): "true" | "false" {
  if (!ctx) return "false";

  const provider = ctx.model?.provider;
  const authMode = provider ? ctx.modelRegistry.getProviderAuthMode(provider) : undefined;
  return supportsStructuredQuestions(pi.getActiveTools(), {
    authMode,
    baseUrl: ctx.model?.baseUrl,
  }) ? "true" : "false";
}

/**
 * Resolve a model ID string to a model object from available models.
 * Handles "provider/model" and bare ID formats.
 */
function resolveAvailableModel<T extends { id: string; provider: string }>(
  modelId: string,
  availableModels: T[],
  currentProvider: string | undefined,
): T | undefined {
  const slashIdx = modelId.indexOf("/");

  if (slashIdx !== -1) {
    const maybeProvider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);

    const knownProviders = new Set(availableModels.map(m => m.provider.toLowerCase()));
    if (knownProviders.has(maybeProvider.toLowerCase())) {
      const match = availableModels.find(
        m => m.provider.toLowerCase() === maybeProvider.toLowerCase()
          && m.id.toLowerCase() === id.toLowerCase(),
      );
      if (match) return match;
    }

    // Try matching the full string as a model ID (OpenRouter-style)
    const lower = modelId.toLowerCase();
    return availableModels.find(
      m => m.id.toLowerCase() === lower
        || `${m.provider}/${m.id}`.toLowerCase() === lower,
    );
  }

  // Bare ID — prefer current provider, then first available
  const exactProviderMatch = availableModels.find(
    m => m.id === modelId && m.provider === currentProvider,
  );
  return exactProviderMatch ?? availableModels.find(m => m.id === modelId);
}

/**
 * Build the discuss-and-plan prompt for a new milestone.
 * Used by all three "new milestone" paths (first ever, no active, all complete).
 */
function buildDiscussPrompt(nextId: string, preamble: string, basePath: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, preparationContext?: string): string {
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");
  return prependLanguageDirective(basePath, loadPrompt("discuss", {
    milestoneId: nextId,
    preamble,
    preparationContext: preparationContext ?? "",
    structuredQuestionsAvailable,
    contextPath: relMilestoneFile(basePath, nextId, "CONTEXT"),
    roadmapPath: relMilestoneFile(basePath, nextId, "ROADMAP"),
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan — N milestones"),
  }));
}

/**
 * Prepend the configured response-language directive to a dispatched discuss
 * prompt so the discuss/QA conversation is held in the language set in
 * PREFERENCES.md (#1210). No-op when no language is configured.
 */
function prependLanguageDirective(basePath: string, prompt: string): string {
  const directive = renderLanguageDirectiveForPrompt(
    loadEffectiveGSDPreferences(basePath)?.preferences,
  );
  return directive ? `${directive}\n\n${prompt}` : prompt;
}

/**
 * Build the discuss prompt for headless milestone creation.
 * Uses the discuss-headless prompt template with seed context injected.
 */
function buildHeadlessDiscussPrompt(nextId: string, seedContext: string, basePath: string): string {
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");
  return prependLanguageDirective(basePath, loadPrompt("discuss-headless", {
    milestoneId: nextId,
    seedContext,
    contextPath: relMilestoneFile(basePath, nextId, "CONTEXT"),
    roadmapPath: relMilestoneFile(basePath, nextId, "ROADMAP"),
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan — N milestones"),
  }));
}

/**
 * Run preparation phase if enabled, then build the discuss prompt.
 * Preparation analyzes the codebase and prior context, injecting the results
 * as supplementary context into the standard discuss template. The discuss
 * template drives the conversation with a variable vision opener, while
 * the preparation briefs give the agent grounding in the existing codebase.
 *
 * @param ctx - Extension command context with UI for progress notifications
 * @param nextId - The milestone ID being discussed
 * @param preamble - Preamble text for the discuss prompt
 * @param basePath - Root directory of the project
 * @returns The discuss prompt string
 */
async function buildDiscussPreparationContext(
  ctx: ExtensionCommandContext,
  basePath: string,
  mode: "greenfield" | "milestone" = "greenfield",
  skipPriorContext = false,
): Promise<string> {
  const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};
  if (prefs.discuss_preparation === false) return "";

  try {
    const prepResult = await runPreparation(basePath, ctx.ui, {
      discuss_preparation: prefs.discuss_preparation,
      discuss_web_research: prefs.discuss_web_research,
      discuss_depth: prefs.discuss_depth,
    });

    if (!prepResult.enabled) return "";

    const codebaseBrief = prepResult.codebaseBrief || formatCodebaseBrief(prepResult.codebase);
    const priorContextBrief = prepResult.priorContextBrief || formatPriorContextBrief(prepResult.priorContext);
    const parts: string[] = [];
    if (codebaseBrief) parts.push(`### Codebase Brief\n\n${codebaseBrief}`);
    if (priorContextBrief && !skipPriorContext) parts.push(`### Prior Context Brief\n\n${priorContextBrief}`);
    if (parts.length === 0) return "";

    const guidance = mode === "milestone"
      ? "Use these findings as background only — they describe what already exists, NOT what the user wants next. This snapshot already covers code reality: do NOT survey the codebase before asking. Send **one** message: a short recap (at most 2-3 sentences) plus 1-3 focused questions, then **stop**. Do not dump a feature-menu brainstorm or send a second message restating the same question."
      : "Use these findings as background context — they describe what already exists, NOT what the user wants to build. This snapshot already covers code reality: do NOT survey the codebase before asking. Always ask the user what they want to build first.";
    return `\n\n## Preparation Context\n\nThe system analyzed the codebase before this discussion. ${guidance}\n\n${parts.join("\n\n")}`;
  } catch (err) {
    logWarning("guided", `preparation failed, proceeding without context: ${(err as Error).message}`);
    return "";
  }
}

async function prepareAndBuildDiscussPrompt(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  nextId: string,
  preamble: string,
  basePath: string,
): Promise<string> {
  const preparationContext = await buildDiscussPreparationContext(ctx, basePath);
  return buildDiscussPrompt(nextId, preamble, basePath, pi, ctx, preparationContext);
}

/**
 * Start discussion for a newly reserved milestone ID.
 * Greenfield (no milestone dirs yet) uses discuss.md (vision + project artifacts).
 * Established projects use guided-discuss-milestone so we do not re-run vision/reflection.
 */
async function dispatchNewMilestoneDiscuss(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  nextId: string,
  stepMode: boolean,
  greenfieldPreamble?: string,
): Promise<void> {
  setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });

  const isGreenfield = findMilestoneIds(basePath).length === 0;
  if (isGreenfield) {
    const prompt = await prepareAndBuildDiscussPrompt(
      ctx,
      pi,
      nextId,
      greenfieldPreamble
        ?? `New project, milestone ${nextId}. Do NOT read or explore .gsd/ — it's empty scaffolding.`,
      basePath,
    );
    await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "discuss-milestone", { basePath });
    return;
  }

  const preparationContext = await buildDiscussPreparationContext(ctx, basePath, "milestone", true);
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  let prompt = await buildDiscussMilestonePrompt(
    nextId,
    `New milestone ${nextId}`,
    basePath,
    structuredQuestionsAvailable,
    {
      commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): milestone context from discuss`),
      includeContextMode: false,
    },
  );
  if (preparationContext) prompt += preparationContext;
  await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone", { basePath });
}

/**
 * Bootstrap a .gsd/ project from scratch for headless use.
 * Ensures git repo, .gsd/ structure, gitignore, and preferences all exist.
 */
function bootstrapGsdProject(basePath: string): void {
  if (!nativeIsRepo(basePath) || isInheritedRepo(basePath)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }

  const root = gsdRoot(basePath);
  mkdirSync(join(root, "runtime"), { recursive: true });

  const gitPrefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  const manageGitignore = gitPrefs?.manage_gitignore;
  ensureGitignore(basePath, { manageGitignore });
  ensurePreferences(basePath);
  if (manageGitignore !== false) untrackRuntimeFiles(basePath);
}

/**
 * Headless milestone creation from a seed specification document.
 * Bootstraps the project if needed, generates the next milestone ID,
 * and dispatches the headless discuss prompt (no Q&A rounds).
 */
export async function showHeadlessMilestoneCreation(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  seedContext: string,
  options: HeadlessMilestoneCreationOptions = {},
): Promise<void> {
  // Clear stale reservations from previous cancelled sessions (#2488)
  clearReservedMilestoneIds();

  // Ensure .gsd/ is bootstrapped
  bootstrapGsdProject(basePath);

  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen(basePath);

  // Generate next milestone ID
  const existingIds = findMilestoneIds(basePath);
  const prefs = loadEffectiveGSDPreferences();
  const nextId = nextMilestoneIdReserved(existingIds, prefs?.preferences?.unique_milestone_ids ?? false, basePath);

  // Fix #4996: Do NOT pre-create the milestone directory here.
  // atomicWriteAsync (used by all artifact writers) calls mkdir lazily before
  // each write, so every path through saveArtifactToDb / saveFile is already
  // lazy-mkdir-safe. Pre-creating the dir before the discuss flow runs leaves
  // an orphan stub if discuss is abandoned — that stub later skews nextMilestoneId.

  // Build and dispatch the headless discuss prompt
  const prompt = buildHeadlessDiscussPrompt(nextId, seedContext, basePath);

  // Set the ready handoff. Headless --auto owns the auto start itself so it can
  // wait for completion without racing the guided-flow pending auto-start.
  setPendingAutoStart(basePath, {
    ctx,
    pi,
    basePath,
    milestoneId: nextId,
    step: true,
    startAuto: options.startAutoAfterReady !== false,
  });

  // Dispatch as discuss-milestone. The LLM writes PROJECT.md, REQUIREMENTS.md,
  // and CONTEXT.md, then calls gsd_plan_milestone — this is semantically the
  // discuss path, just non-interactive. Using "plan-milestone" here caused
  // model/tool routing to skip discuss-flow tool scoping and
  // `checkAutoStartAfterDiscuss` guardrails that rely on the
  // "discuss-"-prefixed unitType.
  await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "discuss-milestone", { basePath });
}


// ─── Discuss Flow ─────────────────────────────────────────────────────────────

type DiscussNormSlice = { id: string; done: boolean; title: string };

/** Prefer DB slice rows; fall back to ROADMAP parsing when the DB is empty (#2892). */
async function loadDiscussNormSlices(basePath: string, mid: string): Promise<DiscussNormSlice[]> {
  let normSlices: DiscussNormSlice[] = [];
  if (isDbAvailable()) {
    normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete", title: s.title }));
  }
  if (normSlices.length === 0) {
    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
    if (roadmapContent) {
      normSlices = parseRoadmapSlices(roadmapContent).map(s => ({ id: s.id, done: s.done, title: s.title }));
    }
  }
  return normSlices;
}

export const _loadDiscussNormSlicesForTest = loadDiscussNormSlices;

function resolveDiscussSliceBasePath(basePath: string, milestoneId: string): string {
  return getAutoWorktreePath(basePath, milestoneId) ?? basePath;
}

/**
 * Build a rich inlined-context prompt for discussing a specific slice.
 * Preloads roadmap, milestone context, research, decisions, and completed
 * slice summaries so the agent can ask grounded UX/behaviour questions
 * without wasting a turn reading files.
 */
// Exported for tests (`prompt-budget-enforcement.test.ts`) — verifies the
// inlined-context cap. Not part of the public flow surface otherwise.
export async function buildDiscussSlicePrompt(
  mid: string,
  sid: string,
  sTitle: string,
  base: string,
  options?: { rediscuss?: boolean; structuredQuestionsAvailable?: string },
): Promise<string> {
  const inlined: string[] = [];

  // Roadmap — always included so the agent sees surrounding slices
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    inlined.push(`### Milestone Roadmap\nSource: \`${roadmapRel}\`\n\n${roadmapContent.trim()}`);
  }

  // Milestone context — understanding the full milestone intent
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextContent = contextPath ? await loadFile(contextPath) : null;
  if (contextContent) {
    inlined.push(`### Milestone Context\nSource: \`${contextRel}\`\n\n${contextContent.trim()}`);
  }

  // Milestone research — technical grounding
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");
  const researchContent = researchPath ? await loadFile(researchPath) : null;
  if (researchContent) {
    inlined.push(`### Milestone Research\nSource: \`${researchRel}\`\n\n${researchContent.trim()}`);
  }

  // Decisions — architectural context that constrains this slice
  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      inlined.push(`### Decisions Register\nSource: \`${relGsdRootFile("DECISIONS")}\`\n\n${decisionsContent.trim()}`);
    }
  }

  // Completed slice summaries — what was already built that this slice builds on
  // Ensure DB is open so getMilestoneSlices returns real data (#2560).
  {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen();
    type NormSlice = { id: string; done: boolean };
    let normSlices: NormSlice[] = [];
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete" }));
    }
    for (const s of normSlices) {
      if (!s.done || s.id === sid) continue;
      const summaryPath = resolveSliceFile(base, mid, s.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, s.id, "SUMMARY");
      const summaryContent = summaryPath ? await loadFile(summaryPath) : null;
      if (summaryContent) {
        inlined.push(`### ${s.id} Summary (completed)\nSource: \`${summaryRel}\`\n\n${summaryContent.trim()}`);
      }
    }
  }

  // Cap the inlined block: it grows unbounded with each completed slice's full
  // SUMMARY. `capPreamble` truncates at `### ` section boundaries — roadmap and
  // milestone context come first (survive), completed-slice summaries come last
  // (dropped first) when the executor's window can't hold everything.
  const inlinedContext = inlined.length > 0
    ? capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`)
    : `## Inlined Context\n\n_(no context files found yet — go in blind and ask broad questions)_`;

  const sliceDirPath = relSlicePath(base, mid, sid);
  const sliceContextPath = relSliceFile(base, mid, sid, "CONTEXT");

  // When re-discussing, inject a preamble so the agent treats this as an update interview
  const rediscussPreamble = options?.rediscuss
    ? `\n\n## Re-discuss Mode\n\nThis slice already has an existing context file (\`${sliceContextPath}\`) from a prior discussion. The user has chosen to re-discuss it. Read the existing context file, interview for any updates, changes, or new decisions, and rewrite the file with merged findings. Do NOT skip the interview — the user explicitly asked to revisit this slice.\n`
    : "";

  const inlinedTemplates = inlineTemplate("slice-context", "Slice Context");
  return prependLanguageDirective(base, loadPrompt("guided-discuss-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    inlinedContext: inlinedContext + rediscussPreamble,
    sliceDirPath,
    contextPath: sliceContextPath,
    projectRoot: base,
    inlinedTemplates,
    structuredQuestionsAvailable: options?.structuredQuestionsAvailable ?? "false",
    commitInstruction: buildDocsCommitInstruction(`docs(${mid}/${sid}): slice context from discuss`),
  }));
}

/**
 * /gsd discuss — show a picker of non-done slices and run a slice interview.
 * Loops back to the picker after each discussion so the user can chain
 * multiple slice interviews in one session.
 */
export async function showDiscuss(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  options?: { target?: string },
): Promise<void> {
  // Guard: no .gsd/ project
  if (!existsSync(gsdRoot(basePath))) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }

  const target = options?.target?.trim() ? normalizeDiscussTarget(options.target.trim()) : undefined;
  if (requiresInteractiveMenu(ctx, !!target)) {
    notifyDiscussNeedsInteractiveMenu(ctx, "this session has no interactive menu");
    return;
  }

  // Ensure DB is open before deriving state (#5837).
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen(basePath);

  // Invalidate caches to pick up artifacts written by a just-completed discuss/plan
  invalidateAllCaches();

  const state = await deriveState(basePath);
  const discussableFutureMilestones = getDiscussableFutureMilestones(
    state.registry,
    state.activeMilestone?.id,
  );

  // Rebuild STATE.md from derived state before any dispatch (#3475).
  // Without this, guided prompts read a stale STATE.md cache and the
  // agent bootstraps from the wrong milestone.
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${(err as Error).message}`);
  }

  if (target) {
    const slash = target.indexOf("/");
    if (slash > 0) {
      const mid = target.slice(0, slash);
      const sid = target.slice(slash + 1);
      const targetMilestone = findDiscussTargetMilestone(state.registry, mid);
      if (!targetMilestone) {
        ctx.ui.notify(
          `Milestone ${mid} was not found in the roadmap. Use /gsd new-milestone to add it, or /gsd status to see available milestones.`,
          "warning",
        );
        return;
      }
      if (targetMilestone.status === "complete") {
        ctx.ui.notify(`Milestone ${targetMilestone.id} is already complete.`, "info");
        return;
      }
      if (targetMilestone.status === "parked") {
        ctx.ui.notify(`Milestone ${targetMilestone.id} is parked. Run /gsd unpark ${targetMilestone.id} to reactivate.`, "warning");
        return;
      }
      const slices = await loadDiscussNormSlices(basePath, targetMilestone.id);
      const chosen = slices.find((s) => s.id.toUpperCase() === sid.toUpperCase());
      if (!chosen) {
        ctx.ui.notify(`Slice ${target} was not found in discussable slices.`, "warning");
        return;
      }
      if (chosen.done) {
        ctx.ui.notify(`Slice ${target} is already complete; nothing to discuss.`, "info");
        return;
      }
      const discussBasePath = resolveDiscussSliceBasePath(basePath, targetMilestone.id);
      const contextFile = resolveSliceFile(discussBasePath, targetMilestone.id, sid, "CONTEXT");
      const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
      const prompt = await buildDiscussSlicePrompt(targetMilestone.id, sid, chosen.title, discussBasePath, {
        rediscuss: !!contextFile,
        structuredQuestionsAvailable: sqAvail,
      });
      await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-slice", { basePath: discussBasePath });
      return;
    }

    const targetMilestone = findDiscussTargetMilestone(state.registry, target);
    if (!targetMilestone) {
      ctx.ui.notify(
        `Milestone ${target} was not found in the roadmap. Use /gsd new-milestone to add it, or /gsd status to see available milestones.`,
        "warning",
      );
      return;
    }
    if (targetMilestone.status === "complete") {
      ctx.ui.notify(`Milestone ${targetMilestone.id} is already complete.`, "info");
      return;
    }
    if (targetMilestone.status === "parked") {
      ctx.ui.notify(`Milestone ${targetMilestone.id} is parked. Run /gsd unpark ${targetMilestone.id} to reactivate.`, "warning");
      return;
    }
    await dispatchDiscussForMilestone(ctx, pi, basePath, targetMilestone.id, targetMilestone.title, {});
    return;
  }

  // No active milestone (or corrupted milestone with undefined id) —
  // check for pending milestones to discuss instead
  if (!state.activeMilestone?.id) {
    if (discussableFutureMilestones.length === 0) {
      ctx.ui.notify("No active milestone. Run /gsd to create one first.", "warning");
      return;
    }
    await showDiscussQueuedMilestone(ctx, pi, basePath, discussableFutureMilestones);
    return;
  }

  const mid = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;

  // Special case: milestone is in needs-discussion phase (has CONTEXT-DRAFT.md but no roadmap yet).
  // Route to the draft discussion flow instead of erroring — the discussion IS how the roadmap gets created.
  if (state.phase === "needs-discussion") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${mid}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off — seed material is loaded automatically.",
          recommended: true,
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch.",
        },
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone as-is and start something new.",
        },
      ],
      notYetMessage: "Run /gsd discuss when ready to discuss this milestone.",
    });

    if (choice === "discuss_draft") {
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const seed = await buildDiscussMilestonePrompt(
        mid,
        milestoneTitle,
        basePath,
        structuredQuestionsAvailable,
        {
          commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
          includeContextMode: false,
        },
      );
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: mid, step: true });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone", { basePath });
    } else if (choice === "discuss_fresh") {
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const prompt = await buildDiscussMilestonePrompt(
        mid,
        milestoneTitle,
        basePath,
        structuredQuestionsAvailable,
        {
          commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
          includeContextMode: false,
          includeDraftSeed: false,
        },
      );
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: mid, step: true });
      await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone", { basePath });
    } else if (choice === "skip_milestone") {
      const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
      await ensureDbOpen(basePath);
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
      await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, true, `New milestone ${nextId}.`);
    }
    return;
  }

  // Pre-planning milestones have no slice roadmap yet — route to milestone-level discuss.
  if (state.phase === "pre-planning") {
    ctx.ui.notify(
      `Discuss — starting milestone interview for ${mid}: ${milestoneTitle}…`,
      "info",
    );
    await dispatchDiscussForMilestone(ctx, pi, basePath, mid, milestoneTitle, {});
    return;
  }

  // Guard: no roadmap yet (unless DB has slices)
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent && !isDbAvailable()) {
    ctx.ui.notify("No roadmap yet for this milestone. Run /gsd to plan first.", "warning");
    return;
  }

  const normSlices = await loadDiscussNormSlices(basePath, mid);
  const pendingSlices = normSlices.filter(s => !s.done);

  if (pendingSlices.length === 0) {
    // All slices complete — but queued milestones may still need discussion (#3150)
    if (discussableFutureMilestones.length > 0) {
      await showDiscussQueuedMilestone(ctx, pi, basePath, discussableFutureMilestones);
      return;
    }
    ctx.ui.notify("All slices are complete — nothing to discuss.", "info");
    return;
  }

  ctx.ui.notify(
    `Discuss — ${mid}: ${milestoneTitle}. Choose a slice from the menu below (↑/↓, Enter).`,
    "info",
  );

  // Loop: show picker, dispatch discuss, repeat until "not_yet"
  while (true) {
    // Invalidate caches so we pick up CONTEXT files written by the just-completed discussion
    invalidateAllCaches();
    const discussBasePath = resolveDiscussSliceBasePath(basePath, mid);

    // Build discussion-state map: which slices have CONTEXT files already?
    const discussedMap = new Map<string, boolean>();
    for (const s of pendingSlices) {
      const contextFile = resolveSliceFile(discussBasePath, mid, s.id, "CONTEXT");
      discussedMap.set(s.id, !!contextFile);
    }

    // If all pending slices are discussed, check for queued milestones before exiting (#3150)
    const allDiscussed = pendingSlices.every(s => discussedMap.get(s.id));
    if (allDiscussed) {
      if (discussableFutureMilestones.length > 0) {
        await showDiscussQueuedMilestone(ctx, pi, basePath, discussableFutureMilestones);
        return;
      }
      const lockData = readSessionLockData(basePath);
      const remoteAutoRunning = lockData && lockData.pid !== process.pid && isSessionLockProcessAlive(lockData);
      const nextStep = remoteAutoRunning
        ? "Auto-mode is already running — use /gsd status to check progress."
        : "Run /gsd to start planning.";
      ctx.ui.notify(
        `All ${pendingSlices.length} slices discussed. ${nextStep}`,
        "info",
      );
      return;
    }

    // Find the first undiscussed slice to recommend
    const firstUndiscussedId = pendingSlices.find(s => !discussedMap.get(s.id))?.id;

    const actions = pendingSlices.map((s) => {
      const discussed = discussedMap.get(s.id) ?? false;
      const statusParts: string[] = [];
      if (state.activeSlice?.id === s.id) statusParts.push("active");
      else statusParts.push("upcoming");
      statusParts.push(discussed ? "discussed ✓" : "not discussed");

      return {
        id: s.id,
        label: `${s.id}: ${s.title}`,
        description: statusParts.join(" · "),
        recommended: s.id === firstUndiscussedId,
      };
    });

    // Offer access to queued milestones when any exist
    if (discussableFutureMilestones.length > 0) {
      actions.push({
        id: "discuss_queued_milestone",
        label: "Discuss a future/planned milestone",
        description: `Refine context for ${discussableFutureMilestones.length} future milestone(s). Does not affect current execution.`,
        recommended: false,
      });
    }

    const choice = await showNextAction(ctx, {
      title: "GSD — Discuss a slice",
      summary: [
        `${mid}: ${milestoneTitle}`,
        "Pick a slice to interview. Context file will be written when done.",
      ],
      actions,
      notYetMessage: "Run /gsd discuss when ready.",
    });

    if (choice === "not_yet") return;

    if (choice === "discuss_queued_milestone") {
      await showDiscussQueuedMilestone(ctx, pi, basePath, discussableFutureMilestones);
      return;
    }

    const chosen = pendingSlices.find(s => s.id === choice);
    if (!chosen) return;

    // If the slice already has a CONTEXT file, confirm re-discuss intent
    const isRediscuss = discussedMap.get(chosen.id) ?? false;
    if (isRediscuss) {
      const confirm = await showNextAction(ctx, {
        title: `Re-discuss ${chosen.id}?`,
        summary: [
          `${chosen.id} already has a context file from a prior discussion.`,
          "Re-discussing will interview for updates and rewrite the context file.",
        ],
        actions: [
          { id: "rediscuss", label: "Re-discuss to update context", description: "Interview for changes and rewrite", recommended: true },
          { id: "cancel", label: "Cancel", description: "Go back to slice picker" },
        ],
      });
      if (confirm !== "rediscuss") continue;
    }

    const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
    const prompt = await buildDiscussSlicePrompt(mid, chosen.id, chosen.title, discussBasePath, {
      rediscuss: isRediscuss,
      structuredQuestionsAvailable: sqAvail,
    });
    await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-slice", { basePath: discussBasePath });

    // Wait for the discuss session to finish, then loop back to the picker
    await ctx.waitForIdle();
    invalidateAllCaches();
  }
}

// ─── Queued Milestone Discussion ─────────────────────────────────────────────

/**
 * Show a picker of queued (pending) milestones and dispatch a discuss flow for
 * the chosen one. Discussing a queued milestone does NOT activate it — it only
 * refines the CONTEXT.md artifact so it is better prepared when auto-mode
 * eventually reaches it.
 */
async function showDiscussQueuedMilestone(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  pendingMilestones: Array<{ id: string; title: string; status: string }>,
): Promise<void> {
  const actions = pendingMilestones.map((m, i) => {
    const hasContext = !!resolveMilestoneFile(basePath, m.id, "CONTEXT");
    const hasDraft = !hasContext && !!resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
    const hasRoadmap = !!resolveMilestoneFile(basePath, m.id, "ROADMAP");
    const contextStatus = hasContext ? "context ✓" : hasDraft ? "draft context" : "no context yet";
    const roadmapStatus = hasRoadmap ? " · roadmap ✓" : "";
    return {
      id: m.id,
      label: `${m.id}: ${m.title}`,
      description: `[${m.status}] · ${contextStatus}${roadmapStatus}`,
      recommended: i === 0,
    };
  });

  const choice = await showNextAction(ctx, {
    title: "GSD — Discuss a future/planned milestone",
    summary: [
      "Select a future or planned milestone to discuss.",
      "Discussing will update its context file. It will not be activated.",
    ],
    actions,

  });

  if (choice === "not_yet") return;

  const chosen = pendingMilestones.find(m => m.id === choice);
  if (!chosen) return;

  const hasDraft = !!resolveMilestoneFile(basePath, chosen.id, "CONTEXT-DRAFT");
  let fastPath = hasDraft;

  if (!hasDraft) {
    const mode = await showNextAction(ctx, {
      title: `Discuss ${chosen.id}`,
      summary: [
        "Choose how to start the discussion.",
        "Fast path skips generic scouting — use it when you already know the scope.",
      ],
      actions: [
        {
          id: "full",
          label: "Full discussion",
          description: "Scout the codebase, ask open-ended questions, explore deeply",
          recommended: true,
        },
        {
          id: "fast",
          label: "I have the scope — fast path",
          description: "Treat your first message as authoritative seed context; skip scouting",
        },
      ],
      notYetMessage: "Run /gsd discuss when ready.",
    });
    if (mode === "not_yet") return;
    fastPath = mode === "fast";
  }

  await dispatchDiscussForMilestone(ctx, pi, basePath, chosen.id, chosen.title, { fastPath });
}

/**
 * Dispatch the guided-discuss-milestone prompt for a milestone without
 * setting pendingAutoStart — so discussing a queued milestone does not
 * implicitly activate it when the session ends.
 */
async function dispatchDiscussForMilestone(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  mid: string,
  milestoneTitle: string,
  opts: { fastPath?: boolean } = {},
): Promise<void> {
  const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const draftContent = draftFile ? await loadFile(draftFile) : null;
  const hasSeed = !!(draftContent || opts.fastPath);
  const fastPathInstruction = hasSeed
    ? [
        "> **Fast path active — scope provided.**",
        "> Do NOT perform a generic codebase scouting pass.",
        "> Do at most 2 targeted reads to check for obvious conflicts with existing work.",
        "> Treat the seed context or the operator's first message as authoritative.",
        "> Move directly to the depth summary and write step.",
        "> Ask only questions where the answer would materially change scope.",
      ].join("\n")
    : "";
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const prompt = await buildDiscussMilestonePrompt(
    mid,
    milestoneTitle,
    basePath,
    structuredQuestionsAvailable,
    {
      commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
      includeContextMode: false,
      fastPathInstruction,
    },
  );
  await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone", { basePath });
}

// ─── Smart Entry Point ────────────────────────────────────────────────────────

/**
 * The one wizard. Reads state, shows contextual options, dispatches into the workflow doc.
 */
/**
 * Self-heal: scan runtime records and clear stale ones left behind when
 * auto-mode crashed mid-unit. auto.ts has its own selfHealRuntimeRecords()
 * but guided-flow (manual /gsd mode) never called it — meaning stale records
 * persisted until the next /gsd auto run.  This ensures the wizard always
 * starts from a clean state regardless of how the previous session ended.
 */
function selfHealRuntimeRecords(basePath: string, ctx: ExtensionContext): { cleared: number } {
  try {
    const records = listUnitRuntimeRecords(basePath);
    let cleared = 0;
    for (const record of records) {
      const { unitType, unitId, phase } = record;
      // Clear records whose expected artifact already exists (completed but not cleaned up)
      // TODO(C-future): selfHealRuntimeRecords iterates across all unit types (not just milestone
      // units), so it cannot be converted to resolveExpectedArtifactPathForScope without
      // first establishing a per-record scope.  Migrate once unit runtime records carry scope info.
      const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
      if (artifactPath && existsSync(artifactPath)) {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
        continue;
      }
      // Clear records stuck in an in-flight phase (process died mid-unit).
      if (isInFlightRuntimePhase(phase)) {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
      }
    }
    if (cleared > 0) {
      ctx.ui.notify(`Self-heal: cleared ${cleared} stale runtime record(s) from a previous session.`, "info");
    }
    return { cleared };
  } catch (e) {
    logWarning("guided", `self-heal stale runtime records failed: ${(e as Error).message}`);
    return { cleared: 0 };
  }
}

/**
 * True when an agent turn is currently streaming or a dispatched message is
 * still queued waiting to trigger one. Used by the pending-auto-start stale
 * check: a live discuss turn can run for minutes before writing its first
 * artifact, and deleting its entry as "stale" re-dispatches the workflow —
 * resetting the interview and producing a duplicate completion turn.
 */
function isAgentTurnInFlight(ctx: ExtensionCommandContext): boolean {
  try {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return true;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return true;
  } catch {
    // assertActive() throws on a stale runner context; fall through to
    // artifact/age staleness signals.
    logWarning("guided", "isAgentTurnInFlight: ctx method threw (stale runner); assuming no turn in flight");
  }
  return false;
}

// ─── Milestone Actions Submenu ──────────────────────────────────────────────

/**
 * Shows a submenu with Park / Discard / Skip / Back options for the active milestone.
 * Returns true if an action was taken (caller should re-enter showSmartEntry or
 * dispatch a new workflow). Returns false if the user chose "Back".
 */
async function handleMilestoneActions(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  milestoneId: string,
  milestoneTitle: string,
  options?: { step?: boolean },
): Promise<boolean> {
  const stepMode = options?.step ?? true;
  const choice = await showNextAction(ctx, {
    title: `Milestone Actions — ${milestoneId}`,
    summary: [`${milestoneId}: ${milestoneTitle}`],
    actions: [
      {
        id: "park",
        label: "Park milestone",
        description: "Pause this milestone — it stays on disk but is skipped.",
      },
      {
        id: "discard",
        label: "Discard milestone",
        description: "Permanently delete this milestone and all its contents.",
      },
      {
        id: "skip",
        label: "Skip — create new milestone",
        description: "Leave this milestone and start a fresh one.",
      },
      {
        id: "back",
        label: "Back",
        description: "Return to the previous menu.",
      },
    ],
    notYetMessage: "Run /gsd when ready.",
  });

  if (choice === "park") {
    const reason = await showNextAction(ctx, {
      title: `Park ${milestoneId}`,
      summary: ["Why is this milestone being parked?"],
      actions: [
        { id: "priority_shift", label: "Priority shift", description: "Other work is more important right now." },
        { id: "blocked_external", label: "Blocked externally", description: "Waiting on an external dependency or decision." },
        { id: "needs_rethink", label: "Needs rethinking", description: "The approach needs to be reconsidered." },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    // User pressed "Not yet" / Escape — cancel the park operation
    if (!reason || reason === "not_yet") return false;

    const reasonText = reason === "priority_shift" ? "Priority shift — other work is more important"
      : reason === "blocked_external" ? "Blocked externally — waiting on external dependency"
      : reason === "needs_rethink" ? "Needs rethinking — approach needs reconsideration"
      : "Parked by user";

    let success: boolean;
    try {
      success = parkMilestone(basePath, milestoneId, reasonText);
    } catch (err) {
      // #2255: the park did not take (e.g. DB sync failed) — surface it as an error.
      ctx.ui.notify(`Could not park ${milestoneId}: ${(err as Error).message}`, "error");
      return true;
    }
    if (success) {
      ctx.ui.notify(`Parked ${milestoneId}. Run /gsd unpark ${milestoneId} to reactivate.`, "info");
    } else {
      ctx.ui.notify(`Could not park ${milestoneId} — milestone not found or already parked.`, "warning");
    }
    return true;
  }

  if (choice === "discard") {
    const confirmed = await showConfirm(ctx, {
      title: "Discard milestone?",
      message: `This will permanently delete ${milestoneId} and all its contents (roadmap, plans, task summaries).`,
      confirmLabel: "Discard",
      declineLabel: "Cancel",
    });
    if (confirmed) {
      discardMilestone(basePath, milestoneId);
      ctx.ui.notify(`Discarded ${milestoneId}.`, "info");
      return true;
    }
    return false;
  }

  if (choice === "skip") {
    const milestoneIds = findMilestoneIds(basePath);
    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
    await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, stepMode, `New milestone ${nextId}.`);
    return true;
  }

  // "back" or null
  return false;
}

export async function showSmartEntry(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  options?: { step?: boolean },
): Promise<void> {
  const stepMode = options?.step ?? true;
  warmWorkflowMcpProbeInBackground(basePath);

  // ── Clear stale milestone ID reservations from previous cancelled sessions ──
  // Reservations only need to survive within a single /gsd interaction.
  // Without this, each cancelled session permanently bumps the next ID. (#2488)
  clearReservedMilestoneIds();

  // ── Directory safety check — refuse to operate in system/home dirs ───
  const dirCheck = validateDirectory(basePath);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason!, "error");
    return;
  }
  if (dirCheck.severity === "warning") {
    const proceed = await showConfirm(ctx, {
      title: "GSD — Unusual Directory",
      message: dirCheck.reason!,
      confirmLabel: "Continue anyway",
      declineLabel: "Cancel",
    });
    if (!proceed) return;
  }

  // ── Detection preamble — run before any bootstrap ────────────────────
  // Check bootstrap completeness, not just .gsd/ directory existence.
  // A zombie .gsd/ state (symlink exists but missing PREFERENCES.md and
  // milestones/) must trigger the init wizard, not skip it (#2942).
  const gsdPath = gsdRoot(basePath);
  const hasBootstrapArtifacts = hasGsdBootstrapArtifacts(gsdPath);
  let skipGitBootstrap = false;

  if (!hasBootstrapArtifacts) {
    const detection = detectProjectState(basePath);

    // v1 .planning/ detected — offer migration before anything else
    if (detection.state === "v1-planning" && detection.v1) {
      const migrationChoice = await offerMigration(ctx, detection.v1);
      if (migrationChoice === "cancel") return;
      if (migrationChoice === "migrate") {
        const { handleMigrate } = await import("./migrate/command.js");
        await handleMigrate("", ctx, pi);
        return;
      }
      // "fresh" — fall through to init wizard
    }

    // No .gsd/ or zombie .gsd/ — run the project init wizard
    const result = await showProjectInit(ctx, pi, basePath, detection);
    if (!result.completed) return; // User cancelled
    skipGitBootstrap = shouldSkipGitBootstrapAfterInit(result);

    // Init wizard bootstrapped .gsd/ — fall through to the normal flow below
    // which will detect "no milestones" and start the discuss prompt
  }

  // ── Ensure git repo exists — GSD needs it for worktree isolation ──────
  // Also handle inherited repos: if basePath is a subdirectory of another
  // git repo that has no .gsd, create a fresh repo to prevent cross-project
  // state leaks (#1639).
  if (!skipGitBootstrap && (!nativeIsRepo(basePath) || isInheritedRepo(basePath))) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }

  // ── Ensure .gitignore has baseline patterns ──────────────────────────
  if (!skipGitBootstrap && nativeIsRepo(basePath)) {
    const gitPrefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
    const manageGitignore = gitPrefs?.manage_gitignore;
    ensureGitignore(basePath, { manageGitignore });
    if (manageGitignore !== false) untrackRuntimeFiles(basePath);
  }

  // Deep setup can pre-create .gsd/PREFERENCES.md before the normal init
  // wizard path runs. If that path also initialized git, make HEAD reachable
  // now so later worktree/git-log operations do not run on an unborn branch.
  if (!skipGitBootstrap && nativeIsRepo(basePath) && !nativeHasCommittedHead(basePath)) {
    try {
      nativeAddAll(basePath);
      nativeCommit(basePath, "chore: init project");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning("guided", `initial git commit failed; worktree isolation will remain disabled until HEAD exists: ${message}`);
    }
  }

  {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen(basePath);
  }

  // ── Self-heal stale runtime records from crashed auto-mode sessions ──
  selfHealRuntimeRecords(basePath, ctx);

  const interrupted = await assessInterruptedSession(basePath);
  if (interrupted.classification === "running") {
    ctx.ui.notify(formatInterruptedSessionRunningMessage(interrupted), "error");
    return;
  }

  if (interrupted.classification === "stale") {
    clearLock(basePath);
    if (interrupted.pausedSession) {
      // Phase C pt 2: paused-session.json migrated to runtime_kv
      // (global scope, key PAUSED_SESSION_KV_KEY).
      try {
        deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
      } catch (e) {
        logWarning("guided", `stale paused-session DB cleanup failed: ${(e as Error).message}`, { file: "guided-flow.ts" });
      }
    }
  } else if (interrupted.classification === "recoverable") {
    if (interrupted.lock) clearLock(basePath);
    const resumeLabel = interrupted.pausedSession?.stepMode
      ? "Resume with /gsd next"
      : "Resume with /gsd auto";
    const resume = await showNextAction(ctx, {
      title: "GSD — Interrupted Session Detected",
      summary: formatInterruptedSessionSummary(interrupted),
      actions: [
        { id: "resume", label: resumeLabel, description: "Pick up where it left off", recommended: true },
        { id: "continue", label: "Continue manually", description: "Open the wizard as normal" },
      ],
    });
    if (resume === "resume") {
      startAutoDetached(ctx, pi, basePath, false, {
        interrupted,
        step: interrupted.pausedSession?.stepMode ?? false,
      });
      return;
    }
  }

  if (interrupted.classification !== "recoverable") {
    try {
      const { checkMarkdownHierarchyAgainstDb } = await import("./migration-auto-check.js");
      const result = await checkMarkdownHierarchyAgainstDb(basePath);
      if (result.action === "recovery-required") {
        if (result.recoveryCommand === "/gsd rebuild markdown") {
          if (shouldAttemptMarkdownAutoRebuild(result)) {
            try {
              const { rebuildMarkdownProjectionsFromDb } = await import("./commands-maintenance.js");
              const rebuild = await rebuildMarkdownProjectionsFromDb(basePath);
              const after = await checkMarkdownHierarchyAgainstDb(basePath);
              if (after.action === "none") {
                clearMarkdownAutoRebuildBackoff();
                const { message, level } = formatMarkdownSelfHealNotification(rebuild);
                ctx.ui.notify(message, level);
              } else {
                if (after.recoveryCommand === "/gsd rebuild markdown") {
                  recordMarkdownAutoRebuildFailure(after);
                } else {
                  clearMarkdownAutoRebuildBackoff();
                }
                ctx.ui.notify(
                  (after.message ?? "Markdown planning artifacts still diverge from the DB after auto-rebuild.") +
                    (rebuild.errors.length > 0
                      ? `\nAuto-rebuild had ${rebuild.errors.length} projection error(s).`
                      : "") +
                    "\nAutomatic rebuild is paused until this drift changes. Run `/gsd rebuild markdown` after review.",
                  "warning",
                );
              }
            } catch (rebuildErr) {
              const rebuildMessage = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
              logWarning("guided", `markdown auto-rebuild failed: ${rebuildMessage}`, { file: "guided-flow.ts" });
              recordMarkdownAutoRebuildFailure(result);
              ctx.ui.notify(
                (result.message ??
                  `Markdown planning artifacts do not match the authoritative DB. Run \`${result.recoveryCommand ?? "/gsd rebuild markdown"}\` to re-project from the DB.`) +
                  "\nAutomatic rebuild is paused until this drift changes.",
                "warning",
              );
            }
          }
        } else {
          clearMarkdownAutoRebuildBackoff();
          ctx.ui.notify(
            result.message ??
              `Markdown planning artifacts do not match the authoritative DB. Run \`${result.recoveryCommand ?? "/gsd recover"}\` to preview an explicit markdown import.`,
            "warning",
          );
        }
      } else {
        clearMarkdownAutoRebuildBackoff();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`GSD could not compare markdown planning artifacts with gsd.db: ${message}`, "warning");
      logWarning("guided", `planning state DB/markdown comparison failed: ${message}`, { file: "guided-flow.ts" });
    }
  }

  // Always derive from the project root — the assessment may have derived
  // state from a worktree path that was cleaned up in the stale branch above.
  const state = await deriveState(basePath);

  // Rebuild STATE.md from derived state before any dispatch (#3475).
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${(err as Error).message}`);
  }

  // ── Deep planning mode kickoff ────────────────────────────────────────
  // When `planning_depth: deep` is set (e.g. via `/gsd new-project --deep`)
  // and any project-level stage gate is still pending, keep the user-question
  // stages in the foreground conversation. Auto-mode is resumed only after
  // the project interview artifacts exist, so questions do not look like
  // cancelled auto-mode runs.
  // Light mode and fully-completed deep projects fall through to the
  // standard wizard below.
  {
    const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
    const { shouldRunDeepProjectSetup } = await import("./auto-dispatch.js");
    if (shouldRunDeepProjectSetup(state, prefs, basePath)) {
      await startDeepProjectSetupForeground(ctx, pi, basePath, stepMode);
      return;
    }
  }

  const planV2GateDecision = runPlanV2Gate(ctx, basePath, state);
  if (planV2GateDecision === "block") return;

  const closeout = await loadCloseoutContext(basePath);
  const primaryCloseout = getPrimaryCloseoutRecommendation(closeout);

  if (!state.activeMilestone?.id) {
    // Guard: if a discuss session is already in flight, don't re-inject the prompt.
    // Both /gsd and /gsd auto reach this branch when no milestone exists yet.
    // Without this guard, every subsequent /gsd call overwrites the pending auto-start
    // and fires another dispatchWorkflow, resetting the conversation mid-interview.
    if (hasPendingAutoStart(basePath)) {
      // #3274: If /clear interrupted the discussion, the pending entry is stale.
      // Detect staleness: no manifest, no milestone CONTEXT/CONTEXT-DRAFT artifact,
      // the entry is older than 30s (avoids race between .set() and LLM writing the
      // first artifact), AND no agent turn is in flight. A dispatched discuss turn
      // can think for well over 30s before its first question round writes any
      // artifact; deleting the entry while that turn is live re-dispatches the
      // workflow, which both resets the interview and queues a duplicate turn that
      // replays the final "context written" message after the real one.
      const entry = _getPendingAutoStart(basePath)!;
      const ageMs = Date.now() - (entry.createdAt || 0);
      const manifestExists = existsSync(join(gsdRoot(basePath), "DISCUSSION-MANIFEST.json"));
      const milestoneHasContext = !!resolveMilestoneFile(basePath, entry.milestoneId, "CONTEXT");
      const milestoneHasDraft = !!resolveMilestoneFile(basePath, entry.milestoneId, "CONTEXT-DRAFT");
      const milestoneHasRoadmap = !!resolveMilestoneFile(basePath, entry.milestoneId, "ROADMAP");
      const milestoneRow = isDbAvailable() ? getMilestone(entry.milestoneId) : null;
      const discussPlanComplete = milestoneHasRoadmap && !!milestoneRow && milestoneRow.status !== "queued";
      if (discussPlanComplete) {
        // The discuss flow already completed, but pending auto-start cleanup handshake did not run.
        // Clear stale in-memory guard and continue through normal active-milestone routing.
        deletePendingAutoStart(basePath);
      } else if (
        !manifestExists &&
        !milestoneHasContext &&
        !milestoneHasDraft &&
        ageMs > 30_000 &&
        !isAgentTurnInFlight(ctx)
      ) {
        // Stale entry from an interrupted discussion — clear and continue
        deletePendingAutoStart(basePath);
      } else {
        if (milestoneHasContext && !isAgentTurnInFlight(ctx)) {
          // The discussion already produced CONTEXT but the agent_end handoff
          // never consumed the entry — e.g. an external-engine post-hoc gate
          // re-arm wiped the depth verification after the save (write-gate
          // two-process sync). CONTEXT can only be written through a verified
          // depth gate, so a gate still pending for this milestone is stale:
          // clear it and re-run the handoff instead of dead-ending.
          const gateBasePath = entry.scope.workspace.projectRoot;
          const pendingGateId = getPendingGate(gateBasePath);
          if (pendingGateId && extractDepthVerificationMilestoneId(pendingGateId) === entry.milestoneId) {
            clearPendingGate(gateBasePath);
          }
          if (checkAutoStartAfterDiscuss(basePath)) return;
        }
        ctx.ui.notify("Discussion already in progress — answer the question above to continue.", "info");
        return;
      }
    }

    const milestoneIds = findMilestoneIds(basePath);

    // Sanity check (#456): if findMilestoneIds returns [] but the milestones
    // directory has contents, something went wrong (permissions, stale worktree
    // cwd, etc). Warn instead of silently starting a new-project flow.
    if (milestoneIds.length === 0) {
      const mDir = milestonesDir(basePath);
      const legDir = legacyMilestonesDir(basePath);
      // Check flat-phase dir first; fall back to legacy milestones/ dir
      const checkDir = existsSync(mDir) ? mDir : existsSync(legDir) ? legDir : null;
      if (checkDir) {
        try {
          const entries = clearEmptyLegacyDeepSetupPseudoMilestones(basePath, readdirSync(checkDir), checkDir);
          if (entries.length > 0) {
            ctx.ui.notify(
              `Milestone directory has ${entries.length} entries but none were recognized as milestones. ` +
              `This may indicate a corrupted state or wrong working directory. Run \`/gsd doctor\` to diagnose.`,
              "warning",
            );
            return;
          }
        } catch (e) { logWarning("guided", `directory read failed: ${(e as Error).message}`); }
      }
    }

    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
    const isFirst = milestoneIds.length === 0;

    if (isFirst) {
      // First ever — skip wizard, just ask directly
      ctx.ui.setStatus("gsd-step", "New Milestone · answer the questions above to plan");
      await dispatchNewMilestoneDiscuss(
        ctx,
        pi,
        basePath,
        nextId,
        stepMode,
        `New project, milestone ${nextId}. Do NOT read or explore .gsd/ — it's empty scaffolding.`,
      );
    } else {
      if (!isInteractiveCommandContext(ctx)) {
        notifySmartEntryNeedsInteractiveMenu(ctx, "milestone menu needs an interactive session");
        return;
      }
      const choice = await showNextAction(ctx, {
        title: "GSD — Git Ship Done",
        summary: buildIdleMenuSummary(state, closeout),
        actions: [
          ...buildCloseoutMenuActions(closeout),
          ...(state.phase === "complete" ? [{
            id: "status",
            label: "Review status",
            description: "Open the live run dashboard. For shipped work, use /gsd visualize.",
            recommended: false,
          }] : []),
          {
            id: "new_milestone",
            label: state.phase === "complete" ? "Start new milestone" : "Create next milestone",
            description: "Define a larger body of work with planning artifacts.",
            recommended: primaryCloseout === null,
          },
          {
            id: "quick_task",
            label: "Quick task",
            description: "For small bounded work, run /gsd quick <task> or /gsd do <task>.",
            recommended: false,
          },
        ],
        notYetMessage: "Run /gsd when ready.",
      });

      if (await handleCloseoutChoice(ctx, basePath, choice, closeout)) return;
      if (choice === "status") {
        const { fireStatusViaCommand } = await import("./commands.js");
        await fireStatusViaCommand(ctx);
      } else if (choice === "quick_task") {
        await runQuickTaskChoice(ctx, pi);
      } else if (choice === "new_milestone") {
        ctx.ui.setStatus("gsd-step", "New Milestone · answer the questions above to plan");
        await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, stepMode, `New milestone ${nextId}.`);
      }
    }
    return;
  }

  const milestoneId = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;

  if (planV2GateDecision === "recover-missing-context") {
    setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
    await dispatchWorkflow(
      pi,
      await buildDiscussMilestonePrompt(
        milestoneId,
        milestoneTitle,
        basePath,
        getStructuredQuestionsAvailability(pi, ctx),
      ),
      "gsd-discuss",
      ctx,
      "discuss-milestone",
      { basePath },
    );
    return;
  }

  // ── All milestones complete → New milestone ──────────────────────────
  if (state.phase === "complete") {
    if (!isInteractiveCommandContext(ctx)) {
      notifySmartEntryNeedsInteractiveMenu(ctx, "all milestones are complete");
      return;
    }
    const unmappedActive = countUnmappedActiveRequirements();
    const choice = await showNextAction(ctx, {
      title: "GSD — All milestones complete",
      summary: buildIdleMenuSummary(state, closeout),
      actions: [
        ...buildCloseoutMenuActions(closeout),
        ...(unmappedActive > 0 ? [{
          id: "review_requirements_backlog",
          label: "Review requirements backlog",
          description: `Inspect ${unmappedActive} unmapped active requirement${unmappedActive === 1 ? "" : "s"} before starting new work.`,
          recommended: primaryCloseout === null,
        }] : []),
        {
          id: "status",
          label: "Review status",
          description: "Open the live run dashboard. For shipped work, use /gsd visualize.",
          recommended: false,
        },
        {
          id: "new_milestone",
          label: "Start new milestone",
          description: "Define and plan the next milestone.",
          recommended: primaryCloseout === null && unmappedActive === 0,
        },
        {
          id: "quick_task",
          label: "Quick task",
          description: "Do a small bounded task without opening a milestone.",
          recommended: false,
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (await handleCloseoutChoice(ctx, basePath, choice, closeout)) return;
    if (choice === "quick_task") {
      await runQuickTaskChoice(ctx, pi);
    } else if (choice === "review_requirements_backlog") {
      const reviewChoice = await showRequirementsBacklogReview(ctx, basePath);
      if (reviewChoice === "new_milestone") {
        await launchNextMilestoneDiscuss(ctx, pi, basePath, stepMode, { mapRequirementsBacklog: true });
      }
    } else if (choice === "new_milestone") {
      await launchNextMilestoneDiscuss(ctx, pi, basePath, stepMode);
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    }
    return;
  }

  // ── Draft milestone — needs discussion before planning ────────────────
  if (state.phase === "needs-discussion") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off — seed material is loaded automatically.",
          recommended: true,
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch.",
        },
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone as-is and start something new.",
        },
      ],
      notYetMessage: "Run /gsd when ready to discuss this milestone.",
    });

    if (choice === "discuss_draft") {
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const seed = await buildDiscussMilestonePrompt(
        milestoneId,
        milestoneTitle,
        basePath,
        structuredQuestionsAvailable,
        {
          commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
          includeContextMode: false,
        },
      );
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone", { basePath });
    } else if (choice === "discuss_fresh") {
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const prompt = await buildDiscussMilestonePrompt(
        milestoneId,
        milestoneTitle,
        basePath,
        structuredQuestionsAvailable,
        {
          commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
          includeContextMode: false,
          includeDraftSeed: false,
        },
      );
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
      await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone", { basePath });
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
      await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, stepMode, `New milestone ${nextId}.`);
    }
    return;
  }

  if (state.phase === "blocked") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId}: ${milestoneTitle}`,
      summary: state.blockers.length > 0
        ? state.blockers
        : [state.nextAction || "This milestone is blocked."],
      actions: [
        {
          id: "status",
          label: "Fix or recover",
          description: "Review the blocker and recovery commands for the active milestone.",
          recommended: true,
        },
        {
          id: "park",
          label: "Park milestone",
          description: "Explicitly defer this milestone before starting other work.",
        },
      ],
      notYetMessage: "Resolve the blocker, or park the milestone explicitly.",
    });

    if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "park") {
      let success: boolean;
      try {
        success = parkMilestone(basePath, milestoneId, "Validation attention deferred by user");
      } catch (err) {
        // #2255: the park did not take (e.g. DB sync failed) — surface it as an error.
        ctx.ui.notify(`Could not park ${milestoneId}: ${(err as Error).message}`, "error");
        return;
      }
      ctx.ui.notify(
        success ? `Parked ${milestoneId}. Run /gsd unpark ${milestoneId} to reactivate.` : `Could not park ${milestoneId} — milestone not found.`,
        success ? "info" : "warning",
      );
    }
    return;
  }

  // ── No active slice ──────────────────────────────────────────────────
  if (!state.activeSlice) {
    const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const hasRoadmap = !!(roadmapFile && await loadFile(roadmapFile));

    // A roadmap file with zero parseable slices (placeholder text) should be
    // treated the same as no roadmap — offer "Create roadmap" instead of "Go auto"
    // which would immediately get stuck in blocked state (#3441).
    let roadmapHasSlices = false;
    if (hasRoadmap) {
      const roadmapContent = await loadFile(roadmapFile!);
      if (roadmapContent) {
        roadmapHasSlices = _roadmapHasParseableSlicesForTest(roadmapContent);
      }
    }

    if (!hasRoadmap || !roadmapHasSlices) {
      // No roadmap → discuss or plan
      const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));

      const actions = [
        ...buildCloseoutMenuActions(closeout),
        {
          id: "plan",
          label: "Create roadmap",
          description: hasContext
            ? "Context captured. Decompose into slices with a boundary map."
            : "Decompose the milestone into slices with a boundary map.",
          recommended: primaryCloseout === null,
        },
        ...(!hasContext ? [{
          id: "discuss",
          label: "Discuss first",
          description: "Capture decisions on gray areas before planning.",
        }] : []),
        {
          id: "quick_task",
          label: "Quick task instead",
          description: "Use this when the work is small and should not become a milestone.",
          recommended: false,
        },
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone on disk and start a fresh one.",
        },
        {
          id: "discard_milestone",
          label: "Discard this milestone",
          description: "Delete the milestone directory and start over.",
        },
      ];

      const choice = await showNextAction(ctx, {
        title: `GSD — ${milestoneId}: ${milestoneTitle}`,
        summary: [hasContext ? "Context captured. Ready to create roadmap." : "New milestone — no roadmap yet."],
        actions,
        notYetMessage: "Run /gsd when ready.",
      });

      if (await handleCloseoutChoice(ctx, basePath, choice, closeout)) return;
      if (choice === "quick_task") {
        await runQuickTaskChoice(ctx, pi);
      } else if (choice === "plan") {
        ctx.ui.setStatus("gsd-step", "Planning Milestone · decomposing into slices");
        setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
        await dispatchWorkflow(
          pi,
          await buildPlanMilestonePrompt(
            milestoneId,
            milestoneTitle,
            basePath,
            scopeMilestone(createWorkspace(basePath), milestoneId),
          ),
          "gsd-run",
          ctx,
          "plan-milestone",
          { basePath },
        );
      } else if (choice === "discuss") {
        const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
        const prompt = await buildDiscussMilestonePrompt(
          milestoneId,
          milestoneTitle,
          basePath,
          structuredQuestionsAvailable,
          {
            commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
            includeContextMode: false,
          },
        );
        await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "discuss-milestone", { basePath });
      } else if (choice === "skip_milestone") {
        const milestoneIds = findMilestoneIds(basePath);
        const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
        const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
        await dispatchNewMilestoneDiscuss(ctx, pi, basePath, nextId, stepMode, `New milestone ${nextId}.`);
      } else if (choice === "discard_milestone") {
        const confirmed = await showConfirm(ctx, {
          title: "Discard milestone?",
          message: `This will permanently delete ${milestoneId} and all its contents.`,
          confirmLabel: "Discard",
          declineLabel: "Cancel",
        });
        if (confirmed) {
          discardMilestone(basePath, milestoneId);
          return showSmartEntry(ctx, pi, basePath, options);
        }
      }
    } else {
      // Roadmap exists — either blocked or ready for auto
      const actions = [
        {
          id: "auto",
          label: "Go auto",
          description: "Execute everything automatically until milestone complete.",
          recommended: true,
        },
        {
          id: "status",
          label: "View status",
          description: "See milestone progress and blockers.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ];

      const choice = await showNextAction(ctx, {
        title: `GSD — ${milestoneId}: ${milestoneTitle}`,
        summary: ["Roadmap exists. Ready to execute."],
        actions,
        notYetMessage: "Run /gsd status for details.",
      });

      if (choice === "auto") {
        startAutoDetached(ctx, pi, basePath, false);
      } else if (choice === "status") {
        const { fireStatusViaCommand } = await import("./commands.js");
        await fireStatusViaCommand(ctx);
      } else if (choice === "milestone_actions") {
        const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
        if (acted) return showSmartEntry(ctx, pi, basePath, options);
      }
    }
    return;
  }

  const sliceId = state.activeSlice.id;
  const sliceTitle = state.activeSlice.title;

  // ── Slice needs planning ─────────────────────────────────────────────
  if (state.phase === "planning") {
    const contextFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTEXT");
    const researchFile = resolveSliceFile(basePath, milestoneId, sliceId, "RESEARCH");
    const hasContext = !!(contextFile && await loadFile(contextFile));
    const hasResearch = !!(researchFile && await loadFile(researchFile));

    const actions = [
      {
        id: "plan",
        label: `Plan ${sliceId}`,
        description: `Decompose "${sliceTitle}" into tasks with must-haves.`,
        recommended: true,
      },
      ...(!hasContext ? [{
        id: "discuss",
        label: `Discuss ${sliceId} first`,
        description: "Capture context and decisions for this slice.",
      }] : []),
      ...(!hasResearch ? [{
        id: "research",
        label: `Research ${sliceId} first`,
        description: "Scout codebase and relevant docs.",
      }] : []),
      {
        id: "status",
        label: "View status",
        description: "See milestone progress.",
      },
      {
        id: "milestone_actions",
        label: "Milestone actions",
        description: "Park, discard, or skip this milestone.",
      },
    ];

    const summaryParts = [];
    if (hasContext) summaryParts.push("context ✓");
    if (hasResearch) summaryParts.push("research ✓");
    const summaryLine = summaryParts.length > 0
      ? `${sliceId}: ${sliceTitle} (${summaryParts.join(", ")})`
      : `${sliceId}: ${sliceTitle} — ready for planning.`;

    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [summaryLine],
      actions,
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "plan") {
      ctx.ui.setStatus("gsd-step", "Slice Planning · answer the questions above");
      await dispatchWorkflow(
        pi,
        await buildPlanSlicePrompt(milestoneId, milestoneTitle, sliceId, sliceTitle, basePath),
        "gsd-run",
        ctx,
        "plan-slice",
        { basePath },
      );
    } else if (choice === "discuss") {
      const discussBasePath = resolveDiscussSliceBasePath(basePath, milestoneId);
      const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
      const prompt = await buildDiscussSlicePrompt(milestoneId, sliceId, sliceTitle, discussBasePath, {
        rediscuss: hasContext,
        structuredQuestionsAvailable: sqAvail,
      });
      await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "discuss-slice", { basePath: discussBasePath });
    } else if (choice === "research") {
      const researchTemplates = inlineTemplate("research", "Research");
      await dispatchWorkflow(pi, loadPrompt("guided-research-slice", {
        milestoneId,
        sliceId,
        sliceTitle,
        scoutAgentType: resolveSubagentRoleForProvider("scout", ctx.model?.provider),
        inlinedTemplates: researchTemplates,
        skillActivation: buildSkillActivationBlock({
          base: basePath,
          milestoneId,
          sliceId,
          sliceTitle,
          extraContext: [researchTemplates],
        }),
      }), "gsd-run", ctx, "research-slice", { basePath });
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── All tasks done → Complete slice ──────────────────────────────────
  if (state.phase === "summarizing") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: ["All tasks complete. Ready for slice summary."],
      actions: [
        {
          id: "complete",
          label: `Complete ${sliceId}`,
          description: "Write slice summary, UAT, mark done, and squash-merge to main.",
          recommended: true,
        },
        {
          id: "status",
          label: "View status",
          description: "Review tasks before completing.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "complete") {
      ctx.ui.setStatus("gsd-step", "Completing Slice · review changes above");
      await dispatchWorkflow(
        pi,
        await buildCompleteSlicePrompt(milestoneId, milestoneTitle, sliceId, sliceTitle, basePath),
        "gsd-run",
        ctx,
        "complete-slice",
        { basePath },
      );
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── Active task → Execute ────────────────────────────────────────────
  if (state.activeTask) {
    const taskId = state.activeTask.id;
    const taskTitle = state.activeTask.title;

    const continueFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE");
    const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
    const hasInterrupted = !!(continueFile && await loadFile(continueFile)) ||
      !!(sDir && await loadFile(join(sDir, "continue.md")));

    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [
        hasInterrupted
          ? `Resuming: ${taskId} — ${taskTitle}`
          : `Next: ${taskId} — ${taskTitle}`,
      ],
      actions: [
        {
          id: "execute",
          label: hasInterrupted ? `Resume ${taskId}` : `Execute ${taskId}`,
          description: hasInterrupted
            ? "Continue from where you left off."
            : `Start working on "${taskTitle}".`,
          recommended: true,
        },
        {
          id: "auto",
          label: "Go auto",
          description: "Execute this and all remaining tasks automatically.",
        },
        {
          id: "status",
          label: "View status",
          description: "See slice progress before starting.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "not_yet") return;

    const route = resolveActiveTaskChoiceRoute({
      choice: choice as ActiveTaskChoice,
      isolationMode: getIsolationMode(basePath),
      milestoneId,
    });

    if (route.kind === "auto-bootstrap") {
      startAutoDetached(ctx, pi, basePath, route.verboseMode, route.options);
      return;
    }

    if (route.kind === "guided-dispatch") {
      ctx.ui.setStatus("gsd-step", "Executing Task · follow progress above");
      if (hasInterrupted) {
        await dispatchWorkflow(pi, loadPrompt("guided-resume-task", {
          milestoneId,
          sliceId,
          skillActivation: buildSkillActivationBlock({
            base: basePath,
            milestoneId,
            sliceId,
            taskId,
            taskTitle,
          }),
        }), "gsd-run", ctx, "execute-task", { basePath });
      } else {
        await dispatchWorkflow(
          pi,
          await buildExecuteTaskPrompt(milestoneId, sliceId, sliceTitle, taskId, taskTitle, basePath),
          "gsd-run",
          ctx,
          "execute-task",
          { basePath },
        );
      }
    } else if (route.kind === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (route.kind === "milestone-actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── Fallback: show status ────────────────────────────────────────────
  const { fireStatusViaCommand } = await import("./commands.js");
  await fireStatusViaCommand(ctx);
}
