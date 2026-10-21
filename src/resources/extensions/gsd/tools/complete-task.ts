// Project/App: gsd-pi
// File Purpose: Complete-task tool handler for GSD workflow state and summaries.

/**
 * complete-task handler — the core operation behind gsd_complete_task.
 *
 * Validates inputs, writes task row and rendered SUMMARY.md to DB in a
 * transaction, then renders projections to disk and invalidates caches.
 * Projection failures are reported as stale without reverting the committed
 * completion, so recovery can repair disk from durable DB state.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type { CompleteTaskParams, EscalationArtifact } from "../types.js";
import { isClosedStatus } from "../status-guards.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getMilestone,
  getSlice,
  getTask,
  getUnresolvedBlockingReworkFindingsForTask,
  applyReworkResolutions,
  setTaskEscalationPending,
  setTaskEscalationAwaitingReview,
} from "../gsd-db.js";
import {
  getWorkflowDatabasePath,
  ensureWorkflowDbAtPath,
  isWorkflowDatabaseOpen,
} from "../db-workspace.js";
import { closeTaskQualityGates } from "../quality-gate-closure.js";
import {
  buildFlatTaskFileName,
  buildTaskFileName,
  gsdProjectionRoot,
  clearPathCache,
  legacyMilestonesDir,
  relMilestoneFile,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSlicePath,
  targetMilestoneFile,
} from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { checkOwnership, taskUnitKey } from "../unit-ownership.js";
import { clearParseCache, normalizePlannedFileReference } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { ProjectionWriteError, renderPlanCheckboxes, writeTaskSummaryProjection } from "../markdown-renderer.js";
import {
  renderMilestoneShellProjections,
  renderSummaryContent,
} from "../workflow-projections.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { isStaleWrite } from "../auto/turn-epoch.js";
import { resolveTaskCompletionAuthority } from "../task-completion-compatibility-adapter.js";
import {
  buildEscalationArtifact,
  escalationArtifactPath,
  writeEscalationArtifact,
} from "../escalation.js";
import { extractBlockerCategory } from "../out-of-surface-blocker.js";

export interface CompleteTaskResult {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
  escalation?: {
    artifactPath: string;
    question: string;
    options: EscalationArtifact["options"];
    recommendation: string;
    recommendationRationale: string;
    continueWithDefault: boolean;
  };
  /**
   * True when this call re-completed an already-closed task from a turn that
   * had been superseded by timeout recovery or cancellation. The underlying
   * state was not mutated; the response is a no-op shaped like a success so
   * the orphaned LLM tool call resolves cleanly.
   */
  duplicate?: boolean;
  stale?: boolean;
}

import type { TaskRow } from "../db-task-slice-rows.js";

function taskSummaryPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): string {
  // Layout-aware: avoid creating a milestones/ directory for flat-phase projects.
  // When that directory is created as a side effect, milestonesDir() detects it as
  // a legacy layout and breaks all subsequent path resolution for the session.
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = phaseDir
    ? phaseDir.startsWith(legacyBase + "/") || phaseDir.startsWith(legacyBase + "\\")
    : false;
  if (isLegacy && phaseDir) {
    // Legacy layout: the slice has its own slices/SID/ subdir → tasks/ subdir.
    const legacySlicePath = slicePath && slicePath !== phaseDir
      ? slicePath
      : join(phaseDir, "slices", sliceId);
    return join(legacySlicePath, "tasks", buildTaskFileName(taskId, "SUMMARY"));
  }
  if (phaseDir) {
    // Flat-phase: task summaries go in the phase dir (no tasks/ subdir)
    return join(phaseDir, buildFlatTaskFileName(sliceId, taskId, "SUMMARY"));
  }
  // Fallback: legacy hardcoded path (milestone/slice dir not on disk yet)
  return join(
    gsdProjectionRoot(basePath),
    "milestones",
    milestoneId,
    "slices",
    sliceId,
    "tasks",
    `${taskId}-SUMMARY.md`,
  );
}

/**
 * Resolve the on-disk SUMMARY.md path for a task without writing anything.
 *
 * Used by callers that need to reference an already-completed task's summary
 * (e.g. the idempotent duplicate short-circuit in `executeTaskComplete`), which
 * must apply the same canonical-milestone-root resolution `handleCompleteTask`
 * uses so the reported path matches the one the real completion wrote.
 */
