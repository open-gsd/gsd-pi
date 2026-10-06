// Project/App: gsd-pi
// File Purpose: Complete-milestone tool handler for GSD workflow state and summaries.

// gsd-pi complete-milestone tool handler
/**
 * complete-milestone handler — the core operation behind gsd_complete_milestone.
 *
 * Milestones validate canonical closeout evidence and complete through one
 * Domain Operation before rendering the durable summary projection.
 */

import { existsSync } from "node:fs";

import { getMilestone } from "../gsd-db.js";
import { readMilestone } from "../db/lifecycle-read.js";
import { clearPathCache, resolveMilestoneFile, targetMilestoneFile } from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { saveFile, clearParseCache, loadFile } from "../files.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { logWarning } from "../workflow-logger.js";
import {
  readMilestoneCloseoutAuthorization,
  readMilestoneLifecycleStatus,
} from "../db/milestone-closeout-readiness.js";
import {
  pendingRequiredCloseoutEffects,
  prepareCloseout,
} from "../closeout-domain-operation.js";
import {
  hasPendingCloseoutEffect,
  milestoneCloseoutEffects,
} from "../milestone-closeout-effects.js";
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
  /**
   * Set when the Closeout Plan is stored and the Milestone is still open: it
   * completes when the host settles these effects (the milestone merge).
   */
  pendingCloseoutEffects?: string[];
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
  if (readMilestone(milestoneId)?.closed) return;
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

function milestoneSummaryPath(artifactBasePath: string, milestoneId: string): string {
  return resolveMilestoneFile(artifactBasePath, milestoneId, "SUMMARY") ??
    targetMilestoneFile(artifactBasePath, milestoneId, "SUMMARY", getMilestone(milestoneId)?.title);
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
  if (!invocation) {
    return { error: "milestone completion requires canonical invocation identity" };
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);

  const replaySourceRevision = readMilestoneCompletionReplaySourceRevision(invocation.idempotencyKey);
  let currentSourceRevision: string;
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

  // ── Guards + canonical write inside one Domain Operation ────────────────
  let completedAt = new Date().toISOString();
  let alreadyComplete = false;
  let canonicalReceipt: MilestoneCompletionReceipt;

  try {
    const authorization = readMilestoneCloseoutAuthorization({
      milestoneId: params.milestoneId,
      sourceRevision: currentSourceRevision,
    });
    if (authorization.authorized) {
      closeQualityGatesFromEvidence(params.milestoneId, {
        milestoneValidationPassed: authorization.kind === "validated",
        milestoneValidationAuthorization: authorization,
      });
    }
    const audit = {
      ...(params.actorName ? { actorName: params.actorName } : {}),
      ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
    };
    const lifecycleStatus = readMilestoneLifecycleStatus(params.milestoneId);
    // The effects come from the tree this closeout proves. A call from the
    // project root still closes out the live milestone worktree, so its
    // merge stays required.
    const effects = lifecycleStatus === "ready" || lifecycleStatus === "in_progress"
      ? milestoneCloseoutEffects(artifactBasePath, params.milestoneId)
      : [];
    // A live plan that waits for an effect the Milestone no longer needs
    // (the branch was merged and deleted by hand, or the work now runs on
    // the integration branch) is superseded by a plan with the current
    // effects, so it does not block completion forever.
    if (effects.length > 0 || hasPendingCloseoutEffect(params.milestoneId)) {
      const plan = prepareCloseout({
        invocation: { ...invocation, idempotencyKey: `${invocation.idempotencyKey}/closeout.prepare` },
        milestoneId: params.milestoneId,
        sourceRevision: currentSourceRevision,
        closeout: completionCloseout(params),
        audit,
        effects,
      });
      const pending = pendingRequiredCloseoutEffects(plan);
      if (pending.length > 0) {
        invalidateStateCache();
        return {
          milestoneId: params.milestoneId,
          summaryPath: milestoneSummaryPath(artifactBasePath, params.milestoneId),
          pendingCloseoutEffects: pending.map((effect) => effect.effectKind),
        };
      }
    }
    canonicalReceipt = completeMilestone({
      invocation,
      milestoneId: params.milestoneId,
      sourceRevision: currentSourceRevision,
      closeout: completionCloseout(params),
      audit,
    });
    completedAt = canonicalReceipt.completedAt;
    alreadyComplete = canonicalReceipt.status === "replayed";
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // ── Filesystem operations (outside the Domain Operation) ────────────────
  const summaryMd = renderMilestoneSummaryMarkdown(
    params.milestoneId,
    completedAt,
    canonicalReceipt.closeout,
  );

  const summaryPath = milestoneSummaryPath(artifactBasePath, params.milestoneId);

  const isCurrent = () => isCurrentMilestoneCompletionOperation(
    canonicalReceipt.operationId,
    params.milestoneId,
  );

  if (!canonicalReceipt.isCurrent) {
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

  // The SUMMARY is a projection of the durable completion closeout: it is
  // always (re)rendered from the committed row.
  let projectionStale = false;
  let superseded = !isCurrent();
  if (!superseded) {
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

  // ── Post-mutation hook: projections, manifest ───────────────────────────
  // Separate try/catch per step so a projection failure doesn't prevent
  // the manifest flush.
  try {
    if (!superseded) {
      const flushed = await flushWorkflowProjections(
        artifactBasePath,
        { milestoneId: params.milestoneId },
        { operationId: canonicalReceipt.operationId, isCurrent },
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

  const current = isCurrent();
  superseded ||= !current;
  projectionStale ||= superseded;
  if (superseded) {
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
    operationId: canonicalReceipt.operationId,
    resultingRevision: canonicalReceipt.resultingRevision,
    replayed: canonicalReceipt.status === "replayed",
    current,
    ...(superseded ? { superseded: true } : {}),
  };
}
