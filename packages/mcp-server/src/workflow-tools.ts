// Project/App: gsd-pi
// File Purpose: Registers packaged workflow tools exposed by the GSD MCP server.

/**
 * Workflow MCP tools — exposes the core GSD mutation/read handlers over MCP.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  WORKFLOW_TOOL_NAMES as CONTRACT_WORKFLOW_TOOL_NAMES,
  CANONICAL_WORKFLOW_TOOL_NAMES as CONTRACT_CANONICAL_WORKFLOW_TOOL_NAMES,
  WORKFLOW_TOOL_ALIAS_NAMES as CONTRACT_WORKFLOW_TOOL_ALIAS_NAMES,
  SUMMARY_SAVE_CONTENT_MAX_LENGTH,
} from "@opengsd/contracts";

import { logAliasUsage } from "./alias-telemetry.js";

export type MilestoneStatusObservationTokenState = "active" | "inactive" | "unavailable";

/** Local mirror of src/resources/extensions/gsd/mcp-bridge.ts.
 *  Kept here so packages/mcp-server/tsconfig.json rootDir boundary is not crossed.
 */
interface GsdMcpBridge {
  loadWriteGateSnapshot: (...args: any[]) => any;
  shouldBlockPendingGateInSnapshot: (...args: any[]) => any;
  shouldBlockQueueExecutionInSnapshot: (...args: any[]) => any;
  ensureDbOpen: (...args: any[]) => any;
  openExistingWorkflowDatabase: (projectDir: string) => WorkflowDatabaseOpenResult;
  _getAdapter: (...args: any[]) => any;
  checkpointDatabase: (...args: any[]) => any;
  closeDatabase: (...args: any[]) => any;
  getAllMilestones: (...args: any[]) => any;
  getDb: (...args: any[]) => any;
  getGateResults: (...args: any[]) => any;
  getMilestoneSlices: (...args: any[]) => any;
  getPendingGates: (...args: any[]) => any;
  getSliceTasks: (...args: any[]) => any;
  insertDecision: (...args: any[]) => any;
  insertMilestone: (...args: any[]) => any;
  insertSlice: (...args: any[]) => any;
  openDatabase: (...args: any[]) => any;
  upsertMilestonePlanning: (...args: any[]) => any;
  invalidateStateCache: (...args: any[]) => any;
  isReusableGhostMilestone: (...args: any[]) => any;
  readProgressFromDb: (...args: any[]) => any;
  loadEffectiveGSDPreferences: (...args: any[]) => any;
  saveDecisionToDb: (...args: any[]) => any;
  saveRequirementToDb: (...args: any[]) => any;
  updateRequirementInDb: (...args: any[]) => any;
  rebuildState: (...args: any[]) => any;
  queryJournal: (...args: any[]) => any;
  claimReservedId: (...args: any[]) => any;
  findMilestoneIds: (...args: any[]) => any;
  getReservedMilestoneIds: (...args: any[]) => any;
  milestoneIdSort: (...args: any[]) => any;
  nextMilestoneId: (...args: any[]) => any;
}

type WorkflowDatabaseOpenResult =
  | { ok: true; reason: "opened-existing" | "created-empty" }
  | {
      ok: false;
      reason: "missing-database" | "missing-gsd-dir" | "locked" | "open-failed";
      error?: Error;
    }
  | { ok: false; reason: "schema-too-new"; error: Error };

async function importBridgeModule(): Promise<GsdMcpBridge> {
  return importLocalModule<GsdMcpBridge>("../../../src/resources/extensions/gsd/mcp-bridge.js");
}

