// Project/App: gsd-pi
// File Purpose: Complete-milestone tool handler for GSD workflow state and summaries.

// gsd-pi complete-milestone tool handler
/**
 * complete-milestone handler — the core operation behind gsd_complete_milestone.
 *
 * Adopted Milestones validate canonical closeout evidence and complete through
 * one Domain Operation before rendering the durable summary projection.
 * Unadopted imports retain the legacy assessment and hierarchy guards.
 */

import { existsSync } from "node:fs";

import {
  transaction,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getLatestAssessmentByScope,
  updateMilestoneStatus,
} from "../gsd-db.js";
import { clearPathCache, resolveMilestoneFile, targetMilestoneFile } from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { isClosedStatus, isDeferredStatus } from "../status-guards.js";
import { saveFile, clearParseCache, loadFile } from "../files.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutAuthorization,
} from "../db/milestone-closeout-readiness.js";
import { closeQualityGatesFromEvidence } from "../quality-gate-closure.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import {
  completeMilestone,
  isCurrentMilestoneCompletionOperation,
  readMilestoneCompletionReplaySourceRevision,
  type MilestoneCompletionCloseout,
  type MilestoneCompletionReceipt,
} from "../milestone-lifecycle-domain-operation.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
} from "../verification-source-integrity.js";
import {
  readMilestoneCompletionProjection,
  renderMilestoneSummaryMarkdown,
  type MilestoneCompletionProjection,
} from "../milestone-summary-projection.js";

