// Project/App: gsd-pi
// File Purpose: Shared DB-backed guard for milestone closeout finalization.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getLatestAssessmentByScope,
  getMilestone,
  getMilestoneSlices,
  getPendingGates,
  getSliceTasks,
  insertAssessment,
  isDbAvailable,
  transaction,
} from "./gsd-db.js";
import {
  getWorkflowDatabasePath,
  refreshWorkflowDatabaseFromDisk,
} from "./db-workspace.js";
import { isClosedStatus, isDeferredStatus } from "./status-guards.js";
import {
  closeQualityGatesFromEvidence,
  inspectQualityGatesFromEvidence,
  type QualityGateClosureOptions,
} from "./quality-gate-closure.js";
import { insertMilestoneValidationGates } from "./milestone-validation-gates.js";
import { relMilestoneFile, resolveSliceFile } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutAuthorization,
  type MilestoneCloseoutAuthorization,
  type MilestoneCloseoutBlocker,
} from "./db/milestone-closeout-readiness.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  captureMilestoneVerificationSourceRevision,
  diagnoseMilestoneVerificationSourceDrift,
  type VerificationSourceDriftDiagnosis,
} from "./verification-source-integrity.js";
import { resolveRepositoryProjectRoot } from "./repository-registry.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";

export const CLOSEOUT_CONSISTENCY_BLOCKED_REASON = "closeout-consistency-blocked";

/**
 * Authorization blockers a fresh validation waiver supersedes. The real
 * grant only requires an adopted, open lifecycle — it never inspects the
 * recorded validation state — so under a preview dry-run these blockers are
 * exactly the ones the would-be waiver would erase. `validation-receipt-invalid`
 * is excluded: it implies corrupt or multiple waivers, where the real grant
 * throws and the dispatch rule stops.
 */
const VALIDATION_SHAPED_BLOCKERS: ReadonlySet<MilestoneCloseoutBlocker["kind"]> = new Set([
  "validation-missing",
  "validation-not-pass",
  "validation-stale",
  "validation-attempt-newer",
  "validation-source-revision-mismatch",
  "criterion-unsatisfied",
  "source-revision-mismatch",
]);

export type CloseoutConsistencyFailureReason =
  | "db-unavailable"
  | "db-refresh-failed"
  | "milestone-missing"
  | "milestone-open"
  | "validation-not-pass"
  | "validation-source-revision-mismatch"
  | "slice-missing"
  | "slice-open"
  | "task-open"
  | "quality-gate-pending";

export type CloseoutConsistencyResult =
  | { ok: true }
  | {
      ok: false;
      reason: CloseoutConsistencyFailureReason;
      recoveryReason: typeof CLOSEOUT_CONSISTENCY_BLOCKED_REASON;
      message: string;
    };

export interface CloseoutConsistencyOptions {
  refreshFromDisk?: boolean;
  allowOpenMilestone?: boolean;
  artifactBasePath?: string;
  allowPassThroughValidation?: boolean;
  /**
   * Preview dry-run (#2230): the dispatch rule records the validation waiver
   * immediately before this gate in a real turn, and preview suppresses that
   * write. When set, a missing-waiver block is treated as waived (without
   * writing) so the preview decision equals the real turn's. Any other
   * blocker still blocks, matching the real post-waiver evaluation.
   */
  assumeValidationWaived?: boolean;
  /**
   * Preview dry-run (#2230): evaluate without the gate's own writes — the
   * pass-through validation recorder and evidence-based gate closure.
   * Decisions are mirrored read-only so the result equals the real turn's.
   */
  readOnly?: boolean;
}

function blocked(reason: CloseoutConsistencyFailureReason, message: string): CloseoutConsistencyResult {
  return {
    ok: false,
    reason,
    recoveryReason: CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
    message,
  };
}

function formatAuthorizationBlocker(blocker: MilestoneCloseoutBlocker): string {
  switch (blocker.kind) {
    case "validation-missing":
      return "validation is missing";
    case "validation-receipt-invalid":
      return `validation receipt is invalid (${blocker.fields.join(", ")})`;
    case "validation-not-pass":
      return `validation verdict is ${blocker.overallVerdict}`;
    case "validation-source-revision-mismatch":
      return `validation-source-revision-mismatch (expected source revision ${blocker.expectedSourceRevision}; tested source revision ${blocker.testedSourceRevision})`;
    case "criterion-unsatisfied":
      return `criterion ${blocker.criterionKey} (${blocker.criterionId}) is unsatisfied`;
    case "source-revision-mismatch":
      return `criterion ${blocker.criterionKey} source mismatch (expected ${blocker.expectedSourceRevision}; tested ${blocker.testedSourceRevision ?? "missing"})`;
    case "validation-stale":
      return `validation is stale (validation revision ${blocker.validationRevision}; descendant revision ${blocker.descendantRevision})`;
    case "validation-attempt-newer":
      return `newer validation attempt ${blocker.attemptId} is ${blocker.attemptState} at revision ${blocker.attemptRevision}`;
  }
}