export function resolveTaskSummaryPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): string {
  return taskSummaryPath(
    resolveCanonicalMilestoneRoot(basePath, milestoneId),
    milestoneId,
    sliceId,
    taskId,
  );
}

/**
 * Persist a task-summary projection through the canonical projection seam,
 * tolerating a workflow database handle that disappears across the summary
 * write's await boundary.
 *
 * The seam records artifact lineage in the DB *after* the disk bytes land, so a
 * handle lost mid-write surfaces as a `ProjectionWriteError` even though the
 * database file is intact and reopenable. That is the same recoverable loss the
 * plan-render step already reopens for; treating it as a stale projection would
 * report a repairable handle loss as durable drift. Genuine persistence
 * failures (a missing database file, or a failing insert against a live handle)
 * still fail loud.
 */
async function persistTaskSummaryProjection(
  artifactBasePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  summaryMd: string,
  workflowDbPath: string | null,
): Promise<void> {
  try {
    await writeTaskSummaryProjection(artifactBasePath, milestoneId, sliceId, taskId, summaryMd);
    return;
  } catch (err) {
    const reopened =
      err instanceof ProjectionWriteError &&
      !isWorkflowDatabaseOpen() &&
      ensureWorkflowDbAtPath(workflowDbPath);
    if (!reopened) throw err;
    logWarning(
      "projection",
      `complete_task reopened the workflow database to record task summary lineage for ${milestoneId}/${sliceId}/${taskId}`,
    );
  }

  await writeTaskSummaryProjection(artifactBasePath, milestoneId, sliceId, taskId, summaryMd);
}

async function repairMissingTaskSummaryProjection(
  artifactBasePath: string,
  taskRow: TaskRow,
): Promise<{ summaryPath: string; stale: boolean }> {
  const workflowDbPath = getWorkflowDatabasePath();
  const summaryPath = taskSummaryPath(
    artifactBasePath,
    taskRow.milestone_id,
    taskRow.slice_id,
    taskRow.id,
  );
  const summaryMd = renderSummaryContent(taskRow, taskRow.slice_id, taskRow.milestone_id, []);
  const skipRoadmap = taskReferencesMilestoneRoadmap(
    artifactBasePath,
    taskRow.milestone_id,
    [
      ...taskRow.expected_output,
      ...taskRow.files,
      ...taskRow.key_files,
    ],
  );
  let stale = false;

  try {
    await persistTaskSummaryProjection(
      artifactBasePath,
      taskRow.milestone_id,
      taskRow.slice_id,
      taskRow.id,
      summaryMd,
      workflowDbPath,
    );
    await renderPlanCheckboxes(artifactBasePath, taskRow.milestone_id, taskRow.slice_id);
  } catch (renderErr) {
    stale = true;
    logWarning(
      "projection",
      `complete_task missing-summary repair failed for ${taskRow.milestone_id}/${taskRow.slice_id}/${taskRow.id}`,
      { error: (renderErr as Error).message },
    );
  }

  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  try {
    const rendered = await renderMilestoneShellProjections(artifactBasePath, taskRow.milestone_id, { skipRoadmap });
    stale ||= rendered.stale;
  } catch (projErr) {
    stale = true;
    logWarning("tool", `complete-task repair projection warning: ${(projErr as Error).message}`);
  }
  try {
    await writeManifestAndFlush(artifactBasePath);
  } catch (mfErr) {
    logWarning("tool", `complete-task repair manifest warning: ${(mfErr as Error).message}`);
  }

  return { summaryPath, stale };
}

/**
 * Normalize a list parameter that may arrive as a string (newline-delimited
 * bullet list from the LLM) into a string array (#3361).
 */
export function normalizeListParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\n/).map(s => s.replace(/^[\s\-*•]+/, "").trim()).filter(Boolean);
  }
  return [];
}

/**
 * Build a TaskRow-shaped object from CompleteTaskParams so the unified
 * renderSummaryContent() can be used at completion time (#2720).
 */

export function normalizeReworkResolution(
  params: Pick<CompleteTaskParams, "milestoneId" | "sliceId" | "taskId" | "reworkResolution">,
): Array<{
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findingId: string;
  status: "resolved" | "deferred-with-override";
  evidence: string;
  decisionRef?: string;
}> {
  return (params.reworkResolution ?? []).map((resolution) => ({
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
    findingId: resolution.findingId,
    status: resolution.status,
    evidence: resolution.evidence,
    decisionRef: resolution.decisionRef,
  }));
}

