// Project/App: gsd-pi
// File Purpose: Builds GSD auto-mode unit prompts and pre-dispatch checks.

/**
 * Auto-mode Prompt Builders — construct dispatch prompts for each unit type.
 *
 * Pure async functions that load templates and inline file content. No module-level
 * state, no globals — every dependency is passed as a parameter or imported as a
 * utility.
 */

import { loadFile, parseContinue, parseSummary, loadActiveOverrides, formatOverridesSection, parseTaskPlanFile } from "./files.js";
import type { Override } from "./files.js";
import { extractVerdict } from "./verdict-parser.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveTasksDir, resolveTaskFiles, resolveTaskFile,
  taskIdFromTaskFileName,
  relMilestoneFile, relSliceFile, relSlicePath, relMilestonePath,
  relTaskFile, resolveGsdRootFile, relGsdRootFile, resolveRuntimeFile, targetMilestoneFile,
  normalizeRealPath,
} from "./paths.js";
import { resolveInlineLevel, loadEffectiveGSDPreferences, renderLanguageDirectiveForPrompt } from "./preferences.js";
import { createRepositoryRegistryFromPreferences } from "./repository-registry.js";
import { isContextModeEnabled } from "./preferences-types.js";
import type { GSDState, InlineLevel } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import { join, basename, relative, sep } from "node:path";
import { existsSync } from "node:fs";
import { computeBudgets, resolveExecutorContextWindow, truncateAtSectionBoundary, type MinimalModelRegistry } from "./context-budget.js";
import type { TokenProvider } from "./token-counter.js";
import {
  getBlockingReworkFindingsForTask,
  getGateResults,
  getMilestoneSlices,
  getPendingGates,
  getPendingGatesForTurn,
  getSlice,
  getTask,
  isDbAvailable,
} from "./gsd-db.js";
import {
  GATE_REGISTRY,
  assertGateCoverage,
  getGatesForTurn,
  type GateDefinition,
} from "./gate-registry.js";
import { formatDecisionsCompact, formatRequirementsCompact } from "./structured-data-formatter.js";
import { readPhaseAnchor, formatAnchorForPrompt } from "./phase-anchor.js";
import {
  composeContextModeInstructions,
  composeContractedUnitContext,
  composeInlinedContext,
  composeToolSurfaceInstructions,
  composeUnitContext,
  type ArtifactResolver,
  type ComposedUnitContextBlock,
  type ContextModeRenderMode,
  type ExcerptResolver,
} from "./unit-context-composer.js";
import { resolveManifest, type ArtifactKey } from "./unit-context-manifest.js";
import { resolveSliceResearchLocation } from "./auto-artifact-paths.js";
import { compileUnitContextContract, type UnitPromptContextContract } from "./tool-contract.js";
import { readCompactionSnapshot } from "./compaction-snapshot.js";
import { logWarning } from "./workflow-logger.js";
import { inlineGraphSubgraph } from "./graph-context.js";
import { buildExtractionStepsBlock } from "./commands-extract-learnings.js";
import { classifyProject, type ProjectClassification } from "./detection.js";
import { debugLog } from "./debug-logger.js";
import { buildSkillActivationBlock, buildSkillDiscoveryVars } from "./skill-activation.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { buildRunUatPresentationForType, RUN_UAT_TOOL_PRESENTATION_PLAN_ID } from "./tool-presentation-plan.js";
import { classifyUatContentForRun } from "./uat-policy.js";
import { checkNeedsRunUat as resolveNeedsRunUat, type UatDispatchCandidate } from "./uat-dispatch.js";
import { isClosedStatus } from "./status-guards.js";
import { buildWebAppUatGuidanceBlock } from "./web-app-uat.js";
import {
  readPendingTaskRecoveryContext,
  type PendingTaskRecoveryContext,
} from "./task-recovery-domain-operation.js";
import type { MilestoneScope } from "./workspace.js";
import { resolveSubagentRoleForProvider } from "./subagent-role-resolver.js";

export { buildSkillActivationBlock, buildSkillDiscoveryVars };

// ─── Preamble Cap ─────────────────────────────────────────────────────────────

/**
 * Static ceiling for the preamble cap. Kept as an upper bound even
 * after context-window-aware sizing so large-window users don't suddenly see
 * 10× looser caps than needed. Small-window users get a tighter cap derived
 * from their configured executor window.
 */
const MAX_PREAMBLE_CHARS = 20_000;

function prependLanguageDirectiveForBase(base: string, prompt: string): string {
  const directive = renderLanguageDirectiveForPrompt(
    loadEffectiveGSDPreferences(base)?.preferences,
  );
  if (!directive || prompt.startsWith(directive)) return prompt;
  return `${directive}\n\n${prompt}`;
}

/**
 * Resolve prompt budgets from the configured executor context window.
 *
 * The prompt builders here don't have access to the runtime model registry
 * (they're called from many non-ctx sites), so `resolveExecutorContextWindow`
 * is fed the user-configurable `context_window_override` preference as the
 * `sessionContextWindow` fallback. That preference exists specifically to
 * cover small-window local models (e.g. 32K lemonade/llama.cpp servers) whose
 * n_ctx is not discoverable through the model registry. Issue #4435.
 */
function resolvePromptBudgets(): ReturnType<typeof computeBudgets> {
  try {
    const prefs = loadEffectiveGSDPreferences();
    const sessionWindow = prefs?.preferences.context_window_override;
    const windowTokens = resolveExecutorContextWindow(undefined, prefs?.preferences, sessionWindow);
    return computeBudgets(windowTokens, resolveExecutionProvider(prefs?.preferences));
  } catch (e) {
    logWarning("prompt", `resolvePromptBudgets failed: ${(e as Error).message}`);
    return computeBudgets(200_000);
  }
}

/**
 * Best-effort provider for the chars/token ratio: the executor's configured
 * model profile is the only provider source reachable here (the runtime
 * `sessionProvider` that reaches `formatExecutorConstraints` isn't threaded to
 * `capPreamble`/summary callers). Undefined when no explicit provider is set —
 * `computeBudgets` then uses the 4.0 default, i.e. today's behavior.
 */
function resolveExecutionProvider(prefs?: { models?: { execution?: unknown } }): TokenProvider | undefined {
  const exec = prefs?.models?.execution;
  if (exec && typeof exec === "object" && "provider" in exec) {
    const provider = (exec as { provider?: unknown }).provider;
    if (typeof provider === "string" && provider) return provider as TokenProvider;
  }
  return undefined;
}

/**
 * Character budget for dependency/prior slice summaries injected into dispatch
 * prompts. Scales with the executor's configured context window (issue #4435).
 */
function resolveSummaryBudgetChars(): number {
  return resolvePromptBudgets().summaryBudgetChars;
}


function renderBlockingReworkFindingsBlock(mid: string, sid: string, tid: string): string {
  const findings = getBlockingReworkFindingsForTask(mid, sid, tid)
    .filter((finding) => finding.status === "pending");
  if (findings.length === 0) return "";

  const lines = [
    "## Blocking Rework Findings (non-optional)",
    "",
    "This task has structured blocking rework findings. Address every finding before calling `gsd_task_complete`. Include `reworkResolution` entries with each `findingId`, `status: \"resolved\"`, and concrete evidence. If deferring a finding, use `status: \"deferred-with-override\"` with concrete evidence and `decisionRef`.",
    "",
  ];
  for (const finding of findings) {
    lines.push(`### ${finding.finding_id} (${finding.severity})`);
    lines.push(`- Status: ${finding.status}`);
    lines.push(`- Finding: ${finding.description}`);
    lines.push(`- Required fix: ${finding.required_fix}`);
    if (finding.verification_commands.length > 0) {
      lines.push("- Required verification:");
      for (const command of finding.verification_commands) {
        lines.push(`  - \`${command}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function renderTaskRecoveryDispatchContext(
  recovery: PendingTaskRecoveryContext,
): string {
  const isAuthorizedContinuation = recovery.resumeAuthorized === true;
  let executionContract: string;
  switch (recovery.action) {
    case "retry":
      executionContract = "Retry the Task from the preserved checkpoint; do not discard the prior failure evidence.";
      break;
    case "repair":
      executionContract = "First repair the deterministic execution fault before continuing the Task.";
      break;
    case "remediate":
      executionContract = "Fix the failed verification evidence and rerun verification before completing the Task.";
      break;
    case "replan":
      executionContract = recovery.replanCompleted
        ? "The replacement Task plan is durable. Execute that replacement plan; do not repeat the invalid plan."
        : "The current Task plan is superseded. This planning unit must call `gsd_replan_task`, then stop before implementation.";
      break;
    case "continue":
      executionContract = "Resume authorization is already durable and this dispatch owns its successor Attempt. Do not call `gsd_task_recovery_resume`; continue from the checkpoint.";
      break;
  }
  return [
    "## Durable Task Recovery",
    "",
    `**Required action:** ${recovery.action}`,
    `**Recovery action:** ${recovery.recoveryActionId}`,
    `**Failed Attempt / Result:** ${recovery.attemptId} / ${recovery.resultId}`,
    `**Failure kind:** ${recovery.failureKind}`,
    `**Failure:** ${recovery.summary}`,
    `**Rationale:** ${recovery.rationale}`,
    `**Work checkpoint:** ${recovery.checkpoint.checkpointId}`,
    isAuthorizedContinuation
      ? `**Repair summary:** ${recovery.checkpoint.confirmedContext}`
      : `**Confirmed context:** ${recovery.checkpoint.confirmedContext}`,
    `**Unresolved:** ${recovery.checkpoint.unresolvedSummary}`,
    `**Suggested next action:** ${recovery.checkpoint.suggestedNextAction}`,
    "",
    "### Durable Evidence",
    "",
    "```json",
    JSON.stringify(recovery.evidence, null, 2),
    "```",
    ...(isAuthorizedContinuation
      ? [
          "",
          "### Authorized Resume Evidence",
          "",
          "```json",
          recovery.checkpoint.evidenceSummary,
          "```",
        ]
      : []),
    "",
    executionContract,
  ].join("\n");
}

function formatProjectClassificationForPlanning(classification: ProjectClassification): string {
  const sampleFiles = classification.contentFiles.slice(0, 8);
  const sample = sampleFiles.length > 0 ? sampleFiles.map((file) => `\`${file}\``).join(", ") : "(none)";
  const lines = [
    "### Project Classification",
    "",
    `- **Kind:** ${classification.kind}`,
    `- **Content files:** ${classification.contentFiles.length}`,
    `- **Sample files:** ${sample}`,
    `- **Reason:** ${classification.reason}`,
    "",
  ];

  if (classification.kind === "untyped-existing") {
    if (classification.contentFiles.length <= 2) {
      lines.push(
        "**Workflow sizing:** This is a tiny existing untyped project. Prefer exactly one slice unless the milestone request clearly spans multiple independent user-visible capabilities.",
      );
    } else if (classification.contentFiles.length <= 5) {
      lines.push(
        "**Workflow sizing:** This is a small existing untyped project. Prefer 1-2 slices unless the milestone request clearly spans multiple independent user-visible capabilities.",
      );
    } else {
      lines.push(
        "**Workflow sizing:** Existing untyped project. Use generic file-level workflow guidance and size slices by real capability boundaries, not by missing tooling markers.",
      );
    }
  } else if (classification.kind === "greenfield") {
    lines.push("**Workflow sizing:** No project content exists yet. Use normal greenfield sizing for the requested scope.");
  } else if (classification.kind === "typed-existing") {
    lines.push("**Workflow sizing:** Known project markers exist. Use normal ecosystem-aware planning guidance.");
  } else {
    lines.push("**Workflow sizing:** Invalid repository state. Planning should surface this as a blocker rather than inventing project structure.");
  }

  return lines.join("\n");
}

function normalizeArtifactRef(value: string): string {
  return value.trim().replace(/^[-\s]+/, "").replace(/^["'`]+|["'`]+$/g, "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseCoveredArtifacts(validationContent: string): Set<string> {
  const covered = new Set<string>();
  const lines = validationContent.split(/\r?\n/);
  let inCoveredArtifacts = false;
  for (const line of lines) {
    if (/^\s*covered[-_]?artifacts\s*:/i.test(line)) {
      inCoveredArtifacts = true;
      const inline = line.split(/covered[-_]?artifacts\s*:/i)[1]?.trim();
      if (inline && inline !== "[]") {
        inline.replace(/^\[|\]$/g, "").split(",").map(normalizeArtifactRef).filter(Boolean).forEach((item) => covered.add(item));
      }
      continue;
    }
    if (!inCoveredArtifacts) continue;
    if (/^\S/.test(line) && !/^\s*-/.test(line)) break;
    const item = line.match(/^\s*-\s*(.+)$/)?.[1];
    if (item) covered.add(normalizeArtifactRef(item));
  }
  return covered;
}

function isValidationFreshOrApplicable(validationContent: string | null, currentArtifacts: string[]): boolean {
  if (!validationContent) return false;
  if (!/validation_metadata:/i.test(validationContent)) return false;
  const coveredArtifacts = parseCoveredArtifacts(validationContent);
  if (coveredArtifacts.size === 0) return false;
  return currentArtifacts
    .map(normalizeArtifactRef)
    .filter(Boolean)
    .every((artifact) => coveredArtifacts.has(artifact));
}

function formatCloseoutReviewInstructions(validationContent: string | null, validationRel: string, currentArtifacts: string[]): string {
  const verdict = validationContent ? extractVerdict(validationContent) : null;
  const validationFresh = isValidationFreshOrApplicable(validationContent, currentArtifacts);
  if (verdict === "pass" && validationFresh) {
    return [
      "### Passing Validation Artifact",
      "",
      `A passing validation projection is present at \`${validationRel}\`. Use it as readable evidence context for success criteria, requirement coverage, verification classes, and cross-slice integration; the current database receipt remains authoritative.`,
      "",
      "Do not delegate fresh reviewer/security/tester audits and do not redo the validation evidence review unless the artifact is internally inconsistent with the inlined summaries. Focus this unit on final milestone narrative, learnings, PROJECT/requirements updates, and `gsd_complete_milestone`.",
    ].join("\n");
  }

  if (verdict) {
    return [
      "### Validation Requires Attention",
      "",
      `A validation artifact is present at \`${validationRel}\` with verdict \`${verdict}\`, but it is missing freshness metadata or does not cover current milestone artifacts. Do not treat the milestone as complete unless the issues are resolved and evidence supports completion.`,
    ].join("\n");
  }

  return [
    "### No Passing Validation Artifact",
    "",
    `No passing validation artifact was found at \`${validationRel}\`. Use the full closeout review path before completion.`,
  ].join("\n");
}

export function capPreamble(preamble: string): string {
  // Cap inlined context at min(static ceiling, scaled inline budget).
  // The ceiling bounds repeated auto prompt payloads; the scaled
  // budget tightens the cap for small-window users whose true safe limit is
  // below 30K. `computeBudgets` allocates 40% of total chars to inline context.
  const budget = Math.min(MAX_PREAMBLE_CHARS, resolvePromptBudgets().inlineContextBudgetChars);
  if (preamble.length <= budget) return preamble;
  return truncateAtSectionBoundary(preamble, budget).content;
}

/**
 * Cap the execute-task inline blocks against one shared budget in priority
 * order. Unlike `capPreamble` (single concatenated preamble), execute-task
 * feeds these blocks into separate, non-contiguous template placeholders, so
 * they can't be joined and re-split — the budget is spent block-by-block.
 *
 * The task plan is the authoritative execution contract: it is never truncated
 * here (it consumes budget first, whole). Remaining budget flows to the slice
 * excerpt, then templates, each truncated at section boundaries so the lowest-
 * priority context drops whole trailing sections first. When the task plan
 * alone meets or exceeds the budget, the trailing blocks are dropped rather
 * than the task plan being cut.
 */
function capExecuteTaskInlineBlocks(
  taskPlan: string,
  slicePlan: string,
  templates: string,
  budgetChars: number,
): { taskPlan: string; slicePlan: string; templates: string } {
  let remaining = budgetChars - taskPlan.length;
  if (remaining <= 0) {
    return { taskPlan, slicePlan: "", templates: "" };
  }
  const cappedSlice = slicePlan.length <= remaining
    ? slicePlan
    : truncateAtSectionBoundary(slicePlan, remaining).content;
  remaining -= cappedSlice.length;
  const cappedTemplates = remaining <= 0
    ? ""
    : templates.length <= remaining
      ? templates
      : truncateAtSectionBoundary(templates, remaining).content;
  return { taskPlan, slicePlan: cappedSlice, templates: cappedTemplates };
}

type PromptContextMode = "inline" | "excerpt" | "on-demand" | "skipped";

interface PromptContextTelemetryEntry {
  readonly key: string;
  readonly mode: PromptContextMode;
  readonly chars: number;
  readonly reason?: string;
}

function trackPromptContext(
  entries: PromptContextTelemetryEntry[],
  key: string,
  mode: PromptContextMode,
  body: string | null | undefined,
  reason?: string,
): void {
  entries.push({
    key,
    mode,
    chars: body?.length ?? 0,
    ...(reason ? { reason } : {}),
  });
}

function emitPromptContextTelemetry(
  unitType: string,
  entries: readonly PromptContextTelemetryEntry[],
  finalBody: string,
): void {
  debugLog("prompt-context", {
    unitType,
    finalChars: finalBody.length,
    loaded: entries.filter((entry) => entry.mode !== "skipped").map((entry) => ({
      key: entry.key,
      mode: entry.mode,
      chars: entry.chars,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    skipped: entries.filter((entry) => entry.mode === "skipped").map((entry) => ({
      key: entry.key,
      reason: entry.reason ?? "not applicable",
    })),
  });
}

function renderContextModeForPrompt(
  unitType: string,
  base: string,
  renderMode: ContextModeRenderMode = "standalone",
): string {
  const effectivePrefs = loadEffectiveGSDPreferences(base)?.preferences;
  return composeContextModeInstructions(unitType, {
    enabled: isContextModeEnabled(effectivePrefs),
    renderMode,
  });
}

function renderContextModeBlockForPrompt(
  unitType: string,
  base: string,
  renderMode: ContextModeRenderMode = "standalone",
): string {
  const contextMode = renderContextModeForPrompt(unitType, base, renderMode);
  if (!contextMode) return "";
  if (renderMode === "nested") return contextMode;

  const snapshot = readCompactionSnapshot(base);
  if (!snapshot?.trim()) return contextMode;

  return `${contextMode}\n\n## Context Snapshot\nSource: \`.gsd/last-snapshot.md\`\n\n${snapshot.trimEnd()}`;
}

function prependContextModeToBlock(
  unitType: string,
  base: string,
  block: string,
  renderMode: ContextModeRenderMode = "standalone",
  sessionProvider?: string,
): string {
  const toolSurface = composeToolSurfaceInstructions(unitType, {
    renderMode,
    basePath: base,
    sessionProvider,
  });
  const contextMode = renderContextModeBlockForPrompt(unitType, base, renderMode);
  const guidance = [toolSurface, contextMode].filter(Boolean).join("\n\n");
  if (!guidance) return block;
  if (!block.trim()) return guidance;
  return `${guidance}\n\n${block}`;
}

function requireUnitPromptContextContract(unitType: string): UnitPromptContextContract {
  const result = compileUnitContextContract(unitType);
  if (result.ok) return result.contract;
  throw new Error(result.detail);
}

function requireComposedArtifactBlock(
  blocks: readonly ComposedUnitContextBlock[],
  unitType: string,
  key: ArtifactKey,
): string {
  const block = blocks.find((item) => item.key === key);
  if (!block) {
    throw new Error(`Unit Context Contract for ${unitType} did not compose required artifact ${key}`);
  }
  return block.body;
}

interface ExecuteTaskOnDemandResult {
  /** Rendered block for the prompt; empty string when not shown. */
  text: string;
  /**
   * Telemetry skip reason when the block was suppressed; null when the block
   * is included. Callers pass this directly to `trackPromptContext`.
   */
  skipReason: string | null;
}

function renderExecuteTaskOnDemandContext(
  base: string,
  mid: string,
  sid: string,
  artifacts: readonly ArtifactKey[],
): ExecuteTaskOnDemandResult {
  if (!artifacts.includes("slice-research")) {
    return { text: "", skipReason: "not declared by contract" };
  }
  const research = resolveSliceResearchLocation(base, mid, sid);
  if (!research.absolutePath || !research.relativePath) {
    return { text: "", skipReason: "missing" };
  }
  return {
    text: [
      "## On-demand Context",
      "",
      `Slice research is available at \`${research.relativePath}\`. Read it only if the inlined task plan, slice plan excerpt, and carry-forward context do not explain a required implementation detail.`,
    ].join("\n"),
    skipReason: null,
  };
}

// ─── Executor Constraints ─────────────────────────────────────────────────────

/**
 * Format executor context constraints for injection into the plan-slice prompt.
 * Uses the budget engine to compute task count ranges and inline context budgets
 * based on the configured executor model's context window.
 */
function formatExecutorConstraints(
  sessionContextWindow?: number,
  modelRegistry?: MinimalModelRegistry,
  sessionProvider?: string,
): string {
  let windowTokens: number;
  try {
    const prefs = loadEffectiveGSDPreferences();
    windowTokens = resolveExecutorContextWindow(modelRegistry, prefs?.preferences, sessionContextWindow, sessionProvider);
  } catch (e) {
    logWarning("prompt", `resolveExecutorContextWindow failed: ${(e as Error).message}`);
    // Delegate to the budget engine without prefs (the path that just threw)
    // so DEFAULT_CONTEXT_WINDOW stays the single source of truth.
    windowTokens = resolveExecutorContextWindow(undefined, undefined, sessionContextWindow, sessionProvider);
  }
  const budgets = computeBudgets(windowTokens, sessionProvider as TokenProvider | undefined);
  const { min, max } = budgets.taskCountRange;
  const execWindowK = Math.round(windowTokens / 1000);
  const perTaskBudgetK = Math.round(budgets.inlineContextBudgetChars / 1000);
  return [
    `## Executor Context Constraints`,
    ``,
    `The agent that executes each task has a **${execWindowK}K token** context window.`,
    `- Recommended task count for this slice: **${min}–${max} tasks**`,
    `- Each task gets ~${perTaskBudgetK}K chars of inline context (plans, code, decisions)`,
    `- Keep individual tasks completable within a single context window — if a task needs more context than fits, split it`,
  ].join("\n");
}

/**
 * Builds the Declared Repositories block for parent-workspace planners.
 * Returns "" for single-repo projects so the common-case prompt is unchanged;
 * only parent mode with declared child repos gets the registry list and the
 * targetRepositories assignment instruction.
 */
export function buildRepoRegistryBlock(base: string): string {
  let registry;
  try {
    registry = createRepositoryRegistryFromPreferences(base, loadEffectiveGSDPreferences(base)?.preferences);
  } catch {
    return "";
  }
  const hasChildRepo = registry.repositories.some((repo) => repo.id !== "project");
  if (registry.mode !== "parent" || !hasChildRepo) return "";

  const lines = registry.repositories.map((repo) => {
    const relPath = relative(registry.projectRoot, repo.root).split(sep).join("/") || ".";
    const role = repo.role ? ` — ${repo.role}` : "";
    const root = repo.id === "project" ? " (root)" : ` (${relPath})`;
    return `- \`${repo.id}\`${root}${role}`;
  });
  return [
    "### Declared Repositories",
    "",
    ...lines,
    "",
    "This is a parent workspace. Assign each task's `targetRepositories` to the repository id(s) it touches (from the list above). Omit `targetRepositories` to inherit the slice-wide default from `gsd_plan_slice`; set it explicitly when a task differs (e.g. `[\"project\"]` for parent-root work).",
  ].join("\n");
}

/**
 * Returns a markdown bullet list of known context file paths for the given
 * milestone (and optionally slice). Falls back to a generic tool-agnostic
 * instruction when no GSD artifacts are found.
 *
 * @param base - Absolute path to the project root.
 * @param mid  - Milestone ID (e.g. `"M001"`).
 * @param sid  - Optional slice ID (e.g. `"S01"`). When provided, the slice
 *   RESEARCH file is preferred over the milestone-level one.
 * @param displayBase - Optional execution root that emitted paths are relative to.
 * @returns Markdown string of file path bullets, or a fallback instruction.
 */
export function buildSourceFilePaths(
  base: string,
  mid: string,
  sid?: string,
  displayBase?: string,
): string {
  const paths: string[] = [];
  const displayPath = (absolutePath: string, defaultPath: string): string => displayBase
    ? relative(normalizeRealPath(displayBase), absolutePath).split(sep).join("/") || "."
    : defaultPath;

  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) {
    paths.push(`- **Project**: \`${displayPath(projectPath, relGsdRootFile("PROJECT"))}\``);
  }

  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) {
    paths.push(`- **Requirements**: \`${displayPath(requirementsPath, relGsdRootFile("REQUIREMENTS"))}\``);
  }

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    paths.push(`- **Decisions**: \`${displayPath(decisionsPath, relGsdRootFile("DECISIONS"))}\``);
  }

  const queuePath = resolveGsdRootFile(base, "QUEUE");
  if (existsSync(queuePath)) {
    paths.push(`- **Queue**: \`${displayPath(queuePath, relGsdRootFile("QUEUE"))}\``);
  }

  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) {
    paths.push(`- **Milestone Context**: \`${displayPath(contextPath, relMilestoneFile(base, mid, "CONTEXT"))}\``);
  }

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) {
    paths.push(`- **Roadmap**: \`${displayPath(roadmapPath, relMilestoneFile(base, mid, "ROADMAP"))}\``);
  }

  if (sid) {
    const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Slice Research**: \`${displayPath(researchPath, relSliceFile(base, mid, sid, "RESEARCH"))}\``);
    }
  } else {
    const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Milestone Research**: \`${displayPath(researchPath, relMilestoneFile(base, mid, "RESEARCH"))}\``);
    }
  }

  return paths.length > 0
    ? paths.join("\n")
    : "- Use the Grep/Glob/Read tools to identify the relevant source files before planning.";
}