export function formatCloseoutAuthorizationBlockers(
  blockers: MilestoneCloseoutBlocker[],
  drift: VerificationSourceDriftDiagnosis = { paths: [], autoCommitDetected: false },
): string {
  const details = blockers.map(formatAuthorizationBlocker).join("; ");
  if (!blockers.some((blocker) => blocker.kind === "validation-source-revision-mismatch")) {
    return details;
  }
  const paths = drift.paths.length > 0
    ? ` Offending source paths: ${drift.paths.join(", ")}.`
    : " Inspect `git status` and the latest commit for the offending source paths.";
  const autoCommit = drift.autoCommitDetected
    ? " The current HEAD is GSD's pre-merge auto-commit."
    : "";
  return `${details}.${paths}${autoCommit}`;
}

function isFileBackedDbPath(path: string | null): boolean {
  return Boolean(path && path !== ":memory:");
}

/**
 * Task statuses that mean the task will never run, so its task-scoped gate
 * rows can never be evaluated: "skipped" (the canonical status replan-slice
 * projects onto removed "husk" tasks) and the raw legacy alias "cancelled".
 * Deferred is intentionally absent: a deferred task is not a closed status and
 * exits via the task-open check before gates are consulted.
 */
function isNeverWillRunTaskStatus(status: string | undefined): boolean {
  return status === "skipped" || status === "cancelled";
}

function artifactBasePathFromDb(): string | undefined {
  const dbPath = getWorkflowDatabasePath();
  if (!isFileBackedDbPath(dbPath)) return undefined;
  const dbBasePath = dirname(dirname(dbPath!));
  return existsSync(join(dbBasePath, ".git"))
    ? dbBasePath
    : resolveRepositoryProjectRoot(process.cwd());
}

function allSlicesHaveCloseoutSummaryEvidence(milestoneId: string, artifactBasePath: string): boolean {
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return false;

  return slices.every((slice) => {
    if (!isClosedStatus(slice.status)) return false;
    for (const task of getSliceTasks(milestoneId, slice.id)) {
      if (!isClosedStatus(task.status)) return false;
    }
    const summaryPath = resolveSliceFile(artifactBasePath, milestoneId, slice.id, "SUMMARY");
    return Boolean(summaryPath && existsSync(summaryPath));
  });
}

function renderCloseoutPassThroughValidation(milestoneId: string): string {
  return [
    "---",
    "verdict: pass",
    "skip_validation: true",
    "skip_validation_reason: closeout-recovery",
    "remediation_round: 0",
    "---",
    "",
    "# Milestone Validation (skipped)",
    "",
    `Milestone validation was recorded during closeout for ${milestoneId} because all slices already had SUMMARY evidence and no milestone-validation assessment was present.`,
    "",
  ].join("\n");
}