export interface CompleteMilestoneParams {
  milestoneId: string;
  title: string;
  oneLiner: string;
  narrative: string;
  verificationPassed: boolean;
  /** @optional — empty/omitted renders as "Not provided." */
  successCriteriaResults?: string;
  /** @optional — empty/omitted renders as "Not provided." */
  definitionOfDoneResults?: string;
  /** @optional — empty/omitted renders as "Not provided." */
  requirementOutcomes?: string;
  /** @optional — empty/omitted renders as an empty frontmatter list */
  keyDecisions?: string[];
  /** @optional — empty/omitted renders as an empty frontmatter list */
  keyFiles?: string[];
  /** @optional — empty/omitted renders as "(none)" */
  lessonsLearned?: string[];
  /** @optional — empty/omitted renders as "None." */
  followUps?: string;
  /** @optional — empty/omitted renders as "None." */
  deviations?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface CompleteMilestoneResult {
  milestoneId: string;
  summaryPath: string;
  stale?: boolean;
  alreadyComplete?: boolean;
  operationId?: string;
  resultingRevision?: number;
  replayed?: boolean;
  current?: boolean;
  superseded?: boolean;
}

let projectionInterleaveForTest: (() => Promise<void>) | null = null;

export function _setCompleteMilestoneProjectionInterleaveForTest(
  hook: (() => Promise<void>) | null,
): void {
  projectionInterleaveForTest = hook;
}

async function removeOwnedProjection(path: string, content: string): Promise<void> {
  if (await loadFile(path) !== content) return;
  try {
    removeProjectionFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function repairSupersededSummary(
  basePath: string,
  milestoneId: string,
  summaryPath: string,
  deliveredContent: string,
): Promise<void> {
  const currentProjection = readMilestoneCompletionProjection(milestoneId);
  if (currentProjection && isCurrentMilestoneCompletionOperation(
    currentProjection.operationId,
    milestoneId,
  )) {
    await writeMilestoneSummaryProjectionIfCurrent(
      basePath,
      milestoneId,
      currentProjection,
    );
    return;
  }

  // A canonically complete head without a matching durable event is sabotage or
  // an imported compatibility state. Preserve its bytes rather than deleting a
  // projection we cannot safely attribute to this delivery.
  if (isClosedStatus(getMilestone(milestoneId)?.status ?? "")) return;
  await removeOwnedProjection(summaryPath, deliveredContent);
}

async function writeMilestoneSummaryProjectionIfCurrent(
  basePath: string,
  milestoneId: string,
  projection: MilestoneCompletionProjection,
): Promise<boolean> {
  const milestone = getMilestone(milestoneId);
  if (!milestone) return false;
  const isCurrent = () => isCurrentMilestoneCompletionOperation(
    projection.operationId,
    milestoneId,
  );
  if (!isCurrent()) return false;

  const summaryPath = targetMilestoneFile(basePath, milestoneId, "SUMMARY", milestone.title);
  const summaryMd = renderMilestoneSummaryMarkdown(
    milestoneId,
    projection.completedAt,
    projection.closeout,
  );
  await saveFile(summaryPath, summaryMd);
  await projectionInterleaveForTest?.();
  if (isCurrent()) return existsSync(summaryPath);

  await repairSupersededSummary(basePath, milestoneId, summaryPath, summaryMd);
  return false;
}

/** Rebuild a missing adopted SUMMARY without creating or replaying authority. */
export async function repairAdoptedMilestoneSummaryProjection(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  const projection = readMilestoneCompletionProjection(milestoneId);
  if (!projection) return false;
  return writeMilestoneSummaryProjectionIfCurrent(basePath, milestoneId, projection);
}

function completionCloseout(params: CompleteMilestoneParams): MilestoneCompletionCloseout {
  return {
    title: params.title,
    oneLiner: params.oneLiner,
    narrative: params.narrative,
    successCriteriaResults: params.successCriteriaResults ?? "",
    definitionOfDoneResults: params.definitionOfDoneResults ?? "",
    requirementOutcomes: params.requirementOutcomes ?? "",
    keyDecisions: params.keyDecisions ?? [],
    keyFiles: params.keyFiles ?? [],
    lessonsLearned: params.lessonsLearned ?? [],
    followUps: params.followUps ?? "",
    deviations: params.deviations ?? "",
  };
}

export async function handleCompleteMilestone(
  params: CompleteMilestoneParams,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<CompleteMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!params.title || typeof params.title !== "string" || params.title.trim() === "") {
    return { error: "title is required and must be a non-empty string" };
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);
  const adoptedLifecycle = isMilestoneLifecycleAdopted(params.milestoneId);

  // Legacy imports retain the caller gate. Adopted Milestones derive readiness
  // only from the current canonical database receipt inside milestone.complete.
  if (!adoptedLifecycle && params.verificationPassed !== true) {
    return { error: "verification did not pass — milestone completion blocked. verificationPassed must be explicitly set to true after all verification steps succeed" };
  }

  let currentSourceRevision: string | undefined;
  if (adoptedLifecycle) {
    const replaySourceRevision = invocation
      ? readMilestoneCompletionReplaySourceRevision(invocation.idempotencyKey)
      : null;
    if (replaySourceRevision) {
      currentSourceRevision = replaySourceRevision;
    } else {
      const targets = resolveVerificationRepositoryTargets(
        artifactBasePath,
        loadEffectiveGSDPreferences()?.preferences,
        null,
        null,
      );
      if (targets.missingRepositoryIds.length > 0) {
        return {
          error: `verification source repositories are missing: ${targets.missingRepositoryIds.join(", ")}`,
        };
      }
      const source = captureVerificationSourceSnapshot(targets.repositories.map((repository) => ({
        id: repository.id,
        cwd: repository.root,
      })));
      if (!source.ok) return { error: source.error };
      currentSourceRevision = source.snapshot.aggregateRevision;
    }
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  let completedAt = new Date().toISOString();
  let guardError: string | null = null;
  let alreadyComplete = false;
  let canonicalReceipt: MilestoneCompletionReceipt | undefined;

  if (adoptedLifecycle) {
    if (!invocation) {
      return { error: "adopted Milestone completion requires canonical invocation identity" };
    }
    try {
      const authorization = readMilestoneCloseoutAuthorization({
        milestoneId: params.milestoneId,
        sourceRevision: currentSourceRevision!,
      });
      if (authorization.authorized) {
        closeQualityGatesFromEvidence(params.milestoneId, {
          artifactBasePath,
          milestoneValidationPassed: authorization.kind === "validated",
          milestoneValidationAuthorization: authorization,
        });
      }
      canonicalReceipt = completeMilestone({
        invocation,
        milestoneId: params.milestoneId,
        sourceRevision: currentSourceRevision!,
        closeout: completionCloseout(params),
        audit: {
          ...(params.actorName ? { actorName: params.actorName } : {}),
          ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
        },
      });
      completedAt = canonicalReceipt.completedAt;
      alreadyComplete = canonicalReceipt.status === "replayed";
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  } else transaction(() => {
    if (isMilestoneLifecycleAdopted(params.milestoneId)) {
      guardError = `Refusing legacy completion for adopted Milestone ${params.milestoneId}`;
      return;
    }
    // State machine preconditions (inside txn for atomicity)
    const milestone = getMilestone(params.milestoneId);
    if (!milestone) {
      guardError = `milestone not found: ${params.milestoneId}`;
      return;
    }
    if (isClosedStatus(milestone.status)) {
      alreadyComplete = true;
      return;
    }

    const validation = getLatestAssessmentByScope(params.milestoneId, "milestone-validation");
    if (validation?.status !== "pass") {
      guardError =
        `Refusing to complete ${params.milestoneId}: latest milestone-validation verdict is ` +
        `"${validation?.status ?? "absent"}". Only verdict=pass permits closeout.`;
      return;
    }

    // Verify all slices are complete
    const slices = getMilestoneSlices(params.milestoneId);
    if (slices.length === 0) {
      guardError = `no slices found for milestone ${params.milestoneId}`;
      return;
    }

    const incompleteSlices = slices.filter(s => !isClosedStatus(s.status) && !isDeferredStatus(s.status));
    if (incompleteSlices.length > 0) {
      const incompleteIds = incompleteSlices.map(s => `${s.id} (status: ${s.status})`).join(", ");
      guardError = `incomplete slices: ${incompleteIds}`;
      return;
    }

    // Deep check: verify all tasks in all slices are complete
    for (const slice of slices) {
      if (isDeferredStatus(slice.status)) continue;
      const tasks = getSliceTasks(params.milestoneId, slice.id);
      const incompleteTasks = tasks.filter(t => !isClosedStatus(t.status));
      if (incompleteTasks.length > 0) {
        const ids = incompleteTasks.map(t => `${t.id} (status: ${t.status})`).join(", ");
        guardError = `slice ${slice.id} has incomplete tasks: ${ids}`;
        return;
      }
    }

    // All guards passed — perform write
    updateMilestoneStatus(params.milestoneId, 'complete', completedAt);
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Filesystem operations (outside transaction) ─────────────────────────
  const summaryMd = renderMilestoneSummaryMarkdown(
    params.milestoneId,
    completedAt,
    canonicalReceipt?.closeout ?? completionCloseout(params),
  );

  const summaryPath =
    resolveMilestoneFile(artifactBasePath, params.milestoneId, "SUMMARY") ??
    targetMilestoneFile(
      artifactBasePath,
      params.milestoneId,
      "SUMMARY",
      getMilestone(params.milestoneId)?.title,
    );

  const isCurrent = canonicalReceipt
    ? () => isCurrentMilestoneCompletionOperation(canonicalReceipt.operationId, params.milestoneId)
    : () => true;

  if (canonicalReceipt && !canonicalReceipt.isCurrent) {
    return {
      milestoneId: params.milestoneId,
      summaryPath,
      stale: true,
      alreadyComplete: true,
      operationId: canonicalReceipt.operationId,
      resultingRevision: canonicalReceipt.resultingRevision,
      replayed: true,
      current: false,
      superseded: true,
    };
  }

  await projectionInterleaveForTest?.();

  // Legacy re-dispatch preserves an existing hand-authored SUMMARY. Adopted
  // Milestones deterministically project the durable completion closeout.
  let projectionStale = false;
  let superseded = !isCurrent();
  if (!superseded && (canonicalReceipt || !existsSync(summaryPath))) {
    try {
      await saveFile(summaryPath, summaryMd);
      if (!isCurrent()) {
        superseded = true;
        projectionStale = true;
        await repairSupersededSummary(
          artifactBasePath,
          params.milestoneId,
          summaryPath,
          summaryMd,
        );
      }
    } catch (renderErr) {
      projectionStale = true;
      logWarning("projection", `complete_milestone projection write failed for ${params.milestoneId}; DB completion remains committed`, {
        error: (renderErr as Error).message,
      });
    }
  }

  // Invalidate all caches
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  // Separate try/catch per step so a projection failure doesn't prevent
  // the event log entry (critical for worktree reconciliation).
  try {
    if (!superseded) {
      const flushed = await flushWorkflowProjections(
        artifactBasePath,
        { milestoneId: params.milestoneId },
        canonicalReceipt ? { operationId: canonicalReceipt.operationId, isCurrent } : undefined,
      );
      projectionStale ||= flushed.stale;
      if (!flushed.stale && existsSync(summaryPath)) projectionStale = false;
      superseded ||= flushed.superseded;
    }
  } catch (projErr) {
    projectionStale = true;
    logWarning("tool", `complete-milestone projection warning: ${(projErr as Error).message}`);
  }
  if (!superseded && isCurrent()) {
    try {
      await writeManifestAndFlush(artifactBasePath);
    } catch (mfErr) {
      logWarning("tool", `complete-milestone manifest warning: ${(mfErr as Error).message}`);
    }
  }
  if (!canonicalReceipt) {
    try {
      if (!alreadyComplete) {
        appendEvent(artifactBasePath, {
          cmd: "complete-milestone",
          params: { milestoneId: params.milestoneId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (eventErr) {
      logError("tool", `complete-milestone event log FAILED — completion invisible to reconciliation`, { error: (eventErr as Error).message });
    }
  }

  const current = isCurrent();
  superseded ||= !current;
  projectionStale ||= superseded;
  if (canonicalReceipt && superseded) {
    try {
      await repairSupersededSummary(
        artifactBasePath,
        params.milestoneId,
        summaryPath,
        summaryMd,
      );
    } catch (cleanupError) {
      projectionStale = true;
      logWarning("projection", `complete_milestone superseded projection cleanup failed for ${params.milestoneId}`, {
        error: (cleanupError as Error).message,
      });
    }
  }

  return {
    milestoneId: params.milestoneId,
    summaryPath,
    ...(projectionStale ? { stale: true } : {}),
    ...(alreadyComplete ? { alreadyComplete: true } : {}),
    ...(canonicalReceipt ? {
      operationId: canonicalReceipt.operationId,
      resultingRevision: canonicalReceipt.resultingRevision,
      replayed: canonicalReceipt.status === "replayed",
      current,
      ...(superseded ? { superseded: true } : {}),
    } : {}),
  };
}