// ─── Inline Helpers ───────────────────────────────────────────────────────

/**
 * Load a file and format it for inlining into a prompt.
 * Returns the content wrapped with a source path header, or a fallback
 * message if the file doesn't exist. This eliminates tool calls — the LLM
 * gets the content directly instead of "Read this file:".
 */
export async function inlineFile(
  absPath: string | null, relPath: string, label: string,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load a file for inlining, returning null if it doesn't exist.
 * Use when the file is optional and should be omitted entirely if absent.
 */
export async function inlineFileOptional(
  absPath: string | null, relPath: string, label: string,
): Promise<string | null> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Smart file inlining — for large files, use semantic chunking to include
 * only the most relevant portions based on the task context.
 * Falls back to full content for small files or when no query is provided.
 *
 * @param absPath Absolute file path
 * @param relPath Relative display path
 * @param label Section label
 * @param query Task description for relevance scoring (optional)
 * @param threshold Character threshold for chunking (default: 3000)
 */
export async function inlineFileSmart(
  absPath: string | null, relPath: string, label: string,
  query?: string, threshold = 3000,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }

  // For small files or no query, include full content
  if (content.length <= threshold || !query) {
    return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
  }

  // For large files, truncate at section boundary
  const truncated = truncateAtSectionBoundary(content, threshold).content;
  return `### ${label}\nSource: \`${relPath}\`\n\n${truncated}`;
}

function inlineCompactTemplate(name: "plan" | "task-summary" | "slice-summary", label: string): string {
  const compact: Record<typeof name, string> = {
    plan: [
      "# {{sliceId}}: {{sliceTitle}}",
      "",
      "**Goal:** {{goal}}",
      "**Demo:** {{demo}}",
      "",
      "## Must-Haves",
      "- {{mustHave}}",
      "",
      "## Threat Surface",
      "- Abuse: {{abuseScenarios}}",
      "- Data exposure: {{sensitiveDataAccessible}}",
      "- Input trust: {{untrustedInput}}",
      "",
      "## Requirement Impact",
      "- Requirements touched: {{requirementIds}}",
      "- Re-verify: {{whatMustBeRetested}}",
      "- Decisions revisited: {{decisionIds}}",
      "",
      "## Proof Level",
      "- This slice proves: {{contract | integration | operational | final-assembly}}",
      "- Real runtime required: {{yes/no}}",
      "- Human/UAT required: {{yes/no}}",
      "",
      "## Verification",
      "- {{testFileOrCommand}}",
      "",
      "## Observability / Diagnostics",
      "- Runtime signals: {{signalOrNone}}",
      "- Inspection surfaces: {{surfaceOrNone}}",
      "- Failure visibility: {{failureSignalOrNone}}",
      "- Redaction constraints: {{secretOrPiiBoundaryOrNone}}",
      "",
      "## Integration Closure",
      "- Upstream surfaces consumed: {{filesModulesContracts}}",
      "- New wiring introduced: {{entrypointOrNone}}",
      "- Remaining end-to-end work: {{listOrNothing}}",
      "",
      "## Tasks",
      "- [ ] **T01: {{taskTitle}}** `est:{{estimate}}`",
      "  - Why: {{whyThisTaskExists}}",
      "  - Files: `{{filePath}}`",
      "  - Do: {{specificImplementationStepsAndConstraints}}",
      "  - Verify: {{testCommandOrRuntimeCheck}}",
      "  - Done when: {{measurableAcceptanceCondition}}",
      "",
      "## Files Likely Touched",
      "- `{{filePath}}`",
    ].join("\n"),
    "task-summary": [
      "---",
      "id: {{taskId}}",
      "parent: {{sliceId}}",
      "milestone: {{milestoneId}}",
      "provides: [{{whatThisTaskProvides}}]",
      "key_files: [{{filePath}}]",
      "key_decisions: [{{decision}}]",
      "patterns_established: [{{pattern}}]",
      "observability_surfaces: [{{diagnosticOrNone}}]",
      "duration: {{duration}}",
      "verification_result: passed",
      "completed_at: {{date}}",
      "blocker_discovered: false",
      "---",
      "",
      "# {{taskId}}: {{taskTitle}}",
      "**{{oneLiner}}**",
      "",
      "## What Happened",
      "{{narrative}}",
      "",
      "## Verification",
      "{{whatWasVerifiedAndHow}}",
      "",
      "## Verification Evidence",
      "| # | Command | Exit Code | Verdict | Duration |",
      "| --- | --- | --- | --- | --- |",
      "| {{row}} | {{command}} | {{exitCode}} | {{verdict}} | {{duration}} |",
      "",
      "## Diagnostics",
      "{{diagnosticsOrNone}}",
      "",
      "## Deviations",
      "{{deviationsFromPlan_OR_none}}",
      "",
      "## Known Issues",
      "{{issuesDiscoveredButNotFixed_OR_none}}",
      "",
      "## Files Created/Modified",
      "- `{{filePath}}` - {{description}}",
    ].join("\n"),
    "slice-summary": [
      "---",
      "id: {{sliceId}}",
      "parent: {{milestoneId}}",
      "milestone: {{milestoneId}}",
      "provides: [{{whatThisSliceProvides}}]",
      "requires: []",
      "affects: []",
      "key_files: [{{filePath}}]",
      "key_decisions: [{{decision}}]",
      "patterns_established: [{{pattern}}]",
      "observability_surfaces: [{{diagnosticOrNone}}]",
      "drill_down_paths: [{{pathToTaskSummary}}]",
      "duration: {{duration}}",
      "verification_result: passed",
      "completed_at: {{date}}",
      "---",
      "",
      "# {{sliceId}}: {{sliceTitle}}",
      "**{{oneLiner}}**",
      "",
      "## What Happened",
      "{{narrative}}",
      "",
      "## Verification",
      "{{whatWasVerifiedAcrossAllTasks}}",
      "",
      "## Requirements Advanced",
      "- {{requirementId}} - {{howThisSliceAdvancedIt}}",
      "",
      "## Requirements Validated",
      "- {{requirementId}} - {{whatProofNowMakesItValidated}}",
      "",
      "## New Requirements Surfaced",
      "- {{newRequirementOr_none}}",
      "",
      "## Requirements Invalidated or Re-scoped",
      "- {{requirementIdOr_none}} - {{whatChanged}}",
      "",
      "## Operational Readiness",
      "- Health signal: {{healthSignalOrNA}}",
      "- Failure signal: {{failureSignalOrNA}}",
      "- Recovery: {{recoveryOrNA}}",
      "- Monitoring gaps: {{gapsOrNone}}",
      "",
      "## Deviations",
      "{{deviationsFromPlan_OR_none}}",
      "",
      "## Known Limitations",
      "{{whatDoesntWorkYet_OR_whatWasDeferredToLaterSlices}}",
      "",
      "## Follow-ups",
      "{{workDeferredOrDiscoveredDuringExecution_OR_none}}",
      "",
      "## Files Created/Modified",
      "- `{{filePath}}` - {{description}}",
      "",
      "## Forward Intelligence",
      "### What the next slice should know",
      "- {{insightThatWouldHelpDownstreamWork}}",
      "### What's fragile",
      "- {{fragileAreaOrThinImplementation}} - {{whyItMatters}}",
      "### Authoritative diagnostics",
      "- {{whereAFutureAgentShouldLookFirst}} - {{whyThisSignalIsTrustworthy}}",
      "### What assumptions changed",
      "- {{originalAssumption}} - {{whatActuallyHappened}}",
    ].join("\n"),
  };

  return `${compact[name]}\n\n### Output Template: ${label}\nSource: \`templates/${name}.md\``;
}

/**
 * Compact slice-summary excerpt for milestone-level closers (#4780).
 *
 * Emits the frontmatter fields + short body section heads rather than the
 * full SUMMARY.md body, and keeps the source path in the header so the
 * closer agent can Read the full file on demand when drafting LEARNINGS.
 *
 * Scope: designed for `buildCompleteMilestonePrompt`, which previously
 * inlined the full SUMMARY per slice and routinely paid ~300–500K tokens
 * per close when the narrative was never synthesized. Not used by
 * `buildValidateMilestonePrompt` yet — validate needs fuller verification
 * evidence; follow-up PR can extend or parameterize.
 *
 * If parsing fails (unrecognizable frontmatter, missing id, etc.) the
 * function falls back to `inlineFile` so the closer loses no information.
 */
export async function buildSliceSummaryExcerpt(
  absPath: string | null, relPath: string, sid: string,
): Promise<string> {
  const header = `### ${sid} Summary (excerpt)\nSource: \`${relPath}\``;
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `${header}\n\n_(not found — file does not exist yet)_`;
  }
  try {
    const s = parseSummary(content);
    if (!s.frontmatter.id) {
      // Unrecognizable — fall back to full file so no context is lost.
      return `### ${sid} Summary\nSource: \`${relPath}\`\n\n${content.trim()}`;
    }
    const lines: string[] = [header, ""];
    if (s.title) lines.push(`**Title:** ${s.title}`);
    if (s.oneLiner) lines.push(`**One-liner:** ${s.oneLiner}`);
    if (s.frontmatter.verification_result) {
      lines.push(`**Verification:** \`${s.frontmatter.verification_result}\``);
    }
    lines.push(`**Blockers:** ${s.frontmatter.blocker_discovered ? "⚠️ blocker recorded — Read full summary" : "none"}`);
    if (s.frontmatter.duration) lines.push(`**Duration:** ${s.frontmatter.duration}`);
    if (s.frontmatter.provides.length > 0) lines.push(`**Provides:** ${s.frontmatter.provides.join("; ")}`);
    if (s.frontmatter.affects.length > 0) lines.push(`**Affects:** ${s.frontmatter.affects.join("; ")}`);
    if (s.frontmatter.key_decisions.length > 0) lines.push(`**Key decisions:** ${s.frontmatter.key_decisions.join("; ")}`);
    if (s.frontmatter.patterns_established.length > 0) lines.push(`**Patterns established:** ${s.frontmatter.patterns_established.join("; ")}`);
    if (s.frontmatter.key_files.length > 0) {
      const files = s.frontmatter.key_files.slice(0, 8);
      const more = s.frontmatter.key_files.length > files.length ? ` (+${s.frontmatter.key_files.length - files.length} more)` : "";
      lines.push(`**Key files:** ${files.join(", ")}${more}`);
    }

    // Cap section bodies (#4908): if any of these
    // narrative sections balloon, excerpt mode still inflates and
    // undermines the token-reduction goal. 800 chars (~200 tokens) is
    // enough to carry intent; the closer agent Reads the full file when
    // it needs richer context for LEARNINGS synthesis.
    const SECTION_CAP_CHARS = 800;
    const capSection = (body: string): string => {
      const trimmed = body.trim();
      if (trimmed.length <= SECTION_CAP_CHARS) return trimmed;
      return `${trimmed.slice(0, SECTION_CAP_CHARS)}\n… (truncated — see full \`${relPath}\`)`;
    };

    if (s.deviations && s.deviations.trim()) {
      lines.push("", "#### Deviations", capSection(s.deviations));
    }
    if (s.knownLimitations && s.knownLimitations.trim()) {
      lines.push("", "#### Known limitations", capSection(s.knownLimitations));
    }
    if (s.followUps && s.followUps.trim()) {
      lines.push("", "#### Follow-ups", capSection(s.followUps));
    }

    lines.push(
      "",
      `> **On-demand:** read \`${relPath}\` for the full "What Happened" narrative, integration notes, and detailed file-change list when drafting LEARNINGS, the Decision Re-evaluation table, or cross-slice synthesis.`,
    );
    return lines.join("\n");
  } catch {
    // Defensive — any parse failure falls back to full inline.
    return `### ${sid} Summary\nSource: \`${relPath}\`\n\n${capMalformedSummary(content, relPath)}`;
  }
}

export async function buildSliceAssessmentExcerpt(
  absPath: string | null, relPath: string, sid: string,
): Promise<string | null> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;

  const verdict = extractVerdict(content);
  const edgeCases = extractMarkdownSection(content, "Edge Cases");
  const checksMatch = content.match(/\b(\d+\s*\/\s*\d+)\s+checks?\s+passed\b/i);
  const lines = [
    `### ${sid} Assessment (excerpt)`,
    `Source: \`${relPath}\``,
    "",
  ];
  if (verdict) lines.push(`**Verdict:** \`${verdict.toUpperCase()}\``);
  if (checksMatch) lines.push(`**Checks:** ${checksMatch[1]} passed`);
  if (edgeCases?.trim()) {
    const trimmed = edgeCases.trim();
    lines.push(
      "",
      "#### Edge cases",
      trimmed.length > 600 ? `${trimmed.slice(0, 600)}\n… (truncated — see full \`${relPath}\`)` : trimmed,
    );
  }
  lines.push("", `> **On-demand:** read \`${relPath}\` only if validation needs full UAT assessment detail.`);
  return lines.join("\n");
}

export async function buildTaskSummaryExcerpt(
  absPath: string | null, relPath: string, tid: string, options?: { blocker?: boolean },
): Promise<string> {
  const label = options?.blocker ? "Blocker Task Summary" : "Task Summary";
  const header = `### ${label}: ${tid} (excerpt)\nSource: \`${relPath}\``;
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `${header}\n\n_(not found — file does not exist yet)_`;
  }

  try {
    const s = parseSummary(content);
    if (!s.frontmatter.id) {
      return `### ${label}: ${tid}\nSource: \`${relPath}\`\n\n${capMalformedSummary(content, relPath)}`;
    }

    const lines: string[] = [header, ""];
    if (s.title) lines.push(`**Title:** ${s.title}`);
    if (s.oneLiner) lines.push(`**One-liner:** ${s.oneLiner}`);
    if (s.frontmatter.verification_result) {
      lines.push(`**Verification:** \`${s.frontmatter.verification_result}\``);
    }
    lines.push(`**Blocker discovered:** ${s.frontmatter.blocker_discovered ? "yes — read full summary if blocker details are insufficient" : "no"}`);
    if (s.frontmatter.provides.length > 0) lines.push(`**Provides:** ${s.frontmatter.provides.slice(0, 4).join("; ")}`);
    if (s.frontmatter.key_decisions.length > 0) lines.push(`**Key decisions:** ${s.frontmatter.key_decisions.slice(0, 4).join("; ")}`);
    if (s.frontmatter.patterns_established.length > 0) lines.push(`**Patterns established:** ${s.frontmatter.patterns_established.slice(0, 4).join("; ")}`);
    if (s.frontmatter.key_files.length > 0) {
      const files = s.frontmatter.key_files.slice(0, 6);
      const more = s.frontmatter.key_files.length > files.length ? ` (+${s.frontmatter.key_files.length - files.length} more)` : "";
      lines.push(`**Key files:** ${files.join(", ")}${more}`);
    }

    const SECTION_CAP_CHARS = 500;
    const capSection = (body: string): string => {
      const trimmed = body.trim();
      if (trimmed.length <= SECTION_CAP_CHARS) return trimmed;
      return `${trimmed.slice(0, SECTION_CAP_CHARS)}\n… (truncated — see full \`${relPath}\`)`;
    };

    const verification = extractMarkdownSection(content, "Verification");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");
    const knownIssues = extractMarkdownSection(content, "Known Issues");

    if (verification && verification.trim()) {
      lines.push("", "#### Verification", capSection(verification));
    }
    if (diagnostics && diagnostics.trim()) {
      lines.push("", "#### Diagnostics", capSection(diagnostics));
    }
    if (s.deviations && s.deviations.trim()) {
      lines.push("", "#### Deviations", capSection(s.deviations));
    }
    if (knownIssues && knownIssues.trim()) {
      lines.push("", "#### Known issues", capSection(knownIssues));
    }

    lines.push(
      "",
      `> **On-demand:** read \`${relPath}\` only when this excerpt is absent/truncated or you need fuller blocker, implementation, or file-change evidence.`,
    );
    return lines.join("\n");
  } catch {
    return `### ${label}: ${tid}\nSource: \`${relPath}\`\n\n${capMalformedSummary(content, relPath)}`;
  }
}

function capMalformedSummary(content: string, relPath: string): string {
  const trimmed = content.trim();
  const limit = 1_500;
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}\n\n[Truncated malformed summary — read \`${relPath}\` for full details.]`;
}

/**
 * Load and inline dependency slice summaries (full content, not just paths).
 */
export async function inlineDependencySummaries(
  mid: string, sid: string, base: string, budgetChars?: number,
): Promise<string> {
  // DB read authority — post-cutover there is no markdown fallback.
  let depends: string[] | null = null;
  try {
    if (isDbAvailable()) {
      const slice = getSlice(mid, sid);
      if (slice) {
        if (slice.depends.length === 0) return "- (no dependencies)";
        depends = slice.depends as string[];
      }
    }
  } catch (err) {
    logWarning("prompt", `inlineDependencySummaries DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!depends) {
    return "- (no dependencies)";
  }

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const dep of depends) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const summaryFile = resolveSliceFile(base, mid, dep, "SUMMARY");
    const summaryContent = summaryFile ? await loadFile(summaryFile) : null;
    const relPath = relSliceFile(base, mid, dep, "SUMMARY");
    if (summaryContent) {
      sections.push(`#### ${dep} Summary\nSource: \`${relPath}\`\n\n${summaryContent.trim()}`);
    } else {
      sections.push(`- \`${relPath}\` _(not found)_`);
    }
  }

  const result = sections.join("\n\n");
  if (budgetChars !== undefined && result.length > budgetChars) {
    return truncateAtSectionBoundary(result, budgetChars).content;
  }
  return result;
}

/**
 * Load a well-known .gsd/ root file for optional inlining.
 * Handles the existsSync check internally.
 */
export async function inlineGsdRootFile(
  base: string, filename: string, label: string,
): Promise<string | null> {
  const key = filename.replace(/\.md$/i, "").toUpperCase() as "PROJECT" | "DECISIONS" | "QUEUE" | "STATE" | "REQUIREMENTS" | "KNOWLEDGE";
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
}

// ─── DB-Aware Inline Helpers ──────────────────────────────────────────────

/**
 * Inline decisions with optional milestone scoping from the DB.
 * Falls back to filesystem via inlineGsdRootFile only when DB is unavailable.
 *
 * Cascade logic (R005):
 * 1. Query with { milestoneId, scope } if scope provided
 * 2. If empty AND scope was provided, retry with { milestoneId } only (drop scope)
 * 3. If still empty, return null (intentional per D020)
 */