function recordCloseoutPassThroughValidationIfReady(
  milestoneId: string,
  artifactBasePath?: string,
): boolean {
  const basePath = artifactBasePath ?? artifactBasePathFromDb();
  if (!basePath) return false;

  const existing = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  if (existing?.status === "pass") return true;
  if (existing) return false;
  if (!allSlicesHaveCloseoutSummaryEvidence(milestoneId, basePath)) return false;

  const validationPath = join(basePath, relMilestoneFile(basePath, milestoneId, "VALIDATION"));
  const content = renderCloseoutPassThroughValidation(milestoneId);
  atomicWriteSync(validationPath, content, "utf-8");

  try {
    transaction(() => {
      insertAssessment({
        path: validationPath,
        milestoneId,
        sliceId: null,
        taskId: null,
        status: "pass",
        scope: "milestone-validation",
        fullContent: content,
      });
      const gateSliceId = getMilestoneSlices(milestoneId)[0]?.id;
      if (gateSliceId) {
        insertMilestoneValidationGates(
          milestoneId,
          gateSliceId,
          "pass",
          new Date().toISOString(),
        );
      }
    });
  } catch (err) {
    try {
      removeProjectionFileSync(validationPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }

  invalidateAllCaches();
  return true;
}

export function checkCloseoutConsistencyGate(
  milestoneId: string,
  options: CloseoutConsistencyOptions = {},
): CloseoutConsistencyResult {
  if (!isDbAvailable()) {
    return blocked(
      "db-unavailable",
      `Closeout consistency blocked for ${milestoneId}: canonical DB is unavailable.`,
    );
  }

  if (options.refreshFromDisk && isFileBackedDbPath(getWorkflowDatabasePath()) && !refreshWorkflowDatabaseFromDisk()) {
    return blocked(
      "db-refresh-failed",
      `Closeout consistency blocked for ${milestoneId}: canonical DB refresh failed.`,
    );
  }

  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    return blocked(
      "milestone-missing",
      `Closeout consistency blocked for ${milestoneId}: milestone is missing from canonical DB.`,
    );
  }
  if (!isClosedStatus(milestone.status) && !options.allowOpenMilestone) {
    return blocked(
      "milestone-open",
      `Closeout consistency blocked for ${milestoneId}: canonical DB milestone status is "${milestone.status}".`,
    );
  }

  const adoptedMilestone = isMilestoneLifecycleAdopted(milestoneId);
  const validationRequired = adoptedMilestone || milestone.status !== "skipped";
  let validation = validationRequired && !adoptedMilestone
    ? getLatestAssessmentByScope(milestoneId, "milestone-validation")
    : null;
  if (
    validationRequired &&
    !adoptedMilestone &&
    validation?.status !== "pass" &&
    options.allowPassThroughValidation
  ) {
    const artifactBasePath = options.artifactBasePath ?? artifactBasePathFromDb();
    if (options.readOnly) {
      // Preview: the pass-through recorder writes a VALIDATION projection and
      // assessment/gate rows. It only records when no assessment exists and
      // every closed slice has SUMMARY evidence — mirror those read-only
      // preconditions and evaluate the rest of the gate as if recorded,
      // without writing (#2230).
      if (!validation && artifactBasePath && allSlicesHaveCloseoutSummaryEvidence(milestoneId, artifactBasePath)) {
        validation = { status: "pass" } as NonNullable<typeof validation>;
      }
    } else if (recordCloseoutPassThroughValidationIfReady(milestoneId, artifactBasePath)) {
      validation = getLatestAssessmentByScope(milestoneId, "milestone-validation");
    }
  }
  let canonicalAuthorization = null;
  let authorizationDrift: VerificationSourceDriftDiagnosis = {
    paths: [],
    autoCommitDetected: false,
  };
  if (adoptedMilestone) {
    // Resolve the tree the milestone actually executed in. Under worktree
    // isolation validation runs inside .gsd-worktrees/<id> and records that
    // tree's revision; computing the current revision from the project root
    // compares two different working trees, so the authorization could never
    // match and the merge blocked with "validation authorization is not
    // current" on a milestone the DB had already marked complete.
    const artifactBasePath = resolveCanonicalMilestoneRoot(
      options.artifactBasePath ?? artifactBasePathFromDb() ?? "",
      milestoneId,
    ) || options.artifactBasePath || artifactBasePathFromDb();
    if (!artifactBasePath) {
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: canonical verification source root is unavailable.`,
      );
    }
    const preferences = loadEffectiveGSDPreferences(artifactBasePath)?.preferences;
    const source = captureMilestoneVerificationSourceRevision(
      artifactBasePath,
      preferences,
    );
    if (!source.ok) {
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: ${source.error}`,
      );
    }
    canonicalAuthorization = readMilestoneCloseoutAuthorization({
      milestoneId,
      sourceRevision: source.sourceRevision,
    });
    if (
      options.assumeValidationWaived &&
      !canonicalAuthorization.authorized &&
      canonicalAuthorization.blockers.length > 0 &&
      canonicalAuthorization.blockers.every(
        (blocker) => VALIDATION_SHAPED_BLOCKERS.has(blocker.kind),
      )
    ) {
      // Preview dry-run: the would-be waiver is treated as recorded. The real
      // grant is unconditional with respect to validation state (it only
      // requires an adopted, open lifecycle and supersedes any prior waiver
      // or validation event), so any all-validation-shaped blocker would be
      // erased by the fresh waiver. The fabricated receipt carries the
      // gate's own source revision, so the revision-match outcome equals the
      // real waiver granted for this tree. `validation-receipt-invalid` is
      // excluded: it implies corrupt/multiple waivers, where the real grant
      // throws and the rule stops.
      canonicalAuthorization = {
        authorized: true,
        kind: "waived",
        eventId: `preview:${milestoneId}`,
        revision: 0,
        testedSourceRevision: source.sourceRevision,
      } satisfies MilestoneCloseoutAuthorization;
    }
    if (
      !canonicalAuthorization.authorized &&
      canonicalAuthorization.blockers.some(
        (blocker) => blocker.kind === "validation-source-revision-mismatch",
      )
    ) {
      authorizationDrift = diagnoseMilestoneVerificationSourceDrift(
        artifactBasePath,
        preferences,
      );
    }
  }
  if (validationRequired) {
    if (canonicalAuthorization) {
      if (!canonicalAuthorization.authorized) {
        const sourceMismatch = canonicalAuthorization.blockers.some(
          (blocker) => blocker.kind === "validation-source-revision-mismatch",
        );
        return blocked(
          sourceMismatch ? "validation-source-revision-mismatch" : "validation-not-pass",
          `Closeout consistency blocked for ${milestoneId}: ${formatCloseoutAuthorizationBlockers(canonicalAuthorization.blockers, authorizationDrift)}`,
        );
      }
    } else if (validation?.status !== "pass") {
      const validationStatus = validation?.status ?? "absent";
      const recovery =
        validationStatus === "absent"
          ? ` Run \`/gsd validate-milestone ${milestoneId}\` to create the validation, or set \`phases.skip_milestone_validation: true\` in .gsd/PREFERENCES.md to skip it.`
          : "";
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: latest milestone validation is "${validationStatus}".${recovery}`,
      );
    }
  }

  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0 && milestone.status !== "skipped") {
    return blocked(
      "slice-missing",
      `Closeout consistency blocked for ${milestoneId}: no slices exist in canonical DB.`,
    );
  }

  let gateClosureOptions: QualityGateClosureOptions | null = null;
  if (validationRequired) {
    gateClosureOptions = canonicalAuthorization?.authorized
      ? { milestoneValidationAuthorization: canonicalAuthorization }
      : {
          artifactBasePath: options.artifactBasePath ?? artifactBasePathFromDb(),
          milestoneValidationPassed: validation?.status === "pass",
        };
  }
  const plannedGateClosure = gateClosureOptions
    ? inspectQualityGatesFromEvidence(milestoneId, gateClosureOptions)
    : { repaired: [], unresolved: [] };

  // Closing gates persists what the read-only inspection above already found;
  // the pending-gate decision below uses plannedGateClosure either way, so
  // suppressing the write under preview is decision-neutral (#2230).
  if (!adoptedMilestone && gateClosureOptions && !options.readOnly) {
    closeQualityGatesFromEvidence(milestoneId, gateClosureOptions);
  }

  for (const slice of slices) {
    if (isDeferredStatus(slice.status)) continue;
    if (!isClosedStatus(slice.status)) {
      return blocked(
        "slice-open",
        `Closeout consistency blocked for ${milestoneId}: slice ${slice.id} status is "${slice.status}".`,
      );
    }

    const taskStatusById = new Map<string, string>();
    for (const task of getSliceTasks(milestoneId, slice.id)) {
      taskStatusById.set(task.id, task.status);
      if (!isClosedStatus(task.status)) {
        return blocked(
          "task-open",
          `Closeout consistency blocked for ${milestoneId}: task ${slice.id}/${task.id} status is "${task.status}".`,
        );
      }
    }

    // #2239: replan-slice deliberately retains removed ("husk") task rows, but
    // their task-scoped gate rows stay pending forever. A gate whose owning
    // task was skipped/cancelled away is unreachable — no session will ever
    // evaluate it — so it must not block closeout. Scope is what makes a gate
    // task-owned (a slice-scoped row may still carry a task_id), and gates of
    // live tasks keep blocking.
    const pendingGate = getPendingGates(milestoneId, slice.id).find((gate) =>
      !(gate.scope === "task" && isNeverWillRunTaskStatus(taskStatusById.get(gate.task_id)))
      && !plannedGateClosure.repaired.some((repair) =>
        repair.gateId === gate.gate_id
        && repair.sliceId === gate.slice_id
        && (repair.taskId ?? "") === gate.task_id
      )
    );
    if (pendingGate) {
      return blocked(
        "quality-gate-pending",
        `Closeout consistency blocked for ${milestoneId}: quality gate ${pendingGate.gate_id} is still pending for ${slice.id}.`,
      );
    }
  }

  return { ok: true };
}

export function formatCloseoutConsistencyBlock(result: CloseoutConsistencyResult): string {
  if (result.ok) return "";
  if (result.reason === "validation-source-revision-mismatch") {
    return `${result.message} Recovery reason: ${result.recoveryReason}. Restore or remove unintended working-tree drift, or re-run milestone validation against the intended current content, then run /gsd auto.`;
  }
  return `${result.message} Recovery reason: ${result.recoveryReason}. Resolve the canonical DB state and run /gsd auto to retry.`;
}
