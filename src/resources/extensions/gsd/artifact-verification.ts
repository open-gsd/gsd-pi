// Project/App: gsd-pi
// File Purpose: Auto-mode artifact verification and worktree path fallbacks.

import { parseUnitId } from "./unit-id.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { clearParseCache } from "./files.js";
import {
  isDbAvailable,
  getSlice,
  getSliceTasks,
  getPendingGatesForTurn,
  getReplanHistory,
  getRoadmapAssessmentForSlice,
  getSliceRunUatAssessment,
  hasSavedArtifact,
  hasUnitRecoveryBlock,
} from "./gsd-db.js";
import { readMilestoneSlices, readSlice, readTask } from "./db/lifecycle-read.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning } from "./workflow-logger.js";
import { clearPathCache } from "./paths.js";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getProjectResearchStatus } from "./project-research-policy.js";
import {
  isSetupArtifactSaved,
  isWorkflowPreferencesCaptured,
} from "./project-setup-facts.js";
import { isGsdWorktreePath } from "./worktree-root.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { loadAllCaptures, loadPendingCaptures } from "./captures.js";
import { loadActiveOverrides } from "./overrides.js";
import { proveMilestoneCloseout } from "./milestone-closeout-proof.js";
import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";
import {
  readPendingTaskRecoveryContext,
  readTaskRecoveryAttemptIds,
  readTaskRecoveryResumeEligibility,
  readTaskRecoveryRoute,
} from "./task-recovery-domain-operation.js";
import { readMilestoneValidationVerdict } from "./milestone-validation-verdict.js";

export type ExecuteTaskArtifactReadiness = "verify" | "route";

/** Return the next actionable stage only when the latest Task Attempt has a Result. */
export function readExecuteTaskArtifactReadiness(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): ExecuteTaskArtifactReadiness | null {
  const attempt = readLatestTaskAttempt({ milestoneId, sliceId, taskId });
  if (attempt?.state !== "settled" || !attempt.resultId) return null;
  if (attempt.nextStage === "verify" && attempt.outcome === "succeeded") return "verify";
  if (attempt.nextStage === "route") return "route";
  return null;
}

/**
 * The recovery action id when the newest agent-owned `abort` is not
 * resume-authorized.
 *
 * `readExecuteTaskArtifactReadiness` reports "route" for *any* settled Attempt
 * parked at the route stage — including one whose agent-owned recovery already
 * aborted. Re-dispatching that unit is a guaranteed dead end:
 * `runWithTaskExecutionAttempt` sees the same predecessor route and breaks with
 * `task-recovery-abort` before any work starts (#1622). Stuck recovery must
 * refuse instead of clearing the dispatch ring and re-dispatching.
 *
 * Detection is not limited to the latest Attempt: a resume-eligible abort on a
 * superseded Attempt remains operative when newer Attempts carry no agent abort
 * of their own (#1754 residual). Ineligible actions are historical evidence,
 * not sanctioned exits; consumed actions in particular must never advertise a
 * resume command that deterministically rejects (#1944). A newer agent-owned
 * non-abort route supersedes any older abort (#1908).
 */
export function readTerminalTaskRecoveryAbort(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): { recoveryActionId: string } | null {
  for (const attemptId of readTaskRecoveryAttemptIds({ milestoneId, sliceId, taskId })) {
    const route = readTaskRecoveryRoute(attemptId);
    if (!route || route.recoveryOwner !== "agent") continue;
    // The newest agent-owned route is authoritative: a non-abort action
    // (retry/repair/remediate) on a newer Attempt supersedes any older abort.
    if (route.action !== "abort") return null;
    const eligibility = readTaskRecoveryResumeEligibility(route.recoveryActionId);
    if (!eligibility.eligible) continue;
    return route.resumeAuthorized ? null : { recoveryActionId: route.recoveryActionId };
  }
  return null;
}

export function diagnoseWorktreeIntegrityFailure(basePath: string): string | null {
  if (!isGsdWorktreePath(basePath)) return null;
  if (!existsSync(basePath)) {
    return `Worktree integrity failure: ${basePath} does not exist. Repair or recreate the worktree before retrying.`;
  }

  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (.git missing). Repair or recreate the worktree before retrying.`;
  }

  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return null;
  } catch (err) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (git rev-parse failed: ${getErrorMessage(err).split("\n")[0]}). Repair or recreate the worktree before retrying.`;
  }
}