export async function inlineDecisionsFromDb(
  base: string, milestoneId?: string, scope?: string, level?: InlineLevel,
): Promise<string | null> {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      // ADR-013 Phase 6 cutover (Stage 1): read decisions from the `memories`
      // table. Both `queryDecisions` (legacy) and `queryDecisionsFromMemories`
      // return identical Decision[] for active rows once Phase 5 dual-write is
      // caught up. Switching the read here lets the destructive Phase 6 step
      // (#5755) retire the legacy `decisions` table without changing prompt
      // contents. Projection regen (`DECISIONS.md`) still sources from the
      // legacy table — that switch lands separately to handle superseded
      // history cleanly.
      const { queryDecisionsFromMemories, formatDecisionsForPrompt } = await import("./context-store.js");

      // First query: try with both milestoneId and scope (if scope provided)
      let decisions = queryDecisionsFromMemories({ milestoneId, scope });

      // Cascade: if empty AND scope was provided, retry without scope
      if (decisions.length === 0 && scope) {
        decisions = queryDecisionsFromMemories({ milestoneId });
      }

      if (decisions.length > 0) {
        // Use compact format for non-full levels to save ~35% tokens
        const formatted = inlineLevel !== "full"
          ? formatDecisionsCompact(decisions)
          : formatDecisionsForPrompt(decisions);
        return `### Decisions\nSource: \`.gsd/DECISIONS.md\`\n\n${formatted}`;
      }
      // DB available but cascade returned empty — intentional per D020, don't fall back to file
      return null;
    }
  } catch (err) {
    logWarning("prompt", `inlineDecisionsFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // DB unavailable — fall back to filesystem
  return inlineGsdRootFile(base, "decisions.md", "Decisions");
}

/**
 * Inline requirements with optional milestone and slice scoping from the DB.
 * Falls back to filesystem via inlineGsdRootFile only when DB is unavailable.
 */
export async function inlineRequirementsFromDb(
  base: string, milestoneId?: string, sliceId?: string, level?: InlineLevel,
): Promise<string | null> {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryRequirements, formatRequirementsForPrompt } = await import("./context-store.js");
      let requirements = queryRequirements({ milestoneId, sliceId });
      let broadenedScope = false;
      if (requirements.length === 0 && sliceId) {
        requirements = queryRequirements({ milestoneId });
        broadenedScope = true;
      }
      if (requirements.length === 0 && milestoneId) {
        requirements = queryRequirements({ status: "active" });
        broadenedScope = true;
      }
      if (requirements.length > 0) {
        // Use compact format for non-full levels, milestone-scoped calls, and
        // any cascade stage that broadened past the originally requested scope —
        // a slice-scoped "full" call that fell through to the project-wide
        // active fallback must not format those rows as full requirements.
        const useCompact = inlineLevel !== "full" || !sliceId || broadenedScope;
        const formatted = useCompact
          ? formatRequirementsCompact(requirements)
          : formatRequirementsForPrompt(requirements);
        return `### Requirements\nSource: \`.gsd/REQUIREMENTS.md\`\n\n${formatted}`;
      }
      return null;
    }
  } catch (err) {
    logWarning("prompt", `inlineRequirementsFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return inlineGsdRootFile(base, "requirements.md", "Requirements");
}

/**
 * Inline project context from the DB.
 * Falls back to filesystem via inlineGsdRootFile when DB unavailable or empty.
 */
export async function inlineProjectFromDb(
  base: string,
): Promise<string | null> {
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryProject } = await import("./context-store.js");
      const content = queryProject();
      if (content) {
        return `### Project\nSource: \`.gsd/PROJECT.md\`\n\n${content}`;
      }
    }
  } catch (err) {
    logWarning("prompt", `inlineProjectFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return inlineGsdRootFile(base, "project.md", "Project");
}

function onDemandProjectBlock(reason: string): string {
  return [
    "### On-demand Project Context",
    "",
    `Project context is available at \`${relGsdRootFile("PROJECT")}\`. Read it only if ${reason}.`,
  ].join("\n");
}

function onDemandDecisionsBlock(reason: string): string {
  return [
    "### On-demand Decisions",
    "",
    `Decision records are available at \`${relGsdRootFile("DECISIONS")}\`. Read them only if ${reason}.`,
  ].join("\n");
}

function onDemandMilestoneContextBlock(contextRel: string, reason: string): string {
  return [
    "### On-demand Milestone Context",
    "",
    `Milestone context is available at \`${contextRel}\`. Read it only if ${reason}.`,
  ].join("\n");
}

// ─── Stopwords for keyword extraction ─────────────────────────────────────
const STOPWORDS = new Set(['of', 'the', 'and', 'a', 'for', '+', '-', 'to', 'in', 'on', 'with', 'is', 'as', 'by']);

// Generic words that don't provide meaningful scope differentiation
const GENERIC_WORDS = new Set([
  'setup', 'integration', 'implementation', 'testing', 'test', 'tests',
  'config', 'configuration', 'init', 'initial', 'basic', 'core',
  'main', 'primary', 'final', 'complete', 'finish', 'end',
  'start', 'begin', 'first', 'last', 'update', 'updates',
  'fix', 'fixes', 'add', 'adds', 'remove', 'removes',
  'create', 'creates', 'build', 'builds', 'deploy', 'deployment',
  'refactor', 'refactoring', 'cleanup', 'polish', 'review',
  // Process/activity words that describe what you're doing, not what domain
  'hardening', 'validation', 'verification', 'optimization',
  'improvement', 'enhancement', 'infrastructure',
]);

// Pattern to match slice/milestone/task IDs (e.g., S01, M001, T03)
const UNIT_ID_PATTERN = /^[smt]\d+$/i;

/**
 * Derive a scope keyword from slice title and optional description.
 * Returns the most specific noun (first non-generic keyword) for decision scoping.
 *
 * Examples:
 * - "Auth Middleware & Protected Route" → "auth"
 * - "Database & User Model Setup" → "database"
 * - "Integration Testing" → undefined (too generic)
 * - "API Rate Limiting" → "api"
 *
 * @param sliceTitle - The slice title
 * @param sliceDescription - Optional roadmap description (demo text)
 * @returns A single lowercase keyword or undefined if no meaningful scope
 */
export function deriveSliceScope(sliceTitle: string, sliceDescription?: string): string | undefined {
  // Combine title and description for keyword extraction
  const combinedText = sliceDescription
    ? `${sliceTitle} ${sliceDescription}`
    : sliceTitle;

  // Extract all words, lowercase, remove punctuation
  const words = combinedText
    .split(/[\s&+,;:|/\\()-]+/)
    .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 2);

  // Find the first word that is:
  // 1. Not a stopword
  // 2. Not a generic word
  // 3. Not a unit ID (S01, M001, T03)
  // 4. At least 3 characters (meaningful scope)
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (GENERIC_WORDS.has(word)) continue;
    if (UNIT_ID_PATTERN.test(word)) continue;
    if (word.length < 3) continue;
    return word;
  }

  return undefined;
}
/**
 * Extract keywords from a slice title for scoped knowledge queries.
 * Splits on whitespace, filters stopwords, lowercases.
 * Example: 'KNOWLEDGE scoping + roadmap excerpt' → ['knowledge', 'scoping', 'roadmap', 'excerpt']
 */
function extractKeywords(title: string): string[] {
  return title
    .split(/\s+/)
    .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 0 && !STOPWORDS.has(w));
}

/**
 * Inline scoped KNOWLEDGE.md content based on keywords from slice title.
 * Reads KNOWLEDGE.md, filters to sections matching keywords, formats with header.
 * Returns null if no KNOWLEDGE.md exists or no sections match.
 */
export async function inlineKnowledgeScoped(
  base: string,
  keywords: string[],
): Promise<string | null> {
  const knowledgePath = resolveGsdRootFile(base, "KNOWLEDGE");
  if (!existsSync(knowledgePath)) return null;

  const content = await loadFile(knowledgePath);
  if (!content) return null;

  // Import queryKnowledge from context-store
  const { queryKnowledge } = await import("./context-store.js");
  const scoped = await queryKnowledge(content, keywords);

  // Return null if no sections matched (empty string from queryKnowledge)
  if (!scoped) return null;

  return `### Project Knowledge (scoped)\nSource: \`${relGsdRootFile("KNOWLEDGE")}\`\n\n${scoped.trim()}`;
}

/**
 * Budget-capped knowledge inline for milestone-level prompt assembly.
 *
 * Addresses issue #4719: the six milestone-phase prompts (research-milestone,
 * plan-milestone, complete-slice, complete-milestone, validate-milestone,
 * reassess-roadmap) previously injected the full KNOWLEDGE.md (~226KB for a
 * real project) on every invocation. This helper scopes by caller-supplied
 * keywords and caps the payload at `maxChars` (default 12,000 chars).
 *
 * Returns null when no KNOWLEDGE.md exists or no entries match any keyword.
 */
export async function inlineKnowledgeBudgeted(
  base: string,
  keywords: string[],
  options?: { maxChars?: number },
): Promise<string | null> {
  const DEFAULT_MAX_CHARS = 12_000;
  const HARD_MAX_CHARS = 100_000;
  const raw = Number(options?.maxChars ?? DEFAULT_MAX_CHARS);
  const maxChars = Number.isFinite(raw)
    ? Math.max(0, Math.min(Math.floor(raw), HARD_MAX_CHARS))
    : DEFAULT_MAX_CHARS;

  const knowledgePath = resolveGsdRootFile(base, "KNOWLEDGE");
  if (!existsSync(knowledgePath)) return null;

  const content = await loadFile(knowledgePath);
  if (!content) return null;

  const { queryKnowledge } = await import("./context-store.js");
  const scoped = await queryKnowledge(content, keywords);
  if (!scoped) return null;

  const trimmed = scoped.trim();
  const truncated =
    trimmed.length > maxChars
      ? `${trimmed.slice(0, maxChars)}\n\n[...truncated ${trimmed.length - maxChars} chars; rerun with narrower scope if needed]`
      : trimmed;

  return `### Project Knowledge (scoped)\nSource: \`${relGsdRootFile("KNOWLEDGE")}\`\n\n${truncated}`;
}

/**
 * Inline a roadmap excerpt for a specific slice.
 * Reads full roadmap, extracts minimal excerpt with header + predecessor + target row.
 * Returns null if roadmap doesn't exist or slice not found.
 */
export async function inlineRoadmapExcerpt(
  base: string,
  mid: string,
  sid: string,
): Promise<string | null> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath || !existsSync(roadmapPath)) return null;

  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const content = await loadFile(roadmapPath);
  if (!content) return null;

  // Import formatRoadmapExcerpt from context-store
  const { formatRoadmapExcerpt } = await import("./context-store.js");
  const excerpt = formatRoadmapExcerpt(content, sid, roadmapRel);

  // Return null if slice not found in roadmap
  if (!excerpt) return null;

  return `### Milestone Roadmap (excerpt)\nSource: \`${roadmapRel}\`\n\n${excerpt}`;
}

// ─── Text Helpers ──────────────────────────────────────────────────────────

export function extractMarkdownSection(content: string, heading: string): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ─── Section Builders ──────────────────────────────────────────────────────

export function buildResumeSection(
  continueContent: string | null,
  legacyContinueContent: string | null,
  continueRelPath: string,
  legacyContinueRelPath: string | null,
): string {
  const resolvedContent = continueContent ?? legacyContinueContent;
  const resolvedRelPath = continueContent ? continueRelPath : legacyContinueRelPath;

  if (!resolvedContent || !resolvedRelPath) {
    return ["## Resume State", "- No continue file present. Start from the top of the task plan."].join("\n");
  }

  const cont = parseContinue(resolvedContent);
  const lines = [
    "## Resume State",
    `Source: \`${resolvedRelPath}\``,
    `- Status: ${cont.frontmatter.status || "in_progress"}`,
  ];

  if (cont.frontmatter.step && cont.frontmatter.totalSteps) {
    lines.push(`- Progress: step ${cont.frontmatter.step} of ${cont.frontmatter.totalSteps}`);
  }
  if (cont.completedWork) lines.push(`- Completed: ${oneLine(cont.completedWork)}`);
  if (cont.remainingWork) lines.push(`- Remaining: ${oneLine(cont.remainingWork)}`);
  if (cont.decisions) lines.push(`- Decisions: ${oneLine(cont.decisions)}`);
  if (cont.nextAction) lines.push(`- Next action: ${oneLine(cont.nextAction)}`);

  return lines.join("\n");
}

export async function buildCarryForwardSection(priorSummaryPaths: string[], base: string): Promise<string> {
  if (priorSummaryPaths.length === 0) {
    return ["## Carry-Forward Context", "- No prior task summaries in this slice."].join("\n");
  }

  const items = await Promise.all(priorSummaryPaths.map(async (relPath) => {
    const absPath = join(base, relPath);
    const content = await loadFile(absPath);
    if (!content) return `- \`${relPath}\``;

    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const keyFiles = summary.frontmatter.key_files.slice(0, 3).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");

    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (keyFiles) parts.push(`key_files: ${keyFiles}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);

    return `- \`${relPath}\` — ${parts.join(" | ")}`;
  }));

  return ["## Carry-Forward Context", ...items].join("\n");
}

export function extractSliceExecutionExcerpt(content: string | null, relPath: string): string {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`,
    ].join("\n");
  }

  const lines = content.split("\n");
  const goalLine = lines.find(l => l.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find(l => l.startsWith("**Demo:**"))?.trim();

  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");

  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) {
    parts.push("", "### Slice Verification", verification.trim());
  }
  if (observability) {
    parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  }

  return parts.join("\n");
}

// ─── Prior Task Summaries ──────────────────────────────────────────────────

/** Resolve where task SUMMARY files live (legacy tasks/ subdir or flat-phase phase dir). */
function resolveTaskSummariesLocation(
  base: string, mid: string, sid: string,
): { dir: string; relPrefix: string } | null {
  const slicePath = resolveSlicePath(base, mid, sid);
  if (!slicePath) return null;
  const tDir = resolveTasksDir(base, mid, sid);
  const sRel = relSlicePath(base, mid, sid);
  if (tDir) return { dir: tDir, relPrefix: `${sRel}/tasks` };
  return { dir: slicePath, relPrefix: sRel };
}

function summaryFileBelongsToSlice(
  fileName: string,
  base: string,
  mid: string,
  sid: string,
): boolean {
  const tid = taskIdFromTaskFileName(fileName, "SUMMARY");
  if (!tid) return false;
  const resolved = resolveTaskFile(base, mid, sid, tid, "SUMMARY");
  return resolved !== null && basename(resolved) === fileName;
}

export async function getPriorTaskSummaryPaths(
  mid: string, sid: string, currentTid: string, base: string,
): Promise<string[]> {
  const loc = resolveTaskSummariesLocation(base, mid, sid);
  if (!loc) return [];

  const summaryFiles = resolveTaskFiles(loc.dir, "SUMMARY");
  const currentNum = parseInt(currentTid.replace(/^T/, ""), 10);

  return summaryFiles
    .filter(f => {
      if (!summaryFileBelongsToSlice(f, base, mid, sid)) return false;
      const tid = taskIdFromTaskFileName(f, "SUMMARY");
      if (!tid) return false;
      const num = parseInt(tid.replace(/^T/, ""), 10);
      return num < currentNum;
    })
    .map(f => `${loc.relPrefix}/${f}`);
}

/**
 * Get carry-forward summary paths scoped to a task's derived dependencies.
 *
 * Instead of all prior tasks (order-based), returns only summaries for task
 * IDs in `dependsOn`. Used by reactive-execute to give each subagent only
 * the context it actually needs — not sibling tasks from a parallel batch.
 *
 * Falls back to order-based when dependsOn is empty (root tasks still get
 * any available prior summaries for continuity).
 */
export async function getDependencyTaskSummaryPaths(
  mid: string, sid: string, currentTid: string,
  dependsOn: string[], base: string,
): Promise<string[]> {
  // If no dependencies, fall back to order-based for root tasks
  if (dependsOn.length === 0) {
    return getPriorTaskSummaryPaths(mid, sid, currentTid, base);
  }

  const loc = resolveTaskSummariesLocation(base, mid, sid);
  if (!loc) return [];

  const summaryFiles = resolveTaskFiles(loc.dir, "SUMMARY");
  const depSet = new Set(dependsOn.map((d) => d.toUpperCase()));

  return summaryFiles
    .filter((f) => {
      if (!summaryFileBelongsToSlice(f, base, mid, sid)) return false;
      const tid = taskIdFromTaskFileName(f, "SUMMARY");
      if (!tid) return false;
      return depSet.has(tid);
    })
    .map((f) => `${loc.relPrefix}/${f}`);
}

// ─── Adaptive Replanning Checks ────────────────────────────────────────────

/**
 * True when a slice row counts as completed work for prompt/dispatch purposes.
 *
 * The DB column is free-form, so legacy and imported rows still carry "done" /
 * "closed" (see `status-guards.ts`). These reads replaced roadmap-checkbox
 * parsing, and the checkbox was rendered `[x]` via `isClosedStatus`, so the
 * closed set must come from the shared guard — an equality check against
 * "complete" silently drops migrated rows from dispatch. A user-directed skip
 * is closed but produced no work, so it is not a reassess/UAT candidate.
 */
function isCompletedSliceStatus(status: string): boolean {
  return isClosedStatus(status) && status !== "skipped";
}

/**
 * Check if the most recently completed slice needs reassessment.
 * Returns { sliceId } if reassessment is needed, null otherwise.
 *
 * Skips reassessment when:
 * - No roadmap exists yet
 * - No slices are completed
 * - The last completed slice already has an assessment file
 * - All slices are complete (milestone done — no point reassessing)
 */
export async function checkNeedsReassessment(
  base: string, mid: string, state: GSDState,
): Promise<{ sliceId: string } | null> {
  // DB read authority — post-cutover there is no markdown fallback. With no DB
  // there is no slice state to reason about, so returning null (never dispatch
  // reassess-roadmap) is the only sound answer: dispatching off a roadmap parse
  // would reassess against a projection that is not the source of truth.
  if (!isDbAvailable()) return null;

  try {
    const slices = getMilestoneSlices(mid);
    if (slices.length > 0) {
      const completedSliceIds = slices.filter(s => isCompletedSliceStatus(s.status)).map(s => s.id);
      const hasIncomplete = slices.some(s => !isClosedStatus(s.status));
      if (completedSliceIds.length === 0 || !hasIncomplete) return null;
      const lastCompleted = completedSliceIds[completedSliceIds.length - 1];
      const assessmentFile = resolveSliceFile(base, mid, lastCompleted, "ASSESSMENT");
      const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));
      if (hasAssessment) return null;
      const summaryFile = resolveSliceFile(base, mid, lastCompleted, "SUMMARY");
      const hasSummary = !!(summaryFile && await loadFile(summaryFile));
      if (!hasSummary) return null;
      return { sliceId: lastCompleted };
    }
  } catch (err) {
    logWarning("prompt", `checkNeedsReassessment DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}


export async function loadRoadmapCompletedSliceCandidates(
  base: string,
  mid: string,
): Promise<UatDispatchCandidate[]> {
  // DB read authority — completed slices come from DB rows, not roadmap checkboxes.
  void base;
  if (!isDbAvailable()) return [];
  return getMilestoneSlices(mid)
    .filter((slice) => isCompletedSliceStatus(slice.status))
    .map((slice) => ({ sliceId: slice.id }))
    .reverse();
}

/**
 * Back-compat wrapper for callers that import UAT dispatch checks from the
 * prompt module. UAT dispatch architecture lives in `uat-dispatch.ts`; the
 * `state` parameter is intentionally ignored because DB/roadmap artifacts are
 * the source of truth for completed-slice discovery.
 */
export async function checkNeedsRunUat(
  base: string, mid: string, state: GSDState, prefs: GSDPreferences | undefined,
): Promise<Awaited<ReturnType<typeof resolveNeedsRunUat>>> {
  void state;

  return resolveNeedsRunUat(
    base,
    mid,
    prefs,
    await loadRoadmapCompletedSliceCandidates(base, mid),
  );
}

// ─── Prompt Builders ──────────────────────────────────────────────────────

/**
 * Build a prompt for the discuss-milestone unit type.
 * Loads the guided-discuss-milestone template and inlines the CONTEXT-DRAFT
 * as a seed when present. The discussion agent interviews the user, writes
 * a full CONTEXT.md, and the phase transitions to pre-planning automatically.
 */
export interface DiscussMilestonePromptOptions {
  headless?: boolean;
  commitInstruction?: string;
  fastPathInstruction?: string;
  includeDraftSeed?: boolean;
  includeContextMode?: boolean;
}

export async function buildDiscussMilestoneInlinedContext(mid: string, base: string): Promise<string> {
  const inlined: string[] = [];

  const roadmapInline = await inlineFileOptional(
    resolveMilestoneFile(base, mid, "ROADMAP"),
    relMilestoneFile(base, mid, "ROADMAP"),
    "Milestone Roadmap",
  );
  if (roadmapInline) inlined.push(roadmapInline);

  const contextInline = await inlineFileOptional(
    resolveMilestoneFile(base, mid, "CONTEXT"),
    relMilestoneFile(base, mid, "CONTEXT"),
    "Milestone Context",
  );
  if (contextInline) inlined.push(contextInline);

  const researchInline = await inlineFileOptional(
    resolveMilestoneFile(base, mid, "RESEARCH"),
    relMilestoneFile(base, mid, "RESEARCH"),
    "Milestone Research",
  );
  if (researchInline) inlined.push(researchInline);

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      inlined.push(`### Decisions Register\nSource: \`${relGsdRootFile("DECISIONS")}\`\n\n${decisionsContent.trim()}`);
    }
  }

  const milestoneIds = findMilestoneIds(base);
  const currentIndex = milestoneIds.indexOf(mid);
  const priorMilestoneIds = currentIndex >= 0 ? milestoneIds.slice(0, currentIndex) : milestoneIds;
  for (const priorMid of priorMilestoneIds) {
    const summaryInline = await inlineFileOptional(
      resolveMilestoneFile(base, priorMid, "SUMMARY"),
      relMilestoneFile(base, priorMid, "SUMMARY"),
      `${priorMid} Prior Milestone Summary`,
    );
    if (summaryInline) inlined.push(summaryInline);
  }

  return inlined.length > 0
    ? `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`
    : "## Inlined Context\n\n_(no milestone context files found yet — go in blind and ask broad questions)_";
}