type WorkflowToolExecutors = {
  SUPPORTED_SUMMARY_ARTIFACT_TYPES: readonly string[];
  MILESTONE_STATUS_OBSERVATION_TOKEN_ENV?: string;
  resolveMilestoneStatusObservationTokenState?: (
    basePath: string,
    token: string,
  ) => MilestoneStatusObservationTokenState;
  resolveMilestoneStatusObservationContext?: (
    basePath: string,
    transport: "native_pi" | "workflow_mcp",
    token?: string,
  ) => {
    mode: "auto" | "interactive" | "guided" | "uok" | "custom" | "legacy";
    transport: "native_pi" | "workflow_mcp";
    sourceRevision: string;
    traceId?: string;
    turnId?: string;
    contextError?: "unavailable" | "invalid";
  };
  executeMilestoneStatus: (
    params: { milestoneId: string },
    basePath?: string,
    observationContext?: {
      mode: "auto" | "interactive" | "guided" | "uok" | "custom" | "legacy";
      transport: "native_pi" | "workflow_mcp";
      sourceRevision: string;
      traceId?: string;
      turnId?: string;
    },
  ) => Promise<unknown>;
  executePlanMilestone: (
    params: {
      milestoneId: string;
      title: string;
      vision: string;
      slices: Array<{
        sliceId: string;
        title: string;
        risk: string;
        depends: string[];
        demo: string;
        goal: string;
        successCriteria?: string;
        proofLevel?: string;
        integrationClosure?: string;
        observabilityImpact?: string;
        isSketch?: boolean;
        sketchScope?: string;
      }>;
      status?: string;
      dependsOn?: string[];
      successCriteria?: string[];
      keyRisks?: Array<{ risk: string; whyItMatters: string }>;
      proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
      verificationContract?: string;
      verificationIntegration?: string;
      verificationOperational?: string;
      verificationUat?: string;
      definitionOfDone?: string[];
      requirementCoverage?: string;
      boundaryMapMarkdown?: string;
    },
    basePath: string,
    invocation: PlanningInvocation,
  ) => Promise<unknown>;
  executePlanSlice: (
    params: {
      milestoneId: string;
      sliceId: string;
      goal: string;
      tasks?: Array<{
        taskId: string;
        title: string;
        description: string;
        estimate: string;
        files: string[];
        verify: string;
        inputs: string[];
        expectedOutput: string[];
        observabilityImpact?: string;
      }>;
      successCriteria?: string;
      proofLevel?: string;
      integrationClosure?: string;
      observabilityImpact?: string;
    },
    basePath: string,
    invocation: PlanningInvocation,
  ) => Promise<unknown>;
  executeReplanSlice: (
    params: {
      milestoneId: string;
      sliceId: string;
      blockerTaskId: string;
      blockerDescription: string;
      whatChanged: string;
      updatedTasks: Array<{
        taskId: string;
        title: string;
        description: string;
        estimate: string;
        files: string[];
        verify: string;
        inputs: string[];
        expectedOutput: string[];
        fullPlanMd?: string;
      }>;
      removedTaskIds: string[];
    },
    basePath: string,
    invocation: PlanningInvocation,
  ) => Promise<unknown>;
  executeReplanTask: (
    params: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
      title: string;
      description: string;
      estimate: string;
      files: string[];
      verify: string;
      inputs: string[];
      expectedOutput: string[];
      observabilityImpact?: string;
      reworkBriefRef?: string;
      replanReason?: string;
      fullPlanMd?: string;
    },
    basePath: string,
    invocation: PlanningInvocation,
  ) => Promise<unknown>;
  executeReworkBriefSave: (
    params: {
      briefId?: string;
      milestoneId: string;
      sliceId: string;
      taskId: string;
      findings: Array<{
        findingId: string;
        severity: "blocking" | "advisory";
        description: string;
        requiredFix: string;
        verificationCommands: string[];
      }>;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeSliceComplete: (
    params: {
      sliceId: string;
      milestoneId: string;
      sliceTitle: string;
      oneLiner: string;
      narrative: string;
      verification?: string;
      uatContent: string;
      deviations?: string;
      knownLimitations?: string;
      followUps?: string;
      keyFiles?: string[] | string;
      keyDecisions?: string[] | string;
      patternsEstablished?: string[] | string;
      observabilitySurfaces?: string[] | string;
      provides?: string[] | string;
      requirementsSurfaced?: string[] | string;
      drillDownPaths?: string[] | string;
      affects?: string[] | string;
      requirementsAdvanced?: Array<{ id: string; how: string } | string>;
      requirementsValidated?: Array<{ id: string; proof: string } | string>;
      requirementsInvalidated?: Array<{ id: string; what: string } | string>;
      filesModified?: Array<{ path: string; description: string } | string>;
      requires?: Array<{ slice: string; provides: string } | string>;
      actorName?: string;
      triggerReason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeCompleteMilestone: (
    params: {
      milestoneId: string;
      title: string;
      oneLiner: string;
      narrative: string;
      verificationPassed: boolean;
      successCriteriaResults?: string;
      definitionOfDoneResults?: string;
      requirementOutcomes?: string;
      keyDecisions?: string[];
      keyFiles?: string[];
      lessonsLearned?: string[];
      followUps?: string;
      deviations?: string;
      actorName?: string;
      triggerReason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeValidateMilestone: (
    params: {
      milestoneId: string;
      verdict: "pass" | "needs-attention" | "needs-remediation";
      remediationRound: number;
      successCriteriaChecklist: string;
      sliceDeliveryAudit: string;
      crossSliceIntegration: string;
      requirementCoverage: string;
      verificationClasses?: string;
      verificationEvidence?: Array<{
        verificationClass: "Contract" | "Integration" | "Operational" | "UAT";
        sliceId?: string;
        evidenceClass: "command" | "runtime" | "browser" | "artifact";
        rationale: string;
        commandOrTool: string;
        workingDirectory: string;
        startedAt: string;
        endedAt: string;
        exitCode?: number;
        observation: "passed" | "failed" | "inconclusive";
        durableOutputRef: string;
        testedSourceRevision: string;
        environment: Record<string, unknown>;
      }>;
      verdictRationale: string;
      remediationPlan?: string;
    },
    basePath?: string,
    opts?: { invocation?: ExecutionInvocation },
  ) => Promise<unknown>;
  executePrepareMilestoneSubjectiveUat: (
    params: {
      milestoneId: string;
      criterionKey: string;
      description: string;
      focusedPrompt: string;
      recommendedDisposition: "accepted" | "rejected";
      recommendationRationale: string;
      recommendationEvidence: string;
      testedSourceRevision: string;
      recommendationConfidence?: number;
      requirementId?: string;
      required?: boolean;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeAnswerMilestoneSubjectiveUat: (
    params: {
      criterionId: string;
      questionId: string;
      interactionId: string;
      selectedOptionId: string;
      verbatimResponse: string;
      rationale: string;
      testedSourceRevision: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeReassessRoadmap: (
    params: {
      milestoneId: string;
      completedSliceId: string;
      verdict: string;
      assessment: string;
      sliceChanges: {
        modified: Array<{
          sliceId: string;
          title: string;
          risk?: string;
          depends?: string[];
          demo?: string;
        }>;
        added: Array<{
          sliceId: string;
          title: string;
          risk?: string;
          depends?: string[];
          demo?: string;
        }>;
        removed: string[];
      };
    },
    basePath: string,
    invocation: PlanningInvocation,
  ) => Promise<unknown>;
  executeSaveGateResult: (
    params: {
      milestoneId: string;
      sliceId: string;
      gateId: string;
      taskId?: string;
      verdict: "pass" | "flag" | "omitted";
      rationale: string;
      findings?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeUatResultSave: (
    params: {
      milestoneId: string;
      sliceId: string;
      uatType: string;
      verdict: "PASS" | "FAIL" | "PARTIAL";
      checks: Array<Record<string, unknown>>;
      presentation: Record<string, unknown>;
      notes?: string;
      attempt?: string;
      previousAttemptId?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeSummarySave: (
    params: {
      milestone_id?: string;
      slice_id?: string;
      task_id?: string;
      artifact_type: string;
      content: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeTaskComplete: (
    params: {
      taskId: string;
      sliceId: string;
      milestoneId: string;
      oneLiner: string;
      narrative: string;
      verification?: string;
      deviations?: string;
      knownIssues?: string;
      keyFiles?: string[];
      keyDecisions?: string[];
      blockerDiscovered?: boolean;
      escalation?: {
        question: string;
        options: Array<{ id: string; label: string; tradeoffs: string }>;
        recommendation: string;
        recommendationRationale: string;
        continueWithDefault: boolean;
      };
      verificationEvidence?: Array<
        { command: string; exitCode: number; verdict: string; durationMs: number } | string
      >;
      reworkResolution?: Array<{
        findingId: string;
        status: "resolved" | "deferred-with-override";
        evidence: string;
        decisionRef?: string;
      }>;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeTaskReopen: (
    params: {
      taskId: string;
      sliceId: string;
      milestoneId: string;
      reason?: string;
      actorName?: string;
      triggerReason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeTaskRecoveryResume: (
    params: {
      recoveryActionId: string;
      repairSummary: string;
      evidence: Record<string, unknown>;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeTaskSettle: (
    params: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
      reason: string;
      apply?: boolean;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeSliceReopen: (
    params: {
      sliceId: string;
      milestoneId: string;
      reason?: string;
      actorName?: string;
      triggerReason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeSkipSlice: (
    params: {
      sliceId: string;
      milestoneId: string;
      reason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
  executeMilestoneReopen: (
    params: {
      milestoneId: string;
      reason?: string;
      actorName?: string;
      triggerReason?: string;
    },
    basePath: string,
    invocation: ExecutionInvocation,
  ) => Promise<unknown>;
};

type WorkflowWriteGateModule = {
  loadWriteGateSnapshot: (basePath: string) => {
    verifiedDepthMilestones: string[];
    activeQueuePhase: boolean;
    pendingGateId: string | null;
  };
  shouldBlockPendingGateInSnapshot: (
    snapshot: {
      verifiedDepthMilestones: string[];
      activeQueuePhase: boolean;
      pendingGateId: string | null;
    },
    toolName: string,
    milestoneId: string | null,
    queuePhaseActive?: boolean,
  ) => { block: boolean; reason?: string };
  shouldBlockQueueExecutionInSnapshot: (
    snapshot: {
      verifiedDepthMilestones: string[];
      activeQueuePhase: boolean;
      pendingGateId: string | null;
    },
    toolName: string,
    input: string,
    queuePhaseActive?: boolean,
  ) => { block: boolean; reason?: string };
};

type WorkflowDbBootstrapModule = {
  ensureDbOpen: (basePath?: string) => Promise<boolean>;
};

let workflowToolExecutorsPromise: Promise<WorkflowToolExecutors> | null = null;
let workflowExecutionQueue: Promise<void> = Promise.resolve();
let workflowWriteGatePromise: Promise<WorkflowWriteGateModule> | null = null;

function getAllowedProjectRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configuredRoot = env.GSD_WORKFLOW_PROJECT_ROOT?.trim();
  return configuredRoot ? resolve(configuredRoot) : null;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the symlink target of `<allowedRoot>/.gsd` when it points into the
 * external state layout (`~/.gsd/projects/<hash>/`). Returns the realpath of
 * that target so callers can accept worktree paths that live under
 * `<external-state>/worktrees/<MID>/`. Returns null when `.gsd` is absent or
 * resolution fails — the caller should fall back to the direct containment
 * check in that case.
 */
function resolveExternalStateRoot(allowedRoot: string): string | null {
  try {
    return realpathSync(join(allowedRoot, ".gsd"));
  } catch {
    return null;
  }
}

export function validateProjectDir(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path. Received: ${projectDir}`);
  }

  const lexicallyResolved = resolve(projectDir);
  // Resolve symlinks on the candidate before the containment check so that a
  // symlink inside the allowed root pointing outside of it cannot bypass the
  // guard. Falls back to the lexical path if the candidate does not exist yet
  // (legitimate for a brand-new worktree dir about to be created).
  const resolvedProjectDir = safeRealpath(lexicallyResolved);

  const allowedRoot = getAllowedProjectRoot(env);
  if (!allowedRoot) return resolvedProjectDir;

  const resolvedAllowedRoot = safeRealpath(allowedRoot);
  if (isWithinRoot(resolvedProjectDir, resolvedAllowedRoot)) return resolvedProjectDir;

  // External state layout: `<allowedRoot>/.gsd` may be a symlink into
  // `~/.gsd/projects/<hash>/`, and auto-worktrees live under
  // `~/.gsd/projects/<hash>/worktrees/<MID>/`. Accept candidates that are
  // under the realpath of `<allowedRoot>/.gsd` — they belong to this project
  // even though their absolute path is outside allowedRoot (#issue-a44).
  const externalRoot = resolveExternalStateRoot(resolvedAllowedRoot);
  if (externalRoot && isWithinRoot(resolvedProjectDir, externalRoot)) {
    return resolvedProjectDir;
  }

  throw new Error(
    `projectDir must stay within the configured workflow project root. Received: ${resolvedProjectDir}; allowed root: ${resolvedAllowedRoot}`,
  );
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    // Only fall back for non-existent paths — a legitimate case when a worktree
    // directory hasn't been created yet. Permission errors (EACCES), not-a-
    // directory (ENOTDIR), etc. must propagate so we do not silently degrade
    // to a lexical-only containment check that a restricted symlink could
    // bypass.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return path;
    throw err;
  }
}

function parseToolArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  return schema.parse(args);
}

/**
 * Extract a milestone ID from parsed tool args, trying common field names.
 * Returns null when no field is present or the value is not a string.
 */
function extractMilestoneId(parsed: Record<string, unknown>): string | null {
  const candidates = [parsed.milestoneId, parsed.milestone_id, parsed.mid];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

/**
 * If an auto-worktree exists for the given milestone under
 * `<projectRoot>/.gsd/worktrees/<milestoneId>/`, return that path as the
 * basePath the tool should write against. Returns null when no worktree
 * exists for this milestone, leaving the caller to use the project root.
 *
 * This unbreaks the external-state layout where the MCP server's process.cwd()
 * is the project root (set at Claude Code launch) but auto-mode is actually
 * working inside a per-milestone worktree. Without this, tool writes go to
 * the shared project `.gsd/` and auto-mode's verifyExpectedArtifact (which
 * uses the worktree `.gsd/`) fails, triggering a guaranteed retry per unit.
 */
/**
 * Containers a GSD worktree may live in: canonical .gsd-worktrees/ first,
 * legacy .gsd/worktrees/ second. Boundary copy of `worktreesDirs` in
 * src/resources/extensions/gsd/worktree-placement.ts — the MCP server cannot
 * statically import the extension tree. Keep the two lists synchronized.
 */
function worktreeContainers(projectRoot: string): string[] {
  return [join(projectRoot, ".gsd-worktrees"), join(projectRoot, ".gsd", "worktrees")];
}

function resolveActiveWorktreeBasePath(
  projectRoot: string,
  milestoneId: string | null,
): string | null {
  if (!milestoneId) return null;
  for (const container of worktreeContainers(projectRoot)) {
    const wtPath = join(container, milestoneId);
    if (!existsSync(wtPath)) continue;
    // Sanity check: a real git worktree has a `.git` file with a gitdir pointer.
    // Bare directories without it shouldn't hijack the write path.
    if (!existsSync(join(wtPath, ".git"))) continue;
    return wtPath;
  }
  return null;
}

/**
 * Fallback when the tool call has no milestoneId: if exactly one auto-worktree
 * exists across the project's worktree containers, treat it as the active one.
 * Multiple worktrees → ambiguous, return null and let writes go to project root.
 */
function resolveSoleActiveWorktree(projectRoot: string): string | null {
  const live: string[] = [];
  for (const worktreesDir of worktreeContainers(projectRoot)) {
    if (!existsSync(worktreesDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(worktreesDir);
    } catch {
      continue;
    }
    live.push(
      ...entries
        .map((name) => join(worktreesDir, name))
        .filter((p) => existsSync(join(p, ".git"))),
    );
  }
  if (live.length !== 1) return null;
  return live[0];
}

async function bridgeRecoveryActionMilestoneId(
  projectDir: string,
  recoveryActionId: string,
): Promise<string | null> {
  const bridge = await importBridgeModule();
  if (!await bridge.ensureDbOpen(projectDir)) return null;
  const row = bridge.getDb().prepare(`
    SELECT lifecycle.milestone_id
    FROM workflow_recovery_actions action
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = action.project_id
     AND lifecycle.lifecycle_id = action.lifecycle_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({ ":recovery_action_id": recoveryActionId });
  return typeof row?.milestone_id === "string" ? row.milestone_id : null;
}

export async function resolveRecoveryActionProjectDir(
  projectRoot: string,
  recoveryActionId: string,
  resolveMilestoneId: (projectDir: string, recoveryActionId: string) => Promise<string | null> = bridgeRecoveryActionMilestoneId,
): Promise<string> {
  const milestoneId = await resolveMilestoneId(projectRoot, recoveryActionId);
  return resolveActiveWorktreeBasePath(projectRoot, milestoneId) ?? projectRoot;
}

function isHomeDirectory(candidate: string): boolean {
  let resolvedHome: string;
  try {
    resolvedHome = realpathSync(resolve(homedir()));
  } catch {
    resolvedHome = resolve(homedir());
  }
  let resolvedCandidate: string;
  try {
    resolvedCandidate = realpathSync(resolve(candidate));
  } catch {
    resolvedCandidate = resolve(candidate);
  }
  return resolvedCandidate === resolvedHome;
}

export function _parseWorkflowArgsForTest<T extends { projectDir?: string }>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
): T & { projectDir: string } {
  return parseWorkflowArgs(schema, args);
}

function parseWorkflowArgs<T extends { projectDir?: string }>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
): T & { projectDir: string } {
  const parsed = parseToolArgs(schema, args);
  // Step 1: figure out the project root. The agent shouldn't need to pass
  // projectDir — default to process.cwd() which the MCP server inherited from
  // Claude Code (launched at the project root).
  const projectRootCandidate = parsed.projectDir ?? process.cwd();

  // Defense-in-depth: refuse when the resolved candidate is the user's home
  // directory. The MCP server's process.cwd() can be $HOME if launched from
  // an unusual context; honoring it would write project artifacts into ~/.gsd.
  if (isHomeDirectory(projectRootCandidate)) {
    throw new Error(
      `projectDir resolves to the user's home directory (${projectRootCandidate}). ` +
      `Run the workflow tool from inside a project directory, or pass an explicit projectDir.`,
    );
  }

  const projectRoot = validateProjectDir(projectRootCandidate);

  // Step 2: if this tool call is scoped to a milestone that has an active
  // auto-worktree, re-route writes to the worktree's .gsd rather than the
  // project's shared .gsd. auto-mode's verifyExpectedArtifact runs against
  // the worktree, and a mismatch here causes every unit to retry once.
  // When the agent omits milestoneId, fall back to the sole live worktree
  // if exactly one exists — that's the active auto-mode session.
  const milestoneId = extractMilestoneId(parsed as Record<string, unknown>);
  const worktreeBasePath = resolveActiveWorktreeBasePath(projectRoot, milestoneId)
    ?? (milestoneId ? null : resolveSoleActiveWorktree(projectRoot));
  const effectiveBasePath = worktreeBasePath ?? projectRoot;

  return {
    ...parsed,
    projectDir: effectiveBasePath,
  };
}

function isWorkflowToolExecutors(value: unknown): value is WorkflowToolExecutors {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const functionExports = [
    "executeMilestoneStatus",
    "executePlanMilestone",
    "executePlanSlice",
    "executeReplanSlice",
    "executeReplanTask",
    "executeReworkBriefSave",
    "executeSliceComplete",
    "executeCompleteMilestone",
    "executeValidateMilestone",
    "executeReassessRoadmap",
    "executeSaveGateResult",
    "executeSummarySave",
    "executeUatResultSave",
    "executeTaskComplete",
    "executeTaskReopen",
    "executeTaskRecoveryResume",
    "executeTaskSettle",
    "executeSliceReopen",
    "executeSkipSlice",
    "executeMilestoneReopen",
  ];

  return Array.isArray(record.SUPPORTED_SUMMARY_ARTIFACT_TYPES) &&
    functionExports.every((key) => typeof record[key] === "function");
}

function getSupportedSummaryArtifactTypes(executors: WorkflowToolExecutors): readonly string[] {
  return executors.SUPPORTED_SUMMARY_ARTIFACT_TYPES;
}

function buildImportCandidates(relativePath: string): string[] {
  const candidates: string[] = [];
  const pushPreferredPair = (path: string | null) => {
    if (!path) return;
    if (path.endsWith(".js")) candidates.push(path.replace(/\.js$/, ".ts"));
    candidates.push(path);
  };

  const sourcePath = relativePath.includes("/dist/")
    ? relativePath.replace("/dist/", "/src/")
    : relativePath;
  const distPath = relativePath.includes("/src/")
    ? relativePath.replace("/src/", "/dist/")
    : relativePath.includes("/dist/")
      ? relativePath
      : null;

  pushPreferredPair(sourcePath);
  pushPreferredPair(distPath);

  return [...new Set(candidates)];
}

function buildBridgeImportCandidates(relativePath: string): string[] {
  const candidates: string[] = [];
  const pushCompiledThenSource = (path: string | null) => {
    if (!path) return;
    candidates.push(path);
    if (path.endsWith(".js")) candidates.push(path.replace(/\.js$/, ".ts"));
  };

  const sourcePath = relativePath.includes("/dist/")
    ? relativePath.replace("/dist/", "/src/")
    : relativePath;
  const distPath = relativePath.includes("/src/")
    ? relativePath.replace("/src/", "/dist/")
    : relativePath.includes("/dist/")
      ? relativePath
      : null;

  pushCompiledThenSource(distPath);
  pushCompiledThenSource(sourcePath);

  return [...new Set(candidates)];
}

function getWriteGateModuleCandidates(): string[] {
  const candidates: string[] = [];
  const explicitModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_WRITE_GATE_MODULE only supports file: URLs or filesystem paths.");
    }
    warnCustomWorkflowModule("GSD_WORKFLOW_WRITE_GATE_MODULE", explicitModule);
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }

  candidates.push(
    ...buildBridgeImportCandidates("../../../src/resources/extensions/gsd/mcp-bridge.js")
      .map((p) => new URL(p, import.meta.url).href),
  );

  return [...new Set(candidates)];
}

function toFileUrl(modulePath: string): string {
  return pathToFileURL(resolve(modulePath)).href;
}

const warnedCustomWorkflowModuleVars = new Set<string>();

/**
 * Emit a one-time stderr warning when GSD_WORKFLOW_EXECUTORS_MODULE or
 * GSD_WORKFLOW_WRITE_GATE_MODULE is set. These overrides exist for dev/test
 * use, but they let the env owner load arbitrary local modules. The warning
 * makes accidental or hostile use loud rather than silent.
 */
function warnCustomWorkflowModule(varName: string, value: string): void {
  if (warnedCustomWorkflowModuleVars.has(varName)) return;
  warnedCustomWorkflowModuleVars.add(varName);
  process.stderr.write(
    `[gsd-mcp-server] WARNING: ${varName} is set (${value}). ` +
    `Custom workflow modules will be loaded from this path. ` +
    `Unset for production use.\n`,
  );
}

/** @internal — exported for testing only */
export function _buildImportCandidates(relativePath: string): string[] {
  // Build candidate paths: prefer source first, including the .ts source
  // variant, before falling back to compiled dist. In source/dev execution a
  // stale dist/resources tree must not silently override edited source files.
  return buildImportCandidates(relativePath);
}

/** @internal — exported for testing only */
export function _buildBridgeImportCandidates(relativePath: string): string[] {
  return buildBridgeImportCandidates(relativePath);
}

async function importLocalModule<T>(relativePath: string): Promise<T> {
  const rawCandidates = _buildImportCandidates(relativePath);
  const candidates = (import.meta.url.includes("/dist-test/") || import.meta.url.includes("\\dist-test\\")
    ? [...rawCandidates].sort((a, b) => Number(a.endsWith(".ts")) - Number(b.endsWith(".ts")))
    : rawCandidates)
    .map((p) => new URL(p, import.meta.url).href);

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return await import(candidate) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function importWorkflowRuntimeModule<T>(relativePath: string): Promise<T> {
  const rawCandidates = import.meta.url.includes("/src/") || import.meta.url.includes("\\src\\")
    ? _buildImportCandidates(relativePath)
    : buildBridgeImportCandidates(relativePath);
  const candidates = rawCandidates
    .map((p) => new URL(p, import.meta.url).href);

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return await import(candidate) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function loadProjectPreferences(projectDir: string): Promise<unknown | null> {
  const bridge = await importBridgeModule();
  try {
    return bridge.loadEffectiveGSDPreferences(projectDir).preferences;
  } catch {
    return null;
  }
}

function getWorkflowExecutorModuleCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const explicitModule = env.GSD_WORKFLOW_EXECUTORS_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_EXECUTORS_MODULE only supports file: URLs or filesystem paths.");
    }
    warnCustomWorkflowModule("GSD_WORKFLOW_EXECUTORS_MODULE", explicitModule);
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }

  candidates.push(
    ...buildBridgeImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js")
      .map((p) => new URL(p, import.meta.url).href),
  );

  return [...new Set(candidates)];
}

export function hasWorkflowToolBridgeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  moduleExists: (modulePath: string) => boolean = existsSync,
): boolean {
  if (
    env.GSD_WORKFLOW_EXECUTORS_MODULE?.trim()
    || env.GSD_WORKFLOW_WRITE_GATE_MODULE?.trim()
  ) {
    return true;
  }

  // Workflow tools need BOTH co-located bridges (executors + write gate), so
  // each module must resolve to at least one existing candidate. A partial
  // checkout with only one of them must report "not configured" rather than
  // enabling workflow tools and then failing warmWorkflowToolBridges().
  const localModuleCandidateGroups = [
    buildBridgeImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js"),
    buildBridgeImportCandidates("../../../src/resources/extensions/gsd/mcp-bridge.js"),
  ];
  return localModuleCandidateGroups.every((candidates) =>
    candidates.some((candidate) =>
      moduleExists(fileURLToPath(new URL(candidate, import.meta.url)))
    )
  );
}

async function getWorkflowToolExecutors(): Promise<WorkflowToolExecutors> {
  if (!workflowToolExecutorsPromise) {
    workflowToolExecutorsPromise = (async () => {
      const attempts: string[] = [];
      for (const candidate of getWorkflowExecutorModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (isWorkflowToolExecutors(loaded)) {
            return loaded;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      throw new Error(
        "Unable to load GSD workflow executor bridge for MCP mutation tools. " +
        "Set GSD_WORKFLOW_EXECUTORS_MODULE to an importable workflow-tool-executors module, " +
        "or run the MCP server from a GSD checkout that includes src/resources/extensions/gsd/tools/workflow-tool-executors.(js|ts). " +
        `Attempts: ${attempts.join("; ")}`,
      );
    })();
  }
  return workflowToolExecutorsPromise;
}

/**
 * Eagerly load and shape-check the workflow executor and write-gate bridges.
 * When workflow tools are enabled, the stdio CLI awaits this before connecting
 * so a broken bridge fails the spawn with an actionable error instead of
 * presenting an available-looking tool surface that errors on the first call.
 * Shares the cached promises the tool handlers use, so a successful warm-up
 * also removes first-call import latency.
 */
export async function warmWorkflowToolBridges(): Promise<void> {
  await getWorkflowToolExecutors();
  await getWorkflowWriteGateModule();
}

export async function resolveMilestoneStatusObservationTokenState(
  projectDir: string,
  token: string,
): Promise<MilestoneStatusObservationTokenState> {
  if (!token.trim()) return "inactive";
  try {
    const executors = await getWorkflowToolExecutors();
    const state = executors.resolveMilestoneStatusObservationTokenState?.(projectDir, token);
    return state === "active" || state === "inactive" || state === "unavailable"
      ? state
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function getWorkflowWriteGateModule(): Promise<WorkflowWriteGateModule> {
  if (!workflowWriteGatePromise) {
    workflowWriteGatePromise = (async () => {
      const attempts: string[] = [];
      for (const candidate of getWriteGateModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (
            loaded &&
            typeof loaded.loadWriteGateSnapshot === "function" &&
            typeof loaded.shouldBlockPendingGateInSnapshot === "function" &&
            typeof loaded.shouldBlockQueueExecutionInSnapshot === "function"
          ) {
            return loaded as WorkflowWriteGateModule;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      throw new Error(
        "Unable to load GSD write-gate bridge for workflow MCP tools. " +
        `Attempts: ${attempts.join("; ")}`,
      );
    })();
  }
  return workflowWriteGatePromise;
}

interface PlanningInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

type ExecutionInvocation = PlanningInvocation;

interface WorkflowMcpRequestExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  sessionId?: string;
  _meta?: Record<string, unknown>;
}

interface McpToolServer {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => Promise<unknown>,
  ): unknown;
}

const MCP_IDEMPOTENCY_META_KEY = "io.opengsd/idempotency-key";
const CLAUDE_CODE_TOOL_USE_META_KEY = "claudecode/toolUseId";
const CLAUDE_CODE_IDEMPOTENCY_PREFIX = "transport:claude-code:";

function mcpInvocation(
  canonicalToolName: string,
  mutationKind: "Planning mutation" | "Task execution mutation" | "Workflow execution mutation",
  extra?: WorkflowMcpRequestExtra,
): ExecutionInvocation {
  const explicitKey = extra?._meta?.[MCP_IDEMPOTENCY_META_KEY];
  const stableExplicitKey = typeof explicitKey === "string" && explicitKey.trim()
    ? explicitKey.trim()
    : undefined;
  const claudeCodeToolUseId = extra?._meta?.[CLAUDE_CODE_TOOL_USE_META_KEY];
  const stableClaudeCodeToolUseId = typeof claudeCodeToolUseId === "string" && claudeCodeToolUseId.trim()
    ? claudeCodeToolUseId.trim()
    : undefined;
  if (stableExplicitKey?.startsWith(CLAUDE_CODE_IDEMPOTENCY_PREFIX)) {
    throw new Error(
      `${mutationKind} ${canonicalToolName} cannot use the reserved Claude Code transport identity namespace`,
    );
  }
  const stableKey = explicitKey === undefined && stableClaudeCodeToolUseId
    ? `${CLAUDE_CODE_IDEMPOTENCY_PREFIX}${stableClaudeCodeToolUseId}`
    : stableExplicitKey;
  if (!stableKey) {
    throw new Error(
      `${mutationKind} ${canonicalToolName} requires replay-stable private request metadata ` +
      `_meta["${MCP_IDEMPOTENCY_META_KEY}"] or _meta["${CLAUDE_CODE_TOOL_USE_META_KEY}"]. ` +
      `Retry with the same nonblank value.`,
    );
  }
  return {
    idempotencyKey: `mcp:${canonicalToolName}:${stableKey}`,
    sourceTransport: "workflow-mcp",
    actorType: "agent",
    traceId: stableKey,
  };
}

function mcpPlanningInvocation(
  canonicalToolName: string,
  extra?: WorkflowMcpRequestExtra,
): PlanningInvocation {
  return mcpInvocation(canonicalToolName, "Planning mutation", extra);
}

function mcpExecutionInvocation(
  canonicalToolName: string,
  extra?: WorkflowMcpRequestExtra,
): ExecutionInvocation {
  return mcpInvocation(canonicalToolName, "Task execution mutation", extra);
}

function mcpWorkflowExecutionInvocation(
  canonicalToolName: string,
  extra?: WorkflowMcpRequestExtra,
): ExecutionInvocation {
  return mcpInvocation(canonicalToolName, "Workflow execution mutation", extra);
}

function mcpUserResponseInvocation(
  canonicalToolName: string,
  extra?: WorkflowMcpRequestExtra,
): ExecutionInvocation {
  const actorId = extra?.sessionId?.trim();
  if (!actorId) {
    throw new Error(`${canonicalToolName} requires an authenticated MCP session identity`);
  }
  return {
    ...mcpWorkflowExecutionInvocation(canonicalToolName, extra),
    actorType: "user",
    actorId,
  };
}

export const WORKFLOW_TOOL_NAMES = CONTRACT_WORKFLOW_TOOL_NAMES;
export const CANONICAL_WORKFLOW_TOOL_NAMES = CONTRACT_CANONICAL_WORKFLOW_TOOL_NAMES;
export const WORKFLOW_TOOL_ALIAS_NAMES = CONTRACT_WORKFLOW_TOOL_ALIAS_NAMES;

const WORKFLOW_TOOL_ALIAS_NAME_SET = new Set<string>(CONTRACT_WORKFLOW_TOOL_ALIAS_NAMES);

const DEFAULT_WORKFLOW_OP_TIMEOUT_MS = 5 * 60 * 1000;

function getWorkflowOpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GSD_MCP_WORKFLOW_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  return parsed; // 0 disables the timeout
}

/**
 * Adapt an executor `ToolExecutionResult` ({ content, details?, isError? }) to
 * the MCP `CallToolResult` shape ({ content, structuredContent?, isError? }).
 *
 * MCP transports (including stdio) only serialize fields declared in the
 * protocol, so a non-standard `details` field is silently dropped over the
 * wire. Mirroring it into `structuredContent` — the protocol's supported
 * channel for structured tool payloads — preserves the data for clients that
 * render from it (e.g. the save_gate_result renderer that reads gateId /
 * verdict). See #4472.
 *
 * Discard policy for non-plain-object `details`: the `isPlainObject` guard
 * accepts the canonical case (a record literal) and intentionally drops bare
 * primitives (string, number, boolean), bare arrays, and class instances /
 * Date objects. This is deliberate — MCP `structuredContent` is specified as
 * a JSON object; non-object payloads can't round-trip cleanly. No current
 * executor returns a non-object `details`, so this never fires in practice.
 * Future executors needing to return a primitive should wrap it
 * (`details: { value: 42 }`) rather than relying on the discard.
 */
function adaptExecutorResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (!("details" in r)) return result;
  const { details, ...rest } = r;
  return isPlainObject(details) ? { ...rest, structuredContent: details } : rest;
}

/**
 * Strict plain-object guard. True only for object literals and
 * `Object.create(null)` — not for `Date`, `URL`, `Map`, `Set`, class instances,
 * or arrays. Used to gate `structuredContent` forwarding so the MCP transport
 * receives only true JSON objects (the protocol contract).
 *
 * Mirrored in `src/mcp-server.ts` for the agent-tool registry path's
 * structured-content gate. Keep both copies in sync if the contract definition
 * needs to evolve. See #4477 review.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

async function runSerializedWorkflowOperation<T>(fn: () => Promise<T>): Promise<T> {
  // The shared DB adapter and workflow log base path are process-global, so
  // workflow MCP mutations must not overlap within a single server process.
  // A per-operation deadline prevents a single stuck call from wedging its
  // caller for the lifetime of the process.
  //
  // Promise.race cannot cancel the underlying `fn()`. On timeout, surface an
  // error to the caller but keep the queue held until `fn()` actually settles
  // so a retry cannot overlap with the still-running operation. True
  // cancellation remains a larger deferred design: it requires threading an
  // AbortSignal through every workflow executor (`workflow-tool-executors.ts`
  // and friends).
  const prior = workflowExecutionQueue;
  let release!: () => void;
  workflowExecutionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior;
  const timeoutMs = getWorkflowOpTimeoutMs();
  const operationPromise = Promise.resolve().then(fn);
  let timedOut = false;
  try {
    if (timeoutMs === 0) {
      return await operationPromise;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Workflow operation exceeded ${timeoutMs}ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    if (timedOut) {
      void operationPromise.then(release, release);
    } else {
      release();
    }
  }
}

/** @internal — exported for testing only */
export function _runSerializedWorkflowOperationForTest<T>(fn: () => Promise<T>): Promise<T> {
  return runSerializedWorkflowOperation(fn);
}

async function runSerializedWorkflowDbOperation<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runSerializedWorkflowOperation(async () => {
    const bridge = await importBridgeModule();
    const dbAvailable = await bridge.ensureDbOpen(projectDir);
    if (!dbAvailable) {
      throw new Error("GSD database is not available");
    }
    return fn();
  });
}

/**
 * DB-authoritative progress payload for the `gsd_progress` tool
 * (ADR-046). Runs inside the workflow serialization queue with the bridge's
 * project-scoped DB open, so back-to-back calls for different projects
 * cannot serve one project's state for another.
 *
 * Returns null when the project database is missing or cannot be opened, so
 * the caller falls back to the projection reader, matching `gsd read progress`.
 * Schema-version errors and failures after a successful open remain loud.
 */
export async function readProjectProgressViaBridge(projectDir: string): Promise<unknown | null> {
  return runSerializedWorkflowOperation(async () => {
    const bridge = await importBridgeModule();
    const opened = bridge.openExistingWorkflowDatabase(projectDir);
    if (!opened.ok) {
      if (opened.reason === "schema-too-new") throw opened.error;
      return null;
    }
    return bridge.readProgressFromDb(projectDir);
  });
}

async function runSerializedCanonicalReadOperation(
  projectDir: string,
  fn: (adapter: { close(): void }) => Promise<unknown>,
): Promise<unknown> {
  return runSerializedWorkflowOperation(async () => {
    const { resolveProjectRootDbPath, openWorkflowDatabaseIsolated } = await importWorkflowRuntimeModule<any>(
      "../../../src/resources/extensions/gsd/db-workspace.js",
    );
    const dbPath = resolveProjectRootDbPath(projectDir);
    if (!existsSync(dbPath)) {
      throw new Error("Database adapter not available (db_unavailable)");
    }
    const adapter = openWorkflowDatabaseIsolated(dbPath);
    if (!adapter) {
      throw new Error("Database adapter not available (db_unavailable)");
    }
    try {
      // Canonical read tools return their payload in `details`, which the MCP
      // wire drops — mirror it into structuredContent like every other tool.
      return adaptExecutorResult(await fn(adapter));
    } finally {
      adapter.close();
    }
  });
}

function mapCanonicalReadError(
  operation:
    | "list_decisions"
    | "get_decision"
    | "list_requirements"
    | "get_requirement"
    | "read_project_snapshot",
  message: string,
  id?: string,
): unknown {
  const dbUnavailable = message.includes("db_unavailable") || message.includes("not available");
  const details: Record<string, unknown> = {
    operation,
    ...(id ? { id } : {}),
    error: dbUnavailable ? "db_unavailable" : "query_error",
  };
  if (!dbUnavailable) {
    details.message = message;
  }

  const actionLabel = operation === "list_decisions"
    ? "listing decisions"
    : operation === "get_decision"
      ? "fetching decision"
        : operation === "list_requirements"
          ? "listing requirements"
          : operation === "read_project_snapshot"
            ? "reading project snapshot"
            : "fetching requirement";

  return adaptExecutorResult({
    content: [{
      type: "text" as const,
      text: dbUnavailable ? "Error: GSD database is not available." : `Error ${actionLabel}: ${message}`,
    }],
    details,
  });
}

async function enforceWorkflowWriteGate(
  toolName: string,
  projectDir: string,
  milestoneId: string | null = null,
): Promise<void> {
  const writeGate = await getWorkflowWriteGateModule();
  const snapshot = writeGate.loadWriteGateSnapshot(projectDir);
  const pendingGate = writeGate.shouldBlockPendingGateInSnapshot(
    snapshot,
    toolName,
    milestoneId,
    snapshot.activeQueuePhase,
  );
  if (pendingGate.block) {
    throw new Error(pendingGate.reason ?? "workflow tool blocked by pending discussion gate");
  }

  const queueGuard = writeGate.shouldBlockQueueExecutionInSnapshot(
    snapshot,
    toolName,
    "",
    snapshot.activeQueuePhase,
  );
  if (queueGuard.block) {
    throw new Error(queueGuard.reason ?? "workflow tool blocked during queue mode");
  }
}

async function handleTaskComplete(
  projectDir: string,
  args: Omit<z.infer<typeof taskCompleteSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_task_complete", projectDir, args.milestoneId);
  const { executeTaskComplete } = await getWorkflowToolExecutors();
  // Pass `args` through directly rather than destructure-then-rebuild. The
  // previous implementation re-listed each field, which silently dropped
  // schema fields that weren't in the rebuild list (e.g., ADR-011's
  // `escalation` payload). The destructure-then-rebuild pattern is the bug
  // class; matching the spread shape used by sibling handlers (handleSliceComplete,
  // handleReplanSlice) eliminates the recurrence risk by construction.
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskComplete(args, projectDir, invocation)),
  );
}

async function handleTaskReopen(
  projectDir: string,
  args: Omit<z.infer<typeof taskReopenSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_task_reopen", projectDir, args.milestoneId);
  const { executeTaskReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskReopen(args, projectDir, invocation)),
  );
}

async function handleTaskRecoveryResume(
  projectDir: string,
  args: Omit<z.infer<typeof taskRecoveryResumeSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(async () => {
      const resolvedProjectDir = await resolveRecoveryActionProjectDir(projectDir, args.recoveryActionId);
      await enforceWorkflowWriteGate("gsd_task_recovery_resume", resolvedProjectDir);
      const { executeTaskRecoveryResume } = await getWorkflowToolExecutors();
      return executeTaskRecoveryResume(args, resolvedProjectDir, invocation);
    }),
  );
}

async function handleTaskSettle(
  projectDir: string,
  args: Omit<z.infer<typeof taskSettleSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  // Dry-run is read-only; only an applying settle crosses the write gate.
  if (args.apply === true) {
    await enforceWorkflowWriteGate("gsd_task_settle", projectDir, args.milestoneId);
  }
  const { executeTaskSettle } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskSettle(args, projectDir, invocation)),
  );
}

async function handleSliceReopen(
  projectDir: string,
  args: Omit<z.infer<typeof sliceReopenSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_slice_reopen", projectDir, args.milestoneId);
  const { executeSliceReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSliceReopen(args, projectDir, invocation)),
  );
}

async function handleMilestoneReopen(
  projectDir: string,
  args: Omit<z.infer<typeof milestoneReopenSchema>, "projectDir">,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_milestone_reopen", projectDir, args.milestoneId);
  const { executeMilestoneReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeMilestoneReopen(args, projectDir, invocation)),
  );
}

async function handleSliceComplete(
  projectDir: string,
  args: z.infer<typeof sliceCompleteSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_slice_complete", projectDir, args.milestoneId);
  const { executeSliceComplete } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSliceComplete(params, projectDir, invocation)),
  );
}

async function handleSkipSlice(
  projectDir: string,
  args: z.infer<typeof skipSliceSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_skip_slice", projectDir, args.milestoneId);
  const { executeSkipSlice } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSkipSlice(params, projectDir, invocation)),
  );
}

async function handleReplanSlice(
  projectDir: string,
  args: z.infer<typeof replanSliceSchema>,
  invocation: PlanningInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_replan_slice", projectDir, args.milestoneId);
  const { executeReplanSlice } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReplanSlice(params, projectDir, invocation)),
  );
}

async function handleReplanTask(
  projectDir: string,
  args: z.infer<typeof replanTaskSchema>,
  invocation: PlanningInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_replan_task", projectDir, args.milestoneId);
  const { executeReplanTask } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReplanTask(params, projectDir, invocation)),
  );
}

async function handleReworkBriefSave(
  projectDir: string,
  args: z.infer<typeof reworkBriefSaveSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_rework_brief_save", projectDir, args.milestoneId);
  const { executeReworkBriefSave } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReworkBriefSave(params, projectDir)),
  );
}

async function handleCompleteMilestone(
  projectDir: string,
  args: z.infer<typeof completeMilestoneSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_complete_milestone", projectDir, args.milestoneId);
  const { executeCompleteMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeCompleteMilestone(params, projectDir, invocation)),
  );
}

async function handleValidateMilestone(
  projectDir: string,
  args: z.infer<typeof validateMilestoneSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_validate_milestone", projectDir, args.milestoneId);
  const { executeValidateMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() =>
      executeValidateMilestone(params, projectDir, { invocation })
    ),
  );
}

async function handlePrepareMilestoneSubjectiveUat(
  projectDir: string,
  args: z.infer<typeof prepareMilestoneSubjectiveUatSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate(
    "gsd_prepare_milestone_subjective_uat",
    projectDir,
    args.milestoneId,
  );
  const { executePrepareMilestoneSubjectiveUat } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(await runSerializedWorkflowOperation(() =>
    executePrepareMilestoneSubjectiveUat(params, projectDir, invocation)
  ));
}

async function handleAnswerMilestoneSubjectiveUat(
  projectDir: string,
  args: z.infer<typeof answerMilestoneSubjectiveUatSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  const { executeAnswerMilestoneSubjectiveUat } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(await runSerializedWorkflowOperation(() =>
    executeAnswerMilestoneSubjectiveUat(params, projectDir, invocation)
  ));
}

async function handleReassessRoadmap(
  projectDir: string,
  args: z.infer<typeof reassessRoadmapSchema>,
  invocation: PlanningInvocation,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_reassess_roadmap", projectDir, args.milestoneId);
  const { executeReassessRoadmap } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReassessRoadmap(params, projectDir, invocation)),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function inferMilestoneIdFromProjectDir(projectDir: string): string | undefined {
  const name = basename(projectDir);
  const match = /^M\d+(?:-[A-Za-z0-9]+)?$/.exec(name);
  return match?.[0];
}

type GateDbModule = {
  getAllMilestones?: () => Array<{ id?: unknown }>;
  getMilestoneSlices?: (milestoneId: string) => Array<{ id?: unknown; sequence?: unknown; status?: unknown }>;
  getPendingGates?: (milestoneId: string, sliceId: string) => Array<Record<string, unknown>>;
  getGateResults?: (milestoneId: string, sliceId: string) => Array<Record<string, unknown>>;
};

async function inferSaveGateResultScope(
  projectDir: string,
  prepared: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out = { ...prepared };
  const gateId = stringValue(out.gateId)?.toUpperCase();
  const taskId = stringValue(out.taskId);

  if (!stringValue(out.milestoneId)) {
    const inferredMilestoneId = inferMilestoneIdFromProjectDir(projectDir);
    if (inferredMilestoneId) out.milestoneId = inferredMilestoneId;
  }

  if (stringValue(out.milestoneId) && stringValue(out.sliceId)) return out;
  if (!gateId) return out;

  const bridge = await importBridgeModule();
  if (!(await bridge.ensureDbOpen(projectDir))) return out;

  if (!bridge.getMilestoneSlices || !bridge.getPendingGates || !bridge.getGateResults) return out;

  const milestoneFilter = stringValue(out.milestoneId);
  const sliceFilter = stringValue(out.sliceId);
  const milestones = milestoneFilter
    ? [{ id: milestoneFilter }]
    : (bridge.getAllMilestones?.() ?? []).filter((milestone: unknown) => stringValue((milestone as { id?: unknown }).id));

  const candidates: Array<{ milestoneId: string; sliceId: string; taskId?: string }> = [];
  for (const milestone of milestones) {
    const milestoneId = stringValue(milestone.id);
    if (!milestoneId) continue;
    const slices = bridge.getMilestoneSlices(milestoneId)
      .filter((slice: unknown) => {
        const sliceId = stringValue((slice as { id?: unknown }).id);
        return sliceId && (!sliceFilter || sliceId === sliceFilter);
      });

    for (const slice of slices) {
      const sliceId = stringValue((slice as { id?: unknown }).id);
      if (!sliceId) continue;
      const rows = [
        ...bridge.getPendingGates(milestoneId, sliceId),
        ...bridge.getGateResults(milestoneId, sliceId),
      ];
      for (const row of rows) {
        if (stringValue(row.gate_id)?.toUpperCase() !== gateId) continue;
        const rowTaskId = stringValue(row.task_id) ?? "";
        if (taskId && rowTaskId !== taskId) continue;
        candidates.push({ milestoneId, sliceId, taskId: rowTaskId || undefined });
      }
    }
  }

  const unique = new Map<string, { milestoneId: string; sliceId: string; taskId?: string }>();
  for (const candidate of candidates) {
    unique.set(`${candidate.milestoneId}/${candidate.sliceId}/${candidate.taskId ?? ""}`, candidate);
  }

  if (unique.size === 1) {
    const only = [...unique.values()][0]!;
    if (!stringValue(out.milestoneId)) out.milestoneId = only.milestoneId;
    if (!stringValue(out.sliceId)) out.sliceId = only.sliceId;
    if (!stringValue(out.taskId) && only.taskId) out.taskId = only.taskId;
  }

  return out;
}

async function handleSaveGateResult(
  projectDir: string,
  args: z.infer<typeof saveGateResultSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_save_gate_result", projectDir, args.milestoneId);
  const { executeSaveGateResult } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSaveGateResult(params, projectDir)),
  );
}