export function resolveArtifactVerificationBase(unitId: string, base: string): string {
  const { milestone } = parseUnitId(unitId);
  if (!MILESTONE_ID_RE.test(milestone)) return base;
  return resolveCanonicalMilestoneRoot(base, milestone);
}

function hasCompleteProjectResearch(base: string): boolean {
  return getProjectResearchStatus(base).complete;
}

/**
 * The database rows that a unit's save tool commits, read as "what is missing".
 * Returns null when the unit's result is recorded. The rendered files of the
 * unit are projections of these rows and are not read.
 */
function missingUnitResult(
  unitType: string,
  mid: string,
  sid: string | undefined,
  readOnly: boolean,
): string | null {
  switch (unitType) {
    case "discuss-milestone":
      return hasSavedArtifact(mid, null, "CONTEXT") ? null : "no saved milestone CONTEXT in the database";
    case "research-milestone":
      return hasSavedArtifact(mid, null, "RESEARCH") ? null : "no saved milestone RESEARCH in the database";
    case "plan-milestone":
      return readMilestoneSlices(mid).length > 0 ? null : "the milestone has no slice rows in the database";
  }

  if (!sid) return "no artifact contract registered for this unit type";
  switch (unitType) {
    case "discuss-slice":
      return hasSavedArtifact(mid, sid, "CONTEXT") ? null : "no saved slice CONTEXT in the database";
    case "research-slice":
      return hasSavedArtifact(mid, sid, "RESEARCH") ? null : "no saved slice RESEARCH in the database";
    case "plan-slice":
      // Re-open a file-backed DB first: the planning tool can commit from
      // another process, and this connection must see those task rows.
      if (!readOnly) refreshWorkflowDatabaseFromDisk();
      return getSliceTasks(mid, sid).length > 0 ? null : "the slice has no task rows in the database";
    case "refine-slice":
      return getSlice(mid, sid)?.is_sketch === 0 && getSliceTasks(mid, sid).length > 0
        ? null
        : "the slice is still a sketch or has no task rows in the database";
    case "reassess-roadmap":
      return getRoadmapAssessmentForSlice(mid, sid) ? null : "no roadmap assessment row for the slice";
    case "replan-slice":
      return getReplanHistory(mid, sid).length > 0 ? null : "no replan row for the slice";
    case "run-uat":
      return getSliceRunUatAssessment(mid, sid)?.status ? null : "no run-uat verdict row for the slice";
    case "complete-slice": {
      const status = readSlice(mid, sid)?.status;
      return status === "complete" ? null : `the slice row is ${status ? `"${status}"` : "missing"}, not "complete"`;
    }
    default:
      return "no artifact contract registered for this unit type";
  }
}

/**
 * Check whether a unit recorded its result. Milestone, slice and task units
 * are verified against database rows only (ADR-046): a rendered file never
 * proves completion and a missing file never blocks it.
 *
 * With `readOnly` the check decides from the rows already in the open
 * database: it does not re-open the database and writes no gate rows.
 */