export async function buildDiscussMilestonePrompt(
  mid: string,
  midTitle: string,
  base: string,
  structuredQuestionsAvailable = "false",
  {
    headless = false,
    commitInstruction = "Do not commit planning artifacts — .gsd/ is managed externally.",
    fastPathInstruction = "",
    includeDraftSeed = true,
    includeContextMode = true,
  }: DiscussMilestonePromptOptions = {},
): Promise<string> {
  const contextTemplate = inlineTemplate("context", "Context");

  if (headless) {
    const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    const prompt = loadPrompt("discuss-headless", {
      seedContext: roadmapContent ?? "",
      inlinedTemplates: contextTemplate,
      workingDirectory: base,
      milestoneId: mid,
      contextPath: relMilestoneFile(base, mid, "CONTEXT"),
      commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
      multiMilestoneCommitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
    });
    return prependLanguageDirectiveForBase(base, prompt);
  }

  const rawInlinedContext = await buildDiscussMilestoneInlinedContext(mid, base);
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  const discussTemplates = [cappedInlinedContext, contextTemplate].join("\n\n---\n\n");

  const basePrompt = loadPrompt("guided-discuss-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    inlinedTemplates: discussTemplates,
    structuredQuestionsAvailable,
    commitInstruction,
    fastPathInstruction,
  });
  const promptWithContextMode = includeContextMode
    ? prependContextModeToBlock("discuss-milestone", base, basePrompt)
    : basePrompt;

  // If a CONTEXT-DRAFT.md exists, append it as seed material
  const draftPath = resolveMilestoneFile(base, mid, "CONTEXT-DRAFT");
  const draftContent = draftPath ? await loadFile(draftPath) : null;

  if (includeDraftSeed && draftContent) {
    const draftRelPath = relMilestoneFile(base, mid, "CONTEXT-DRAFT");
    const draftSeed = `### Prior Discussion Draft\nSource: \`${draftRelPath}\`\n\n${draftContent.trim()}`;
    const cappedDraftSeed = capPreamble(draftSeed);
    const truncationNote = cappedDraftSeed !== draftSeed
      ? `\n\n_(Draft seed truncated; read the full draft at \`${draftRelPath}\` if needed.)_`
      : "";
    const promptWithDraftSeed = `${promptWithContextMode}\n\n## Prior Discussion (Draft Seed)\n\nThe following draft was captured from a prior multi-milestone discussion. Use it as seed material — the user has already provided this context. Start with a brief reflection on what the draft covers, then probe for any gaps or open questions before writing the full CONTEXT.md.\n\n${cappedDraftSeed}${truncationNote}`;
    return prependLanguageDirectiveForBase(base, promptWithDraftSeed);
  }

  return prependLanguageDirectiveForBase(base, promptWithContextMode);
}

/**
 * Build a prompt for the workflow-preferences unit type (deep mode).
 * Default-writing stage: records high-impact workflow defaults in
 * .gsd/PREFERENCES.md. Runs ONCE per project, early
 * in deep-mode bootstrap before discuss-project.
 */
export async function buildWorkflowPreferencesPrompt(
  base: string,
  structuredQuestionsAvailable = "false",
): Promise<string> {
  return prependContextModeToBlock("workflow-preferences", base, loadPrompt("guided-workflow-preferences", {
    workingDirectory: base,
    structuredQuestionsAvailable,
  }));
}

/**
 * Build a prompt for the research-project (parallel) unit type (deep mode).
 * Orchestrator that spawns 4 parallel Task() calls covering stack, features,
 * architecture, and pitfalls. Each subagent writes its findings to .gsd/research/.
 * Fires after research-decision marker says "research" and project research files
 * are missing. Skipped entirely if user picked "skip".
 */
export async function buildResearchProjectPrompt(
  base: string,
  structuredQuestionsAvailable = "false",
  sessionProvider?: string,
): Promise<string> {
  const scoutAgentType = resolveSubagentRoleForProvider("scout", sessionProvider);
  return prependContextModeToBlock("research-project", base, loadPrompt("guided-research-project", {
    workingDirectory: base,
    structuredQuestionsAvailable,
    scoutAgentType,
  }), "standalone", sessionProvider);
}

/**
 * Build a prompt for the research-decision unit type (deep mode).
 * Fixed-question stage: asks "research first or skip?" via ask_user_questions
 * and writes .gsd/runtime/research-decision.json. Fires after discuss-requirements
 * and before research-project-parallel.
 */
export async function buildResearchDecisionPrompt(
  base: string,
  structuredQuestionsAvailable = "false",
): Promise<string> {
  return prependContextModeToBlock("research-decision", base, loadPrompt("guided-research-decision", {
    workingDirectory: base,
    structuredQuestionsAvailable,
  }));
}

/**
 * Build a prompt for the discuss-project unit type (deep mode).
 * Project-level interview: produces .gsd/PROJECT.md.
 * Fires before any milestone-level work when planning_depth === "deep" and
 * PROJECT.md is missing.
 */
export async function buildDiscussProjectPrompt(
  base: string,
  structuredQuestionsAvailable = "false",
): Promise<string> {
  const inlinedTemplates = inlineTemplate("project", "Project");

  return prependContextModeToBlock("discuss-project", base, loadPrompt("guided-discuss-project", {
    workingDirectory: base,
    inlinedTemplates,
    structuredQuestionsAvailable,
    commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
  }));
}

/**
 * Build a prompt for the discuss-requirements unit type (deep mode).
 * Requirements-level interview: produces .gsd/REQUIREMENTS.md using the
 * structured R### format. Reads PROJECT.md as authoritative context.
 * Fires when planning_depth === "deep", PROJECT.md exists, and REQUIREMENTS.md is missing.
 */
export async function buildDiscussRequirementsPrompt(
  base: string,
  structuredQuestionsAvailable = "false",
): Promise<string> {
  const inlinedTemplates = inlineTemplate("requirements", "Requirements");

  return prependContextModeToBlock("discuss-requirements", base, loadPrompt("guided-discuss-requirements", {
    workingDirectory: base,
    inlinedTemplates,
    structuredQuestionsAvailable,
    commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
  }));
}

/**
 * Bounded codebase snapshot for research-milestone grounding (ADR-029).
 *
 * Reuses the in-process, ~millisecond `analyzeCodebase` / `formatCodebaseBrief`
 * machinery that powers the guided-discuss Preparation Snapshot, so research
 * grounds on current code reality instead of running an open-ended `rg`/`find`/
 * `scout` survey on every dispatch (the auto-mode counterpart to ADR-028).
 *
 * Gated on the manifest's `codebaseMap` flag (previously a dead policy flag)
 * and the `discuss_preparation` opt-out. Failures degrade silently — research
 * still runs, it just falls back to on-demand reads.
 */
async function buildResearchCodebaseSnapshot(base: string): Promise<string | null> {
  const manifest = resolveManifest("research-milestone");
  if (!manifest?.codebaseMap) return null;
  const prefs = loadEffectiveGSDPreferences(base)?.preferences;
  if (prefs?.discuss_preparation === false) return null;
  try {
    const { analyzeCodebase, formatCodebaseBrief } = await import("./preparation.js");
    const brief = await analyzeCodebase(base);
    const formatted = formatCodebaseBrief(brief).trim();
    if (!formatted) return null;
    return [
      "### Codebase Snapshot (current code reality)",
      "Source: in-process bounded scan of the working tree.",
      "",
      "This snapshot describes what already exists. Treat it as authoritative for current code reality and do NOT re-survey the tree to rediscover it. Read a specific file only when a research question hinges on its exact contents.",
      "",
      formatted,
    ].join("\n");
  } catch (err) {
    logWarning("prompt", `buildResearchCodebaseSnapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Lightweight research resume block (ADR-029).
 *
 * When a prior attempt for this milestone left durable output — a partial
 * RESEARCH artifact and/or a research phase anchor — inline it under a
 * "continue, do not redo" banner so a re-dispatched research unit extends
 * prior work instead of re-running every command from scratch (the
 * restart-from-scratch pattern observed in the 789 run trace). No new state
 * machine: the partial RESEARCH file and the existing phase anchor are the
 * durable signals. Returns null when there is nothing to resume.
 */
async function buildResearchResumeBlock(base: string, mid: string): Promise<string | null> {
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");
  const partial = await inlineFileOptional(researchPath, researchRel, "Prior Partial Research");
  const anchor = readPhaseAnchor(base, mid, "research-milestone");
  if (!partial && !anchor) return null;
  const lines: string[] = [
    "### Resume — Prior Partial Research (continue, do not redo)",
    "",
    "A previous research attempt for this milestone left the durable output below. **Build on it — do not restart from scratch.** Re-run a command only when its prior result is missing or stale, and persist progress incrementally with `gsd_summary_save` so any interruption keeps your findings.",
    "",
  ];
  if (anchor) lines.push(formatAnchorForPrompt(anchor), "");
  if (partial) lines.push(partial);
  return lines.join("\n").trimEnd();
}

export async function buildResearchMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextTelemetry: PromptContextTelemetryEntry[] = [];

  // Keep research milestone prompts focused on the milestone brief and
  // research template. Project-wide docs stay on-demand instead of being
  // loaded at the start of every milestone.
  const resolveArtifact: ArtifactResolver = async (key) => {
    switch (key) {
      case "milestone-context": {
        const p = resolveMilestoneFile(base, mid, "CONTEXT");
        const r = relMilestoneFile(base, mid, "CONTEXT");
        const body = await inlineFile(p, r, "Milestone Context");
        trackPromptContext(contextTelemetry, "milestone-context", "inline", body);
        return body;
      }
      case "project":
      case "requirements":
      case "decisions":
        trackPromptContext(contextTelemetry, key, "skipped", null, "handled as on-demand path");
        return null;
      case "templates": {
        const body = inlineTemplate("research", "Research");
        trackPromptContext(contextTelemetry, "templates", "inline", body);
        return body;
      }
      default:
        return null;
    }
  };

  const composed = await composeUnitContext("research-milestone", {
    base: { unitType: "research-milestone", basePath: base, milestoneId: mid },
    resolveArtifact,
  });

  // Knowledge block stays outside the composer — budgeted, scoped via
  // keyword extraction (#4719). Inserted before the template so research
  // instructions remain the final contract in the preloaded block.
  const knowledgeInlineRM = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  const parts: string[] = [];
  if (composed.prepend) parts.push(composed.prepend);

  // Resume grounding (ADR-029): if a prior attempt left partial research or a
  // phase anchor, inline it prominently so a re-dispatched unit continues
  // rather than re-running every command from scratch.
  const resumeBlock = await buildResearchResumeBlock(base, mid);
  if (resumeBlock) {
    parts.push(resumeBlock);
    trackPromptContext(contextTelemetry, "research-resume", "inline", resumeBlock);
  } else {
    trackPromptContext(contextTelemetry, "research-resume", "skipped", null, "no prior partial research");
  }

  // Project-size signal (ADR-029): same classification plan-milestone gets, so
  // research right-sizes effort on tiny projects instead of over-researching.
  const classificationBlock = formatProjectClassificationForPlanning(classifyProject(base));
  parts.push(classificationBlock);
  trackPromptContext(contextTelemetry, "project-classification", "inline", classificationBlock);

  // Codebase snapshot (ADR-029): bounded, in-process code-reality grounding so
  // research does not open-endedly survey the tree (auto-mode ADR-028).
  const codebaseSnapshot = await buildResearchCodebaseSnapshot(base);
  if (codebaseSnapshot) {
    parts.push(codebaseSnapshot);
    trackPromptContext(contextTelemetry, "codebase-snapshot", "inline", codebaseSnapshot);
  } else {
    trackPromptContext(contextTelemetry, "codebase-snapshot", "skipped", null, "disabled, empty, or scan failed");
  }

  if (knowledgeInlineRM && composed.inline) {
    const idx = composed.inline.lastIndexOf("### Output Template:");
    if (idx > 0) {
      const before = composed.inline.slice(0, idx).replace(/\n\n---\n\n$/, "");
      const after = composed.inline.slice(idx);
      parts.push(before, knowledgeInlineRM, after);
    } else {
      parts.push(composed.inline, knowledgeInlineRM);
    }
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInlineRM);
  } else if (composed.inline) {
    parts.push(composed.inline);
    if (knowledgeInlineRM) parts.push(knowledgeInlineRM);
    trackPromptContext(contextTelemetry, "knowledge", knowledgeInlineRM ? "inline" : "skipped", knowledgeInlineRM, knowledgeInlineRM ? undefined : "missing");
  } else {
    trackPromptContext(contextTelemetry, "knowledge", knowledgeInlineRM ? "inline" : "skipped", knowledgeInlineRM, knowledgeInlineRM ? undefined : "missing");
  }

  const onDemandDocs = [
    "### On-demand Planning Context",
    "",
    "Broader project context is available if the research needs it. Read only the specific source that answers the question:",
    "",
    `- \`${relGsdRootFile("PROJECT")}\` — product/project narrative`,
    `- \`${relGsdRootFile("REQUIREMENTS")}\` — requirement status and acceptance criteria`,
    `- \`${relGsdRootFile("DECISIONS")}\` — active architecture/product decisions`,
  ].join("\n");
  parts.push(onDemandDocs);
  trackPromptContext(contextTelemetry, "project,requirements,decisions", "on-demand", onDemandDocs);

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${parts.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );

  const inlinedContext = prependContextModeToBlock(
    "research-milestone",
    base,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("research-milestone", contextTelemetry, inlinedContext);

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid, midTitle),
    contextPath: relMilestoneFile(base, mid, "CONTEXT"),
    outputPath: join(base, outputRelPath),
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "research-milestone",
    }),
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildPlanMilestonePrompt(
  mid: string,
  midTitle: string,
  base: string,
  milestoneScope: MilestoneScope,
  level?: InlineLevel,
): Promise<string> {
  const projectBase = milestoneScope.workspace.projectRoot;
  const promptBase = normalizeRealPath(base);
  const displayProjectPath = (path: string): string => relative(promptBase, path).split(sep).join("/") || ".";
  const rebaseInlineSource = (
    body: string | null,
    key: "PROJECT" | "REQUIREMENTS" | "DECISIONS",
  ): string | null => body?.replace(
    `Source: \`${relGsdRootFile(key)}\``,
    `Source: \`${displayProjectPath(resolveGsdRootFile(projectBase, key))}\``,
  ) ?? null;
  const inlineLevel = level ?? resolveInlineLevel();
  const contextPath = milestoneScope.contextFile();
  const contextRel = displayProjectPath(contextPath);
  const researchPath = resolveMilestoneFile(projectBase, mid, "RESEARCH");
  const researchTarget = researchPath ?? targetMilestoneFile(projectBase, mid, "RESEARCH", midTitle);
  const researchRel = displayProjectPath(researchTarget);

  const inlined: string[] = [];
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  const pushTracked = (key: string, body: string, reason?: string): void => {
    inlined.push(body);
    trackPromptContext(contextTelemetry, key, "inline", body, reason);
  };

  // Inject phase handoff anchor from research phase (if available)
  const researchAnchor = readPhaseAnchor(projectBase, mid, "research-milestone");
  if (researchAnchor) {
    pushTracked("research-anchor", formatAnchorForPrompt(researchAnchor));
  } else {
    trackPromptContext(contextTelemetry, "research-anchor", "skipped", null, "missing");
  }

  pushTracked("project-classification", formatProjectClassificationForPlanning(classifyProject(base)));

  pushTracked("milestone-context", await inlineFile(contextPath, contextRel, "Milestone Context"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Milestone Research");
  if (researchInline) {
    pushTracked("milestone-research", researchInline);
  } else {
    trackPromptContext(contextTelemetry, "milestone-research", "skipped", null, "missing");
  }
  const { inlinePriorMilestoneSummary } = await import("./files.js");
  const priorSummaryInline = await inlinePriorMilestoneSummary(mid, projectBase);
  if (priorSummaryInline) {
    pushTracked("prior-milestone-summary", priorSummaryInline);
  } else {
    trackPromptContext(contextTelemetry, "prior-milestone-summary", "skipped", null, "missing");
  }
  if (inlineLevel === "full") {
    const projectInline = rebaseInlineSource(await inlineProjectFromDb(projectBase), "PROJECT");
    if (projectInline) {
      pushTracked("project", projectInline, inlineLevel);
    } else {
      trackPromptContext(contextTelemetry, "project", "skipped", null, "missing");
    }
    const requirementsInline = rebaseInlineSource(
      await inlineRequirementsFromDb(projectBase, mid, undefined, inlineLevel),
      "REQUIREMENTS",
    );
    if (requirementsInline) {
      pushTracked("requirements", requirementsInline, inlineLevel);
    } else {
      trackPromptContext(contextTelemetry, "requirements", "skipped", null, "missing");
    }
    const decisionsInline = rebaseInlineSource(
      await inlineDecisionsFromDb(projectBase, mid, undefined, inlineLevel),
      "DECISIONS",
    );
    if (decisionsInline) {
      pushTracked("decisions", decisionsInline, inlineLevel);
    } else {
      trackPromptContext(contextTelemetry, "decisions", "skipped", null, "missing");
    }
  } else if (inlineLevel === "standard") {
    trackPromptContext(contextTelemetry, "project", "skipped", null, "handled as on-demand path");
    const requirementsInline = rebaseInlineSource(
      await inlineRequirementsFromDb(projectBase, mid, undefined, inlineLevel),
      "REQUIREMENTS",
    );
    if (requirementsInline) {
      pushTracked("requirements", requirementsInline, inlineLevel);
    } else {
      trackPromptContext(contextTelemetry, "requirements", "skipped", null, "missing");
    }
    trackPromptContext(contextTelemetry, "decisions", "skipped", null, "handled as on-demand path");
  } else {
    trackPromptContext(contextTelemetry, "project", "skipped", null, "handled as on-demand path");
    trackPromptContext(contextTelemetry, "requirements", "skipped", null, "minimal inline level");
    trackPromptContext(contextTelemetry, "decisions", "skipped", null, "handled as on-demand path");
  }
  if (inlineLevel !== "full") {
    const onDemandDocs = [
      "### On-demand Planning Context",
      "",
      "Broader project context is available if roadmap planning needs it. Read only the source that answers the planning question:",
      "",
      `- \`${displayProjectPath(resolveGsdRootFile(projectBase, "PROJECT"))}\` - product/project narrative`,
      `- \`${displayProjectPath(resolveGsdRootFile(projectBase, "DECISIONS"))}\` - active architecture/product decisions`,
    ].join("\n");
    inlined.push(onDemandDocs);
    trackPromptContext(contextTelemetry, "project,decisions", "on-demand", onDemandDocs);
  }
  const queuePath = resolveGsdRootFile(projectBase, "QUEUE");
  if (existsSync(queuePath)) {
    const queueInline = await inlineFileSmart(
      queuePath,
      displayProjectPath(queuePath),
      "Project Queue",
      `${mid} ${midTitle}`,
    );
    pushTracked("project-queue", queueInline);
  } else {
    trackPromptContext(contextTelemetry, "project-queue", "skipped", null, "missing");
  }
  // Scoped + budgeted — see issue #4719
  const knowledgeInlinePM = await inlineKnowledgeBudgeted(projectBase, extractKeywords(midTitle));
  if (knowledgeInlinePM) {
    pushTracked("knowledge", knowledgeInlinePM);
  } else {
    trackPromptContext(contextTelemetry, "knowledge", "skipped", null, "missing");
  }
  const webAppUatGuidance = buildWebAppUatGuidanceBlock(base);
  if (webAppUatGuidance) {
    pushTracked("web-app-uat", webAppUatGuidance);
  } else {
    trackPromptContext(contextTelemetry, "web-app-uat", "skipped", null, "not a web app");
  }
  pushTracked("templates", inlineTemplate("roadmap", "Roadmap"));
  if (inlineLevel === "full") {
    pushTracked("templates", inlineTemplate("decisions", "Decisions"));
    pushTracked("templates", inlineTemplate("plan", "Slice Plan"));
    pushTracked("templates", inlineTemplate("task-plan", "Task Plan"));
    pushTracked("templates", inlineTemplate("secrets-manifest", "Secrets Manifest"));
  } else if (inlineLevel === "standard") {
    pushTracked("templates", inlineTemplate("decisions", "Decisions"));
    pushTracked("templates", inlineTemplate("plan", "Slice Plan"));
    pushTracked("templates", inlineTemplate("task-plan", "Task Plan"));
  }

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "plan-milestone",
    projectBase,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("plan-milestone", contextTelemetry, inlinedContext);

  const roadmapPath = milestoneScope.roadmapFile();
  const secretsOutputPath = targetMilestoneFile(projectBase, mid, "SECRETS", midTitle);
  return loadPrompt("plan-milestone", {
    workingDirectory: base,
    projectGsdPath: displayProjectPath(milestoneScope.workspace.contract.projectGsd),
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: displayProjectPath(milestoneScope.milestoneDir()),
    contextPath: contextRel,
    researchPath: researchRel,
    researchOutputPath: displayProjectPath(researchTarget),
    outputPath: displayProjectPath(roadmapPath),
    secretsOutputPath: displayProjectPath(secretsOutputPath),
    inlinedContext,
    sourceFilePaths: buildSourceFilePaths(projectBase, mid, undefined, promptBase),
    skillActivation: buildSkillActivationBlock({
      base: projectBase,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "plan-milestone",
    }),
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildResearchSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
  options?: { contextModeRenderMode?: ContextModeRenderMode; sessionProvider?: string },
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const milestoneResearchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const milestoneResearchRel = relMilestoneFile(base, mid, "RESEARCH");

  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");

  const inlined: string[] = [];
  const contextTelemetry: PromptContextTelemetryEntry[] = [];

  // Use roadmap excerpt instead of full roadmap for context reduction
  const roadmapExcerptRS = await inlineRoadmapExcerpt(base, mid, sid);
  if (roadmapExcerptRS) {
    inlined.push(roadmapExcerptRS);
    trackPromptContext(contextTelemetry, "roadmap", "excerpt", roadmapExcerptRS);
  } else {
    // Fall back to full roadmap if excerpt fails
    const roadmapInline = await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap");
    inlined.push(roadmapInline);
    trackPromptContext(contextTelemetry, "roadmap", "inline", roadmapInline, "excerpt unavailable");
  }

  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) {
    inlined.push(contextInline);
    trackPromptContext(contextTelemetry, "milestone-context", "inline", contextInline);
  } else {
    trackPromptContext(contextTelemetry, "milestone-context", "skipped", null, "missing");
  }
  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) {
    inlined.push(sliceCtxInline);
    trackPromptContext(contextTelemetry, "slice-context", "inline", sliceCtxInline);
  } else {
    trackPromptContext(contextTelemetry, "slice-context", "skipped", null, "missing");
  }
  const researchInline = await inlineFileOptional(milestoneResearchPath, milestoneResearchRel, "Milestone Research");
  if (researchInline) {
    inlined.push(researchInline);
    trackPromptContext(contextTelemetry, "milestone-research", "inline", researchInline);
  } else {
    trackPromptContext(contextTelemetry, "milestone-research", "skipped", null, "missing");
  }

  // Derive scope from slice title for decision filtering (R005)
  const derivedScope = deriveSliceScope(sTitle);
  if (derivedScope) {
    const decisionsInline = await inlineDecisionsFromDb(base, mid, derivedScope);
    if (decisionsInline) {
      inlined.push(decisionsInline);
      trackPromptContext(contextTelemetry, "decisions", "inline", decisionsInline, `scope:${derivedScope}`);
    } else {
      trackPromptContext(contextTelemetry, "decisions", "skipped", null, `no scoped decisions for ${derivedScope}`);
    }
  } else {
    const onDemandDecisions = [
      "### On-demand Decisions",
      "",
      `No specific decision scope was derived from "${sTitle}". Read \`${relGsdRootFile("DECISIONS")}\` only if research needs prior architecture/product decisions.`,
    ].join("\n");
    inlined.push(onDemandDecisions);
    trackPromptContext(contextTelemetry, "decisions", "on-demand", onDemandDecisions, "no derived scope");
  }
  const requirementsInline = await inlineRequirementsFromDb(base, mid, sid);
  if (requirementsInline) {
    inlined.push(requirementsInline);
    trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
  } else {
    trackPromptContext(contextTelemetry, "requirements", "skipped", null, "missing");
  }

  // Use scoped knowledge based on slice title keywords
  const keywords = extractKeywords(sTitle);
  const knowledgeInlineRS = await inlineKnowledgeScoped(base, keywords);
  if (knowledgeInlineRS) {
    inlined.push(knowledgeInlineRS);
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInlineRS);
  } else {
    trackPromptContext(contextTelemetry, "knowledge", "skipped", null, "missing");
  }

  // Knowledge graph: subgraph for this slice (graceful — skipped if no graph.json)
  const graphBlockRS = await inlineGraphSubgraph(base, `${sid} ${sTitle}`, { budget: 3000 });
  if (graphBlockRS) {
    inlined.push(graphBlockRS);
    trackPromptContext(contextTelemetry, "graph-subgraph", "inline", graphBlockRS);
  } else {
    trackPromptContext(contextTelemetry, "graph-subgraph", "skipped", null, "missing");
  }

  const templateInline = inlineTemplate("research", "Research");
  inlined.push(templateInline);
  trackPromptContext(contextTelemetry, "templates", "inline", templateInline);

  const depContent = await inlineDependencySummaries(mid, sid, base, resolveSummaryBudgetChars());
  trackPromptContext(contextTelemetry, "dependency-summaries", depContent.trim() ? "inline" : "skipped", depContent, depContent.trim() ? undefined : "none");
  const activeOverrides = await loadActiveOverrides(base);
  const overridesInline = formatOverridesSection(activeOverrides);
  if (overridesInline) {
    inlined.unshift(overridesInline);
    trackPromptContext(contextTelemetry, "overrides", "inline", overridesInline);
  } else {
    trackPromptContext(contextTelemetry, "overrides", "skipped", null, "none active");
  }

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "research-slice",
    base,
    cappedInlinedContext,
    options?.contextModeRenderMode,
    options?.sessionProvider,
  );
  emitPromptContextTelemetry("research-slice", contextTelemetry, inlinedContext);

  const outputRelPath = relSliceFile(base, mid, sid, "RESEARCH");
  const scoutAgentType = resolveSubagentRoleForProvider("scout", options?.sessionProvider);
  return loadPrompt("research-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    contextPath: contextRel,
    milestoneResearchPath: milestoneResearchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    scoutAgentType,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
      unitType: "research-slice",
    }),
    ...buildSkillDiscoveryVars(),
  });
}