async function ensureMilestoneDbRow(milestoneId: string): Promise<void> {
  try {
    const bridge = await importBridgeModule();
    bridge.insertMilestone({ id: milestoneId, status: "queued" });
  } catch {
    // Ignore pre-existing rows or transient DB availability issues.
  }
}

async function findDatabaseMilestoneIds(): Promise<string[]> {
  try {
    const bridge = await importBridgeModule();
    return (bridge.getAllMilestones?.() ?? [])
      .map((milestone: unknown) => {
        const id = (milestone as { id?: unknown })?.id;
        return typeof id === "string" ? id : null;
      })
      .filter((id: string | null): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * Fix #4996: Shared helper for both gsd_milestone_generate_id and
 * gsd_generate_milestone_id. Reuses the lowest reusable ghost milestone ID
 * (a disk-only stub with no DB row, no worktree, no content files) before
 * falling back to max+1. Uses the stricter `isReusableGhostMilestone` —
 * not `isGhostMilestone` — to avoid racing with in-flight queued DB rows
 * from an earlier call to this same tool.
 */
async function generateOrReuseMilestoneId(projectDir: string): Promise<string> {
  const bridge = await importBridgeModule();
  const {
    claimReservedId,
    findMilestoneIds,
    getReservedMilestoneIds,
    nextMilestoneId,
    milestoneIdSort,
  } = bridge;

  const reserved = claimReservedId();
  if (reserved) {
    await ensureMilestoneDbRow(reserved);
    return reserved;
  }

  const allIds = [
    ...new Set([
      ...findMilestoneIds(projectDir),
      ...getReservedMilestoneIds(),
      ...(await findDatabaseMilestoneIds()),
    ]),
  ];

  // Attempt ghost-ID reuse before falling back to max+1.
  const { isReusableGhostMilestone } = bridge;
  const sorted = [...allIds].sort(milestoneIdSort);
  for (const candidate of sorted) {
    if (isReusableGhostMilestone(projectDir, candidate)) {
      await ensureMilestoneDbRow(candidate);
      return candidate;
    }
  }

  const prefsMod = await importBridgeModule().catch(() => null);
  // Graceful degradation: a corrupt preferences file should not crash
  // milestone-id generation. Fall back to non-unique IDs if anything
  // throws here — matches the pre-fix behavior for missing prefs.
  let uniqueEnabled = false;
  try {
    uniqueEnabled = !!prefsMod?.loadEffectiveGSDPreferences?.(projectDir)?.preferences?.unique_milestone_ids;
  } catch {
    uniqueEnabled = false;
  }
  const nextId = nextMilestoneId(allIds, uniqueEnabled);
  await ensureMilestoneDbRow(nextId);
  return nextId;
}

// projectDir is optional. When omitted, the server uses process.cwd(). This
// prevents the agent from burning tokens reasoning about which absolute path
// to pass (git root vs worktree vs symlink-resolved external state layout) —
// the server already knows where it is running.
const projectDirParam = z
  .string()
  .optional()
  .describe("Optional. Omit this field — the server defaults to its current working directory, which is already the correct project or worktree root.");

const unknownRecord = z.record(z.string(), z.unknown());

/** Split "id — detail" / "id - detail" pairs used by legacy string payloads. */
function splitPair(value: string): [string, string] {
  const match = value.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
  return match ? [match[1].trim(), match[2].trim()] : [value.trim(), ""];
}

/** Accept string or string[] at runtime; emit array-only JSON Schema (no anyOf). */
const optionalStringOrStringArray = () =>
  z.preprocess(
    (value) => (value == null ? value : Array.isArray(value) ? value : [value]),
    z.array(z.string()).optional(),
  );

function optionalStructuredStringArray<T extends z.ZodTypeAny>(
  itemSchema: T,
  coerceString: (value: string) => z.infer<T>,
) {
  return z.preprocess(
    (value) => {
      if (value == null) return value;
      if (!Array.isArray(value)) return value;
      return value.map((item) => (typeof item === "string" ? coerceString(item) : item));
    },
    z.array(itemSchema).optional(),
  );
}

const requirementAdvancedItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const [id, how] = splitPair(value);
    return { id, how };
  },
  z.object({ id: z.string(), how: z.string() }),
);

const requirementValidatedItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const [id, proof] = splitPair(value);
    return { id, proof };
  },
  z.object({ id: z.string(), proof: z.string() }),
);

const requirementInvalidatedItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const [id, what] = splitPair(value);
    return { id, what };
  },
  z.object({ id: z.string(), what: z.string() }),
);

const filesModifiedItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const [path, description] = splitPair(value);
    return { path, description };
  },
  z.object({ path: z.string(), description: z.string() }),
);

const requiresItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const [slice, provides] = splitPair(value);
    return { slice, provides };
  },
  z.object({ slice: z.string(), provides: z.string() }),
);

// Accept either a string (legacy command-only form) or the structured object.
// Mirrors `normalizeVerificationEvidence` in the executor: strings are coerced
// into the canonical object shape before Zod validates, so the emitted JSON
// Schema stays a single object type (no anyOf/oneOf) for Moonshot/Kimi.
const verificationEvidenceItemSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    return {
      command: value,
      exitCode: -1,
      verdict: "unknown (coerced from string)",
      durationMs: 0,
    };
  },
  z.object({
    command: z.string(),
    exitCode: z.number(),
    verdict: z.string(),
    durationMs: z.number(),
  }),
);

const verificationEvidenceSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z.array(verificationEvidenceItemSchema),
);

const nonEmptyString = (field: string) =>
  z.string().trim().min(1, `${field} must be a non-empty string`);

// Optional non-empty string: accepts omitted/undefined but rejects "" or
// whitespace. Mirrors executor guards of the form
// `value !== undefined && !isNonEmptyString(value)` — e.g. plan-task's
// observabilityImpact. Do not preprocess "" to undefined; the executor
// treats them differently.
const optionalNonEmptyString = (field: string) => nonEmptyString(field).optional();

// Array of non-empty strings. Mirrors executor guards that call
// `validateStringArray` or `arr.some((item) => !isNonEmptyString(item))`.
const nonEmptyStringArray = (field: string) =>
  z.array(nonEmptyString(`${field}[]`));

// Matches the executor's `isNonEmptyString` (trim + length>0) so Zod rejects
// empty/whitespace fields at parse time. Without this, MCP callers pass "" for
// the heavy planning fields, Zod accepts it, and the executor rejects one
// field per call — forcing the agent into a retry loop to discover every gap.
//
// #4759 follow-up: the four heavy fields are Zod-optional because sketch
// slices (isSketch=true) legitimately omit them, but they are REQUIRED for
// every other slice. The conditional requirement is invisible in the JSON
// Schema `required` array, so callers can only discover it from the
// descriptions or by hitting the runtime superRefine below. The `.describe()`
// calls below make that contract unmistakable in the tool schema sent to
// agents; the superRefine enforces it at parse time.
const HEAVY_FIELD_DESCRIBE = (field: string) =>
  `${field} for this slice. REQUIRED unless isSketch=true (sketch slices defer this to refine-slice).`;

const planMilestoneSliceSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: nonEmptyString("risk"),
  depends: z.array(z.string()),
  demo: nonEmptyString("demo"),
  goal: nonEmptyString("goal"),
  // ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
  successCriteria: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("successCriteria")),
  proofLevel: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("proofLevel")),
  integrationClosure: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("integrationClosure")),
  observabilityImpact: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("observabilityImpact")),
  // ADR-011 sketch-then-refine fields.
  isSketch: z.boolean().optional().describe("ADR-011: true marks this slice as a sketch awaiting refine-slice expansion. When true, successCriteria/proofLevel/integrationClosure/observabilityImpact may be omitted and sketchScope becomes required."),
  sketchScope: z.string().optional().describe("ADR-011: 2-3 sentence scope boundary, required when isSketch=true"),
}).describe(
  "Planned slice. For full slices (isSketch omitted or false): successCriteria, proofLevel, integrationClosure, and observabilityImpact are all required. For sketch slices (isSketch=true): those four fields may be omitted, but sketchScope is required.",
).superRefine((slice, ctx) => {
  if (slice.isSketch === true) {
    if (typeof slice.sketchScope !== "string" || slice.sketchScope.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sketchScope"],
        message: "sketchScope must be a non-empty string when isSketch is true",
      });
    }
    return;
  }
  const required = ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"] as const;
  for (const field of required) {
    const value = slice[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a non-empty string`,
      });
    }
  }
});

const planMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  vision: nonEmptyString("vision").describe("Milestone vision"),
  slices: z.array(planMilestoneSliceSchema).describe("Planned slices for the milestone"),
  status: z.string().optional().describe("Milestone status"),
  dependsOn: z.array(z.string()).optional().describe("Milestone dependencies"),
  successCriteria: z.array(z.string()).optional().describe("Top-level success criteria bullets"),
  keyRisks: z.array(z.object({
    risk: nonEmptyString("risk"),
    whyItMatters: nonEmptyString("whyItMatters"),
  })).optional().describe("Structured risk entries"),
  proofStrategy: z.array(z.object({
    riskOrUnknown: nonEmptyString("riskOrUnknown"),
    retireIn: nonEmptyString("retireIn"),
    whatWillBeProven: nonEmptyString("whatWillBeProven"),
  })).optional().describe("Structured proof strategy entries"),
  verificationContract: z.string().optional(),
  verificationIntegration: z.string().optional(),
  verificationOperational: z.string().optional(),
  verificationUat: z.string().optional(),
  definitionOfDone: z.array(z.string()).optional(),
  requirementCoverage: z.string().optional(),
  boundaryMapMarkdown: z.string().optional(),
};
const planMilestoneSchema = z.object(planMilestoneParams);

const planSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  goal: nonEmptyString("goal").describe("Slice goal"),
  tasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: nonEmptyString("description"),
    estimate: nonEmptyString("estimate"),
    files: nonEmptyStringArray("files"),
    verify: nonEmptyString("verify"),
    inputs: nonEmptyStringArray("inputs"),
    expectedOutput: nonEmptyStringArray("expectedOutput"),
    requiredWorkflowTools: z.array(z.string()).describe("Workflow tools required during execute-task; use [] for ordinary tasks"),
    observabilityImpact: optionalNonEmptyString("observabilityImpact"),
  })).optional().describe("Optional full task replacement for the slice. Omit for incremental planning, then call gsd_plan_task once per task."),
  successCriteria: z.string().optional(),
  proofLevel: z.string().optional(),
  integrationClosure: z.string().optional(),
  observabilityImpact: z.string().optional(),
};
const planSliceSchema = z.object(planSliceParams);

const completeMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  oneLiner: z.string().describe("One-sentence summary of what the milestone achieved"),
  narrative: z.string().describe("Detailed narrative of what happened during the milestone"),
  verificationPassed: z.boolean().describe("Must be true after milestone verification succeeds"),
  successCriteriaResults: z.string().optional(),
  definitionOfDoneResults: z.string().optional(),
  requirementOutcomes: z.string().optional(),
  keyDecisions: z.array(z.string()).optional(),
  keyFiles: z.array(z.string()).optional(),
  lessonsLearned: z.array(z.string()).optional(),
  followUps: z.string().optional(),
  deviations: z.string().optional(),
  actorName: z.string().optional().describe("Caller-provided actor identity for the audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered"),
};
const completeMilestoneSchema = z.object(completeMilestoneParams);

const validateMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  verdict: z.enum(["pass", "needs-attention", "needs-remediation"]).describe("Validation verdict"),
  remediationRound: z.number().describe("Remediation round (0 for first validation)"),
  successCriteriaChecklist: z.string().describe("Markdown checklist of success criteria with evidence"),
  sliceDeliveryAudit: z.string().describe("Markdown auditing each slice's claimed vs delivered output"),
  crossSliceIntegration: z.string().describe("Markdown describing cross-slice issues or closure"),
  requirementCoverage: z.string().describe("Markdown describing requirement coverage and gaps"),
  verificationClasses: z.string().optional().describe("Complete markdown table with one canonical row for every applicable planned verification class: Contract, Integration, Operational, and UAT"),
  verificationEvidence: z.array(z.object({
    verificationClass: z.enum(["Contract", "Integration", "Operational", "UAT"]),
    sliceId: nonEmptyString("sliceId").optional(),
    evidenceClass: z.enum(["command", "runtime", "browser", "artifact"]),
    rationale: nonEmptyString("rationale"),
    commandOrTool: nonEmptyString("commandOrTool"),
    workingDirectory: nonEmptyString("workingDirectory"),
    startedAt: nonEmptyString("startedAt"),
    endedAt: nonEmptyString("endedAt"),
    exitCode: z.number().optional(),
    observation: z.enum(["passed", "failed", "inconclusive"]),
    durableOutputRef: nonEmptyString("durableOutputRef"),
    testedSourceRevision: nonEmptyString("testedSourceRevision"),
    environment: z.record(z.string(), z.unknown()).refine(
      (value) => Object.keys(value).length > 0,
      "environment must contain at least one field",
    ),
  }).strict()).optional().describe("Current source-bound structured evidence for each applicable planned verification class"),
  verdictRationale: z.string().describe("Why this verdict was chosen"),
  remediationPlan: z.string().optional(),
};
const validateMilestoneSchema = z.object(validateMilestoneParams);

const prepareMilestoneSubjectiveUatParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId"),
  criterionKey: nonEmptyString("criterionKey"),
  description: nonEmptyString("description"),
  focusedPrompt: nonEmptyString("focusedPrompt"),
  recommendedDisposition: z.enum(["accepted", "rejected"]),
  recommendationRationale: nonEmptyString("recommendationRationale"),
  recommendationEvidence: nonEmptyString("recommendationEvidence"),
  testedSourceRevision: nonEmptyString("testedSourceRevision"),
  recommendationConfidence: z.number().min(0).max(1).optional(),
  requirementId: nonEmptyString("requirementId").optional(),
  required: z.boolean().optional(),
};
const prepareMilestoneSubjectiveUatSchema = z.object(prepareMilestoneSubjectiveUatParams);

const answerMilestoneSubjectiveUatParams = {
  projectDir: projectDirParam,
  criterionId: nonEmptyString("criterionId"),
  questionId: nonEmptyString("questionId"),
  interactionId: nonEmptyString("interactionId"),
  selectedOptionId: nonEmptyString("selectedOptionId"),
  verbatimResponse: nonEmptyString("verbatimResponse"),
  rationale: nonEmptyString("rationale"),
  testedSourceRevision: nonEmptyString("testedSourceRevision"),
};
const answerMilestoneSubjectiveUatSchema = z.object(answerMilestoneSubjectiveUatParams);

const roadmapSliceChangeSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: z.string().optional(),
  depends: z.array(z.string()).optional(),
  demo: z.string().optional(),
});

const reassessRoadmapParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  completedSliceId: nonEmptyString("completedSliceId").describe("Slice ID that just completed"),
  verdict: nonEmptyString("verdict").describe("Assessment verdict such as roadmap-confirmed or roadmap-adjusted"),
  assessment: nonEmptyString("assessment").describe("Assessment text explaining the roadmap decision"),
  sliceChanges: z.object({
    modified: z.array(roadmapSliceChangeSchema),
    added: z.array(roadmapSliceChangeSchema),
    removed: z.array(z.string()),
  }).describe("Slice changes to apply"),
  metadataCorrections: z.object({
    milestone: z.object({
      successCriteria: z.array(z.string()).optional(),
      verificationContract: z.string().optional(),
      verificationIntegration: z.string().optional(),
      verificationOperational: z.string().optional(),
      verificationUat: z.string().optional(),
      definitionOfDone: z.array(z.string()).optional(),
      requirementCoverage: z.string().optional(),
      boundaryMapMarkdown: z.string().optional(),
    }).strict().optional(),
    completedSlices: z.array(z.object({
      sliceId: nonEmptyString("sliceId"),
      demo: z.string().optional(),
      goal: z.string().optional(),
      successCriteria: z.string().optional(),
      proofLevel: z.string().optional(),
      integrationClosure: z.string().optional(),
      observabilityImpact: z.string().optional(),
    }).strict()).optional(),
  }).strict().optional().describe("Narrow DB-backed acceptance and completed-slice evidence corrections"),
};
const reassessRoadmapSchema = z.object(reassessRoadmapParams);

const saveGateResultParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  gateId: nonEmptyString("gateId").describe("Gate ID (e.g. Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04). Accepts any string for forward-compatibility with new gates."),
  taskId: z.string().optional().describe("Task ID for task-scoped gates"),
  verdict: z.enum(["pass", "flag", "omitted"]).describe("Gate verdict"),
  rationale: nonEmptyString("rationale").describe("One-sentence justification"),
  findings: z.string().optional().describe("Detailed markdown findings"),
};
const saveGateResultSchema = z.object(saveGateResultParams);

const saveGateResultIncomingParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().optional().describe("Milestone ID (e.g. M001). Required unless it can be inferred from the active worktree or pending gate row."),
  sliceId: z.string().optional().describe("Slice ID (e.g. S01). Required unless it can be inferred from the active pending gate row."),
  gateId: z.string().optional().describe("Gate ID (e.g. Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04)"),
  taskId: z.string().optional().describe("Task ID for task-scoped gates"),
  verdict: z.string().optional().describe("Gate verdict: pass, flag, or omitted"),
  rationale: z.string().optional().describe("One-sentence justification"),
  findings: z.string().optional().describe("Detailed markdown findings"),
  milestone_id: z.string().optional(),
  mid: z.string().optional(),
  milestone: z.string().optional(),
  slice_id: z.string().optional(),
  sid: z.string().optional(),
  slice: z.string().optional(),
  gate_id: z.string().optional(),
  gate: z.string().optional(),
  questionId: z.string().optional(),
  question_id: z.string().optional(),
  task_id: z.string().optional(),
  tid: z.string().optional(),
  task: z.string().optional(),
  result: z.string().optional(),
  status: z.string().optional(),
  outcome: z.string().optional(),
  reason: z.string().optional(),
  summary: z.string().optional(),
  justification: z.string().optional(),
  explanation: z.string().optional(),
  finding: z.string().optional(),
  details: z.string().optional(),
  analysis: z.string().optional(),
  report: z.string().optional(),
  arguments: unknownRecord.optional(),
  args: unknownRecord.optional(),
  params: unknownRecord.optional(),
  input: unknownRecord.optional(),
  payload: unknownRecord.optional(),
};
const saveGateResultIncomingSchema = z.object(saveGateResultIncomingParams);

const replanSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  blockerTaskId: nonEmptyString("blockerTaskId").describe("Task ID that discovered the blocker"),
  blockerDescription: nonEmptyString("blockerDescription").describe("Description of the blocker"),
  whatChanged: nonEmptyString("whatChanged").describe("Summary of what changed in the plan"),
  updatedTasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: z.string(),
    estimate: z.string(),
    files: z.array(z.string()),
    verify: z.string(),
    inputs: z.array(z.string()),
    expectedOutput: z.array(z.string()),
    requiredWorkflowTools: z.array(z.string()).describe("Workflow tools required during task execution; use [] for ordinary tasks"),
    fullPlanMd: z.string().optional(),
  })).describe("Tasks to upsert into the replanned slice"),
  removedTaskIds: z.array(z.string()).describe("Task IDs to remove from the slice"),
};
const replanSliceSchema = z.object(replanSliceParams);

const replanTaskParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  title: nonEmptyString("title").describe("Updated task title"),
  description: nonEmptyString("description").describe("Updated task description incorporating rework scope"),
  estimate: nonEmptyString("estimate").describe("Updated task estimate"),
  files: z.array(z.string()).describe("Updated files likely touched"),
  verify: nonEmptyString("verify").describe("Updated verification command or block"),
  inputs: z.array(z.string()).describe("Updated input files or references"),
  expectedOutput: z.array(z.string()).describe("Updated files this task creates or overwrites"),
  requiredWorkflowTools: z.array(z.string()).describe("Workflow tools required during task execution; use [] for ordinary tasks"),
  reworkBriefRef: z.string().optional().describe("Rework brief ID/reference that triggered this task replan"),
};
const replanTaskSchema = z.object(replanTaskParams);

const reworkFindingSchema = z.object({
  findingId: nonEmptyString("findingId"),
  severity: z.enum(["blocking", "advisory"]),
  description: nonEmptyString("description"),
  requiredFix: nonEmptyString("requiredFix"),
  verificationCommands: z.array(z.string()),
  status: z.enum(["pending", "resolved", "deferred-with-override"]).optional(),
  evidence: z.string().optional(),
  decisionRef: z.string().optional(),
});
const reworkBriefSaveParams = {
  projectDir: projectDirParam,
  briefId: z.string().optional().describe("Stable brief ID"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  findings: z.array(reworkFindingSchema).min(1).describe("Structured rework findings for this task"),
};
const reworkBriefSaveSchema = z.object(reworkBriefSaveParams);

const sliceCompleteParams = {
  projectDir: projectDirParam,
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceTitle: z.string().describe("Title of the slice"),
  oneLiner: z.string().describe("One-line summary of what the slice accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened across all tasks"),
  verification: z.string().optional().describe("Optional closeout prose describing verification. Durable Task proof is read from SQLite and cannot be supplied by this field."),
  uatContent: z.string().describe("UAT test content (markdown body)"),
  deviations: z.string().optional(),
  knownLimitations: z.string().optional(),
  followUps: z.string().optional(),
  keyFiles: optionalStringOrStringArray(),
  keyDecisions: optionalStringOrStringArray(),
  patternsEstablished: optionalStringOrStringArray(),
  observabilitySurfaces: optionalStringOrStringArray(),
  provides: optionalStringOrStringArray(),
  requirementsSurfaced: optionalStringOrStringArray(),
  drillDownPaths: optionalStringOrStringArray(),
  affects: optionalStringOrStringArray(),
  requirementsAdvanced: optionalStructuredStringArray(
    requirementAdvancedItemSchema,
    (value) => {
      const [id, how] = splitPair(value);
      return { id, how };
    },
  ),
  requirementsValidated: optionalStructuredStringArray(
    requirementValidatedItemSchema,
    (value) => {
      const [id, proof] = splitPair(value);
      return { id, proof };
    },
  ),
  requirementsInvalidated: optionalStructuredStringArray(
    requirementInvalidatedItemSchema,
    (value) => {
      const [id, what] = splitPair(value);
      return { id, what };
    },
  ),
  filesModified: optionalStructuredStringArray(
    filesModifiedItemSchema,
    (value) => {
      const [path, description] = splitPair(value);
      return { path, description };
    },
  ),
  requires: optionalStructuredStringArray(
    requiresItemSchema,
    (value) => {
      const [slice, provides] = splitPair(value);
      return { slice, provides };
    },
  ),
  actorName: z.string().optional().describe("Caller-provided actor identity for the audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered"),
};
const sliceCompleteSchema = z.object(sliceCompleteParams);
export const _sliceCompleteSchemaForTest = sliceCompleteSchema;

const summarySaveParams = {
  projectDir: projectDirParam,
  milestone_id: z.string().optional().describe("Milestone ID (e.g. M001). Omit only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts."),
  slice_id: z.string().optional().describe("Slice ID (e.g. S01)"),
  task_id: z.string().optional().describe("Task ID (e.g. T01)"),
  artifact_type: z.string().describe("Artifact type to save (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT)"),
  content: z.string()
    .max(SUMMARY_SAVE_CONTENT_MAX_LENGTH, `content must be at most ${SUMMARY_SAVE_CONTENT_MAX_LENGTH} characters per save`)
    .describe(`The full markdown content of the artifact. Maximum ${SUMMARY_SAVE_CONTENT_MAX_LENGTH} characters per save.`),
};
const ROOT_SUMMARY_ARTIFACT_TYPES = new Set([
  "PROJECT",
  "PROJECT-DRAFT",
  "REQUIREMENTS",
  "REQUIREMENTS-DRAFT",
]);
const summarySaveSchema = z.object(summarySaveParams).superRefine((value, ctx) => {
  const isRootArtifact = ROOT_SUMMARY_ARTIFACT_TYPES.has(value.artifact_type);
  if (!isRootArtifact && (!value.milestone_id || value.milestone_id.trim() === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["milestone_id"],
      message: "milestone_id is required for milestone-scoped artifact types",
    });
  }
});
export const _summarySaveSchemaForTest = summarySaveSchema;

const decisionSaveParams = {
  projectDir: projectDirParam,
  scope: z.string().describe("Scope of the decision (e.g. architecture, library, observability)"),
  decision: z.string().describe("What is being decided"),
  choice: z.string().describe("The choice made"),
  rationale: z.string().describe("Why this choice was made"),
  revisable: z.string().optional().describe("Whether this can be revisited"),
  when_context: z.string().optional().describe("When/context for the decision"),
  made_by: z.enum(["human", "agent", "collaborative"]).optional().describe("Who made the decision"),
};
const decisionSaveSchema = z.object(decisionSaveParams);

const requirementUpdateParams = {
  projectDir: projectDirParam,
  id: z.string().describe("Requirement ID (e.g. R001)"),
  status: z.string().optional().describe("New status"),
  validation: z.string().optional().describe("Validation criteria or proof"),
  notes: z.string().optional().describe("Additional notes"),
  description: z.string().optional().describe("Updated description"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
};
const requirementUpdateSchema = z.object(requirementUpdateParams);

const requirementSaveParams = {
  projectDir: projectDirParam,
  class: z.string().describe("Requirement class: core-capability, primary-user-loop, launchability, continuity, failure-visibility, integration, quality-attribute, operability, admin/support, compliance/security, differentiator, constraint, or anti-feature"),
  description: z.string().describe("Short description of the requirement"),
  why: z.string().describe("Why this requirement matters"),
  source: z.string().describe("Origin of the requirement"),
  status: z.string().optional().describe("Requirement status"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
  validation: z.string().optional().describe("Validation criteria"),
  notes: z.string().optional().describe("Additional notes"),
};
const requirementSaveSchema = z.object(requirementSaveParams);

const milestoneGenerateIdParams = {
  projectDir: projectDirParam,
};
const milestoneGenerateIdSchema = z.object(milestoneGenerateIdParams);

const planTaskParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  title: nonEmptyString("title").describe("Task title"),
  description: nonEmptyString("description").describe("Task description / steps block"),
  estimate: nonEmptyString("estimate").describe("Task estimate"),
  files: z.array(z.string()).describe("Files likely touched"),
  verify: nonEmptyString("verify").describe("Verification command or block"),
  inputs: z.array(z.string()).describe("Input files or references"),
  expectedOutput: z.array(z.string()).describe("Files this task creates or overwrites"),
  requiredWorkflowTools: z.array(z.string()).describe("Workflow tools required during execute-task; use [] for ordinary tasks"),
  observabilityImpact: optionalNonEmptyString("observabilityImpact").describe("Task observability impact"),
};
const planTaskSchema = z.object(planTaskParams);

const skipSliceParams = {
  projectDir: projectDirParam,
  sliceId: z.string().describe("Slice ID (e.g. S02)"),
  milestoneId: z.string().describe("Milestone ID (e.g. M003)"),
  reason: z.string().optional().describe("Reason for skipping this slice"),
};
const skipSliceSchema = z.object(skipSliceParams);

const taskCompleteParams = {
  projectDir: projectDirParam,
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  oneLiner: z.string().describe("One-line summary of what was accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened during the task"),
  verification: z.string().optional().describe("What was verified and how. If omitted, the executor derives this from verificationEvidence when possible."),
  deviations: z.string().optional().describe("Deviations from the task plan"),
  knownIssues: z.string().optional().describe("Known issues discovered but not fixed"),
  failureModes: z.string().optional().describe("Q5: what breaks when dependencies fail; omit only when genuinely not applicable"),
  loadProfile: z.string().optional().describe("Q6: expected load, 10x breakpoint, and protection; omit only when genuinely not applicable"),
  negativeTests: z.string().optional().describe("Q7: malformed inputs, error paths, and boundary tests; omit only when genuinely not applicable"),
  keyFiles: z.array(z.string()).optional().describe("List of key files created or modified"),
  keyDecisions: z.array(z.string()).optional().describe("List of key decisions made during this task"),
  blockerDiscovered: z.boolean().optional().describe("Whether a plan-invalidating blocker was discovered"),
  // ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
  escalation: z.object({
    question: z.string().describe("The question the user needs to answer — one clear sentence."),
    options: z.array(z.object({
      id: z.string().describe("Short id (e.g. 'A', 'B') used by /gsd escalate resolve."),
      label: z.string().describe("One-line label."),
      tradeoffs: z.string().describe("1-2 sentences on the tradeoffs of this option."),
    })).min(2).max(4).describe("2-4 options the user can choose between."),
    recommendation: z.string().describe("Option id the executor recommends."),
    recommendationRationale: z.string().describe("Why the recommendation — 1-2 sentences."),
    continueWithDefault: z.boolean().describe(
      "When true, the recommendation is recorded as the default, but auto-mode still pauses until the user resolves via /gsd escalate resolve.",
    ),
  }).optional().describe("ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true."),
  verificationEvidence: verificationEvidenceSchema.optional().describe("Verification evidence entries, or that array encoded as JSON"),
  reworkResolution: z.array(z.object({
    findingId: nonEmptyString("findingId"),
    status: z.enum(["resolved", "deferred-with-override"]),
    evidence: nonEmptyString("evidence"),
    decisionRef: z.string().optional(),
  })).optional().describe("Resolution evidence for structured rework findings linked to this task"),
};
const taskCompleteSchema = z.object(taskCompleteParams);

const taskReopenParams = {
  projectDir: projectDirParam,
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the task is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered"),
};
const taskReopenSchema = z.object(taskReopenParams);

const taskRecoveryResumeParams = {
  projectDir: projectDirParam,
  recoveryActionId: nonEmptyString("recoveryActionId").describe("Exact current abort or remediate Recovery Action ID"),
  repairSummary: nonEmptyString("repairSummary").describe("What was repaired and why retry is now safe"),
  evidence: unknownRecord.refine(
    (value) => Object.keys(value).length > 0,
    "evidence must be a non-empty object",
  ).describe("Structured evidence proving the repair"),
};
const taskRecoveryResumeSchema = z.object(taskRecoveryResumeParams);

const taskSettleParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  reason: nonEmptyString("reason").describe("Operator rationale recorded on the settled Attempt Result"),
  apply: z.boolean().optional().describe("Actually settle; omit or false for a dry run that changes nothing"),
  reconcileLifecycle: z.boolean().optional().describe(
    "After settling or an interrupted Attempt, adopt ready/completed; after a succeeded Attempt, adopt completed. Preserve SUMMARYs",
  ),
};
const taskSettleSchema = z.object(taskSettleParams);

const sliceReopenParams = {
  projectDir: projectDirParam,
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the slice is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered"),
};
const sliceReopenSchema = z.object(sliceReopenParams);

const milestoneReopenParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the milestone is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered"),
  keepCompleted: z.boolean().optional().describe("When true, unlock the milestone without resetting completed slices/tasks or deleting their SUMMARY projections. Default false (full cascade reset)."),
};
const milestoneReopenSchema = z.object(milestoneReopenParams);

const milestoneStatusParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID to query (e.g. M001)"),
};
const milestoneStatusSchema = z.object(milestoneStatusParams);

const checkpointDbParams = {
  projectDir: projectDirParam,
};
const checkpointDbSchema = z.object(checkpointDbParams);

const journalQueryParams = {
  projectDir: projectDirParam,
  flowId: z.string().optional().describe("Filter by flow ID"),
  unitId: z.string().optional().describe("Filter by unit ID"),
  rule: z.string().optional().describe("Filter by rule name"),
  eventType: z.string().optional().describe("Filter by event type"),
  after: z.string().optional().describe("ISO-8601 lower bound (inclusive)"),
  before: z.string().optional().describe("ISO-8601 upper bound (inclusive)"),
  limit: z.number().optional().describe("Maximum entries to return"),
};
const journalQuerySchema = z.object(journalQueryParams);

const execRuntimeSchema = z.string();
const execParams = {
  projectDir: projectDirParam,
  runtime: execRuntimeSchema
    .optional()
    .describe("Optional interpreter. Defaults to bash. Supported: bash, node, python; sh/shell, js/nodejs, and py/python3 aliases are accepted."),
  script: z.string().optional().describe("Script body. Keep output small; capped stdout/stderr are persisted under .gsd/exec."),
  command: z.string().optional().describe("Alias for script; defaults to bash when runtime is omitted."),
  cmd: z.string().optional().describe("Short alias for script."),
  code: z.string().optional().describe("Alias for script, useful for node/python snippets."),
  purpose: z.string().optional().describe("Short label recorded in meta.json for later review."),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe("Per-invocation timeout in milliseconds."),
};
const execSchema = z.object(execParams);

const uatExecIntentSchema = z.enum([
  "uat-artifact-check",
  "uat-runtime-check",
  "uat-browser-check",
  "uat-service-start",
  "uat-log-inspection",
]);
const uatExecParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  checkId: nonEmptyString("checkId").describe("Stable check ID from the UAT spec"),
  intent: uatExecIntentSchema.describe("UAT command intent"),
  runtime: execRuntimeSchema
    .optional()
    .describe("Optional interpreter. Defaults to bash. Supported: bash, node, python; sh/shell, js/nodejs, and py/python3 aliases are accepted."),
  script: z.string().optional().describe("Script body. Keep output small; capped stdout/stderr are persisted under .gsd/exec."),
  command: z.string().optional().describe("Alias for script; defaults to bash when runtime is omitted."),
  cmd: z.string().optional().describe("Short alias for script."),
  code: z.string().optional().describe("Alias for script, useful for node/python snippets."),
  expected: z.string().optional().describe("Expected outcome for this UAT check."),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe("Per-invocation timeout in milliseconds."),
};
const uatExecSchema = z.object(uatExecParams);

const uatEvidenceKindValues = ["gsd_uat_exec", "gsd_exec", "screenshot", "log", "url", "browser"] as const;
const uatEvidenceRefDescription =
  "Kind-specific evidence ref: gsd_uat_exec/gsd_exec use an evidence id or .gsd/exec/*.meta.json path; " +
  "screenshot/log use a path under .gsd/exec/, .gsd/uat/, or .artifacts/browser/; " +
  "url uses an http(s) URL; browser uses an http(s) URL or .artifacts/browser/ path.";
const uatEvidenceRefSchema = z.object({
  kind: z.enum(uatEvidenceKindValues).describe(`Evidence kind. Valid values: ${uatEvidenceKindValues.join(", ")}`),
  ref: nonEmptyString("ref").describe(uatEvidenceRefDescription),
  note: z.string().optional(),
});
const uatCheckSchema = z.object({
  id: nonEmptyString("id"),
  description: nonEmptyString("description"),
  mode: z.enum(["artifact", "runtime", "browser", "human-follow-up"]),
  result: z.enum(["PASS", "FAIL", "NEEDS-HUMAN"]),
  evidence: z.array(uatEvidenceRefSchema).optional(),
  notes: z.string().optional(),
  nonAutomatable: z.boolean().optional(),
});
const uatPresentationSchema = z.object({
  surface: z.enum(["provider-tools", "claude-code-sdk", "mcp", "hybrid"]),
  model: z.object({
    provider: z.string().optional(),
    api: z.string().optional(),
    id: z.string().optional(),
  }).optional(),
  presentedTools: z.array(z.string()),
  blockedTools: z.array(z.object({ name: z.string(), reason: z.string() })),
  aliases: z.array(z.object({ requested: z.string(), canonical: z.string() })).optional(),
  fallbackToolsUsed: z.array(z.string()).optional(),
  toolPresentationPlanId: z.string().optional(),
  notes: z.string().optional(),
});
const uatResultSaveParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  uatType: z.enum(["artifact-driven", "browser-executable", "runtime-executable", "live-runtime", "mixed", "human-experience"]).describe("Declared UAT mode"),
  verdict: z.enum(["PASS", "FAIL", "PARTIAL"]).describe("Overall UAT verdict"),
  checks: z.array(uatCheckSchema).min(1).describe("Structured check results"),
  presentation: uatPresentationSchema.describe("Tool-presentation evidence"),
  notes: z.string().optional().describe("Overall verdict rationale"),
  // Accept number (e.g. 1) or string (e.g. "1", "auto") and coerce to string
  // before validation, so the emitted JSON Schema stays a single primitive type
  // (no anyOf/oneOf) for Moonshot/Kimi. The executor still treats "auto" and
  // numeric strings as previously.
  attempt: z.preprocess(
    (value) => (typeof value === "number" ? String(value) : value),
    z.string().optional(),
  ).describe("Attempt number or auto"),
  previousAttemptId: z.string().optional(),
};
const uatResultSaveSchema = z.object(uatResultSaveParams);

const execSearchParams = {
  projectDir: projectDirParam,
  query: z.string().optional().describe("Substring matched against id and purpose, case-insensitive."),
  runtime: z.enum(["bash", "node", "python"]).optional().describe("Restrict to one runtime."),
  failing_only: z.boolean().optional().describe("Only non-zero exit codes and timeouts."),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20, cap 200)."),
};
const execSearchSchema = z.object(execSearchParams);

const resumeParams = {
  projectDir: projectDirParam,
};
const resumeSchema = z.object(resumeParams);

/**
 * Wrap a real McpToolServer so every handler we register catches thrown
 * errors and returns a structured `{isError: true, content: [...]}` MCP
 * tool result instead of letting the SDK convert the throw into a
 * JSON-RPC error frame. Some MCP hosts (notably Cursor) surface JSON-RPC
 * errors as a generic "tool failed" with no message, which strips the
 * agent of the context it needs to recover (write-gate blocks, schema
 * mismatches, downstream RPC failures).
 *
 * Read-only tools in server.ts use the same pattern via per-handler
 * try/catch + errorContent(). This shim applies it uniformly to every
 * mutation handler in this module.
 */
function wrapServerWithErrorHandler(realServer: McpToolServer): McpToolServer {
  return {
    tool(name, description, params, handler) {
      return realServer.tool(name, description, params, async (args, extra) => {
        try {
          return await handler(args, extra);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: message }],
          };
        }
      });
    },
  };
}

export interface RegisterWorkflowToolsOptions {
  /**
   * Whether to advertise the 17 backwards-compatibility alias tools in the
   * server's tool list. Defaults to `true` so in-process callers (e.g. the
   * daemon's handler map) keep resolving alias names. The MCP subprocess
   * passes `false` by default to drop ~6.8K tokens/turn of duplicate alias
   * schemas from the model-facing surface; canonical names are always
   * registered.
   */
  advertiseAliases?: boolean;
}

export function registerWorkflowTools(
  realServer: McpToolServer,
  options: RegisterWorkflowToolsOptions = {},
): void {
  const advertiseAliases = options.advertiseAliases ?? true;
  const wrapped = wrapServerWithErrorHandler(realServer);
  // When aliases are not advertised, skip their registration entirely so they
  // never enter the tool list. Canonical tools always register. Alias handlers
  // remain available wherever advertiseAliases is true (e.g. the daemon).
  const server: McpToolServer = advertiseAliases
    ? wrapped
    : {
        tool(name, description, params, handler) {
          if (WORKFLOW_TOOL_ALIAS_NAME_SET.has(name)) return undefined;
          return wrapped.tool(name, description, params, handler);
        },
      };
  server.tool(
    "gsd_decision_save",
    "Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved decision ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_save_decision",
    "Alias for gsd_decision_save. Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args: Record<string, unknown>) => {
      logAliasUsage("gsd_save_decision", "gsd_decision_save");
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved decision ${result.id}` }] };
    },
  );

  // ─── PR #1613: Canonical read tools for requirements and decisions ───────
  //
  // Read-only access to the canonical GSD database state. These tools
  // return the DB truth, not projections (REQUIREMENTS.md, DECISIONS.md).
  // Error contracts: db_unavailable, not_found, query_error.

  const decisionListSchema = z.object({
    projectDir: z.string().optional(),
    scope: z.string().optional(),
    milestoneId: z.string().optional(),
    includeSuperseded: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });

  server.tool(
    "gsd_decision_list",
    "List decisions from the GSD database. Returns canonical store (never stale). Use instead of parsing DECISIONS.md.",
    {
      projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
      scope: z.string().optional().describe("Filter by scope (exact match)."),
      milestoneId: z.string().optional().describe("Filter by milestone ID in when_context."),
      includeSuperseded: z.boolean().optional().describe("Include superseded decisions (default false)."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum results (default 200, max 500)."),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(decisionListSchema, args);
      try {
        return await runSerializedCanonicalReadOperation(projectDir, async (adapter: any) => {
          const { queryDecisionsWithLimit } = await importWorkflowRuntimeModule<any>(
            "../../../src/resources/extensions/gsd/context-store.js",
          );
          const limit = Math.min(params.limit ?? 200, 500);
          const results = queryDecisionsWithLimit(
            {
              scope: params.scope ?? undefined,
              milestoneId: params.milestoneId ?? undefined,
              includeSuperseded: params.includeSuperseded ?? false,
              limit,
            },
            adapter,
          );
          return {
            content: [{ type: "text" as const, text: `Found ${results.length} decision(s).` }],
            details: { operation: "list_decisions", count: results.length, decisions: results },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mapCanonicalReadError("list_decisions", message);
      }
    },
  );

  const decisionGetSchema = z.object({
    projectDir: z.string().optional(),
    id: z.string(),
    includeSuperseded: z.boolean().optional(),
  });

  server.tool(
    "gsd_decision_get",
    "Fetch a single decision by ID from the GSD database. Returns the full row or error (not_found / db_unavailable).",
    {
      projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
      id: z.string().describe("Decision ID (e.g. 'D007')."),
      includeSuperseded: z.boolean().optional().describe("Include superseded decisions (default false)."),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(decisionGetSchema, args);
      try {
        return await runSerializedCanonicalReadOperation(projectDir, async (adapter: any) => {
          const { getDecisionByIdStrict } = await importWorkflowRuntimeModule<any>(
            "../../../src/resources/extensions/gsd/context-store.js",
          );
          const decision = getDecisionByIdStrict(
            params.id,
            params.includeSuperseded ?? false,
            adapter,
          );
          if (!decision) {
            return {
              content: [{ type: "text" as const, text: `Decision ${params.id} not found.` }],
              details: { operation: "get_decision", id: params.id, error: "not_found" },
            };
          }
          return {
            content: [{ type: "text" as const, text: `Decision ${decision.id}: ${decision.decision}` }],
            details: { operation: "get_decision", id: decision.id, decision },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mapCanonicalReadError("get_decision", message, params.id);
      }
    },
  );

  server.tool(
    "gsd_requirement_update",
    "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Updated requirement ${id}` }] };
    },
  );

  server.tool(
    "gsd_update_requirement",
    "Alias for gsd_requirement_update. Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args: Record<string, unknown>) => {
      logAliasUsage("gsd_update_requirement", "gsd_requirement_update");
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Updated requirement ${id}` }] };
    },
  );

  server.tool(
    "gsd_requirement_save",
    "Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved requirement ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_save_requirement",
    "Alias for gsd_requirement_save. Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args: Record<string, unknown>) => {
      logAliasUsage("gsd_save_requirement", "gsd_requirement_save");
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        return bridge.saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved requirement ${result.id}` }] };
    },
  );

  const requirementListSchema = z.object({
    projectDir: z.string().optional(),
    class: z.string().optional(),
    status: z.string().optional(),
    milestoneId: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });

  server.tool(
    "gsd_project_snapshot",
    "Read the project snapshot from the GSD database (DB-authoritative, never projections). Returns authority, current focus, progress, blockers, open questions, verification, and bounded milestones in one payload.",
    {
      projectDir: z
        .string()
        .optional()
        .describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir } = parseWorkflowArgs(
        z.object({ projectDir: z.string().optional() }),
        args,
      );
      try {
        return await runSerializedCanonicalReadOperation(projectDir, async () => {
          const snapshot = await (
            await importWorkflowRuntimeModule<any>(
              "../../../src/resources/extensions/gsd/state/project-snapshot.js",
            )
          ).readProjectSnapshotFromDb(projectDir, { preserveGlobalDbHandle: true });
          if (!snapshot) {
            throw new Error("Database adapter not available (db_unavailable)");
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
            details: {
              operation: "read_project_snapshot",
              revision: snapshot.authority?.revision,
              snapshot,
            },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mapCanonicalReadError("read_project_snapshot", message);
      }
    },
  );

  server.tool(
    "gsd_requirement_list",
    "List requirements from the GSD database. Returns canonical store (never stale). Use instead of parsing REQUIREMENTS.md.",
    {
      projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
      class: z.string().optional().describe("Filter by class: core-capability, primary-user-loop, launchability, continuity, failure-visibility, integration, quality-attribute, operability, admin/support, compliance/security, differentiator, constraint, anti-feature."),
      status: z.string().optional().describe("Filter by status (e.g. 'active', 'validated', 'deferred')."),
      milestoneId: z.string().optional().describe("Filter to requirements owned by or supporting a specific milestone."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum results (default 200, max 500)."),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(requirementListSchema, args);
      try {
        return await runSerializedCanonicalReadOperation(projectDir, async (adapter: any) => {
          const { queryRequirementsWithLimit } = await importWorkflowRuntimeModule<any>(
            "../../../src/resources/extensions/gsd/context-store.js",
          );
          const limit = Math.min(params.limit ?? 200, 500);
          const results = queryRequirementsWithLimit(
            {
              class: params.class ?? undefined,
              status: params.status ?? undefined,
              milestoneId: params.milestoneId ?? undefined,
              limit,
            },
            adapter,
          );
          return {
            content: [{ type: "text" as const, text: `Found ${results.length} requirement(s).` }],
            details: { operation: "list_requirements", count: results.length, requirements: results },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mapCanonicalReadError("list_requirements", message);
      }
    },
  );

  const requirementGetSchema = z.object({
    projectDir: z.string().optional(),
    id: z.string(),
  });

  server.tool(
    "gsd_requirement_get",
    "Fetch a single requirement by ID from the GSD database. Returns the full row or error (not_found / db_unavailable).",
    {
      projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
      id: z.string().describe("Requirement ID (e.g. 'R021')."),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(requirementGetSchema, args);
      try {
        return await runSerializedCanonicalReadOperation(projectDir, async (adapter: any) => {
          const { getRequirementByIdStrict } = await importWorkflowRuntimeModule<any>(
            "../../../src/resources/extensions/gsd/context-store.js",
          );
          const req = getRequirementByIdStrict(params.id, adapter);
          if (!req) {
            return {
              content: [{ type: "text" as const, text: `Requirement ${params.id} not found.` }],
              details: { operation: "get_requirement", id: params.id, error: "not_found" },
            };
          }
          return {
            content: [{ type: "text" as const, text: `Requirement ${req.id}: ${req.description}` }],
            details: { operation: "get_requirement", id: req.id, requirement: req },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mapCanonicalReadError("get_requirement", message, params.id);
      }
    },
  );

  server.tool(
    "gsd_milestone_generate_id",
    "Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args: Record<string, unknown>) => {
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(projectDir, () =>
        generateOrReuseMilestoneId(projectDir),
      );
      return { content: [{ type: "text" as const, text: id }] };
    },
  );

  server.tool(
    "gsd_generate_milestone_id",
    "Alias for gsd_milestone_generate_id. Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args: Record<string, unknown>) => {
      logAliasUsage("gsd_generate_milestone_id", "gsd_milestone_generate_id");
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(projectDir, () =>
        generateOrReuseMilestoneId(projectDir),
      );
      return { content: [{ type: "text" as const, text: id }] };
    },
  );

  server.tool(
    "gsd_plan_milestone",
    "Write milestone planning state to the GSD database and render ROADMAP.md from DB.",
    planMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(planMilestoneSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_milestone", projectDir, params.milestoneId);
      const { executePlanMilestone } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanMilestone(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_milestone", extra),
        )),
      );
    },
  );

  server.tool(
    "gsd_milestone_plan",
    "Alias for gsd_plan_milestone. Write milestone planning state to the GSD database and render ROADMAP.md from DB.",
    planMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_milestone_plan", "gsd_plan_milestone");
      const parsed = parseWorkflowArgs(planMilestoneSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_milestone", projectDir, params.milestoneId);
      const { executePlanMilestone } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanMilestone(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_milestone", extra),
        )),
      );
    },
  );

  server.tool(
    "gsd_plan_slice",
    "Write slice/task planning state to the GSD database and render plan artifacts from DB.",
    planSliceParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(planSliceSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_slice", projectDir, params.milestoneId);
      const { executePlanSlice } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanSlice(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_slice", extra),
        )),
      );
    },
  );

  server.tool(
    "gsd_slice_plan",
    "Alias for gsd_plan_slice. Write slice/task planning state to the GSD database and render plan artifacts from DB.",
    planSliceParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_slice_plan", "gsd_plan_slice");
      const parsed = parseWorkflowArgs(planSliceSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_slice", projectDir, params.milestoneId);
      const { executePlanSlice } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanSlice(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_slice", extra),
        )),
      );
    },
  );

  server.tool(
    "gsd_plan_task",
    "Write task planning state to the GSD database and render the slice PLAN from DB.",
    planTaskParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule<any>("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_task", extra),
        );
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text" as const, text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      };
    },
  );

  server.tool(
    "gsd_task_plan",
    "Alias for gsd_plan_task. Write task planning state to the GSD database and render the slice PLAN from DB.",
    planTaskParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_task_plan", "gsd_plan_task");
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule<any>("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(
          params,
          projectDir,
          mcpPlanningInvocation("gsd_plan_task", extra),
        );
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text" as const, text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      };
    },
  );

  server.tool(
    "gsd_replan_slice",
    "Replan a slice after a blocker is discovered, preserving completed tasks and re-rendering PLAN.md + REPLAN.md.",
    replanSliceParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(
        parsed.projectDir,
        parsed,
        mcpPlanningInvocation("gsd_replan_slice", extra),
      );
    },
  );

  server.tool(
    "gsd_slice_replan",
    "Alias for gsd_replan_slice. Replan a slice after a blocker is discovered.",
    replanSliceParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_slice_replan", "gsd_replan_slice");
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(
        parsed.projectDir,
        parsed,
        mcpPlanningInvocation("gsd_replan_slice", extra),
      );
    },
  );

  server.tool(
    "gsd_replan_task",
    "Update one pending task's planning contract after rework without touching sibling tasks.",
    replanTaskParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(replanTaskSchema, args);
      return handleReplanTask(
        parsed.projectDir,
        parsed,
        mcpPlanningInvocation("gsd_replan_task", extra),
      );
    },
  );

  server.tool(
    "gsd_rework_brief_save",
    "Persist a structured task rework brief whose blocking findings gate gsd_task_complete.",
    reworkBriefSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(reworkBriefSaveSchema, args);
      return handleReworkBriefSave(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_slice_complete",
    "Commit evidence-backed Slice completion in one revision- and Authority-Epoch-fenced SQLite operation, then refresh readable projections; projection failure is reported as stale.",
    sliceCompleteParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_slice_complete", extra),
      );
    },
  );

  server.tool(
    "gsd_complete_slice",
    "Alias for gsd_slice_complete. Commit evidence-backed Slice completion in SQLite, then refresh readable projections.",
    sliceCompleteParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_complete_slice", "gsd_slice_complete");
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_slice_complete", extra),
      );
    },
  );

  server.tool(
    "gsd_skip_slice",
    "Cancel a Slice atomically in SQLite, preserve completed work, interrupt running Attempts, and grant a current Slice-scoped dependency Waiver before refreshing projections.",
    skipSliceParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(skipSliceSchema, args);
      return handleSkipSlice(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_skip_slice", extra),
      );
    },
  );

  server.tool(
    "gsd_complete_milestone",
    "Commit validated Milestone completion atomically, then render its readable SUMMARY projection.",
    completeMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_complete_milestone", extra),
      );
    },
  );

  server.tool(
    "gsd_milestone_complete",
    "Alias for gsd_complete_milestone. Commit validated Milestone completion atomically, then render its readable SUMMARY projection.",
    completeMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_milestone_complete", "gsd_complete_milestone");
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_complete_milestone", extra),
      );
    },
  );

  server.tool(
    "gsd_validate_milestone",
    "Validate a milestone, persist validation results to the GSD database, and render VALIDATION.md.",
    validateMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_validate_milestone", extra),
      );
    },
  );

  server.tool(
    "gsd_milestone_validate",
    "Alias for gsd_validate_milestone. Validate a milestone and render VALIDATION.md.",
    validateMilestoneParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_milestone_validate", "gsd_validate_milestone");
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_validate_milestone", extra),
      );
    },
  );

  server.tool(
    "gsd_prepare_milestone_subjective_uat",
    "Prepare a source-bound subjective Milestone UAT question with a recommendation for a real user decision.",
    prepareMilestoneSubjectiveUatParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(prepareMilestoneSubjectiveUatSchema, args);
      return handlePrepareMilestoneSubjectiveUat(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_prepare_milestone_subjective_uat", extra),
      );
    },
  );

  server.tool(
    "gsd_answer_milestone_subjective_uat",
    "Record the user's actual response to a prepared subjective Milestone UAT question using authenticated MCP session identity.",
    answerMilestoneSubjectiveUatParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(answerMilestoneSubjectiveUatSchema, args);
      return handleAnswerMilestoneSubjectiveUat(
        parsed.projectDir,
        parsed,
        mcpUserResponseInvocation("gsd_answer_milestone_subjective_uat", extra),
      );
    },
  );

  server.tool(
    "gsd_reassess_roadmap",
    "Reassess a milestone roadmap after a slice completes, writing ROADMAP-ASSESSMENT.md and re-rendering ROADMAP.md.",
    reassessRoadmapParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(
        parsed.projectDir,
        parsed,
        mcpPlanningInvocation("gsd_reassess_roadmap", extra),
      );
    },
  );

  server.tool(
    "gsd_roadmap_reassess",
    "Alias for gsd_reassess_roadmap. Reassess a roadmap after slice completion.",
    reassessRoadmapParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_roadmap_reassess", "gsd_reassess_roadmap");
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(
        parsed.projectDir,
        parsed,
        mcpPlanningInvocation("gsd_reassess_roadmap", extra),
      );
    },
  );

  server.tool(
    "gsd_save_gate_result",
    "Save a quality gate result to the GSD database.",
    saveGateResultIncomingParams,
    async (args: Record<string, unknown>) => {
      const incoming = parseWorkflowArgs(saveGateResultIncomingSchema, args);
      const { prepareSaveGateResultArguments } = await importLocalModule<{
        prepareSaveGateResultArguments: (raw: unknown) => unknown;
      }>("../../../src/resources/extensions/gsd/tools/save-gate-result-args.js");
      const prepared = await inferSaveGateResultScope(
        incoming.projectDir,
        prepareSaveGateResultArguments(incoming) as Record<string, unknown>,
      );
      const record =
        prepared !== null && typeof prepared === "object" && !Array.isArray(prepared)
          ? (prepared as Record<string, unknown>)
          : {};
      const parsed = parseWorkflowArgs(saveGateResultSchema, record);
      return handleSaveGateResult(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_uat_result_save",
    "Save structured UAT checks, evidence, verdict, and tool-presentation proof. Writes ASSESSMENT, attempt history, and aggregate UAT gate.",
    uatResultSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(uatResultSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_uat_result_save", projectDir, params.milestoneId);
      const { executeUatResultSave } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executeUatResultSave(params, projectDir)),
      );
    },
  );

  server.tool(
    "gsd_summary_save",
    "Save a GSD summary/research/context/assessment artifact to the database and disk. Omit milestone_id only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts.",
    summarySaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(summarySaveSchema, args);
      const { projectDir, milestone_id, slice_id, task_id, artifact_type, content } = parsed;
      await enforceWorkflowWriteGate("gsd_summary_save", projectDir, milestone_id ?? null);
      const executors = await getWorkflowToolExecutors();
      const supportedArtifactTypes = getSupportedSummaryArtifactTypes(executors);
      if (!supportedArtifactTypes.includes(artifact_type)) {
        throw new Error(
          `artifact_type must be one of: ${supportedArtifactTypes.join(", ")}`,
        );
      }
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() =>
          executors.executeSummarySave({ milestone_id, slice_id, task_id, artifact_type, content }, projectDir),
        ),
      );
    },
  );

  server.tool(
    "gsd_save_summary",
    "Alias for gsd_summary_save. Save a GSD summary/research/context/assessment artifact to the database and disk.",
    summarySaveParams,
    async (args: Record<string, unknown>) => {
      logAliasUsage("gsd_save_summary", "gsd_summary_save");
      const parsed = parseWorkflowArgs(summarySaveSchema, args);
      const { projectDir, milestone_id, slice_id, task_id, artifact_type, content } = parsed;
      await enforceWorkflowWriteGate("gsd_summary_save", projectDir, milestone_id ?? null);
      const executors = await getWorkflowToolExecutors();
      const supportedArtifactTypes = getSupportedSummaryArtifactTypes(executors);
      if (!supportedArtifactTypes.includes(artifact_type)) {
        throw new Error(
          `artifact_type must be one of: ${supportedArtifactTypes.join(", ")}`,
        );
      }
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() =>
          executors.executeSummarySave({ milestone_id, slice_id, task_id, artifact_type, content }, projectDir),
        ),
      );
    },
  );

  server.tool(
    "gsd_task_complete",
    "Record a Task execution result in SQLite; canonical Tasks advance to host verification or recovery, while legacy Tasks complete directly and refresh readable projections.",
    taskCompleteParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(
        projectDir,
        taskArgs,
        mcpExecutionInvocation("gsd_task_complete", extra),
      );
    },
  );

  server.tool(
    "gsd_complete_task",
    "Alias for gsd_task_complete. Record a Task result and advance canonical host verification/recovery or legacy completion.",
    taskCompleteParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_complete_task", "gsd_task_complete");
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(
        projectDir,
        taskArgs,
        mcpExecutionInvocation("gsd_task_complete", extra),
      );
    },
  );

  server.tool(
    "gsd_task_reopen",
    "Reset a completed task back to pending so it can be re-done.",
    taskReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(taskReopenSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskReopen(
        projectDir,
        taskArgs,
        mcpExecutionInvocation("gsd_task_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_reopen_task",
    "Alias for gsd_task_reopen. Reset a completed task back to pending so it can be re-done.",
    taskReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_reopen_task", "gsd_task_reopen");
      const parsed = parseWorkflowArgs(taskReopenSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskReopen(
        projectDir,
        taskArgs,
        mcpExecutionInvocation("gsd_task_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_task_recovery_resume",
    "Authorize one new Task Attempt after the current durable abort or remediation cause has been repaired.",
    taskRecoveryResumeParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(taskRecoveryResumeSchema, args);
      const { projectDir, ...resumeArgs } = parsed;
      return handleTaskRecoveryResume(
        projectDir,
        resumeArgs,
        mcpExecutionInvocation("gsd_task_recovery_resume", extra),
      );
    },
  );

  server.tool(
    "gsd_task_settle",
    "Operator tool: settle a Task's orphaned running Attempt as interrupted. Dry-run by default — prints the exact rows it would change; mutation requires apply: true. Optional reconcileLifecycle adopts ready/completed to match tasks.status without deleting SUMMARYs.",
    taskSettleParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(taskSettleSchema, args);
      const { projectDir, ...settleArgs } = parsed;
      return handleTaskSettle(
        projectDir,
        settleArgs,
        mcpExecutionInvocation("gsd_task_settle", extra),
      );
    },
  );

  server.tool(
    "gsd_slice_reopen",
    "Reopen a terminal Slice and all Tasks atomically in SQLite while preserving immutable history, revoking cancellation Waivers, and blocking progressed downstream Slices.",
    sliceReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(sliceReopenSchema, args);
      const { projectDir, ...sliceArgs } = parsed;
      return handleSliceReopen(
        projectDir,
        sliceArgs,
        mcpWorkflowExecutionInvocation("gsd_slice_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_reopen_slice",
    "Alias for gsd_slice_reopen. Reopen a terminal Slice and all Tasks atomically in SQLite while preserving immutable history and enforcing downstream guards.",
    sliceReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_reopen_slice", "gsd_slice_reopen");
      const parsed = parseWorkflowArgs(sliceReopenSchema, args);
      const { projectDir, ...sliceArgs } = parsed;
      return handleSliceReopen(
        projectDir,
        sliceArgs,
        mcpWorkflowExecutionInvocation("gsd_slice_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_milestone_reopen",
    "Reopen a terminal Milestone hierarchy atomically while preserving immutable history, then refresh readable projections. Pass keepCompleted=true to unlock the milestone without resetting completed slices/tasks or deleting their SUMMARYs.",
    milestoneReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(milestoneReopenSchema, args);
      const { projectDir, ...milestoneArgs } = parsed;
      return handleMilestoneReopen(
        projectDir,
        milestoneArgs,
        mcpWorkflowExecutionInvocation("gsd_milestone_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_reopen_milestone",
    "Alias for gsd_milestone_reopen. Reopen a terminal Milestone hierarchy atomically, then refresh readable projections. Pass keepCompleted=true to unlock without resetting completed work.",
    milestoneReopenParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      logAliasUsage("gsd_reopen_milestone", "gsd_milestone_reopen");
      const parsed = parseWorkflowArgs(milestoneReopenSchema, args);
      const { projectDir, ...milestoneArgs } = parsed;
      return handleMilestoneReopen(
        projectDir,
        milestoneArgs,
        mcpWorkflowExecutionInvocation("gsd_milestone_reopen", extra),
      );
    },
  );

  server.tool(
    "gsd_milestone_status",
    "Read the current status of a milestone and all its slices from the GSD database. Includes `dependsOn`, the persisted milestone dependencies.",
    milestoneStatusParams,
    async (args: Record<string, unknown>) => {
      // gsd_milestone_status is a read-only query. In-process (query-tools.ts)
      // does not apply the write-gate; MCP must match to avoid blocking reads
      // during pending-gate or queue-mode states.
      const { projectDir, milestoneId } = parseWorkflowArgs(milestoneStatusSchema, args);
      const executors = await getWorkflowToolExecutors();
      const tokenEnv = executors.MILESTONE_STATUS_OBSERVATION_TOKEN_ENV
        ?? "GSD_MILESTONE_STATUS_OBSERVATION_TOKEN";
      const observationContext = executors.resolveMilestoneStatusObservationContext?.(
        projectDir,
        "workflow_mcp",
        process.env[tokenEnv],
      ) ?? {
        mode: "legacy" as const,
        transport: "workflow_mcp" as const,
        sourceRevision: "unavailable",
        contextError: "unavailable" as const,
      };
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executors.executeMilestoneStatus(
          { milestoneId },
          projectDir,
          observationContext,
        )),
      );
    },
  );

  server.tool(
    "gsd_checkpoint_db",
    "Flush the SQLite WAL into gsd.db so git add stages the current GSD database state.",
    checkpointDbParams,
    async (args: Record<string, unknown>) => {
      const { projectDir } = parseWorkflowArgs(checkpointDbSchema, args);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const bridge = await importBridgeModule();
        bridge.checkpointDatabase();
      });
      return {
        content: [{
          type: "text" as const,
          text: "WAL checkpoint complete. gsd.db is now up to date and safe to stage with git add.",
        }],
        structuredContent: { operation: "checkpoint_db", status: "ok" },
      };
    },
  );

  server.tool(
    "gsd_journal_query",
    "Query the structured event journal for auto-mode iterations.",
    journalQueryParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, limit, ...filters } = parseWorkflowArgs(journalQuerySchema, args);
      const bridge = await importBridgeModule();
      const entries = bridge.queryJournal(projectDir, filters).slice(0, limit ?? 100);
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching journal entries found." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    },
  );

  server.tool(
    "gsd_uat_exec",
    "Run one UAT-scoped bash/node/python check with milestone/slice/check metadata. Evidence persists under .gsd/exec with kind=uat_exec.",
    uatExecParams,
    async (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
      const { projectDir, ...params } = parseWorkflowArgs(uatExecSchema, args);
      await enforceWorkflowWriteGate("gsd_uat_exec", projectDir);
      const { executeUatExec } = await importLocalModule<any>(
        "../../../src/resources/extensions/gsd/tools/exec-tool.js",
      );
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(async () =>
          executeUatExec(params, {
            baseDir: projectDir,
            preferences: await loadProjectPreferences(projectDir),
            signal: extra?.signal,
          }),
        ),
      );
    },
  );

  server.tool(
    "gsd_exec",
    "Run a short bash/node/python script in the project directory. Capped stdout/stderr and metadata persist under .gsd/exec; only a digest returns to MCP.",
    execParams,
    async (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
      const { projectDir, ...params } = parseWorkflowArgs(execSchema, args);
      await enforceWorkflowWriteGate("gsd_exec", projectDir);
      const { executeGsdExec } = await importLocalModule<any>(
        "../../../src/resources/extensions/gsd/tools/exec-tool.js",
      );
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(async () =>
          executeGsdExec(params, {
            baseDir: projectDir,
            preferences: await loadProjectPreferences(projectDir),
            signal: extra?.signal,
          }),
        ),
      );
    },
  );

  server.tool(
    "gsd_exec_search",
    "Search prior gsd_exec runs from .gsd/exec/*.meta.json without re-running them.",
    execSearchParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(execSearchSchema, args);
      const { executeExecSearch } = await importLocalModule<any>(
        "../../../src/resources/extensions/gsd/tools/exec-search-tool.js",
      );
      return adaptExecutorResult(
        executeExecSearch(params, {
          baseDir: projectDir,
          preferences: await loadProjectPreferences(projectDir),
        }),
      );
    },
  );

  server.tool(
    "gsd_resume",
    "Read .gsd/last-snapshot.md so agents can re-orient after compaction or session resume.",
    resumeParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(resumeSchema, args);
      const { executeResume } = await importLocalModule<any>(
        "../../../src/resources/extensions/gsd/tools/resume-tool.js",
      );
      return adaptExecutorResult(
        executeResume(params, {
          baseDir: projectDir,
          preferences: await loadProjectPreferences(projectDir),
        }),
      );
    },
  );

  // ─── ADR-013 step 3 — memory-store tools for external MCP clients ────────
  //
  // The same three tools the LLM sees in-process as `capture_thought`,
  // `memory_query`, and `gsd_graph` (the memory variant). MCP exposes them
  // under the gsd_* prefix and renames the memory graph to gsd_memory_graph
  // to avoid collision with the project knowledge graph tool registered as
  // `gsd_graph` in server.ts.

  const MEMORY_CATEGORY = z.enum([
    "architecture",
    "convention",
    "gotcha",
    "preference",
    "environment",
    "pattern",
  ]);

  const captureThoughtSchema = z.object({
    projectDir: z.string().optional(),
    category: MEMORY_CATEGORY,
    // Reject empty / whitespace-only content at the schema layer so the LLM
    // never produces a memory row with no searchable text.
    content: z.string().trim().min(1, "content must be a non-empty trimmed string"),
    confidence: z.number().min(0.1).max(0.99).optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    structuredFields: z.record(z.string(), z.unknown()).optional(),
  });
  const captureThoughtParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    category: MEMORY_CATEGORY.describe("Memory category"),
    content: z.string().describe("Memory text (1-3 sentences, no secrets)"),
    confidence: z.number().min(0.1).max(0.99).optional().describe("0.1-0.99, default 0.8"),
    tags: z.array(z.string()).optional().describe("Free-form tags"),
    scope: z.string().optional().describe("Scope name; defaults to 'project'"),
    structuredFields: z.record(z.string(), z.unknown()).optional().describe("ADR-013 structured payload (e.g. decision fields)"),
  };

  server.tool(
    "gsd_capture_thought",
    "Record a durable project insight into the GSD memory store. Categories: architecture, convention, gotcha, preference, environment, pattern. Mirrors the in-process capture_thought tool for external MCP clients.",
    captureThoughtParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(captureThoughtSchema, args);
      await enforceWorkflowWriteGate("gsd_capture_thought", projectDir);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryCapture } = await importWorkflowRuntimeModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeMemoryCapture(params);
      });
    },
  );

  const memoryQuerySchema = z.object({
    projectDir: z.string().optional(),
    // Match the documented "2+ char terms" contract in the in-process
    // memory_query tool — reject sub-2-char queries at the schema layer.
    query: z.string().trim().min(2, "query must be at least 2 characters"),
    k: z.number().int().min(1).max(50).optional(),
    category: MEMORY_CATEGORY.optional(),
    scope: z.string().optional(),
    tag: z.string().optional(),
    include_superseded: z.boolean().optional(),
    reinforce_hits: z.boolean().optional(),
  });
  const memoryQueryParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    query: z.string().describe("Keyword query (2+ char terms)"),
    k: z.number().int().min(1).max(50).optional().describe("Max results (default 10, max 50)"),
    category: MEMORY_CATEGORY.optional().describe("Restrict to a single category"),
    scope: z.string().optional().describe("Only include memories with this scope"),
    tag: z.string().optional().describe("Only include memories tagged with this value"),
    include_superseded: z.boolean().optional().describe("Include superseded memories (default false)"),
    reinforce_hits: z.boolean().optional().describe("Increment hit_count on returned memories (default false)"),
  };

  server.tool(
    "gsd_memory_query",
    "Search the GSD memory store by keyword. Returns ranked memories with id, category, content, confidence, scope, and tags. Mirrors the in-process memory_query tool for external MCP clients.",
    memoryQueryParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryQuerySchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryQuery } = await importWorkflowRuntimeModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeMemoryQuery(params);
      });
    },
  );

  const memoryGraphSchema = z.object({
    projectDir: z.string().optional(),
    mode: z.enum(["build", "query"]),
    memoryId: z.string().optional(),
    depth: z.number().int().min(0).max(5).optional(),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional(),
  }).refine(
    (val) => val.mode !== "query" || (typeof val.memoryId === "string" && val.memoryId.trim().length > 0),
    { message: "memoryId is required and must be non-empty when mode=query", path: ["memoryId"] },
  );
  const memoryGraphParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    mode: z.enum(["build", "query"]).describe("build = recompute graph (placeholder), query = inspect edges"),
    memoryId: z.string().optional().describe("Memory ID (required when mode=query)"),
    depth: z.number().int().min(0).max(5).optional().describe("Hops to traverse (0-5, default 1)"),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional().describe("Only include edges with this relation type"),
  };

  server.tool(
    "gsd_memory_graph",
    "Inspect the relationship graph between memories. mode=query walks edges from a given memoryId. mode=build is a placeholder reserved for future graph rebuilds. Distinct from gsd_graph (project knowledge graph) — see ADR-013.",
    memoryGraphParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryGraphSchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeGsdGraph } = await importWorkflowRuntimeModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeGsdGraph(params);
      });
    },
  );
}