export function verifyExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
  options: { readOnly?: boolean } = {},
): boolean {
  if (unitType.startsWith("hook/")) return true;

  clearPathCache();
  clearParseCache();

  if (unitType === "rewrite-docs") {
    return loadActiveOverrides(base).length === 0;
  }

  if (unitType === "workflow-preferences") {
    return isWorkflowPreferencesCaptured();
  }

  if (unitType === "replan-task") {
    const { milestone, slice, task } = parseUnitId(unitId);
    if (!milestone || !slice || !task) return false;
    const recovery = readPendingTaskRecoveryContext({
      milestoneId: milestone,
      sliceId: slice,
      taskId: task,
    });
    return recovery?.action === "replan" && recovery.replanCompleted;
  }

  if (unitType === "triage-captures") {
    const pending = loadPendingCaptures(base);
    if (pending.length === 0) return true;
    logWarning("recovery", `verify-fail triage-captures ${unitId}: ${pending.length} pending capture(s) remain in the database`);
    return false;
  }

  if (unitType === "quick-task") {
    const { slice: captureId } = parseUnitId(unitId);
    const capture = captureId ? loadAllCaptures(base).find((entry) => entry.id === captureId) : undefined;
    if (capture?.executed === true) return true;
    logWarning("recovery", `verify-fail quick-task ${unitId}: capture ${captureId ?? "(missing capture id)"} not found or not recorded as executed by gsd_capture_complete`);
    return false;
  }

  // Deep setup stages are verified against database rows. The rendered
  // PROJECT.md and REQUIREMENTS.md are projections and are not read.
  if (unitType === "discuss-project") {
    return isSetupArtifactSaved("project");
  }

  if (unitType === "discuss-requirements") {
    return isSetupArtifactSaved("requirements");
  }

  if (unitType === "research-project") {
    return hasCompleteProjectResearch(base);
  }

  // Fail closed: milestone, slice and task state is DB-authoritative
  // (ADR-046). With no open DB there is nothing to verify these units
  // against, and a file on disk is not proof. The project-level and sidecar
  // units above have no DB representation yet.
  if (!isDbAvailable()) {
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: DB unavailable, cannot verify unit artifact`);
    return false;
  }

  if (unitType === "reactive-execute") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const plusIdx = batchPart.indexOf("+");
    const batchIds = plusIdx === -1 ? [] : batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (batchIds.length === 0) return false;
    // A batch Task is settled when its row is closed or its latest Attempt has
    // a Result. A task SUMMARY file is a projection and is not read.
    return batchIds.every((tid) =>
      readTask(mid, sid, tid)?.done === true ||
      readExecuteTaskArtifactReadiness(mid, sid, tid) !== null,
    );
  }

  if (unitType === "gate-evaluate") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;

    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) return true;

    const gateIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (gateIds.length === 0) return true;

    try {
      const pending = getPendingGatesForTurn(mid, sid, "gate-evaluate");
      const pendingIds = new Set<string>(pending.map((g) => g.gate_id));
      for (const gid of gateIds) {
        if (pendingIds.has(gid)) return false;
      }
    } catch (err) {
      logWarning("recovery", `gate-evaluate DB check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (unitType === "research-slice" && unitId.endsWith("/parallel-research")) {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) return false;

    // A recorded recovery block is the terminal outcome of the aggregate unit:
    // dispatch then falls back to per-slice research.
    if (hasUnitRecoveryBlock(unitType, unitId)) return true;

    try {
      const slices = readMilestoneSlices(mid);
      const doneSliceIds = new Set(slices.filter((slice) => slice.done).map((slice) => slice.id));
      const hasMilestoneResearch = hasSavedArtifact(mid, null, "RESEARCH");
      for (const slice of slices) {
        if (slice.done) continue;
        if (hasMilestoneResearch && slice.id === "S01") continue;
        if (!(slice.depends ?? []).every((depId) => doneSliceIds.has(depId))) continue;
        if (!hasSavedArtifact(mid, slice.id, "RESEARCH")) {
          logWarning("recovery", `verify-fail ${unitType} ${unitId}: slice ${slice.id} has no saved RESEARCH`);
          return false;
        }
      }
      return true;
    } catch (err) {
      logWarning("recovery", `parallel-research verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  if (unitType === "execute-task") {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (!mid || !sid || !tid) return false;
    try {
      return readExecuteTaskArtifactReadiness(mid, sid, tid) !== null;
    } catch (err) {
      logWarning("recovery", `execute-task Attempt readiness failed for ${unitId}: ${getErrorMessage(err)}`);
      return false;
    }
  }

  if (unitType === "validate-milestone") {
    const { milestone } = parseUnitId(unitId);
    if (!milestone) return false;
    try {
      return readMilestoneValidationVerdict(milestone) !== undefined;
    } catch (err) {
      logWarning("recovery", `validate-milestone DB verification failed for ${unitId}: ${getErrorMessage(err)}`);
      return false;
    }
  }

  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  if (!mid) return false;
  try {
    if (unitType === "complete-milestone") {
      const closeoutProof = proveMilestoneCloseout(mid, {
        refreshFromDisk: !options.readOnly,
        artifactBasePath: resolveArtifactVerificationBase(unitId, base),
        implementationEvidence: {
          basePath: base,
          requirement: "not-absent",
        },
      });
      if (!closeoutProof.ok) {
        logWarning(
          "recovery",
          `verify-fail ${unitType} ${unitId}: closeout proof failed (${closeoutProof.reason}), cannot confirm milestone closeout`,
        );
      }
      return closeoutProof.ok;
    }

    const missing = missingUnitResult(unitType, mid, sid, options.readOnly === true);
    if (missing === null) return true;
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: ${missing}`);
    return false;
  } catch (err) {
    // Fail closed: a failed read is not evidence that the unit completed.
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: DB read failed: ${getErrorMessage(err)}`);
    return false;
  }
}