/**
 * Shared assembly for plan-slice and refine-slice prompts. Both builders need
 * the same inlined context (roadmap excerpt, slice context, research, decisions,
 * requirements, knowledge, graph subgraph, templates, dependency summaries,
 * overrides). Extracted to prevent drift between the two sites.
 *
 * `prependBlocks` are pushed onto the start of the inlined array BEFORE any
 * shared content, so callers can add unit-specific headers (e.g., the refine
 * sketch-scope constraint).
 */
async function renderSlicePrompt(options: {
  mid: string;
  sid: string;
  sTitle: string;
  base: string;
  level: InlineLevel;
  promptTemplate: "plan-slice" | "refine-slice";
  prependBlocks?: string[];
  extraVars?: Record<string, string>;
  sessionContextWindow?: number;
  modelRegistry?: MinimalModelRegistry;
  sessionProvider?: string;
  contextModeRenderMode?: ContextModeRenderMode;
}): Promise<string> {
  const {
    mid, sid, sTitle, base, level, promptTemplate, prependBlocks = [], extraVars = {},
    sessionContextWindow, modelRegistry, sessionProvider,
  } = options;

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");
  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");

  const inlined: string[] = [...prependBlocks];
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  for (const block of prependBlocks) {
    trackPromptContext(contextTelemetry, "prepend", "inline", block);
  }

  // Phase handoff anchor from research phase (if available)
  const researchSliceAnchor = readPhaseAnchor(base, mid, "research-slice");
  if (researchSliceAnchor) {
    const body = formatAnchorForPrompt(researchSliceAnchor);
    inlined.push(body);
    trackPromptContext(contextTelemetry, "research-anchor", "inline", body);
  } else {
    trackPromptContext(contextTelemetry, "research-anchor", "skipped", null, "missing");
  }

  // Roadmap excerpt with full-roadmap fallback
  const roadmapExcerpt = await inlineRoadmapExcerpt(base, mid, sid);
  if (roadmapExcerpt) {
    inlined.push(roadmapExcerpt);
    trackPromptContext(contextTelemetry, "roadmap", "excerpt", roadmapExcerpt);
  } else {
    const body = await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap");
    inlined.push(body);
    trackPromptContext(contextTelemetry, "roadmap", "inline", body, "excerpt unavailable");
  }

  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) {
    inlined.push(sliceCtxInline);
    trackPromptContext(contextTelemetry, "slice-context", "inline", sliceCtxInline);
  } else {
    trackPromptContext(contextTelemetry, "slice-context", "skipped", null, "missing");
  }
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) {
    inlined.push(researchInline);
    trackPromptContext(contextTelemetry, "slice-research", "inline", researchInline);
  } else {
    trackPromptContext(contextTelemetry, "slice-research", "skipped", null, "missing");
  }

  if (level !== "minimal") {
    const derivedScope = deriveSliceScope(sTitle);
    if (derivedScope) {
      const decisionsInline = await inlineDecisionsFromDb(base, mid, derivedScope, level);
      if (decisionsInline) {
        inlined.push(decisionsInline);
        trackPromptContext(contextTelemetry, "decisions", "inline", decisionsInline, `scope:${derivedScope}`);
      } else {
        trackPromptContext(contextTelemetry, "decisions", "skipped", null, `no scoped decisions for ${derivedScope}`);
      }
    } else {
      const onDemandDecisions = [
        "### On-demand Decisions",
        "",
        `No specific decision scope was derived from "${sTitle}". Read \`${relGsdRootFile("DECISIONS")}\` only if planning needs prior architecture/product decisions.`,
      ].join("\n");
      inlined.push(onDemandDecisions);
      trackPromptContext(contextTelemetry, "decisions", "on-demand", onDemandDecisions, "no derived scope");
    }
    const requirementsInline = await inlineRequirementsFromDb(base, mid, sid, level);
    if (requirementsInline) {
      inlined.push(requirementsInline);
      trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
    } else {
      trackPromptContext(contextTelemetry, "requirements", "skipped", null, "missing");
    }
  } else {
    trackPromptContext(contextTelemetry, "decisions", "skipped", null, "minimal inline level");
    trackPromptContext(contextTelemetry, "requirements", "skipped", null, "minimal inline level");
  }

  const knowledgeInline = await inlineKnowledgeScoped(base, extractKeywords(sTitle));
  if (knowledgeInline) {
    inlined.push(knowledgeInline);
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInline);
  } else {
    trackPromptContext(contextTelemetry, "knowledge", "skipped", null, "missing");
  }

  const graphBlock = await inlineGraphSubgraph(base, `${sid} ${sTitle}`, { budget: 3000 });
  if (graphBlock) {
    inlined.push(graphBlock);
    trackPromptContext(contextTelemetry, "graph-subgraph", "inline", graphBlock);
  } else {
    trackPromptContext(contextTelemetry, "graph-subgraph", "skipped", null, "missing");
  }

  const webAppUatGuidance = buildWebAppUatGuidanceBlock(base);
  if (webAppUatGuidance) {
    inlined.push(webAppUatGuidance);
    trackPromptContext(contextTelemetry, "web-app-uat", "inline", webAppUatGuidance);
  } else {
    trackPromptContext(contextTelemetry, "web-app-uat", "skipped", null, "not a web app");
  }

  const planTemplateInline = level === "minimal" ? inlineCompactTemplate("plan", "Slice Plan") : inlineTemplate("plan", "Slice Plan");
  inlined.push(planTemplateInline);
  trackPromptContext(contextTelemetry, "templates", "inline", planTemplateInline);
  if (level === "full") {
    const taskPlanTemplateInline = inlineTemplate("task-plan", "Task Plan");
    inlined.push(taskPlanTemplateInline);
    trackPromptContext(contextTelemetry, "templates", "inline", taskPlanTemplateInline);
  }

  const depContent = await inlineDependencySummaries(mid, sid, base, resolveSummaryBudgetChars());
  const overridesInline = formatOverridesSection(await loadActiveOverrides(base));
  if (overridesInline) {
    inlined.unshift(overridesInline);
    trackPromptContext(contextTelemetry, "overrides", "inline", overridesInline);
  } else {
    trackPromptContext(contextTelemetry, "overrides", "skipped", null, "none active");
  }

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    promptTemplate,
    base,
    cappedInlinedContext,
    options.contextModeRenderMode,
  );
  emitPromptContextTelemetry(promptTemplate, contextTelemetry, inlinedContext);
  const executorContextConstraints = formatExecutorConstraints(sessionContextWindow, modelRegistry, sessionProvider);
  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  const commitInstruction = "Do not commit — .gsd/ planning docs are managed externally and not tracked in git.";

  return loadPrompt(promptTemplate, {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    sourceFilePaths: buildSourceFilePaths(base, mid, sid),
    repoRegistry: buildRepoRegistryBlock(base),
    executorContextConstraints,
    commitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
      unitType: promptTemplate,
    }),
    ...extraVars,
  });
}

export async function buildPlanSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string, level?: InlineLevel,
  options?: {
    softScopeHint?: string;
    sessionContextWindow?: number;
    modelRegistry?: MinimalModelRegistry;
    sessionProvider?: string;
    /** Failure context from a prior pre-exec gate run (#4551). When present, a
     *  "Fix these specific issues" section is appended so the LLM addresses the
     *  exact problems instead of producing an identical plan that fails again. */
    priorPreExecFailure?: {
      blockingFindings: string[];
      verdictExcerpt: string;
    };
  },
): Promise<string> {
  const prependBlocks: string[] = [];
  // ADR-011: when the refining-phase dispatch rule gracefully downgrades to
  // plan-slice (progressive_planning was toggled off mid-milestone), it
  // forwards the stored sketch_scope as a SOFT hint — context, not a hard
  // constraint. The planner is free to expand beyond it.
  if (options?.softScopeHint && options.softScopeHint.trim().length > 0) {
    prependBlocks.push(
      `## Prior Sketch Scope (soft hint — non-binding)\n\n${options.softScopeHint.trim()}\n\n` +
      `This scope was captured during an earlier progressive-planning pass that was later disabled. Treat it as context only — you may plan beyond it if the work genuinely requires more scope. Do NOT treat this as a hard boundary.`,
    );
  }
  // #4551: inject pre-exec failure context so the re-dispatched plan-slice
  // addresses the exact blocked references rather than reproducing the same plan.
  if (options?.priorPreExecFailure) {
    const { blockingFindings, verdictExcerpt } = options.priorPreExecFailure;
    const findingsList = blockingFindings.length > 0
      ? blockingFindings.map(f => `- ${f}`).join("\n")
      : "- (no specific findings recorded)";
    prependBlocks.push(
      `## Fix these specific issues from the prior pre-exec check\n\n` +
      `The previous plan-slice attempt was blocked by pre-execution validation.\n` +
      `Gate verdict: ${verdictExcerpt}\n\n` +
      `Blocked references that must be resolved in this plan:\n${findingsList}\n\n` +
      `**How to fix each type of issue:**\n` +
      `- **"[file] X doesn't exist and isn't created by prior or same-task outputs"**: ` +
      `Either (a) add an earlier task that creates X on disk before the task that needs it, ` +
      `or (b) if this task IS the one that creates X, move X from inputs to expected_output. ` +
      `Do NOT put X in a task's expected_output if that task only reads or verifies X — only tasks that actually write X to disk should list it in expected_output.\n` +
      `- **"[file] X: ... GSD planning artifacts are projections preloaded as context / written by workflow tools"**: ` +
      `Remove X from the task's inputs, files, and expectedOutput entirely. Planning artifacts (anything under .gsd/, .planning/, or .audits/, or names like M001-CONTEXT.md / S01-PLAN.md) are preloaded as context and written by workflow tools — ` +
      `do NOT add a task that creates X and do NOT move X to expectedOutput.\n` +
      `- **"[file] X: Task T_early reads X but it's created by task T_late (sequence violation)"**: ` +
      `Either (a) reorder tasks so T_late (the creator) runs before T_early (the reader), ` +
      `or (b) if T_late doesn't actually create X (it only reads/tests it), remove X from T_late's expected_output entirely.\n` +
      `- **"[package] P not found on npm"**: Either remove the npm install for P, or use the correct package name.\n\n` +
      `Every file listed in a task's inputs must either exist on disk already or appear in an earlier task's expected_output. ` +
      `A task's expected_output must only list files it actually writes to disk.`,
    );
  }
  return renderSlicePrompt({
    mid, sid, sTitle, base,
    level: level ?? resolveInlineLevel(),
    promptTemplate: "plan-slice",
    prependBlocks,
    sessionContextWindow: options?.sessionContextWindow,
    modelRegistry: options?.modelRegistry,
    sessionProvider: options?.sessionProvider,
  });
}

/**
 * ADR-011 refine-slice: expand a sketch into a full plan using the current
 * codebase state and prior slice summary. Mechanically similar to plan-slice
 * but framed as a *transformation* (sketch → full plan) rather than a
 * blank-sheet planning pass. Reuses inlineDependencySummaries for prior
 * slice SUMMARY and inlines the stored sketch_scope as a hard constraint.
 */
export async function buildRefineSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string, level?: InlineLevel,
  options?: { sessionContextWindow?: number; modelRegistry?: MinimalModelRegistry; sessionProvider?: string },
): Promise<string> {
  // Pull the stored sketch scope from the DB — the hard constraint we plan within.
  let sketchScope = "";
  try {
    const { isDbAvailable, getSlice } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      sketchScope = getSlice(mid, sid)?.sketch_scope ?? "";
    }
  } catch {
    sketchScope = "";
  }

  const prependBlocks: string[] = [];
  if (sketchScope.trim().length > 0) {
    prependBlocks.push(
      `## Sketch Scope (hard constraint)\n\n${sketchScope.trim()}\n\n` +
      `Treat this as the authoritative boundary for the slice. Do not plan work outside this scope; if the scope is too narrow, surface it as a deviation rather than expanding silently.`,
    );
  }

  return renderSlicePrompt({
    mid, sid, sTitle, base,
    level: level ?? resolveInlineLevel(),
    promptTemplate: "refine-slice",
    prependBlocks,
    extraVars: { sketchScope },
    sessionContextWindow: options?.sessionContextWindow,
    modelRegistry: options?.modelRegistry,
    sessionProvider: options?.sessionProvider,
  });
}

/** Options for customizing execute-task prompt construction. */
export interface ExecuteTaskPromptOptions {
  level?: InlineLevel;
  /** Override carry-forward paths (dependency-based instead of order-based). */
  carryForwardPaths?: string[];
  /** Session model context window in tokens, forwarded to the budget engine. */
  sessionContextWindow?: number;
  /** Model registry forwarded to the budget engine for executor-model lookup. */
  modelRegistry?: MinimalModelRegistry;
  /** Session model provider, used for provider-specific effective context windows. */
  sessionProvider?: string;
  /** Render compact Context Mode guidance when embedded inside another prompt. */
  contextModeRenderMode?: ContextModeRenderMode;
}

function extractInlineTaskPlan(slicePlan: string, taskId: string): string | null {
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xmlTask = new RegExp(`<task\\b[^>]*\\bid=["']${escapedTaskId}["'][^>]*>([\\s\\S]*?)<\\/task>`, "i")
    .exec(slicePlan);
  if (xmlTask?.[0]) return xmlTask[0].trim();

  const taskLines = slicePlan.split("\n");
  const start = taskLines.findIndex((line) =>
    new RegExp(`^\\s*-\\s*\\[[ xX]\\]\\s+\\*\\*${escapedTaskId}(?:\\*\\*|:)`, "i").test(line),
  );
  if (start >= 0) {
    let end = start + 1;
    while (end < taskLines.length && !/^\s*-\s*\[[ xX]\]\s+\*\*/.test(taskLines[end]!)) {
      if (/^<\/tasks>\s*$/.test(taskLines[end]!.trim())) break;
      end++;
    }
    return taskLines.slice(start, end).join("\n").trim();
  }

  const tasksBlock = /<tasks>([\s\S]*?)<\/tasks>/i.exec(slicePlan)?.[0];
  return tasksBlock?.includes(taskId) ? tasksBlock.trim() : null;
}

async function resolveExecuteTaskPlan(input: {
  basePath: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  slicePlanContent: string | null;
}): Promise<{ content: string | null; relativePath: string; source: string }> {
  const relativePath = relTaskFile(
    input.basePath,
    input.milestoneId,
    input.sliceId,
    input.taskId,
    "PLAN",
  );
  const standalonePath = resolveTaskFile(
    input.basePath,
    input.milestoneId,
    input.sliceId,
    input.taskId,
    "PLAN",
  );
  if (standalonePath) {
    return { content: await loadFile(standalonePath), relativePath, source: `\`${relativePath}\`` };
  }

  const durablePlan = isDbAvailable()
    ? getTask(input.milestoneId, input.sliceId, input.taskId)?.full_plan_md.trim() || null
    : null;
  if (durablePlan) {
    return {
      content: durablePlan,
      relativePath,
      source: `durable task planning state for ${input.milestoneId}/${input.sliceId}/${input.taskId}`,
    };
  }

  const inlinePlan = input.slicePlanContent
    ? extractInlineTaskPlan(input.slicePlanContent, input.taskId)
    : null;
  const slicePlanRelativePath = relSliceFile(
    input.basePath,
    input.milestoneId,
    input.sliceId,
    "PLAN",
  );
  return {
    content: inlinePlan,
    relativePath: inlinePlan ? slicePlanRelativePath : relativePath,
    source: inlinePlan
      ? `\`${slicePlanRelativePath}\``
      : `\`${relativePath}\``,
  };
}

export async function buildTaskRecoveryReplanPrompt(
  mid: string,
  sid: string,
  sTitle: string,
  tid: string,
  tTitle: string,
  base: string,
): Promise<string> {
  const recovery = readPendingTaskRecoveryContext({
    milestoneId: mid,
    sliceId: sid,
    taskId: tid,
  });
  if (recovery?.action !== "replan" || recovery.replanCompleted) {
    throw new Error(`Task recovery replan is not pending for ${mid}/${sid}/${tid}`);
  }
  const taskPlanPath = resolveTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanRelPath = relTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanInline = taskPlanPath
    ? (await loadFile(taskPlanPath))?.trim() || "_(current Task plan is empty)_"
    : "_(current Task plan projection is missing; rebuild it from durable planning state and recovery evidence)_";
  return loadPrompt("replan-task", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    taskId: tid,
    taskTitle: tTitle,
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    recoveryContext: renderTaskRecoveryDispatchContext(recovery),
  });
}

