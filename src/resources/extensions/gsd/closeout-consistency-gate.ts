// Project/App: gsd-pi
// File Purpose: Shared DB-backed guard for milestone closeout finalization.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getPendingGates,
  isDbAvailable,
} from "./gsd-db.js";
import { readMilestone, readMilestoneSlices, readSliceTasks } from "./db/lifecycle-read.js";
import {
  getWorkflowDatabasePath,
  refreshWorkflowDatabaseFromDisk,
} from "./db-workspace.js";
import { isDeferredStatus } from "./status-guards.js";
import {
  inspectQualityGatesFromEvidence,
  type QualityGateClosureOptions,
} from "./quality-gate-closure.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutAuthorization,
  type MilestoneCloseoutAuthorization,
  type MilestoneCloseoutBlocker,
} from "./db/milestone-closeout-readiness.js";
import { isMilestoneCloseoutPrepared } from "./db/writers/closeout.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  captureMilestoneVerificationSourceRevision,
  diagnoseMilestoneVerificationSourceDrift,
  type VerificationSourceDriftDiagnosis,
} from "./verification-source-integrity.js";
import { resolveRepositoryProjectRoot } from "./repository-registry.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";

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
  /**
   * Preview dry-run (#2230): the dispatch rule records the validation waiver
   * immediately before this gate in a real turn, and preview suppresses that
   * write. When set, a missing-waiver block is treated as waived (without
   * writing) so the preview decision equals the real turn's. Any other
   * blocker still blocks, matching the real post-waiver evaluation.
   */
  assumeValidationWaived?: boolean;
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

  const milestone = readMilestone(milestoneId);
  if (!milestone) {
    return blocked(
      "milestone-missing",
      `Closeout consistency blocked for ${milestoneId}: milestone is missing from canonical DB.`,
    );
  }
  // An open Milestone with a Closeout Plan is prepared: its completion
  // requirements are proven and it completes when the host settles the plan.
  if (
    !milestone.closed &&
    !options.allowOpenMilestone &&
    !isMilestoneCloseoutPrepared(milestoneId)
  ) {
    return blocked(
      "milestone-open",
      `Closeout consistency blocked for ${milestoneId}: canonical DB milestone status is "${milestone.status}".`,
    );
  }

  const adoptedMilestone = isMilestoneLifecycleAdopted(milestoneId);
  const validationRequired = adoptedMilestone || !milestone.discarded;
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
    } else {
      // No lifecycle adoption: there is no canonical closeout authorization to
      // consult, so the gate stops. Cutover runs on the first open; a milestone
      // reaching here unadopted is stale state, never a pass-through.
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: latest milestone validation is "absent". Run \`/gsd dispatch validate ${milestoneId}\` to create the validation, or set \`phases.skip_milestone_validation: true\` in .gsd/PREFERENCES.md to skip it.`,
      );
    }
  }

  const slices = readMilestoneSlices(milestoneId);
  if (slices.length === 0 && !milestone.discarded) {
    return blocked(
      "slice-missing",
      `Closeout consistency blocked for ${milestoneId}: no slices exist in canonical DB.`,
    );
  }

  // A validation-required milestone always carries an authorized canonical
  // closeout authorization here — the gate stopped above otherwise. Adopted
  // milestones defer validation-owned gate closure to complete-milestone so
  // waivers stay pending until the terminal completion write (#2248 area).
  const authorizedCloseout = canonicalAuthorization?.authorized ? canonicalAuthorization : null;
  const gateClosureOptions: QualityGateClosureOptions | null =
    validationRequired && authorizedCloseout
      ? { milestoneValidationAuthorization: authorizedCloseout }
      : null;
  const plannedGateClosure = gateClosureOptions
    ? inspectQualityGatesFromEvidence(milestoneId, gateClosureOptions)
    : { repaired: [], unresolved: [] };

  for (const slice of slices) {
    if (isDeferredStatus(slice.status)) continue;
    if (!slice.closed) {
      return blocked(
        "slice-open",
        `Closeout consistency blocked for ${milestoneId}: slice ${slice.id} status is "${slice.status}".`,
      );
    }

    const taskStatusById = new Map<string, string>();
    for (const task of readSliceTasks(milestoneId, slice.id)) {
      taskStatusById.set(task.id, task.status);
      if (!task.done) {
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