export function unresolvedReworkError(missingFindingIds: string[]): string {
  const plural = missingFindingIds.length === 1 ? "finding" : "findings";
  return `unresolved blocking rework ${plural}: ${missingFindingIds.join(", ")} — provide reworkResolution entries with status resolved and evidence, or status deferred-with-override with evidence and decisionRef, before completing the task`;
}

export function satisfiesBlockingReworkFinding(resolution: ReturnType<typeof normalizeReworkResolution>[number]): boolean {
  if (resolution.evidence.trim().length === 0) return false;
  if (resolution.status === "resolved") return true;
  return (resolution.decisionRef ?? "").trim().length > 0;
}

function normalizeTaskFileReference(value: string, basePath: string): string {
  const cleaned = normalizePlannedFileReference(value).trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) return "";

  if (isAbsolute(cleaned)) {
    const rel = relative(basePath, cleaned).replace(/\\/g, "/");
    if (rel && rel !== "." && rel !== ".." && !rel.startsWith("../")) {
      return rel.replace(/^\.\//, "").toLowerCase();
    }
  }

  return cleaned.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function taskReferencesMilestoneRoadmap(
  basePath: string,
  milestoneId: string,
  references: string[],
): boolean {
  if (references.length === 0) return false;

  const milestone = getMilestone(milestoneId);
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP")
    ?? targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestone?.title);
  if (!existsSync(roadmapPath)) return false;

  const normalizedRoadmapPath = roadmapPath.replace(/\\/g, "/").toLowerCase();
  const relFromProjectionRoot = relative(gsdProjectionRoot(basePath), roadmapPath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const exactMatches = new Set([
    relative(basePath, roadmapPath).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(),
    relMilestoneFile(basePath, milestoneId, "ROADMAP", milestone?.title).replace(/^\.\//, "").toLowerCase(),
    `.gsd/${relFromProjectionRoot}`.toLowerCase(),
    normalizedRoadmapPath,
  ]);
  const roadmapFileName = basename(roadmapPath).toLowerCase();

  return references.some((reference) => {
    const normalized = normalizeTaskFileReference(reference, basePath);
    return exactMatches.has(normalized) || normalized === roadmapFileName;
  });
}

function paramsToTaskRow(params: CompleteTaskParams, completedAt: string): TaskRow {
  return {
    milestone_id: params.milestoneId,
    slice_id: params.sliceId,
    id: params.taskId,
    title: params.oneLiner || params.taskId,
    status: "complete",
    one_liner: params.oneLiner,
    narrative: params.narrative,
    verification_result: params.verification,
    duration: "",
    completed_at: completedAt,
    blocker_discovered: params.blockerDiscovered ?? false,
    deviations: params.deviations ?? "",
    known_issues: params.knownIssues ?? "",
    key_files: normalizeListParam(params.keyFiles),
    key_decisions: normalizeListParam(params.keyDecisions),
    full_summary_md: "",
    description: "",
    estimate: "",
    files: [],
    verify: "",
    inputs: [],
    expected_output: [],
    observability_impact: "",
    full_plan_md: "",
    sequence: 0,
    blocker_source: params.blockerDiscovered
      ? extractBlockerCategory(params.narrative, params.knownIssues, params.oneLiner) ?? ""
      : "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
  };
}

/**
 * Handle the complete_task operation end-to-end.
 *
 * 1. Validate required fields
 * 2. Write DB in a transaction (milestone, slice, task, verification evidence)
 * 3. Render SUMMARY.md to disk
 * 4. Toggle plan checkbox
 * 5. Store rendered markdown back in DB (for D004 recovery)
 * 6. Invalidate caches
 */
export async function handleCompleteTask(
  params: CompleteTaskParams,
  basePath: string,
): Promise<CompleteTaskResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.taskId || typeof params.taskId !== "string" || params.taskId.trim() === "") {
    return { error: "taskId is required and must be a non-empty string" };
  }
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!params.oneLiner || typeof params.oneLiner !== "string" || params.oneLiner.trim() === "") {
    return { error: "oneLiner is required and must be a non-empty string" };
  }
  if (!params.narrative || typeof params.narrative !== "string" || params.narrative.trim() === "") {
    return { error: "narrative is required and must be a non-empty string" };
  }
  if (!params.verification || typeof params.verification !== "string" || params.verification.trim() === "") {
    return { error: "verification is required and must be a non-empty string" };
  }

  try {
    if (resolveTaskCompletionAuthority({
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
    }, undefined, { blockerReport: params.blockerDiscovered === true }) === "canonical") {
      return { error: "canonical Task completion requires the durable Attempt completion pipeline" };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);

  // ── Ownership check (opt-in: only enforced when claim file exists) ──────
  const ownershipErr = checkOwnership(
    artifactBasePath,
    taskUnitKey(params.milestoneId, params.sliceId, params.taskId),
    params.actorName,
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  const completedAt = new Date().toISOString();
  let guardError: string | null = null;
  let summaryMd = "";
  let repairTaskSummaryRow: TaskRow | null = null;
  let skipRoadmapProjectionAfterCompletion = false;
  const workflowDbPath = getWorkflowDatabasePath();

  // ── ADR-011 Phase 2: validate escalation payload BEFORE any side effects ─
  // Building the artifact runs the full shape validation (2-4 options, unique
  // ids, recommendation references a real id). If the payload is malformed
  // we must reject the call before marking the task complete, writing
  // SUMMARY.md, flipping the plan checkbox, or closing execute-task gates —
  // otherwise a rejected payload would leave the task marked complete with
  // no escalation recorded, and the loop would silently advance past it.
  // The transaction below stores the validated artifact path and escalation
  // flag with completion; the readable JSON projection is written afterward.
  const reworkResolutions = normalizeReworkResolution(params);

  let validatedEscalationArtifact: ReturnType<typeof buildEscalationArtifact> | null = null;
  let validatedEscalationPath: string | null = null;
  let escalationWriteEnabled = false;
  if (params.escalation) {
    escalationWriteEnabled = loadEffectiveGSDPreferences()?.preferences?.phases?.mid_execution_escalation === true;
    if (escalationWriteEnabled) {
      try {
        validatedEscalationArtifact = buildEscalationArtifact({
          taskId: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          question: params.escalation.question,
          options: params.escalation.options,
          recommendation: params.escalation.recommendation,
          recommendationRationale: params.escalation.recommendationRationale,
          continueWithDefault: params.escalation.continueWithDefault,
        });
      } catch (validationErr) {
        return {
          error: `complete-task escalation payload invalid for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(validationErr as Error).message}`,
        };
      }
      validatedEscalationPath = escalationArtifactPath(
        artifactBasePath,
        params.milestoneId,
        params.sliceId,
        params.taskId,
      );
      if (!validatedEscalationPath) {
        return {
          error: `complete-task escalation path unavailable for ${params.milestoneId}/${params.sliceId}/${params.taskId}; run doctor`,
        };
      }
    } else if (params.escalation.continueWithDefault === false) {
      return {
        error: `complete-task received a hard-blocker escalation (continueWithDefault=false) but phases.mid_execution_escalation is disabled for ${params.milestoneId}/${params.sliceId}/${params.taskId}`,
      };
    }
  }

  transaction(() => {
    // State machine preconditions (inside txn for atomicity).
    // Milestone/slice not existing is OK — insertMilestone/insertSlice below will auto-create.
    // Only block if they exist and are closed.
    const milestone = getMilestone(params.milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      guardError = `cannot complete task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }

    const slice = getSlice(params.milestoneId, params.sliceId);
    if (slice && isClosedStatus(slice.status)) {
      guardError = `cannot complete task in a closed slice: ${params.sliceId} (status: ${slice.status})`;
      return;
    }

    const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
    // If this task just produced the ROADMAP projection, preserve its verified
    // content instead of immediately regenerating it from stale DB rows (#1433).
    skipRoadmapProjectionAfterCompletion = taskReferencesMilestoneRoadmap(
      artifactBasePath,
      params.milestoneId,
      [
        ...(existingTask?.expected_output ?? []),
        ...(existingTask?.files ?? []),
        ...(existingTask?.key_files ?? []),
        ...normalizeListParam(params.keyFiles),
      ],
    );
    const unresolvedRework = getUnresolvedBlockingReworkFindingsForTask(params.milestoneId, params.sliceId, params.taskId);
    const resolvedFindingIds = new Set(
      reworkResolutions
        .filter(satisfiesBlockingReworkFinding)
        .map((resolution) => resolution.findingId),
    );
    const missingFindingIds = unresolvedRework
      .filter((finding) => !resolvedFindingIds.has(finding.finding_id))
      .map((finding) => finding.finding_id);
    if (missingFindingIds.length > 0) {
      guardError = unresolvedReworkError(missingFindingIds);
      return;
    }

    if (existingTask && isClosedStatus(existingTask.status)) {
      // Stale-turn path: a timed-out turn that was superseded by recovery
      // can still reach this code when its LLM call eventually returns and
      // invokes gsd_complete_task. Returning an error would produce noisy
      // "already complete — use reopen first" logs in the orphaned turn.
      // Instead, signal the duplicate via a non-mutating success shape that
      // callers can detect via `duplicate: true` / `stale: true`.
      if (isStaleWrite("complete-task")) {
        // Sentinel handled below — outside the transaction — so we don't
        // render SUMMARY.md or flip plan checkboxes for a stale duplicate.
        guardError = "__stale_duplicate__";
        return;
      }
      const existingSummaryPath = taskSummaryPath(
        artifactBasePath,
        params.milestoneId,
        params.sliceId,
        params.taskId,
      );
      if (existingTask.full_summary_md.trim() && !existsSync(existingSummaryPath)) {
        repairTaskSummaryRow = existingTask;
        guardError = "__repair_missing_summary__";
        return;
      }
      guardError = `task ${params.taskId} is already complete — use gsd_task_reopen first if you need to redo it`;
      return;
    }

    // All guards passed — perform writes. Preserve existing slice planning
    // metadata; completing a task must not reset title/risk/depends/demo.
    const taskRow = paramsToTaskRow(params, completedAt);
    summaryMd = renderSummaryContent(taskRow, params.sliceId, params.milestoneId, params.verificationEvidence ?? []);

    insertMilestone({ id: params.milestoneId, title: params.milestoneId });
    if (!slice) {
      insertSlice({ id: params.sliceId, milestoneId: params.milestoneId, title: params.sliceId });
    }
    insertTask({
      id: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      // A completion must not rewrite planning data (#2216): pass the stored
      // title through so the upsert cannot replace it with the executor's
      // one-liner. Fall back to the one-liner only for a genuinely new row.
      title: existingTask?.title ?? params.oneLiner,
      status: "complete",
      oneLiner: params.oneLiner,
      narrative: params.narrative,
      verificationResult: params.verification,
      duration: "",
      blockerDiscovered: params.blockerDiscovered ?? false,
      deviations: params.deviations ?? "None.",
      knownIssues: params.knownIssues ?? "None.",
      keyFiles: params.keyFiles ?? [],
      keyDecisions: params.keyDecisions ?? [],
      fullSummaryMd: summaryMd,
    });

    if (validatedEscalationArtifact && validatedEscalationPath) {
      const setEscalationState = validatedEscalationArtifact.continueWithDefault
        ? setTaskEscalationAwaitingReview
        : setTaskEscalationPending;
      setEscalationState(
        params.milestoneId,
        params.sliceId,
        params.taskId,
        validatedEscalationPath,
      );
    }

    // Only persist resolutions that actually satisfy the evidence
    // requirement. The guard above admits a finding as long as ONE satisfying
    // entry exists, but applyReworkResolutions writes by findingId and lets the
    // last entry win. Persisting every entry would let a later non-satisfying
    // duplicate (empty evidence, or deferred-with-override without decisionRef)
    // overwrite a valid resolution and leave the finding non-pending without
    // acceptable evidence. Filtering with the same predicate the guard uses
    // keeps the applied set and the gate consistent.
    const resolutionsToApply = reworkResolutions.filter(satisfiesBlockingReworkFinding);
    if (resolutionsToApply.length > 0) {
      applyReworkResolutions(resolutionsToApply);
    }

    for (const evidence of (params.verificationEvidence ?? [])) {
      insertVerificationEvidence({
        taskId: params.taskId,
        sliceId: params.sliceId,
        milestoneId: params.milestoneId,
        command: evidence.command,
        exitCode: evidence.exitCode,
        verdict: evidence.verdict,
        durationMs: evidence.durationMs,
      });
    }

    closeTaskQualityGates(params, params);
  });

  if (guardError === "__stale_duplicate__") {
    // Orphaned-turn duplicate: the task is already complete from the
    // superseded turn's earlier (real) call. Return a non-mutating success
    // so the stale LLM tool call unwinds cleanly. summaryPath is synthesized
    // from the existing on-disk layout; no file is written.
    const staleSummaryPath = taskSummaryPath(
      artifactBasePath,
      params.milestoneId,
      params.sliceId,
      params.taskId,
    );
    return {
      taskId: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      summaryPath: staleSummaryPath,
      duplicate: true,
      stale: true,
    };
  }

  if (guardError === "__repair_missing_summary__" && repairTaskSummaryRow) {
    const repair = await repairMissingTaskSummaryProjection(artifactBasePath, repairTaskSummaryRow);
    return {
      taskId: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      summaryPath: repair.summaryPath,
      duplicate: true,
      ...(repair.stale ? { stale: true } : {}),
    };
  }

  if (guardError) {
    return { error: guardError };
  }

  // Resolve and write summary to disk
  const summaryPath = taskSummaryPath(
    artifactBasePath,
    params.milestoneId,
    params.sliceId,
    params.taskId,
  );

  try {
    await persistTaskSummaryProjection(
      artifactBasePath,
      params.milestoneId,
      params.sliceId,
      params.taskId,
      summaryMd,
      workflowDbPath,
    );

    // Toggle or regenerate the plan projection from DB. Missing projection
    // files are rebuilt by the renderer instead of being skipped.
    if (!ensureWorkflowDbAtPath(workflowDbPath)) {
      throw new Error(`database unavailable before plan projection render for ${params.milestoneId}/${params.sliceId}`);
    }
    const wrotePlan = await renderPlanCheckboxes(artifactBasePath, params.milestoneId, params.sliceId);
    if (!wrotePlan) {
      throw new Error(`plan projection write returned false for ${params.milestoneId}/${params.sliceId}`);
    }
  } catch (renderErr) {
    logWarning(
      "projection",
      `complete_task projection write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}`,
      { error: (renderErr as Error).message },
    );
    // The database completion is authoritative. Leave its summary/evidence and
    // any successfully written projection in place so recovery can repair the
    // stale disk projection without another lifecycle mutation.
    clearPathCache();
    clearParseCache();
    return {
      error: `complete_task projection write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}; completion remains committed and the disk projection is stale`,
    };
  }

  // ── ADR-011 Phase 2: write escalation artifact (opt-in) ────────────────
  // Validation and authoritative escalation state were committed with the
  // Task. This block only writes the readable artifact projection.
  let escalationMetadata: CompleteTaskResult["escalation"] | undefined;
  let escalationProjectionError: string | null = null;
  if (validatedEscalationArtifact) {
    try {
      const escalationPath = writeEscalationArtifact(artifactBasePath, validatedEscalationArtifact);
      escalationMetadata = {
        artifactPath: escalationPath,
        question: validatedEscalationArtifact.question,
        options: validatedEscalationArtifact.options,
        recommendation: validatedEscalationArtifact.recommendation,
        recommendationRationale: validatedEscalationArtifact.recommendationRationale,
        continueWithDefault: validatedEscalationArtifact.continueWithDefault,
      };
    } catch (escalationErr) {
      const msg = `complete-task escalation write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(escalationErr as Error).message}`;
      logWarning("tool", msg);
      if (validatedEscalationArtifact.continueWithDefault === false) {
        escalationProjectionError = `${msg}; completion remains committed and the escalation projection is stale`;
      }
    }
  } else if (params.escalation && !escalationWriteEnabled) {
    logWarning(
      "tool",
      `complete-task received escalation payload but phases.mid_execution_escalation is not enabled; ignoring (${params.milestoneId}/${params.sliceId}/${params.taskId})`,
    );
  }

  // Invalidate all caches
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  // Separate try/catch per step so a projection failure doesn't prevent
  // the event log entry (critical for worktree reconciliation).
  let projectionStale = false;
  try {
    const rendered = await renderMilestoneShellProjections(artifactBasePath, params.milestoneId, {
      skipRoadmap: skipRoadmapProjectionAfterCompletion,
    });
    projectionStale = rendered.stale;
  } catch (projErr) {
    projectionStale = true;
    logWarning("tool", `complete-task projection warning: ${(projErr as Error).message}`);
  }
  try {
    await writeManifestAndFlush(artifactBasePath);
  } catch (mfErr) {
    logWarning("tool", `complete-task manifest warning: ${(mfErr as Error).message}`);
  }
  try {
    appendEvent(artifactBasePath, {
      cmd: "complete-task",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (eventErr) {
    logError("tool", `complete-task event log FAILED — completion invisible to reconciliation`, { error: (eventErr as Error).message });
  }

  if (escalationProjectionError) {
    return { error: escalationProjectionError };
  }

  return {
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    ...(escalationMetadata ? { escalation: escalationMetadata } : {}),
    ...(projectionStale ? { stale: true } : {}),
  };
}