export async function buildExecuteTaskPrompt(
  mid: string, sid: string, sTitle: string,
  tid: string, tTitle: string, base: string,
  level?: InlineLevel | ExecuteTaskPromptOptions,
): Promise<string> {
  const opts: ExecuteTaskPromptOptions = typeof level === "object" && level !== null && !Array.isArray(level)
    ? level
    : { level: level as InlineLevel | undefined };
  const inlineLevel = opts.level ?? resolveInlineLevel();
  const contextTelemetry: PromptContextTelemetryEntry[] = [];

  // Inject phase handoff anchor from planning phase (if available)
  const planAnchor = readPhaseAnchor(base, mid, "plan-slice");

  const priorSummaries = opts.carryForwardPaths ?? await getPriorTaskSummaryPaths(mid, sid, tid, base);
  const priorLines = priorSummaries.length > 0
    ? priorSummaries.map(p => `- \`${p}\``).join("\n")
    : "- (no prior tasks)";

  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const taskPlan = await resolveExecuteTaskPlan({
    basePath: base,
    milestoneId: mid,
    sliceId: sid,
    taskId: tid,
    slicePlanContent,
  });
  const taskPlanContent = taskPlan.content;
  const taskPlanRelPath = taskPlan.relativePath;
  const taskPlanContext = taskPlanContent
    ? [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Source: ${taskPlan.source}`,
      "",
      taskPlanContent.trim(),
    ].join("\n")
    : [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Task plan not found at dispatch time. Read ${taskPlan.source} before executing.`,
    ].join("\n");
  trackPromptContext(contextTelemetry, "task-plan", taskPlanContent ? "inline" : "on-demand", taskPlanContext, taskPlanContent ? undefined : "missing at dispatch");

  const slicePlanContext = extractSliceExecutionExcerpt(slicePlanContent, relSliceFile(base, mid, sid, "PLAN"));
  trackPromptContext(contextTelemetry, "slice-plan", slicePlanContext ? "excerpt" : "skipped", slicePlanContext, slicePlanContext ? undefined : "missing");

  // Check for continue file (new naming or legacy)
  const continueFile = resolveSliceFile(base, mid, sid, "CONTINUE");
  const legacyContinueDir = resolveSlicePath(base, mid, sid);
  const legacyContinuePath = legacyContinueDir ? join(legacyContinueDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContinueContent = !continueContent && legacyContinuePath ? await loadFile(legacyContinuePath) : null;
  const continueRelPath = relSliceFile(base, mid, sid, "CONTINUE");
  const resumeSection = buildResumeSection(
    continueContent,
    legacyContinueContent,
    continueRelPath,
    legacyContinuePath ? `${relSlicePath(base, mid, sid)}/continue.md` : null,
  );
  trackPromptContext(contextTelemetry, "resume-section", resumeSection.trim() ? "inline" : "skipped", resumeSection, resumeSection.trim() ? undefined : "missing");

  // For minimal inline level, only carry forward the most recent prior summary
  const effectivePriorSummaries = inlineLevel === "minimal" && priorSummaries.length > 1
    ? priorSummaries.slice(-1)
    : priorSummaries;
  const carryForwardSection = await buildCarryForwardSection(effectivePriorSummaries, base);

  // Inline project knowledge if available (smart-chunked for relevance)
  const knowledgeAbsPath = resolveGsdRootFile(base, "KNOWLEDGE");
  const knowledgeInlineET = existsSync(knowledgeAbsPath)
    ? await inlineFileSmart(
        knowledgeAbsPath,
        relGsdRootFile("KNOWLEDGE"),
        "Project Knowledge",
        `${tTitle} ${sTitle}`,  // use task + slice title as relevance query
      )
    : null;
  // Only include if it has content (not a "not found" result)
  const knowledgeContent = knowledgeInlineET && !knowledgeInlineET.includes("not found") ? knowledgeInlineET : null;

  // Knowledge graph: tight subgraph for this task (graceful — skipped if no graph.json)
  const graphBlockET = await inlineGraphSubgraph(base, `${tid} ${tTitle}`, { budget: 2000 });
  const decisionsOnDemandET = [
    "### On-demand Decisions Template",
    "",
    "If this task records a durable architecture or product decision, read `templates/decisions.md` before calling `capture_thought` or `gsd_decision_save`.",
  ].join("\n");

  const inlinedTemplates = inlineLevel === "minimal"
    ? inlineCompactTemplate("task-summary", "Task Summary")
    : [
        inlineTemplate("task-summary", "Task Summary"),
        decisionsOnDemandET,
        ...(knowledgeContent ? [knowledgeContent] : []),
        ...(graphBlockET ? [graphBlockET] : []),
      ].join("\n\n---\n\n");

  const taskSummaryPath = join(base, `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`);

  const activeOverrides = await loadActiveOverrides(base);
  const overridesSection = formatOverridesSection(activeOverrides);

  // Compute verification budget for the executor's context window (issue #707)
  const prefs = loadEffectiveGSDPreferences();
  const contextWindow = resolveExecutorContextWindow(opts.modelRegistry, prefs?.preferences, opts.sessionContextWindow, opts.sessionProvider);
  const budgets = computeBudgets(contextWindow, opts.sessionProvider as TokenProvider | undefined);
  const verificationBudget = `~${Math.round(budgets.verificationBudgetChars / 1000)}K chars`;

  // Truncate carry-forward section when it exceeds 40% of inline context budget.
  const carryForwardBudget = Math.floor(budgets.inlineContextBudgetChars * 0.4);
  let finalCarryForward = carryForwardSection;
  if (carryForwardSection.length > carryForwardBudget) {
    finalCarryForward = truncateAtSectionBoundary(carryForwardSection, carryForwardBudget).content;
  }
  trackPromptContext(
    contextTelemetry,
    "prior-task-summaries",
    finalCarryForward.trim() ? "excerpt" : "skipped",
    finalCarryForward,
    finalCarryForward.length < carryForwardSection.length ? `truncated from ${carryForwardSection.length} chars` : undefined,
  );

  // Inline RUNTIME.md if present
  const runtimePath = resolveRuntimeFile(base);
  const runtimeContent = existsSync(runtimePath) ? await loadFile(runtimePath) : null;
  const runtimeContext = runtimeContent
    ? `### Runtime Context\nSource: \`.gsd/RUNTIME.md\`\n\n${runtimeContent.trim()}`
    : "";
  trackPromptContext(contextTelemetry, "runtime", runtimeContext ? "inline" : "skipped", runtimeContext, runtimeContext ? undefined : "missing");

  let phaseAnchorSection = planAnchor ? formatAnchorForPrompt(planAnchor) : "";
  trackPromptContext(contextTelemetry, "plan-anchor", phaseAnchorSection ? "inline" : "skipped", phaseAnchorSection, phaseAnchorSection ? undefined : "missing");

  const recoveryContext = isDbAvailable()
    ? readPendingTaskRecoveryContext({ milestoneId: mid, sliceId: sid, taskId: tid })
    : null;
  if (recoveryContext) {
    const recoveryBlock = renderTaskRecoveryDispatchContext(recoveryContext);
    phaseAnchorSection = phaseAnchorSection
      ? `${recoveryBlock}\n\n---\n\n${phaseAnchorSection}`
      : recoveryBlock;
    trackPromptContext(contextTelemetry, "task-recovery", "inline", recoveryBlock);
  } else {
    trackPromptContext(contextTelemetry, "task-recovery", "skipped", null, "no pending recovery action");
  }

  // #1272: inject a pending reopen reason into this task's prompt. When a gate
  // (e.g. complete-slice's full-suite run) reopened the task via gsd_task_reopen
  // with a diagnosis, surface it here so the re-dispatched executor fixes the
  // regression instead of re-running the original (green) scoped verify. Claim
  // is one-shot (artifact deleted on read). Not feature-gated — a reopened task
  // must always know why. Prepended so it sits above the plan anchor.
  try {
    const { claimReopenReasonForInjection } = await import("./reopen-reason.js");
    const reopenClaimed = claimReopenReasonForInjection(base, mid, sid, tid);
    if (reopenClaimed) {
      const block = reopenClaimed.injectionBlock + "\n\n---\n\n";
      phaseAnchorSection = phaseAnchorSection
        ? `${block}${phaseAnchorSection}`
        : block;
      trackPromptContext(contextTelemetry, "reopen-reason", "inline", reopenClaimed.injectionBlock);
    }
  } catch (reopenErr) {
    logWarning("prompt", `reopen reason injection failed: ${(reopenErr as Error).message}`);
  }

  const reworkFindingsBlock = renderBlockingReworkFindingsBlock(mid, sid, tid);
  if (reworkFindingsBlock) {
    const block = reworkFindingsBlock + "\n\n---\n\n";
    phaseAnchorSection = phaseAnchorSection
      ? `${block}${phaseAnchorSection}`
      : block;
    trackPromptContext(contextTelemetry, "rework-findings", "inline", reworkFindingsBlock);
  }

  // ADR-011 Phase 2: inject any resolved-but-unapplied escalation override
  // into this task's prompt. Claim is atomic via DB UPDATE WHERE IS NULL, so
  // if a parallel build already injected it, we skip. Feature-gated by
  // phases.mid_execution_escalation. Prepended to phaseAnchorSection so it
  // appears near the top of the prompt above planning anchors.
  if (prefs?.preferences?.phases?.mid_execution_escalation === true) {
    try {
      const { claimOverrideForInjection } = await import("./escalation.js");
      const claimed = claimOverrideForInjection(base, mid, sid);
      if (claimed) {
        const block = claimed.injectionBlock + "\n\n---\n\n";
        phaseAnchorSection = phaseAnchorSection
          ? `${block}${phaseAnchorSection}`
          : block;
      }
    } catch (escalationErr) {
      // Escalation module unavailable or threw — log and proceed.
      logWarning("prompt", `escalation override injection failed: ${(escalationErr as Error).message}`);
    }
  }

  // Task-scoped gates owned by execute-task (Q5/Q6/Q7). Pull only the
  // gates that plan-slice actually seeded for this task — tasks with no
  // external dependencies legitimately skip Q5, tasks with no runtime
  // load dimension skip Q6, etc.
  const etPending = getPendingGatesForTurn(mid, sid, "execute-task", tid);
  assertGateCoverage(etPending, "execute-task", { requireAll: false });
  const gatesToClose = renderGatesToCloseBlock(
    getGatesForTurn("execute-task"),
    { pending: new Set(etPending.map((g) => g.gate_id)), allowOmit: true },
  );
  phaseAnchorSection = prependContextModeToBlock("execute-task", base, phaseAnchorSection, opts.contextModeRenderMode);
  trackPromptContext(contextTelemetry, "context-mode", phaseAnchorSection ? "inline" : "skipped", phaseAnchorSection, phaseAnchorSection ? undefined : "disabled or empty");
  trackPromptContext(contextTelemetry, "overrides", overridesSection ? "inline" : "skipped", overridesSection, overridesSection ? undefined : "none active");
  trackPromptContext(contextTelemetry, "gates", gatesToClose ? "inline" : "skipped", gatesToClose, gatesToClose ? undefined : "none pending");
  trackPromptContext(contextTelemetry, "knowledge", knowledgeContent ? "inline" : "skipped", knowledgeContent, knowledgeContent ? undefined : "missing");
  trackPromptContext(contextTelemetry, "graph-subgraph", graphBlockET ? "inline" : "skipped", graphBlockET, graphBlockET ? undefined : "missing");
  if (inlineLevel !== "minimal") {
    trackPromptContext(contextTelemetry, "decisions-template", "on-demand", decisionsOnDemandET);
  }
  trackPromptContext(contextTelemetry, "templates", "inline", inlinedTemplates, inlineLevel);

  const contextContract = requireUnitPromptContextContract("execute-task");
  const contractedContext = await composeContractedUnitContext(contextContract, {
    base: { unitType: "execute-task", basePath: base, milestoneId: mid, sliceId: sid, taskId: tid },
    resolveArtifact: async (key) => {
      switch (key) {
        case "task-plan":
          return taskPlanContext;
        case "slice-plan":
          return slicePlanContext;
        case "prior-task-summaries":
          return finalCarryForward;
        case "templates":
          return inlinedTemplates;
        default:
          return null;
      }
    },
  });
  const rawTaskPlanInline = requireComposedArtifactBlock(contractedContext.blocks, "execute-task", "task-plan");
  const rawSlicePlanExcerpt = requireComposedArtifactBlock(contractedContext.blocks, "execute-task", "slice-plan");
  const contractedCarryForward = requireComposedArtifactBlock(contractedContext.blocks, "execute-task", "prior-task-summaries");
  const rawContractedTemplates = requireComposedArtifactBlock(contractedContext.blocks, "execute-task", "templates");
  // Cap the static inline blocks against one shared budget so a small-window
  // executor can't overflow (the sibling builders cap via `capPreamble`;
  // execute-task's blocks feed separate template slots, so they share a budget
  // block-by-block). Carry-forward already has its own truncation above.
  const inlineBudget = Math.min(MAX_PREAMBLE_CHARS, budgets.inlineContextBudgetChars);
  const { taskPlan: taskPlanInline, slicePlan: slicePlanExcerpt, templates: contractedTemplates } =
    capExecuteTaskInlineBlocks(rawTaskPlanInline, rawSlicePlanExcerpt, rawContractedTemplates, inlineBudget);
  const inlineDropped = (rawTaskPlanInline.length + rawSlicePlanExcerpt.length + rawContractedTemplates.length)
    - (taskPlanInline.length + slicePlanExcerpt.length + contractedTemplates.length);
  trackPromptContext(
    contextTelemetry,
    "inline-cap",
    inlineDropped > 0 ? "excerpt" : "skipped",
    null,
    inlineDropped > 0 ? `dropped ${inlineDropped} chars (budget ${inlineBudget})` : "within budget",
  );
  const onDemandResult = renderExecuteTaskOnDemandContext(base, mid, sid, contractedContext.onDemand);
  const onDemandContext = onDemandResult.text;
  trackPromptContext(
    contextTelemetry,
    "slice-research",
    onDemandContext ? "on-demand" : "skipped",
    onDemandContext,
    onDemandContext ? undefined : onDemandResult.skipReason ?? undefined,
  );

  const prompt = loadPrompt("execute-task", {
    overridesSection,
    runtimeContext,
    phaseAnchorSection,
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle, taskId: tid, taskTitle: tTitle,
    planPath: join(base, relSliceFile(base, mid, sid, "PLAN")),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection: contractedCarryForward,
    resumeSection,
    priorTaskLines: priorLines,
    onDemandContext,
    taskSummaryPath,
    inlinedTemplates: contractedTemplates,
    verificationBudget,
    gatesToClose,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      taskId: tid,
      taskTitle: tTitle,
      taskPlanContent,
      extraContext: [taskPlanInline, slicePlanExcerpt, contractedCarryForward, resumeSection],
      unitType: "execute-task",
    }),
  });
  emitPromptContextTelemetry("execute-task", contextTelemetry, prompt);
  return prompt;
}

export async function buildCompleteSlicePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const contextTelemetry: PromptContextTelemetryEntry[] = [];

  // #4782 phase 3: complete-slice migrated through composer. Manifest
  // declares [roadmap, slice-context, slice-plan, requirements,
  // prior-task-summaries, templates]. Overrides prepend and knowledge
  // splice stay imperative — they need the composer v2 contract
  // (computed + prepend blocks; see RFC #4924).
  const resolveArtifact: ArtifactResolver = async (key) => {
    switch (key) {
      case "roadmap": {
        const p = resolveMilestoneFile(base, mid, "ROADMAP");
        const r = relMilestoneFile(base, mid, "ROADMAP");
        const body = await inlineFile(p, r, "Milestone Roadmap");
        trackPromptContext(contextTelemetry, "roadmap", "inline", body);
        return body;
      }
      case "slice-context": {
        const p = resolveSliceFile(base, mid, sid, "CONTEXT");
        const r = relSliceFile(base, mid, sid, "CONTEXT");
        const body = await inlineFileOptional(p, r, "Slice Context (from discussion)");
        trackPromptContext(contextTelemetry, "slice-context", body ? "inline" : "skipped", body, body ? undefined : "missing");
        return body;
      }
      case "slice-plan": {
        const p = resolveSliceFile(base, mid, sid, "PLAN");
        const r = relSliceFile(base, mid, sid, "PLAN");
        const body = await inlineFile(p, r, "Slice Plan");
        trackPromptContext(contextTelemetry, "slice-plan", "inline", body);
        return body;
      }
      case "requirements":
        if (inlineLevel === "minimal") {
          trackPromptContext(contextTelemetry, "requirements", "skipped", null, "minimal inline level");
          return null;
        }
        {
          const body = await inlineRequirementsFromDb(base, mid, sid, inlineLevel);
          trackPromptContext(contextTelemetry, "requirements", body ? "inline" : "skipped", body, body ? undefined : "missing");
          return body;
        }
      case "prior-task-summaries": {
        const loc = resolveTaskSummariesLocation(base, mid, sid);
        if (!loc) {
          trackPromptContext(contextTelemetry, "prior-task-summaries", "skipped", null, "missing tasks dir");
          return null;
        }
        const summaryFiles = resolveTaskFiles(loc.dir, "SUMMARY")
          .filter((file) => summaryFileBelongsToSlice(file, base, mid, sid))
          .sort();
        const blocks: string[] = [];
        for (const file of summaryFiles) {
          const absPath = join(loc.dir, file);
          const relPath = `${loc.relPrefix}/${file}`;
          const taskId = taskIdFromTaskFileName(file, "SUMMARY") ?? file.replace(/-SUMMARY\.md$/i, "");
          blocks.push(await buildTaskSummaryExcerpt(absPath, relPath, taskId));
        }
        const body = blocks.length > 0 ? blocks.join("\n\n---\n\n") : null;
        trackPromptContext(contextTelemetry, "prior-task-summaries", body ? "excerpt" : "skipped", body, body ? undefined : "missing");
        return body;
      }
      case "templates": {
        const parts = [inlineLevel === "minimal"
          ? inlineCompactTemplate("slice-summary", "Slice Summary")
          : inlineTemplate("slice-summary", "Slice Summary")];
        if (inlineLevel !== "minimal") {
          parts.push(inlineTemplate("uat", "UAT"));
        }
        const body = parts.join("\n\n---\n\n");
        trackPromptContext(contextTelemetry, "templates", "inline", body);
        return body;
      }
      default:
        return null;
    }
  };

  const composed = await composeInlinedContext("complete-slice", resolveArtifact);

  // Knowledge splices in between requirements and prior-task-summaries
  // so overall order matches pre-migration: roadmap → slice-context →
  // slice-plan → requirements → KNOWLEDGE → task summaries → templates.
  const knowledgeInlineCS = await inlineKnowledgeBudgeted(
    base,
    [...extractKeywords(midTitle), ...extractKeywords(sTitle)],
  );
  if (knowledgeInlineCS) {
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInlineCS);
  } else {
    trackPromptContext(contextTelemetry, "knowledge", "skipped", null, "missing");
  }

  let body = composed;
  if (knowledgeInlineCS && body) {
    // Splice knowledge right before the first "### Task Summary:" block
    // to preserve pre-migration ordering. If no task summaries exist,
    // splice before the templates block (which inlineTemplate emits as
    // "### Output Template: Slice Summary").
    const taskIdx = body.indexOf("### Task Summary:");
    const templatesIdx = body.lastIndexOf("### Output Template: Slice Summary");
    const spliceIdx = taskIdx > -1 ? taskIdx : templatesIdx;
    if (spliceIdx > 0) {
      const before = body.slice(0, spliceIdx).replace(/\n\n---\n\n$/, "");
      const after = body.slice(spliceIdx);
      body = [before, knowledgeInlineCS, after].join("\n\n---\n\n");
    } else {
      body = `${body}\n\n---\n\n${knowledgeInlineCS}`;
    }
  }

  const webAppUatGuidance = buildWebAppUatGuidanceBlock(base);
  if (webAppUatGuidance && body) {
    body = `${webAppUatGuidance}\n\n---\n\n${body}`;
    trackPromptContext(contextTelemetry, "web-app-uat", "inline", webAppUatGuidance);
  } else {
    trackPromptContext(contextTelemetry, "web-app-uat", "skipped", null, webAppUatGuidance ? "missing composed body" : "not a web app");
  }

  // Overrides section prepends to the top of the inlined context —
  // standard pattern for slice-level builders (until composer v2 lands
  // the prepend contract).
  const completeActiveOverrides = await loadActiveOverrides(base);
  const completeOverridesInline = formatOverridesSection(completeActiveOverrides);
  if (completeOverridesInline) {
    trackPromptContext(contextTelemetry, "overrides", "inline", completeOverridesInline);
  } else {
    trackPromptContext(contextTelemetry, "overrides", "skipped", null, "none active");
  }
  const finalBody = completeOverridesInline
    ? `${completeOverridesInline}\n\n---\n\n${body}`
    : body;

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${finalBody}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "complete-slice",
    base,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("complete-slice", contextTelemetry, inlinedContext);
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const sliceRel = relSlicePath(base, mid, sid);
  const sliceSummaryPath = join(base, `${sliceRel}/${sid}-SUMMARY.md`);
  const sliceUatPath = join(base, `${sliceRel}/${sid}-UAT.md`);

  // Gates owned by complete-slice (e.g. Q8). Pull from the DB so the
  // prompt only prompts for gates the plan actually seeded. The tool
  // handler closes each gate based on the SUMMARY.md section content
  // after the assistant calls gsd_complete_slice.
  const csPending = getPendingGatesForTurn(mid, sid, "complete-slice");
  // coverage check: every pending row must be owned by complete-slice.
  // requireAll:false because a slice may have already closed some gates.
  assertGateCoverage(csPending, "complete-slice", { requireAll: false });
  const gatesToClose = renderGatesToCloseBlock(
    getGatesForTurn("complete-slice"),
    { pending: new Set(csPending.map((g) => g.gate_id)), allowOmit: true },
  );

  return loadPrompt("complete-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: sliceRel,
    roadmapPath: join(base, roadmapRel),
    inlinedContext,
    sliceSummaryPath,
    sliceUatPath,
    gatesToClose,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext],
      unitType: "complete-slice",
    }),
  });
}

export async function buildCompleteMilestonePrompt(
  mid: string, midTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const validationPath = resolveMilestoneFile(base, mid, "VALIDATION");
  const validationRel = relMilestoneFile(base, mid, "VALIDATION");
  const validationContent = validationPath ? await loadFile(validationPath) : null;

  const inlined: string[] = [];
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  const roadmapInline = await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap");
  inlined.push(roadmapInline);
  trackPromptContext(contextTelemetry, "roadmap", "inline", roadmapInline);

  // Inline all slice summaries (deduplicated by slice ID)
  let sliceIds: string[] = [];
  try {
    if (isDbAvailable()) {
      sliceIds = getMilestoneSlices(mid)
        .filter(s => s.status !== "skipped")
        .map(s => s.id);
    }
  } catch (err) {
    logWarning("prompt", `buildCompleteMilestonePrompt DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const seenSlices = new Set<string>();
  const summaryRelPaths: string[] = [];
  for (const sid of sliceIds) {
    if (seenSlices.has(sid)) continue;
    seenSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    summaryRelPaths.push(summaryRel);
    // Compact excerpt instead of full inline (#4780). Closer Reads the
    // full file on-demand when synthesizing LEARNINGS narrative.
    const summaryExcerpt = await buildSliceSummaryExcerpt(summaryPath, summaryRel, sid);
    inlined.push(summaryExcerpt);
    trackPromptContext(contextTelemetry, "slice-summary", "excerpt", summaryExcerpt);
  }
  if (summaryRelPaths.length > 0) {
    const pathList = summaryRelPaths.map(p => `- \`${p}\``).join("\n");
    const onDemandSummaries = `### On-demand Slice Summaries\n\nExcerpted above. Read the full file for any slice when the excerpt's section heads don't carry enough narrative for the milestone summary you're drafting:\n\n${pathList}`;
    inlined.push(onDemandSummaries);
    trackPromptContext(contextTelemetry, "slice-summary", "on-demand", onDemandSummaries);
  }
  const validationContext = [
    formatCloseoutReviewInstructions(validationContent, validationRel, [validationRel, roadmapRel, ...summaryRelPaths]),
  ];
  trackPromptContext(contextTelemetry, "validation-review-instructions", "inline", validationContext[0]);
  if (validationContent) {
    const validationInline = `### Milestone Validation\nSource: \`${validationRel}\`\n\n${validationContent.trim()}`;
    validationContext.push(validationInline);
    trackPromptContext(contextTelemetry, "milestone-validation", "inline", validationInline);
  } else {
    trackPromptContext(contextTelemetry, "milestone-validation", "skipped", null, "missing");
  }
  inlined.unshift(...validationContext);

  // Inline compact requirement facts for standard closeout. Broader narrative
  // docs stay on-demand unless the caller explicitly asks for full context.
  if (inlineLevel === "full") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, undefined, inlineLevel);
    if (requirementsInline) {
      inlined.push(requirementsInline);
      trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
    }
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) {
      inlined.push(decisionsInline);
      trackPromptContext(contextTelemetry, "decisions", "inline", decisionsInline);
    }
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) {
      inlined.push(projectInline);
      trackPromptContext(contextTelemetry, "project", "inline", projectInline);
    }
  } else if (inlineLevel === "standard") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, undefined, inlineLevel);
    if (requirementsInline) {
      inlined.push(requirementsInline);
      trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
    }
    const decisionsOnDemand = onDemandDecisionsBlock("the slice summaries or validation artifact reference a decision that must be re-evaluated before closeout");
    inlined.push(decisionsOnDemand);
    trackPromptContext(contextTelemetry, "decisions", "on-demand", decisionsOnDemand);
    const projectOnDemand = onDemandProjectBlock("the milestone summary needs product/domain wording that is not present in the roadmap, validation artifact, or slice summaries");
    inlined.push(projectOnDemand);
    trackPromptContext(contextTelemetry, "project", "on-demand", projectOnDemand);
  } else {
    trackPromptContext(contextTelemetry, "requirements", "skipped", null, "minimal inline level");
    const decisionsOnDemand = onDemandDecisionsBlock("the closeout cannot be completed from the roadmap and slice summaries alone");
    inlined.push(decisionsOnDemand);
    trackPromptContext(contextTelemetry, "decisions", "on-demand", decisionsOnDemand);
    const projectOnDemand = onDemandProjectBlock("the closeout cannot be completed from the roadmap and slice summaries alone");
    inlined.push(projectOnDemand);
    trackPromptContext(contextTelemetry, "project", "on-demand", projectOnDemand);
  }
  // Scoped + budgeted — see issue #4719
  const knowledgeInlineCM = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInlineCM) {
    inlined.push(knowledgeInlineCM);
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInlineCM);
  }
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = inlineLevel === "full"
    ? await inlineFileOptional(contextPath, contextRel, "Milestone Context")
    : null;
  if (contextInline) {
    inlined.push(contextInline);
    trackPromptContext(contextTelemetry, "milestone-context", "inline", contextInline);
  } else if (contextPath) {
    const contextOnDemand = onDemandMilestoneContextBlock(contextRel, "the roadmap, validation artifact, and slice summaries do not explain the milestone's intent clearly enough");
    inlined.push(contextOnDemand);
    trackPromptContext(contextTelemetry, "milestone-context", "on-demand", contextOnDemand);
  } else {
    trackPromptContext(contextTelemetry, "milestone-context", "skipped", null, "missing");
  }
  const templateInline = inlineTemplate("milestone-summary", "Milestone Summary");
  inlined.push(templateInline);
  trackPromptContext(contextTelemetry, "templates", "inline", templateInline);

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "complete-milestone",
    base,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("complete-milestone", contextTelemetry, inlinedContext);

  // Use relMilestoneFile to get the layout-aware filename (NN-SUFFIX.md for flat-phase,
  // M001-SUFFIX.md for legacy) rather than manually appending the raw milestone id.
  const milestoneSummaryPath = join(base, relMilestoneFile(base, mid, "SUMMARY"));

  const learningsRelPath = relMilestoneFile(base, mid, "LEARNINGS");
  const learningsAbsPath = join(base, learningsRelPath);
  const extractLearningsSteps = buildExtractionStepsBlock({
    milestoneId: mid,
    outputPath: learningsAbsPath,
    relativeOutputPath: learningsRelPath,
  });

  return loadPrompt("complete-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
    extractLearningsSteps,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "complete-milestone",
    }),
  });
}

export async function buildValidateMilestonePrompt(
  mid: string, midTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const inlined: string[] = [];
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  const roadmapInline = await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap");
  inlined.push(roadmapInline);
  trackPromptContext(contextTelemetry, "roadmap", "inline", roadmapInline);

  // Inline verification classes from planning (if available in DB)
  try {
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone) {
        const escapeCell = (value: string) =>
          value.replace(/[\\|]/g, (char) => `\\${char}`).replace(/\r?\n/g, " ");
        const classes: string[] = [];
        if (milestone.verification_contract) classes.push(`| Contract | ${escapeCell(milestone.verification_contract)} |`);
        if (milestone.verification_integration) classes.push(`| Integration | ${escapeCell(milestone.verification_integration)} |`);
        if (milestone.verification_operational) classes.push(`| Operational | ${escapeCell(milestone.verification_operational)} |`);
        if (milestone.verification_uat) classes.push(`| UAT | ${escapeCell(milestone.verification_uat)} |`);
        if (classes.length > 0) {
          const verificationClasses = [
            "### Verification Classes (from planning)",
            "",
            "These verification tiers were defined during milestone planning. Every row in this table must appear in `verificationClasses` with the same canonical class name.",
            "",
            "| Class | Planned Check |",
            "| --- | --- |",
            ...classes,
          ].join("\n");
          inlined.push(verificationClasses);
          trackPromptContext(contextTelemetry, "verification-classes", "inline", verificationClasses);
        }
      }
    }
  } catch (err) {
    logWarning("prompt", `buildValidateMilestonePrompt verification classes lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate from compact slice evidence first. Full slice summaries and
  // assessments stay on-demand so milestone validation does not rehydrate the
  // whole milestone on every closeout pass.
  let valSliceIds: string[] = [];
  try {
    if (isDbAvailable()) {
      valSliceIds = getMilestoneSlices(mid)
        .filter(s => s.status !== "skipped")
        .map(s => s.id);
    }
  } catch (err) {
    logWarning("prompt", `buildValidateMilestonePrompt slice IDs lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const seenValSlices = new Set<string>();
  const onDemandValidationPaths: string[] = [];
  for (const sid of valSliceIds) {
    if (seenValSlices.has(sid)) continue;
    seenValSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    const summaryExcerpt = await buildSliceSummaryExcerpt(summaryPath, summaryRel, sid);
    inlined.push(summaryExcerpt);
    onDemandValidationPaths.push(summaryRel);
    trackPromptContext(contextTelemetry, "slice-summary", "excerpt", summaryExcerpt);

    const assessmentPath = resolveSliceFile(base, mid, sid, "ASSESSMENT");
    const assessmentRel = relSliceFile(base, mid, sid, "ASSESSMENT");
    const assessmentExcerpt = await buildSliceAssessmentExcerpt(assessmentPath, assessmentRel, sid);
    if (assessmentExcerpt) {
      inlined.push(assessmentExcerpt);
      trackPromptContext(contextTelemetry, "slice-assessment", "excerpt", assessmentExcerpt);
    } else {
      trackPromptContext(contextTelemetry, "slice-assessment", "skipped", null, "missing");
    }
    onDemandValidationPaths.push(assessmentRel);
  }
  if (onDemandValidationPaths.length > 0) {
    const pathList = onDemandValidationPaths.map(p => `- \`${p}\``).join("\n");
    const onDemandBlock = [
      "### On-demand Validation Artifacts",
      "",
      "Slice summaries and assessments are excerpted above. Read full files only when an excerpt is missing, truncated, or internally inconsistent with validation evidence:",
      "",
      pathList,
    ].join("\n");
    inlined.push(onDemandBlock);
    trackPromptContext(contextTelemetry, "slice-summary,slice-assessment", "on-demand", onDemandBlock);
  }

  // Aggregate unresolved follow-ups and known limitations across slices
  const outstandingItems: string[] = [];
  for (const sid of valSliceIds) {
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    if (!summaryPath) continue;
    const content = await loadFile(summaryPath);
    if (!content) continue;
    const summary = parseSummary(content);
    if (summary.followUps) outstandingItems.push(`- **${sid} Follow-ups:** ${summary.followUps.trim()}`);
    if (summary.knownLimitations) outstandingItems.push(`- **${sid} Known Limitations:** ${summary.knownLimitations.trim()}`);
  }
  if (outstandingItems.length > 0) {
    const outstandingBlock = `### Outstanding Items (aggregated from slice summaries)\n\nThese follow-ups and known limitations were documented during slice completion but have not been resolved.\n\n${outstandingItems.join('\n')}`;
    inlined.push(outstandingBlock);
    trackPromptContext(contextTelemetry, "outstanding-items", "inline", outstandingBlock);
  }

  const persistedGateFlags: string[] = [];
  try {
    const gateLabels = {
      Q3: "Threat Surface",
      Q4: "Requirement Impact",
    } as const;
    for (const sid of seenValSlices) {
      for (const gate of getGateResults(mid, sid, "slice")) {
        if (gate.gate_id !== "Q3" && gate.gate_id !== "Q4") continue;
        const findings = gate.findings.trim();
        const rationale = gate.rationale.trim();
        const verdict = gate.verdict ?? "";
        const hasNonPassVerdict = verdict !== "" && verdict !== "pass" && verdict !== "omitted";
        if (!findings && !hasNonPassVerdict) continue;

        const displayVerdict = verdict || gate.status;
        const detail = findings || rationale || "_No findings text recorded; reconcile the persisted non-pass verdict._";
        persistedGateFlags.push(`- **${sid} / ${gate.gate_id} (${gateLabels[gate.gate_id]}) / ${displayVerdict}:** ${detail}`);
        if (findings && rationale) persistedGateFlags.push(`  - Rationale: ${rationale}`);
      }
    }
  } catch (err) {
    logWarning("prompt", `buildValidateMilestonePrompt persisted gate flags lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (persistedGateFlags.length > 0) {
    const persistedGateFlagsBlock = [
      "### Persisted Slice-Level Gate Flags (from quality_gates)",
      "",
      "These slice gates recorded findings or non-pass verdicts during execution. Reconcile each against the milestone-level evidence before returning MV03/MV04 verdicts.",
      "",
      ...persistedGateFlags,
    ].join("\n");
    inlined.push(persistedGateFlagsBlock);
    trackPromptContext(contextTelemetry, "persisted-slice-gate-flags", "inline", persistedGateFlagsBlock);
  } else {
    trackPromptContext(contextTelemetry, "persisted-slice-gate-flags", "skipped", null, "none");
  }

  // Inline existing VALIDATION file if this is a re-validation round
  const validationPath = resolveMilestoneFile(base, mid, "VALIDATION");
  const validationRel = relMilestoneFile(base, mid, "VALIDATION");
  const validationContent = validationPath ? await loadFile(validationPath) : null;
  let remediationRound = 0;
  if (validationContent) {
    const roundMatch = validationContent.match(/remediation_round:\s*(\d+)/);
    remediationRound = roundMatch ? parseInt(roundMatch[1], 10) + 1 : 1;
    const previousValidation = `### Previous Validation (re-validation round ${remediationRound})\nSource: \`${validationRel}\`\n\n${validationContent.trim()}`;
    inlined.push(previousValidation);
    trackPromptContext(contextTelemetry, "milestone-validation", "inline", previousValidation);
  } else {
    trackPromptContext(contextTelemetry, "milestone-validation", "skipped", null, "missing");
  }

  // Validation keeps compact requirements inline, but broad narrative docs are
  // on-demand in standard mode to avoid rehydrating full project context.
  if (inlineLevel === "full") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, undefined, inlineLevel);
    if (requirementsInline) {
      inlined.push(requirementsInline);
      trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
    }
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) {
      inlined.push(decisionsInline);
      trackPromptContext(contextTelemetry, "decisions", "inline", decisionsInline);
    }
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) {
      inlined.push(projectInline);
      trackPromptContext(contextTelemetry, "project", "inline", projectInline);
    }
  } else if (inlineLevel === "standard") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, undefined, inlineLevel);
    if (requirementsInline) {
      inlined.push(requirementsInline);
      trackPromptContext(contextTelemetry, "requirements", "inline", requirementsInline);
    }
    const decisionsOnDemand = onDemandDecisionsBlock("a validation finding conflicts with an existing architectural decision");
    inlined.push(decisionsOnDemand);
    trackPromptContext(contextTelemetry, "decisions", "on-demand", decisionsOnDemand);
    const projectOnDemand = onDemandProjectBlock("validation evidence needs product/domain context that is not present in the roadmap or slice artifacts");
    inlined.push(projectOnDemand);
    trackPromptContext(contextTelemetry, "project", "on-demand", projectOnDemand);
  } else {
    trackPromptContext(contextTelemetry, "requirements", "skipped", null, "minimal inline level");
    const decisionsOnDemand = onDemandDecisionsBlock("validation cannot determine the correct verdict from milestone artifacts alone");
    inlined.push(decisionsOnDemand);
    trackPromptContext(contextTelemetry, "decisions", "on-demand", decisionsOnDemand);
    const projectOnDemand = onDemandProjectBlock("validation cannot determine the correct verdict from milestone artifacts alone");
    inlined.push(projectOnDemand);
    trackPromptContext(contextTelemetry, "project", "on-demand", projectOnDemand);
  }
  // Scoped + budgeted — see issue #4719
  const knowledgeInline = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInline) {
    inlined.push(knowledgeInline);
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInline);
  }
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = inlineLevel === "full"
    ? await inlineFileOptional(contextPath, contextRel, "Milestone Context")
    : null;
  if (contextInline) {
    inlined.push(contextInline);
    trackPromptContext(contextTelemetry, "milestone-context", "inline", contextInline);
  } else if (contextPath) {
    const contextOnDemand = onDemandMilestoneContextBlock(contextRel, "the roadmap and slice artifacts do not explain the intended outcome clearly enough");
    inlined.push(contextOnDemand);
    trackPromptContext(contextTelemetry, "milestone-context", "on-demand", contextOnDemand);
  } else {
    trackPromptContext(contextTelemetry, "milestone-context", "skipped", null, "missing");
  }

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "validate-milestone",
    base,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("validate-milestone", contextTelemetry, inlinedContext);

  // Use relMilestoneFile for layout-aware filenames (NN-SUFFIX.md flat-phase, M001-SUFFIX.md legacy).
  const validationOutputPath = join(base, relMilestoneFile(base, mid, "VALIDATION"));
  const roadmapOutputPath = relMilestoneFile(base, mid, "ROADMAP");

  // Every milestone validation turn owns MV01–MV04 unconditionally: the
  // registry is the source of truth for which gates the validator must
  // address, and the block below is what the template renders so the
  // assistant can never accidentally skip one.
  const mvGates = getGatesForTurn("validate-milestone");
  const gatesToEvaluate = renderGatesToCloseBlock(mvGates, {
    pending: new Set(mvGates.map((g) => g.id)),
    allowOmit: false,
  });

  return loadPrompt("validate-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapOutputPath,
    inlinedContext,
    validationPath: validationOutputPath,
    remediationRound: String(remediationRound),
    gatesToEvaluate,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "validate-milestone",
    }),
  });
}

export async function buildReplanSlicePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");
  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) inlined.push(sliceCtxInline);
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Current Slice Plan"));

  // Find the blocker task summary — the completed task with blocker_discovered: true
  let blockerTaskId = "";
  const summaryLoc = resolveTaskSummariesLocation(base, mid, sid);
  if (summaryLoc) {
    const summaryFiles = resolveTaskFiles(summaryLoc.dir, "SUMMARY")
      .filter((file) => summaryFileBelongsToSlice(file, base, mid, sid))
      .sort();
    for (const file of summaryFiles) {
      const absPath = join(summaryLoc.dir, file);
      const content = await loadFile(absPath);
      if (!content) continue;
      const summary = parseSummary(content);
      const relPath = `${summaryLoc.relPrefix}/${file}`;
      if (summary.frontmatter.blocker_discovered) {
        blockerTaskId = summary.frontmatter.id || taskIdFromTaskFileName(file, "SUMMARY") || file.replace(/-SUMMARY\.md$/i, "");
        inlined.push(await buildTaskSummaryExcerpt(absPath, relPath, blockerTaskId, { blocker: true }));
      }
    }
  }

  // Inline decisions
  const decisionsInline = await inlineDecisionsFromDb(base, mid);
  if (decisionsInline) inlined.push(decisionsInline);
  const replanActiveOverrides = await loadActiveOverrides(base);
  const replanOverridesInline = formatOverridesSection(replanActiveOverrides);
  if (replanOverridesInline) inlined.unshift(replanOverridesInline);

  const inlinedContext = prependContextModeToBlock(
    "replan-slice",
    base,
    capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`),
  );

  const replanPath = join(base, relSliceFile(base, mid, sid, "REPLAN"));

  // Build capture context for replan prompt (captures that triggered this replan)
  let captureContext = "(none)";
  try {
    const { loadReplanCaptures } = await import("./triage-resolution.js");
    const replanCaptures = loadReplanCaptures(base);
    if (replanCaptures.length > 0) {
      captureContext = replanCaptures.map(c =>
        `- **${c.id}**: "${c.text}" — ${c.rationale ?? "no rationale"}`
      ).join("\n");
    }
  } catch (err) {
    logWarning("prompt", `loadReplanCaptures failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return loadPrompt("replan-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: join(base, slicePlanRel),
    blockerTaskId,
    inlinedContext,
    replanPath,
    captureContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, captureContext],
      unitType: "replan-slice",
    }),
  });
}

export async function buildRunUatPrompt(
  mid: string, sliceId: string, uatPath: string, uatContent: string, base: string,
): Promise<string> {
  // Run-UAT keeps only the UAT body inline. Prior slice/project context is
  // compact or on-demand so validation does not pay for full closeout context.
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  const resolveArtifact: ArtifactResolver = async (key) => {
    switch (key) {
      case "slice-uat": {
        // Use the in-memory snapshot the caller already loaded (#4925 review).
        // Re-reading from disk via inlineFile(p, uatPath, ...) would risk
        // drift between the inlined body and uatType (computed from
        // uatContent below) if the file changes mid-dispatch.
        const trimmed = uatContent.trim();
        if (!trimmed) {
          const body = `### ${sliceId} UAT\nSource: \`${uatPath}\`\n\n_(not found — file does not exist yet)_`;
          trackPromptContext(contextTelemetry, "slice-uat", "inline", body);
          return body;
        }
        const body = `### ${sliceId} UAT\nSource: \`${uatPath}\`\n\n${trimmed}`;
        trackPromptContext(contextTelemetry, "slice-uat", "inline", body);
        return body;
      }
      case "slice-summary": {
        trackPromptContext(contextTelemetry, "slice-summary", "skipped", null, "handled by excerpt resolver");
        return null;
      }
      case "project": {
        trackPromptContext(contextTelemetry, "project", "skipped", null, "handled as on-demand path");
        return null;
      }
      default:
        return null;
    }
  };
  const resolveExcerpt: ExcerptResolver = async (key) => {
    switch (key) {
      case "slice-summary": {
        const p = resolveSliceFile(base, mid, sliceId, "SUMMARY");
        const r = relSliceFile(base, mid, sliceId, "SUMMARY");
        if (!p) {
          trackPromptContext(contextTelemetry, "slice-summary", "skipped", null, "missing");
          return null;
        }
        const body = await buildSliceSummaryExcerpt(p, r, sliceId);
        trackPromptContext(contextTelemetry, "slice-summary", "excerpt", body);
        return body;
      }
      default:
        return null;
    }
  };

  const composed = await composeUnitContext("run-uat", {
    base: { unitType: "run-uat", basePath: base, milestoneId: mid, sliceId },
    resolveArtifact,
    resolveExcerpt,
  });
  const parts: string[] = [];
  if (composed.prepend) parts.push(composed.prepend);
  if (composed.inline) parts.push(composed.inline);
  const projectOnDemand = [
    "### On-demand Project Context",
    "",
    `Project context is available at \`${relGsdRootFile("PROJECT")}\`. Read it only if the UAT spec or slice summary lacks enough product/domain context to assess the scenario.`,
  ].join("\n");
  parts.push(projectOnDemand);
  trackPromptContext(contextTelemetry, "project", "on-demand", projectOnDemand);
  const composedBody = parts.join("\n\n---\n\n");
  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${composedBody}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const uatPolicy = classifyUatContentForRun(uatContent, cappedInlinedContext);
  const uatType = uatPolicy.effectiveType;
  const runtimeHarnessOverride = uatPolicy.declaredType === "browser-executable" && uatType === "runtime-executable"
    ? [
      "## Runtime harness override",
      "",
      "This UAT declares `browser-executable` but the slice references a self-contained verification command (`npm run test:uat`, `search-uat.mjs`, or similar).",
      "Run **only** that command via `gsd_uat_exec` with `uat-runtime-check` intent.",
      "Do **not** call `uat-service-start`, do **not** run `npm run start`, `npm run test:server`, or any separate server command.",
      "Do **not** use `browser_navigate` or other `browser_*` tools — the harness already exercises the browser.",
      "When the harness exits 0, save **PASS** with `uatType: \"runtime-executable\"` (the effective mode above, not the UAT file header) and **runtime** check modes only.",
      "",
    ].join("\n")
    : "";
  const inlinedContext = prependContextModeToBlock(
    "run-uat",
    base,
    runtimeHarnessOverride
      ? `${runtimeHarnessOverride}\n${cappedInlinedContext}`
      : cappedInlinedContext,
  );
  emitPromptContextTelemetry("run-uat", contextTelemetry, inlinedContext);

  const uatResultPath = join(base, relSliceFile(base, mid, sliceId, "ASSESSMENT"));
  const canonicalPresentation = JSON.stringify(buildRunUatPresentationForType(uatType), null, 2);

  return loadPrompt("run-uat", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultPath,
    uatType,
    toolPresentationPlanId: RUN_UAT_TOOL_PRESENTATION_PLAN_ID,
    canonicalPresentation,
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId,
      extraContext: [inlinedContext],
      unitType: "run-uat",
    }),
  });
}

export async function buildReassessRoadmapPrompt(
  mid: string, midTitle: string, completedSliceId: string, base: string, level?: InlineLevel,
): Promise<string> {
  void level;
  const contextTelemetry: PromptContextTelemetryEntry[] = [];

  // Reassess-roadmap runs between slices, so keep only the roadmap and
  // completed-slice evidence in prompt. Broader project docs stay on-demand.
  const resolveArtifact: ArtifactResolver = async (key) => {
    switch (key) {
      case "roadmap": {
        const p = resolveMilestoneFile(base, mid, "ROADMAP");
        const r = relMilestoneFile(base, mid, "ROADMAP");
        const body = await inlineFile(p, r, "Current Roadmap");
        trackPromptContext(contextTelemetry, "roadmap", "inline", body);
        return body;
      }
      case "slice-context": {
        const p = resolveSliceFile(base, mid, completedSliceId, "CONTEXT");
        const r = relSliceFile(base, mid, completedSliceId, "CONTEXT");
        const body = await inlineFileOptional(p, r, "Slice Context (from discussion)");
        trackPromptContext(contextTelemetry, "slice-context", body ? "inline" : "skipped", body, body ? undefined : "missing");
        return body;
      }
      case "slice-summary": {
        trackPromptContext(contextTelemetry, "slice-summary", "skipped", null, "handled by excerpt resolver");
        return null;
      }
      case "project":
      case "requirements":
      case "decisions":
        trackPromptContext(contextTelemetry, key, "skipped", null, "handled as on-demand path");
        return null;
      default:
        return null;
    }
  };
  const resolveExcerpt: ExcerptResolver = async (key) => {
    switch (key) {
      case "slice-summary": {
        const p = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
        const r = relSliceFile(base, mid, completedSliceId, "SUMMARY");
        const body = await buildSliceSummaryExcerpt(p, r, completedSliceId);
        trackPromptContext(contextTelemetry, "slice-summary", "excerpt", body);
        return body;
      }
      default:
        return null;
    }
  };

  const composed = await composeUnitContext("reassess-roadmap", {
    base: { unitType: "reassess-roadmap", basePath: base, milestoneId: mid, sliceId: completedSliceId },
    resolveArtifact,
    resolveExcerpt,
  });
  const parts: string[] = [];
  if (composed.prepend) parts.push(composed.prepend);
  if (composed.inline) parts.push(composed.inline);
  const onDemandDocs = [
    "### On-demand Planning Context",
    "",
    "Broader project context is available if the roadmap update needs it. Read only the specific source that answers the reassessment question:",
    "",
    `- \`${relGsdRootFile("PROJECT")}\` — product/project narrative`,
    `- \`${relGsdRootFile("REQUIREMENTS")}\` — requirement status and acceptance criteria`,
    `- \`${relGsdRootFile("DECISIONS")}\` — active architecture/product decisions`,
  ].join("\n");
  parts.push(onDemandDocs);
  trackPromptContext(contextTelemetry, "project,requirements,decisions", "on-demand", onDemandDocs);
  // Knowledge block stays outside the composer — budgeted, scoped via
  // keyword extraction (#4719). Future phase folds it in.
  const knowledgeInlineRA = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInlineRA) {
    parts.push(knowledgeInlineRA);
    trackPromptContext(contextTelemetry, "knowledge", "inline", knowledgeInlineRA);
  } else {
    trackPromptContext(contextTelemetry, "knowledge", "skipped", null, "missing");
  }

  const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${parts.join("\n\n---\n\n")}`;
  const cappedInlinedContext = capPreamble(rawInlinedContext);
  trackPromptContext(
    contextTelemetry,
    "cap",
    cappedInlinedContext.length < rawInlinedContext.length ? "skipped" : "inline",
    null,
    cappedInlinedContext.length < rawInlinedContext.length ? `dropped ${rawInlinedContext.length - cappedInlinedContext.length} chars` : "within budget",
  );
  const inlinedContext = prependContextModeToBlock(
    "reassess-roadmap",
    base,
    cappedInlinedContext,
  );
  emitPromptContextTelemetry("reassess-roadmap", contextTelemetry, inlinedContext);

  const assessmentPath = join(base, relSliceFile(base, mid, completedSliceId, "ASSESSMENT"));

  // Build deferred captures context for reassess prompt
  let deferredCaptures = "(none)";
  try {
    const { loadDeferredCaptures } = await import("./triage-resolution.js");
    const deferred = loadDeferredCaptures(base);
    if (deferred.length > 0) {
      deferredCaptures = deferred.map(c =>
        `- **${c.id}**: "${c.text}" — ${c.rationale ?? "deferred during triage"}`
      ).join("\n");
    }
  } catch (err) {
    logWarning("prompt", `loadDeferredCaptures failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const reassessCommitInstruction = "Do not commit — .gsd/ planning docs are managed externally and not tracked in git.";

  return loadPrompt("reassess-roadmap", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: relMilestoneFile(base, mid, "ROADMAP"),
    assessmentPath,
    inlinedContext,
    deferredCaptures,
    commitInstruction: reassessCommitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext, deferredCaptures],
      unitType: "reassess-roadmap",
    }),
  });
}

// ─── Reactive Execute Prompt ──────────────────────────────────────────────

/**
 * Build the `with model: "…" and thinking: "…"` suffix injected into a prompt
 * that instructs the coordinator how to dispatch a `subagent` call. Either or
 * both may be absent (ADR-026 / #508).
 */
function subagentCallSuffix(model?: string, thinking?: string, fallbacks?: string[]): string {
  const parts: string[] = [];
  if (model) {
    let modelHint = `model: "${model}"`;
    if (fallbacks && fallbacks.length > 0) {
      modelHint += ` (fallbacks, in order: ${fallbacks.map((f) => `"${f}"`).join(", ")})`;
    }
    parts.push(modelHint);
  }
  if (thinking) parts.push(`thinking: "${thinking}"`);
  return parts.length > 0 ? ` with ${parts.join(" and ")}` : "";
}

export async function buildReactiveExecutePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string,
  readyTaskIds: string[], base: string,
  subagentModel?: string,
  // Reasoning effort travels inside opts here (not as a positional param) so
  // existing positional `opts` callers don't shift (#508).
  opts?: {
    sessionContextWindow?: number;
    modelRegistry?: MinimalModelRegistry;
    sessionProvider?: string;
    subagentThinking?: string;
    subagentModelFallbacks?: string[];
  },
): Promise<string> {
  const { loadSliceTaskIO, deriveTaskGraph, graphMetrics } = await import("./reactive-graph.js");

  // Build graph for context
  const taskIO = await loadSliceTaskIO(base, mid, sid);
  const graph = deriveTaskGraph(taskIO);
  const metrics = graphMetrics(graph);

  // Build graph context section
  const graphLines: string[] = [];
  for (const node of graph) {
    const status = node.done ? "✅ done" : readyTaskIds.includes(node.id) ? "🟢 ready" : "⏳ waiting";
    const deps = node.dependsOn.length > 0 ? ` (depends on: ${node.dependsOn.join(", ")})` : "";
    graphLines.push(`- **${node.id}: ${node.title}** — ${status}${deps}`);
    if (node.outputFiles.length > 0) {
      graphLines.push(`  - Outputs: ${node.outputFiles.map(f => `\`${f}\``).join(", ")}`);
    }
  }
  const graphContext = [
    `Tasks: ${metrics.taskCount}, Edges: ${metrics.edgeCount}, Ready: ${metrics.readySetSize}`,
    "",
    ...graphLines,
  ].join("\n");

  // Build individual subagent prompts for each ready task
  const subagentSections: string[] = [];
  const readyTaskListLines: string[] = [];
  const prefs = loadEffectiveGSDPreferences();
  const contextWindow = resolveExecutorContextWindow(opts?.modelRegistry, prefs?.preferences, opts?.sessionContextWindow, opts?.sessionProvider);
  const budgets = computeBudgets(contextWindow);
  const perSubagentCarryForwardBudget = Math.max(
    1_000,
    Math.floor((budgets.inlineContextBudgetChars * 0.4) / Math.max(1, readyTaskIds.length)),
  );
  const contextTelemetry: PromptContextTelemetryEntry[] = [];
  trackPromptContext(contextTelemetry, "graph-context", "inline", graphContext);
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;

  for (const tid of readyTaskIds) {
    const node = graph.find((n) => n.id === tid);
    const tTitle = node?.title ?? tid;
    readyTaskListLines.push(`- **${tid}: ${tTitle}**`);

    // Build dependency-scoped carry-forward paths for this task
    const depPaths = await getDependencyTaskSummaryPaths(
      mid, sid, tid, node?.dependsOn ?? [], base,
    );

    const taskPlan = await resolveExecuteTaskPlan({
      basePath: base,
      milestoneId: mid,
      sliceId: sid,
      taskId: tid,
      slicePlanContent,
    });
    const taskPlanContent = taskPlan.content;
    const taskPlanInline = taskPlanContent
      ? [
          "## Inlined Task Plan (authoritative local execution contract)",
          `Source: ${taskPlan.source}`,
          "",
          taskPlanContent.trim(),
        ].join("\n")
      : [
          "## Inlined Task Plan (authoritative local execution contract)",
          `Task plan not found at dispatch time. Read ${taskPlan.source} before executing.`,
        ].join("\n");
    const carryForwardSection = await buildCarryForwardSection(depPaths, base);
    const finalCarryForwardSection = carryForwardSection.length > perSubagentCarryForwardBudget
      ? truncateAtSectionBoundary(carryForwardSection, perSubagentCarryForwardBudget).content
      : carryForwardSection;
    trackPromptContext(
      contextTelemetry,
      "prior-task-summaries",
      finalCarryForwardSection.trim() ? "excerpt" : "skipped",
      finalCarryForwardSection,
      finalCarryForwardSection.length < carryForwardSection.length ? `truncated from ${carryForwardSection.length} chars for ${tid}` : tid,
    );
    const taskSummaryPath = `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`;
    const taskPrompt = [
      `## UNIT: Execute Task ${tid} ("${tTitle}")`,
      "",
      "## Working Directory",
      "",
      `Your working directory is \`${base}\`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT \`cd\` to any other directory.`,
      `If any inlined plan names an absolute path outside \`${base}\`, treat it as stale — use the equivalent path under \`${base}\` before reading, writing, or executing.`,
      "",
      "Implement from the inlined task plan below. Verify changes, then call `gsd_task_complete`.",
      "Do not run git commands.",
      "",
      finalCarryForwardSection,
      "",
      taskPlanInline,
      "",
      "## Completion Contract",
      `- Call \`gsd_task_complete\` with camelCase fields: \`milestoneId\`, \`sliceId\`, \`taskId\`, \`oneLiner\`, \`narrative\`, \`verification\`, and \`verificationEvidence\`.`,
      `- Do not manually write \`${taskSummaryPath}\` or edit PLAN checkboxes; the completion tool is canonical.`,
      `- Use \`blocker_discovered: true\` only if the task cannot be completed due to a real blocker.`,
      "",
      `When done, say: "Task ${tid} complete."`,
    ].join("\n");

    const modelSuffix = subagentCallSuffix(
      subagentModel,
      opts?.subagentThinking,
      opts?.subagentModelFallbacks,
    );
    subagentSections.push([
      `### ${tid}: ${tTitle}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix}:`,
      "",
      "```",
      taskPrompt,
      "```",
    ].join("\n"));
  }

  const inlinedTemplates = inlineTemplate("task-summary", "Task Summary");
  trackPromptContext(contextTelemetry, "templates", "inline", inlinedTemplates);

  const prompt = prependContextModeToBlock(
    "reactive-execute",
    base,
    loadPrompt("reactive-execute", {
      workingDirectory: base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      graphContext,
      readyTaskCount: String(readyTaskIds.length),
      readyTaskList: readyTaskListLines.join("\n"),
      subagentPrompts: subagentSections.join("\n\n---\n\n"),
      inlinedTemplates,
    }),
  );
  emitPromptContextTelemetry("reactive-execute", contextTelemetry, prompt);
  return prompt;
}

// ─── Gate Evaluation ──────────────────────────────────────────────────────
//
// Gate definitions (question, guidance, owner turn) now live in
// gate-registry.ts so that prompt builders, dispatch rules, state
// derivation, and tool handlers all consult the same source of truth.
// See gate-registry.ts for the full ownership map.

/**
 * Adapt gate-registry guidance for section-close phases.
 *
 * Gate-registry text is shared with the gate-evaluate subagent, where
 * "Return verdict ..." is literal. Section-close units write artifact sections
 * instead, so translate that wording at render time without mutating the
 * canonical guidance.
 */
function sectionModeGuidance(guidance: string): string {
  return guidance.replace(
    /Return verdict '([^']+)'/g,
    (_match, verdict: string) =>
      verdict === "omitted" ? "Leave the section empty" : `Record a \`${verdict}\``,
  );
}

/**
 * Render a "Gates to Close" block for turns like `complete-slice` and
 * `validate-milestone` that own gates which are closed as a side-effect
 * of writing artifact sections (not via a dedicated gate-evaluate
 * subagent loop).
 *
 * Returns a plain-text block or an empty string if there are no gates to
 * close, so callers can drop it straight into a template variable.
 */
function renderGatesToCloseBlock(
  gates: ReadonlyArray<GateDefinition>,
  opts: { pending: ReadonlySet<string>; allowOmit: boolean },
): string {
  const applicable = gates.filter((g) => opts.pending.has(g.id));
  if (applicable.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Gates to Close");
  lines.push("");
  lines.push(
    "These quality gates are still pending for this unit. You MUST address every one before calling the closing tool — the handler closes the DB row based on whether the corresponding artifact section is present.",
  );
  lines.push("");
  lines.push(
    "**Do NOT call `gsd_save_gate_result` (or any gate-result tool) for these gates** — that tool belongs to a different phase and the call will be blocked. You close each gate purely by writing its named section: a populated section records `pass`, an empty section records `omitted`, and the completion handler persists the verdict for you. Treat any \"return verdict\" wording in the guidance below as describing that section outcome, not as an instruction to call a tool.",
  );
  lines.push("");
  for (const def of applicable) {
    lines.push(`### ${def.id} — ${def.promptSection}`);
    lines.push("");
    lines.push(`**Question:** ${def.question}`);
    lines.push("");
    lines.push(sectionModeGuidance(def.guidance));
    if (opts.allowOmit) {
      lines.push("");
      lines.push(
        `If this gate genuinely does not apply to this unit, leave the **${def.promptSection}** section empty and the handler will record it as \`omitted\`. Otherwise, fill the section with concrete evidence.`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function buildParallelResearchSlicesPrompt(
  mid: string,
  midTitle: string,
  slices: Array<{ id: string; title: string }>,
  basePath: string,
  subagentModel?: string,
  subagentThinking?: string,
  sessionProvider?: string,
): Promise<string> {
  // Build individual research-slice prompts for each slice
  const subagentSections: string[] = [];
  const modelSuffix = subagentCallSuffix(subagentModel, subagentThinking);
  const scoutAgentType = resolveSubagentRoleForProvider("scout", sessionProvider);
  for (const slice of slices) {
    const slicePrompt = await buildResearchSlicePrompt(mid, midTitle, slice.id, slice.title, basePath, {
      contextModeRenderMode: "nested",
      sessionProvider,
    });
    subagentSections.push([
      `### ${slice.id}: ${slice.title}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix} (agent: \`${scoutAgentType}\`):`,
      "",
      "```",
      slicePrompt,
      "```",
    ].join("\n"));
  }

  return loadPrompt("parallel-research-slices", {
    workingDirectory: basePath,
    mid,
    midTitle,
    sliceCount: String(slices.length),
    sliceList: slices.map((s) => `- **${s.id}**: ${s.title}`).join("\n"),
    scoutAgentType,
    subagentPrompts: subagentSections.join("\n\n---\n\n"),
  });
}

export async function buildGateEvaluatePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string,
  base: string,
  subagentModel?: string,
  subagentThinking?: string,
): Promise<string> {
  // Pull only the gates this turn actually owns (Q3/Q4). Filter via the
  // registry so that scope:"slice" gates owned by other turns (Q8) can't
  // leak into this prompt and can't block dispatch via silent skip.
  const pending = getPendingGatesForTurn(mid, sid, "gate-evaluate");

  // Fails loudly if the pending list contains a gate id the registry
  // doesn't own for this turn. Missing owned gates is allowed here —
  // `gate-evaluate` is dispatched whenever *any* of its owned gates are
  // pending, not only when all of them are.
  assertGateCoverage(pending, "gate-evaluate", { requireAll: false });

  // Load the slice plan for context
  const planFile = resolveSliceFile(base, mid, sid, "PLAN");
  const planContent = planFile ? (await loadFile(planFile)) ?? "(plan file empty)" : "(plan file not found)";

  // Build per-gate subagent prompts from the pending rows. Because the
  // registry has already validated every row, `getGateDefinition` cannot
  // return undefined here.
  const pendingIds = new Set(pending.map((g) => g.gate_id));
  const gateDefs = getGatesForTurn("gate-evaluate").filter((def) => pendingIds.has(def.id));

  const subagentSections: string[] = [];
  const gateListLines: string[] = [];
  const normalizedBase = base.replaceAll("\\", "/");

  for (const def of gateDefs) {
    gateListLines.push(`- **${def.id}**: ${def.question}`);

    const subPrompt = [
      renderContextModeForPrompt("gate-evaluate", base, "nested"),
      "",
      `You are evaluating quality gate **${def.id}** for slice ${sid} (${sTitle}).`,
      "",
      `**Working directory:** \`${normalizedBase}\`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT \`cd\` to any other directory.`,
      "",
      `## Question: ${def.question}`,
      "",
      def.guidance,
      "",
      "## Slice Plan",
      "",
      planContent,
      "",
      "## Instructions",
      "",
      "Analyze the slice plan above and answer the gate question.",
      `Call the \`gsd_save_gate_result\` tool with:`,
      `- \`milestoneId\`: "${mid}"`,
      `- \`sliceId\`: "${sid}"`,
      `- \`gateId\`: "${def.id}"`,
      "- `verdict`: \"pass\" (no concerns), \"flag\" (concerns found), or \"omitted\" (not applicable)",
      "- `rationale`: one-sentence justification",
      "- `findings`: detailed markdown findings (or empty if omitted)",
    ].join("\n");

    const modelSuffix = subagentCallSuffix(subagentModel, subagentThinking);
    subagentSections.push([
      `### ${def.id}: ${def.question}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix} (agent: \`tester\`):`,
      "",
      "```",
      subPrompt,
      "```",
    ].join("\n"));
  }

  return prependContextModeToBlock(
    "gate-evaluate",
    base,
    loadPrompt("gate-evaluate", {
      workingDirectory: base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      slicePlanContent: planContent,
      gateCount: String(pending.length),
      gateList: gateListLines.join("\n"),
      subagentPrompts: subagentSections.join("\n\n---\n\n"),
    }),
  );
}

export async function buildRewriteDocsPrompt(
  mid: string, midTitle: string,
  activeSlice: { id: string; title: string } | null,
  base: string,
  overrides: Override[],
): Promise<string> {
  const sid = activeSlice?.id;
  const sTitle = activeSlice?.title ?? "";
  const docList: string[] = [];

  if (sid) {
    const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
    const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");
    if (slicePlanPath) {
      docList.push(`- Slice plan: \`${slicePlanRel}\``);
      const tDir = resolveTasksDir(base, mid, sid);
      if (tDir) {
        // DB primary path — get incomplete tasks
        let incompleteTasks: { id: string }[] | null = null;
        try {
          const { isDbAvailable, getSliceTasks } = await import("./gsd-db.js");
          if (isDbAvailable()) {
            incompleteTasks = getSliceTasks(mid, sid)
              .filter(t => t.status !== "complete" && t.status !== "done")
              .map(t => ({ id: t.id }));
          }
        } catch (err) {
          logWarning("prompt", `buildRewriteDocsPrompt DB task lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!incompleteTasks) {
          // DB unavailable — no task data to inline
          incompleteTasks = [];
        }

        if (incompleteTasks) {
          for (const task of incompleteTasks) {
            const taskPlanPath = resolveTaskFile(base, mid, sid, task.id, "PLAN");
            if (taskPlanPath) {
              const taskRelPath = `${relSlicePath(base, mid, sid)}/tasks/${task.id}-PLAN.md`;
              docList.push(`- Task plan: \`${taskRelPath}\``);
            }
          }
        }
      }
    }
  }

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) docList.push(`- Decisions: \`${relGsdRootFile("DECISIONS")}\``);
  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) docList.push(`- Requirements: \`${relGsdRootFile("REQUIREMENTS")}\``);
  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) docList.push(`- Project: \`${relGsdRootFile("PROJECT")}\``);
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) docList.push(`- Milestone context (reference only): \`${contextRel}\``);
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) docList.push(`- Roadmap: \`${roadmapRel}\``);

  const overrideContent = overrides.map((o, i) => [
    `### Override ${i + 1}`,
    `**Change:** ${o.change}`,
    `**Issued:** ${o.timestamp}`,
    `**During:** ${o.appliedAt}`,
  ].join("\n")).join("\n\n");

  const documentList = docList.length > 0 ? docList.join("\n") : "- No active plan documents found.";

  return prependContextModeToBlock("rewrite-docs", base, loadPrompt("rewrite-docs", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid ?? "none",
    sliceTitle: sTitle,
    overrideContent,
    documentList,
    overridesPath: relGsdRootFile("OVERRIDES"),
  }));
}
