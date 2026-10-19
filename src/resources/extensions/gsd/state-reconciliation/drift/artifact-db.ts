// Project/App: gsd-pi
// File Purpose: Fail-closed reconciliation guards for DB/artifact and slice-id drift.
// Which Milestone, Slice or Task is closed comes from the read interface
// (db/lifecycle-read.ts): the same answer as dispatch.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  _getAdapter,
  clearTaskSummaryProjectionState,
  getMilestoneSlices,
  isDbAvailable,
} from "../../gsd-db.js";
import {
  readMilestone,
  readMilestoneSlices,
  readMilestones,
  readSliceTasks,
  readTask,
} from "../../db/lifecycle-read.js";
import { clearParseCache } from "../../files.js";
import {
  clearPathCache,
  gsdProjectionRoot,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
} from "../../paths.js";
import { isClosedStatus } from "../../status-guards.js";
import { findMilestoneIds } from "../../milestone-ids.js";
import { removeProjectionTreeSync } from "../../atomic-write.js";
import { invalidateStateCache } from "../../state.js";
import { hasTaskExecutionOrReopenHistory, latestSliceReopenAt, listRunningTaskAttempts } from "../../db/lifecycle-queries.js";
import type { GSDState } from "../../types.js";
import {
  completedEventCoversDispatch,
  isAfter,
  latestExplicitReopenAt,
  legacyReopenImportGuidance,
} from "../../milestone-reopen-events.js";
import { isCanonicalStagedTaskSummaryProjection } from "../../task-summary-projection-classification.js";
import {
  isTaskExecutionAttemptOrphaned,
  readLatestSettledTaskAttempt,
  readLatestTaskAttempt,
  type TaskExecutionAttemptSnapshot,
} from "../../task-execution-domain-operation.js";
import { readTaskRecoveryRoute } from "../../task-recovery-domain-operation.js";
import { taskHasVerificationPauseReceipt } from "../../task-settle.js";
import { quarantineProjectionEvidence } from "../../projection-observation.js";
import { reopenProjectionRoots } from "../../projection-cleanup.js";
import { computeProjectionSha, deriveCompatProjectionKey, readCompatMarker } from "../../compat/compat-marker.js";
import { comparableProjectionContent } from "../../markdown-renderer.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type DiskSliceIdDivergenceDrift = Extract<
  DriftRecord,
  { kind: "disk-slice-id-divergence" }
>;
type ArtifactDbStatusDivergenceDrift = Extract<
  DriftRecord,
  { kind: "artifact-db-status-divergence" }
>;
type CompletedMilestoneReopenedDrift = Extract<
  DriftRecord,
  { kind: "completed-milestone-reopened" }
>;

type ArtifactStatusRow = {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
  imported_at: string | null;
};

type CompletedDispatchRow = {
  started_at: string | null;
  ended_at: string | null;
};

function safeListArtifactRows(milestoneId: string): ArtifactStatusRow[] {
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    return adapter
      .prepare(
        `SELECT path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
         FROM artifacts
         WHERE milestone_id = :mid
         ORDER BY imported_at, path`,
      )
      .all({ ":mid": milestoneId }) as ArtifactStatusRow[];
  } catch {
    return [];
  }
}

function completedMilestoneDispatches(
  milestoneId: string,
): CompletedDispatchRow[] {
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    return adapter
      .prepare(
        `SELECT started_at, ended_at
         FROM unit_dispatches
         WHERE milestone_id = :mid
           AND unit_type = 'complete-milestone'
           AND unit_id = :mid
           AND status = 'completed'
         ORDER BY COALESCE(ended_at, started_at) DESC, id DESC`,
      )
      .all({ ":mid": milestoneId }) as CompletedDispatchRow[];
  } catch {
    return [];
  }
}

function hasExplicitReopenAfter(
  milestoneId: string,
  completedDispatchAt: string | null | undefined,
): boolean {
  const reopenAt = latestExplicitReopenAt(milestoneId);
  if (!reopenAt) return false;
  if (!completedDispatchAt) return true;
  return Date.parse(reopenAt) > Date.parse(completedDispatchAt);
}

/**
 * Disk-existence check for a staged task SUMMARY artifact row (#1771): the
 * recorded path, or the currently-resolved projection path. Mirrors the
 * sibling disk-check branch below so a stale DB row whose file never existed
 * cannot fail-close into a phantom divergence wedge.
 */
function stagedTaskSummaryExistsOnDisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  rowPath: string,
): boolean {
  const candidates = [
    isAbsolute(rowPath) ? rowPath : resolve(basePath, rowPath),
    resolveTaskFile(basePath, milestoneId, sliceId, taskId, "SUMMARY"),
  ];
  return candidates.some((candidate) => candidate !== null && existsSync(candidate));
}

/**
 * Whether a missing-file SUMMARY row has authoritative history proving that
 * it is dead bookkeeping: either the task ran before returning to pending
 * (#1771), or its current lifecycle head is an explicit reopen after a
 * completion failed before minting an Attempt (#1983).
 */
function taskHasExecutionOrReopenHistory(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): boolean {
  if (!isDbAvailable()) return false;
  return hasTaskExecutionOrReopenHistory(milestoneId, sliceId, taskId);
}

/**
 * Disk-existence check for a slice-level SUMMARY artifact row: the recorded
 * path, or the currently-resolved slice projection path. Mirrors the
 * task-level stagedTaskSummaryExistsOnDisk above.
 */
function sliceSummaryExistsOnDisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  rowPath: string,
): boolean {
  const candidates = [
    isAbsolute(rowPath) ? rowPath : resolve(basePath, rowPath),
    resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY"),
  ];
  return candidates.some((candidate) => candidate !== null && existsSync(candidate));
}

/**
 * The occurred-at of a slice's newest explicit reopen, or null when the DB
 * is unavailable or the slice was never reopened. The caller ties this to
 * the artifact row's imported_at: only a row that predates the reopen is
 * dead bookkeeping left by the pre-reopen completion.
 */
function sliceLatestReopenAt(milestoneId: string, sliceId: string): string | null {
  if (!isDbAvailable()) return null;
  return latestSliceReopenAt(milestoneId, sliceId);
}

/**
 * Content proof that the staged SUMMARY projection named by `record` is the
 * Task's own DB intent: a surviving disk copy comparable to
 * `tasks.full_summary_md`, or the projection marker the staging write left
 * behind. Shared by the abandoned (#2714) and verification-paused (#2864)
 * staged-SUMMARY classifications.
 */
function stagedSummaryProjectionMatchesTaskIntent(
  basePath: string,
  record: ArtifactDbStatusDivergenceDrift,
  task: { full_summary_md: string | null },
  allowMarkerBaseline: boolean,
): boolean {
  const projectionPath = resolveTaskSummaryDriftPath(basePath, record);
  const canonicalPath = resolveTaskFile(
    basePath,
    record.milestoneId,
    record.sliceId!,
    record.taskId!,
    "SUMMARY",
  );
  if (!projectionPath || !canonicalPath || resolve(projectionPath) !== resolve(canonicalPath)) return false;
  let content: string;
  try {
    content = readFileSync(projectionPath, "utf8");
  } catch {
    return false;
  }
  if (
    task.full_summary_md &&
    comparableProjectionContent(content) === comparableProjectionContent(task.full_summary_md)
  ) return true;
  // The marker vouches for what staging wrote, not for the current DB intent:
  // admissible only where the repair keeps the Task's intent in place
  // (#2714 abandoned staging), never where it deletes it (#2864 pause).
  if (!allowMarkerBaseline) return false;

  const projectionKey = deriveCompatProjectionKey(
    projectionPath,
    [gsdProjectionRoot(basePath), join(basePath, ".gsd")],
  );
  // gsd_summary_save renders the SUMMARY at the project root and copies it into
  // the milestone worktree. The baseline of that copy is only in the
  // project-root marker (#2714).
  const sha = computeProjectionSha(content);
  return reopenProjectionRoots(basePath).some((root) =>
    readCompatMarker(root).projections[projectionKey]?.sha === sha
  );
}

/**
 * Whether a SUMMARY artifacts row of this Task still carries the Task's own
 * DB intent. The disk-independent half of the #2864 proof: the pause state is
 * exactly the one whose projection copy projection-worker may already have
 * quarantined, so the row itself must be able to prove the staging.
 */
function stagedTaskSummaryRowMatchesTaskIntent(
  record: ArtifactDbStatusDivergenceDrift,
  task: { full_summary_md: string | null },
): boolean {
  const intent = task.full_summary_md;
  if (!intent) return false;
  return safeListArtifactRows(record.milestoneId).some((candidate) =>
    candidate.artifact_type === "SUMMARY" &&
    candidate.slice_id === record.sliceId &&
    candidate.task_id === record.taskId &&
    comparableProjectionContent(candidate.full_content) ===
      comparableProjectionContent(intent)
  );
}

function isAbandonedStagedTaskSummary(
  record: ArtifactDbStatusDivergenceDrift,
  basePath: string,
): boolean {
  if (!record.sliceId || !record.taskId || record.artifactType !== "SUMMARY") return false;
  const task = readTask(record.milestoneId, record.sliceId, record.taskId);
  if (task?.status !== "in_progress") return false;
  const attemptIdentity = {
    milestoneId: record.milestoneId,
    sliceId: record.sliceId,
    taskId: record.taskId,
  };
  const latest = readLatestTaskAttempt(attemptIdentity);
  // #2855: a kill between staging and publication leaves the re-dispatch
  // Attempt orphaned `running` (terminal coordination dispatch row, no live
  // runner) on top of the settled attempt that owns the durable outcome.
  // Classify the staged SUMMARY against that settled attempt instead of
  // fail-closing on the orphan.
  const attempt = isTaskExecutionAttemptOrphaned(latest)
    ? readLatestSettledTaskAttempt(attemptIdentity) ?? latest
    : latest;
  if (attempt?.state !== "settled" || attempt.outcome === "succeeded") return false;

  return stagedSummaryProjectionMatchesTaskIntent(basePath, record, task, true);
}

/**
 * #2864: the verification-pause identity of a staged-SUMMARY drift record —
 * legacy in_progress, `attempt` settled succeeded at the verify stage, a
 * durable `task.verification.paused` receipt vouching for that exact Attempt
 * (a receipt for an earlier Attempt never vouches, mirroring the #2334
 * reconcile gate), and no agent-owned abort route owning the lineage. This is
 * the state the `gsd task settle --reconcile-lifecycle` gate releases to
 * ready, so the drift repair may treat its staged SUMMARY as repairable
 * bookkeeping. Without the receipt the state stays fail-closed.
 */
function verificationPausedAttemptUnit(
  record: ArtifactDbStatusDivergenceDrift,
  attempt: TaskExecutionAttemptSnapshot | null,
): { milestoneId: string; sliceId: string; taskId: string } | null {
  if (!record.sliceId || !record.taskId || record.artifactType !== "SUMMARY") return null;
  if (
    attempt?.state !== "settled" ||
    attempt.outcome !== "succeeded" ||
    attempt.nextStage !== "verify"
  ) return null;
  const unit = {
    milestoneId: record.milestoneId,
    sliceId: record.sliceId,
    taskId: record.taskId,
  };
  const task = readTask(record.milestoneId, record.sliceId, record.taskId);
  if (task?.status !== "in_progress") return null;
  if (!taskHasVerificationPauseReceipt(unit, attempt.attemptId)) return null;
  const route = readTaskRecoveryRoute(attempt.attemptId);
  if (route && route.recoveryOwner === "agent" && route.action === "abort" && !route.resumeAuthorized) {
    return null;
  }
  return unit;
}

/**
 * #2864: the verification-paused staged SUMMARY with its content proof — the
 * row (or a surviving projection copy) must still carry the Task's own DB
 * intent, exactly as the #2334 reconcile gate leaves it. The marker baseline
 * is not proof here: it vouches for what staging wrote, not for the current
 * DB intent, and this repair deletes the staged state. A diverged row stays a
 * genuine divergence behind the guidance exit. An orphaned running retry is
 * read through to the settled predecessor (#2855), mirroring the detector.
 */
function isVerificationPausedStagedTaskSummary(
  record: ArtifactDbStatusDivergenceDrift,
  basePath: string,
): boolean {
  if (!record.sliceId || !record.taskId || record.artifactType !== "SUMMARY") return false;
  const unit = {
    milestoneId: record.milestoneId,
    sliceId: record.sliceId,
    taskId: record.taskId,
  };
  const latest = readLatestTaskAttempt(unit);
  const attempt = isTaskExecutionAttemptOrphaned(latest)
    ? readLatestSettledTaskAttempt(unit) ?? latest
    : latest;
  if (!verificationPausedAttemptUnit(record, attempt)) return false;
  const task = readTask(unit.milestoneId, unit.sliceId, unit.taskId);
  if (!task) return false;
  return stagedTaskSummaryRowMatchesTaskIntent(record, task) ||
    stagedSummaryProjectionMatchesTaskIntent(basePath, record, task, false);
}

/**
 * #2864: guidance-mirrors-enforcement. `gsd task settle --reconcile-lifecycle`
 * refuses while any Attempt is still running (planTaskSettle has nothing to
 * settle then), so the guidance may name that exit only in the exact shape
 * the gate accepts: no running Attempt, latest Attempt settled succeeded at
 * the verify stage, receipt present, no agent-owned abort route.
 */
function verificationPausedSettleExitUnit(
  record: ArtifactDbStatusDivergenceDrift,
): { milestoneId: string; sliceId: string; taskId: string } | null {
  if (!record.sliceId || !record.taskId || record.artifactType !== "SUMMARY") return null;
  const unit = {
    milestoneId: record.milestoneId,
    sliceId: record.sliceId,
    taskId: record.taskId,
  };
  if (listRunningTaskAttempts(unit.milestoneId, unit.sliceId, unit.taskId).length > 0) return null;
  return verificationPausedAttemptUnit(record, readLatestTaskAttempt(unit));
}

function resolveTaskSummaryDriftPath(
  basePath: string,
  record: ArtifactDbStatusDivergenceDrift,
): string | null {
  if (record.artifactPath) {
    if (isAbsolute(record.artifactPath)) return record.artifactPath;
    const candidates = [
      join(gsdProjectionRoot(basePath), record.artifactPath),
      join(basePath, ".gsd", record.artifactPath),
    ];
    const existing = candidates.find((candidate) => existsSync(candidate));
    if (existing) return existing;
  }
  if (!record.sliceId || !record.taskId) return null;
  return resolveTaskFile(
    basePath,
    record.milestoneId,
    record.sliceId,
    record.taskId,
    "SUMMARY",
  );
}

function addUniqueDrift(
  drifts: ArtifactDbStatusDivergenceDrift[],
  seen: Set<string>,
  drift: ArtifactDbStatusDivergenceDrift,
): void {  const key = [
    drift.milestoneId,
    drift.sliceId ?? "",
    drift.taskId ?? "",
    drift.artifactType,
    drift.artifactPath ?? "",
    drift.reason,
  ].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  drifts.push(drift);
}

function detectArtifactDbStatusDriftForMilestone(
  basePath: string,
  milestoneId: string,
): ArtifactDbStatusDivergenceDrift[] {
  const milestone = readMilestone(milestoneId);
  if (!milestone || milestone.closed) return [];

  const latestReopen = latestExplicitReopenAt(milestoneId);
  const artifacts = safeListArtifactRows(milestoneId).filter((row) =>
    isAfter(row.imported_at, latestReopen),
  );
  const bySlice = new Map(readMilestoneSlices(milestoneId).map((slice) => [slice.id, slice]));
  const drifts: ArtifactDbStatusDivergenceDrift[] = [];
  const seen = new Set<string>();

  for (const slice of bySlice.values()) {
    if (!slice.closed) {
      const diskSummary = resolveSliceFile(basePath, milestoneId, slice.id, "SUMMARY");
      if (diskSummary && existsSync(diskSummary)) {
        addUniqueDrift(drifts, seen, {
          kind: "artifact-db-status-divergence",
          milestoneId,
          sliceId: slice.id,
          artifactType: "SUMMARY",
          artifactPath: diskSummary,
          dbStatus: slice.status,
          reason: `slice ${slice.id} has SUMMARY on disk while DB status is ${slice.status}`,
        });
      }
    }

    const tasks = readSliceTasks(milestoneId, slice.id);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const summaryRows = artifacts.filter(
      (row) =>
        row.artifact_type === "SUMMARY" &&
        row.slice_id === slice.id &&
        row.task_id,
    );
    const currentStagedTaskIds = new Set<string>();

    if (tasks.length === 0 && summaryRows.length > 0) {
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        artifactType: "SUMMARY",
        artifactPath: summaryRows[0]?.path,
        dbStatus: "no-db-tasks",
        reason: `slice ${slice.id} has task SUMMARY artifacts but no DB tasks`,
      });
    }

    for (const row of summaryRows) {
      const task = row.task_id ? taskById.get(row.task_id) : null;
      if (!task) {
        if (tasks.length > 0) {
          addUniqueDrift(drifts, seen, {
            kind: "artifact-db-status-divergence",
            milestoneId,
            sliceId: slice.id,
            taskId: row.task_id ?? undefined,
            artifactType: "SUMMARY",
            artifactPath: row.path,
            dbStatus: "missing-db-task",
            reason: `task ${slice.id}/${row.task_id} has SUMMARY artifact but no DB task`,
          });
        }
        continue;
      }
      if (task.done) continue;
      // A missing-file row on a task that ran before (#1771), or whose current
      // lifecycle head is an explicit reopen (#1983), is dead bookkeeping.
      // An unproven row stays a blocker (ADR-017/#414).
      if (
        task.status === "pending" &&
        taskHasExecutionOrReopenHistory(milestoneId, slice.id, task.id) &&
        !stagedTaskSummaryExistsOnDisk(basePath, milestoneId, slice.id, task.id, row.path)
      ) {
        continue;
      }
      if (isCanonicalStagedTaskSummaryProjection(basePath, {
        path: row.path,
        milestoneId: row.milestone_id,
        sliceId: row.slice_id,
        taskId: row.task_id,
        fullContent: row.full_content,
      }, {
        milestoneId,
        sliceId: slice.id,
        taskId: task.id,
        status: task.status,
        fullSummaryMd: task.full_summary_md,
      })) {
        currentStagedTaskIds.add(task.id);
        continue;
      }
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        taskId: row.task_id ?? undefined,
        artifactType: "SUMMARY",
        artifactPath: row.path,
        dbStatus: task.status,
        reason: `task ${slice.id}/${row.task_id} has SUMMARY artifact while DB status is ${task.status}`,
      });
    }

    for (const task of tasks) {
      if (task.done) continue;
      if (currentStagedTaskIds.has(task.id)) continue;
      const diskTaskSummary = resolveTaskFile(
        basePath,
        milestoneId,
        slice.id,
        task.id,
        "SUMMARY",
      );
      if (!diskTaskSummary || !existsSync(diskTaskSummary)) continue;
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        taskId: task.id,
        artifactType: "SUMMARY",
        artifactPath: diskTaskSummary,
        dbStatus: task.status,
        reason: `task ${slice.id}/${task.id} has SUMMARY on disk while DB status is ${task.status}`,
      });
    }
  }

  for (const row of artifacts) {
    if (row.artifact_type !== "SUMMARY" || !row.slice_id || row.task_id) continue;
    const slice = bySlice.get(row.slice_id);
    if (!slice || slice.closed) continue;
    // A missing-file slice-level SUMMARY row imported BEFORE the slice's
    // latest reopen is dead bookkeeping, mirroring the task-level
    // #1771/#1983 exemption: the reopen cleared the summary carrier and
    // quarantined the file, so the orphaned artifacts row must not wedge the
    // reopened slice's re-execution. The temporal tie matters (PR #2674
    // review): a row imported AFTER the latest reopen with no file on disk is
    // a genuine divergence — for example a post-reopen gsd_summary_save whose
    // projection write failed — and must stay flaggable. A slice that
    // legitimately re-completes re-writes its SUMMARY to disk, so the
    // disk-absence gate keeps that genuine completion-claim flaggable too.
    const latestSliceReopen = sliceLatestReopenAt(milestoneId, row.slice_id);
    if (
      latestSliceReopen !== null &&
      !isAfter(row.imported_at, latestSliceReopen) &&
      !sliceSummaryExistsOnDisk(basePath, milestoneId, row.slice_id, row.path)
    ) {
      continue;
    }
    addUniqueDrift(drifts, seen, {
      kind: "artifact-db-status-divergence",
      milestoneId,
      sliceId: row.slice_id,
      artifactType: "SUMMARY",
      artifactPath: row.path,
      dbStatus: slice.status,
      reason: `slice ${row.slice_id} has SUMMARY artifact while DB status is ${slice.status}`,
    });
  }

  return drifts;
}

function classifyDiskOnlySliceDir(
  sliceDir: string,
): DiskSliceIdDivergenceDrift["disposition"] {
  let sawScaffold = false;
  const stack = [sliceDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return "block-meaningful";
    }
    if (entries.length === 0 && dir !== sliceDir) {
      sawScaffold = true;
      continue;
    }
    for (const entry of entries) {
      if (entry === ".DS_Store") continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        return "block-meaningful";
      }
      if (stat.isDirectory()) {
        sawScaffold = true;
        stack.push(full);
        continue;
      }
      if (stat.isFile() && stat.size === 0) {
        sawScaffold = true;
        continue;
      }
      return "block-meaningful";
    }
  }

  return sawScaffold ? "quarantine-scaffold" : "delete-empty";
}

/**
 * Milestone ids that all resolve to the same directory on disk.
 *
 * #1565: with unique-suffix ids enabled, `gsd_plan_milestone` stores the DB row
 * as `M004-t76mxm` while `findMilestoneIds()` derives `M004` from the flat-phase
 * directory name — later units then plan slices under `M004`. Both ids resolve
 * to the same phase dir, so slices for this milestone can live under either id.
 * Looking up only `milestone.id` yields an empty slice set and flags every
 * `NN-MM-PLAN.md` as unknown, which blocks auto-mode permanently.
 */
function milestoneIdAliases(
  milestoneId: string,
  milestonePath: string,
  filesystemIds: string[],
  resolvePath: (id: string) => string | null,
): string[] {
  const aliases = [milestoneId];
  for (const fsId of filesystemIds) {
    if (aliases.includes(fsId)) continue;
    if (resolvePath(fsId) === milestonePath) aliases.push(fsId);
  }
  return aliases;
}

/**
 * Slice ids that a bare, PLAN-filename-derived id may legitimately resolve to.
 *
 * #1623: a flat-phase plan file only encodes a numeric index (`NN-MM-PLAN.md`),
 * so the derived id is always bare (`S01`). DB rows, however, routinely carry a
 * suffix — `S01-replan`, `S02-db-repair`, `S00-blocker` — and exact-equality
 * membership flagged every one of them as `disk-slice-id-divergence`, pausing
 * `/gsd auto` with no repair path short of hand-creating a bare placeholder
 * slice. Accept the bare id itself or any id that extends it with a `-<suffix>`;
 * the `-` separator keeps `S1` from matching `S10`.
 */
function knownSliceIdMatches(knownSliceIds: ReadonlySet<string>, sliceId: string): boolean {
  if (knownSliceIds.has(sliceId)) return true;
  const prefix = `${sliceId}-`;
  for (const known of knownSliceIds) {
    if (known.startsWith(prefix)) return true;
  }
  return false;
}

function detectDiskSliceIdDivergenceForMilestone(
  milestoneId: string,
  filesystemIds: string[],
  resolvePath: (id: string) => string | null,
): DiskSliceIdDivergenceDrift[] {
  const milestonePath = resolvePath(milestoneId);
  if (!milestonePath) return [];

  const knownSliceIds = new Set(
    milestoneIdAliases(milestoneId, milestonePath, filesystemIds, resolvePath).flatMap((id) =>
      getMilestoneSlices(id).map((slice) => slice.id),
    ),
  );
  const drifts: DiskSliceIdDivergenceDrift[] = [];

  // Flat-phase: scan phase dir for plan files (NN-MM-PLAN.md) where MM
  // doesn't match any known slice. Each plan file's slice id is S<MM>.
  try {
    for (const entry of readdirSync(milestonePath)) {
      const planMatch = entry.match(/^\d+-(\d+)-PLAN\.md$/i);
      if (!planMatch) continue;
      const planNum = parseInt(planMatch[1]!, 10);
      const sliceId = `S${String(planNum).padStart(2, "0")}`;
      if (knownSliceIdMatches(knownSliceIds, sliceId)) continue;
      drifts.push({
        kind: "disk-slice-id-divergence",
        milestoneId,
        sliceId,
        sliceDir: join(milestonePath, entry),
        disposition: "block-meaningful",
        reason: `plan file ${entry} references unknown ${sliceId}`,
      });
    }
  } catch {
    // unreadable phase dir
  }

  // Legacy: scan slices/ subdir for unknown slice dirs
  const slicesDir = join(milestonePath, "slices");
  if (!existsSync(slicesDir)) return drifts;

  for (const entry of readdirSync(slicesDir)) {
    const sliceDir = join(slicesDir, entry);
    try {
      if (!lstatSync(sliceDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry === "parallel-research") continue;
    if (knownSliceIds.has(entry)) continue;

    const disposition = classifyDiskOnlySliceDir(sliceDir);
    drifts.push({
      kind: "disk-slice-id-divergence",
      milestoneId,
      sliceId: entry,
      sliceDir,
      disposition,
      reason:
        disposition === "block-meaningful"
          ? `disk-only slice directory ${entry} contains meaningful files and is not in the DB`
          : `disk-only slice directory ${entry} is not in the DB`,
    });
  }

  return drifts;
}

type ArtifactDbDrift =
  | DiskSliceIdDivergenceDrift
  | ArtifactDbStatusDivergenceDrift
  | CompletedMilestoneReopenedDrift;

// #442 Phase 1.6: the three artifact/DB drift handlers (disk-slice-id,
// artifact-db-status, completed-milestone-reopened) each call
// detectArtifactDbDrift and then filter for their own kind — so the full
// milestone→slice→task walk + artifact SQL + disk scan would run THREE times
// per detection pass and discard 2/3 of the work. Memoize the result per
// DriftContext so the three handlers share one computation. The key is the
// ctx object, which detectAllDrift rebuilds for every pass (and which is
// unreferenced once the pass ends, so the WeakMap entry is GC'd) — DB/disk
// state is immutable within a single pass (repairs run only after detection),
// so this is behavior-preserving. A fresh ctx (e.g. the maintenance command's
// inline { basePath, state }) always recomputes.
const _artifactDbDriftMemo = new WeakMap<DriftContext, ArtifactDbDrift[]>();

export function detectArtifactDbDrift(
  state: GSDState,
  ctx: DriftContext,
): ArtifactDbDrift[] {
  const cached = _artifactDbDriftMemo.get(ctx);
  if (cached) return cached;
  const computed = computeArtifactDbDrift(state, ctx);
  _artifactDbDriftMemo.set(ctx, computed);
  return computed;
}

function computeArtifactDbDrift(
  _state: GSDState,
  ctx: DriftContext,
): ArtifactDbDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: ArtifactDbDrift[] = [];
  // Scanned once per pass: the disk layout is immutable while detection runs.
  let filesystemIds: string[] = [];
  try {
    filesystemIds = findMilestoneIds(ctx.basePath);
  } catch {
    // unreadable projection root — fall back to DB ids only
  }

  // #1565 follow-up: resolveMilestonePath scans the whole phases dir on most
  // calls, so resolve each milestone id to its disk path at most once per pass
  // instead of re-resolving every id inside milestoneIdAliases for every DB
  // milestone (which was O(#milestones × #filesystemIds × #phaseDirs)). Safe to
  // cache for the whole pass: the disk layout is immutable while detection runs.
  const resolvedPathById = new Map<string, string | null>();
  const resolvePath = (id: string): string | null => {
    const cached = resolvedPathById.get(id);
    if (cached !== undefined) return cached;
    const resolved = resolveMilestonePath(ctx.basePath, id);
    resolvedPathById.set(id, resolved);
    return resolved;
  };

  for (const milestone of readMilestones()) {
    if (milestone.closed) continue;

    // #2398: a completed `complete-milestone` dispatch row alone is not proof
    // the milestone was ever completed — a closeout whose attempts all fail
    // (or whose session exits) still leaves a status='completed' row behind.
    // Evaluate every completed dispatch, newest first: a later receiptless
    // row must not hide an earlier event-backed completion that was never
    // explicitly reopened, while a row with no covering milestone.completed
    // event is closeout debris, not completed-then-reopened history.
    for (const dispatch of completedMilestoneDispatches(milestone.id)) {
      const completedAt = dispatch.ended_at ?? dispatch.started_at ?? null;
      if (
        completedEventCoversDispatch(milestone.id, dispatch.started_at) &&
        !hasExplicitReopenAfter(milestone.id, completedAt)
      ) {
        drifts.push({
          kind: "completed-milestone-reopened",
          milestoneId: milestone.id,
          dbStatus: milestone.status,
          completedDispatchAt: completedAt,
        });
        break; // one drift record per milestone
      }
    }

    drifts.push(...detectArtifactDbStatusDriftForMilestone(ctx.basePath, milestone.id));
    drifts.push(
      ...detectDiskSliceIdDivergenceForMilestone(milestone.id, filesystemIds, resolvePath),
    );
  }

  return drifts;
}

function quarantineSliceDir(record: DiskSliceIdDivergenceDrift, basePath: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantineDir = join(
    gsdProjectionRoot(basePath),
    "quarantine",
    "milestones",
    record.milestoneId,
    "slices",
  );
  mkdirSync(quarantineDir, { recursive: true });
  const target = join(quarantineDir, `${basename(record.sliceDir)}-${stamp}`);
  renameSync(record.sliceDir, target);
}

export function completedMilestoneReopenedGuidance(
  record: Pick<CompletedMilestoneReopenedDrift, "milestoneId" | "dbStatus" | "completedDispatchAt">,
): string {
  const when = record.completedDispatchAt ?? "time unknown";
  const intro =
    `Milestone ${record.milestoneId} has completed closeout dispatch history (${when}) ` +
    `but DB status is still ${record.dbStatus}.`;

  if (isClosedStatus(record.dbStatus)) {
    return (
      `${intro} Use gsd_milestone_reopen for ${record.milestoneId} to redo this milestone, then run /gsd next.`
    );
  }

  return (
    `${intro} Finish closeout with \`/gsd dispatch complete-milestone ${record.milestoneId}\`, ` +
    `review with \`/gsd status ${record.milestoneId}\`, then run /gsd next. ` +
    "Running /gsd next again before fixing this will pause immediately."
  );
}

function diskSliceIdDivergenceGuidance(record: DiskSliceIdDivergenceDrift): string {
  const quarantineExample = `.gsd/quarantine/milestones/${record.milestoneId}/slices/${record.sliceId}-manual-review`;
  return (
    `Slice ID drift in ${record.milestoneId}: ${record.reason}. ` +
    "Runtime will not import disk-only slice IDs into the DB. " +
    `Review ${record.sliceDir}. ` +
    `If ${record.sliceId} is stale, move or delete that directory; to preserve it, move it under ${quarantineExample}. ` +
    "If it contains work to keep, copy or merge that content into a DB-backed slice, or explicitly recreate the slice through GSD planning, then remove the disk-only directory. " +
    `After repair, run /gsd doctor ${record.milestoneId}, then resume with /gsd next or /gsd auto.`
  );
}

/**
 * Recovery text for an artifact/DB status drift. A rebuild moves the file on
 * disk aside but keeps the artifact row, so it cannot clear a drift that comes
 * from a stale row. Do not tell the user that it can.
 */
function artifactDbStatusDivergenceExit(record: ArtifactDbStatusDivergenceDrift, basePath?: string): string {
  // #2864: guidance mirrors enforcement — for the verification-paused state,
  // name the receipt-gated exit that actually releases the Task, not the
  // rebuild/recover pair that cannot clear it.
  const pausedUnit = verificationPausedSettleExitUnit(record);
  if (pausedUnit) {
    const unit = `${pausedUnit.milestoneId}/${pausedUnit.sliceId}/${pausedUnit.taskId}`;
    return (
      `Task ${unit} is verification-paused: its latest Attempt settled succeeded at the verify ` +
      "stage and the auto finalizer recorded a verification-pause receipt for it. " +
      `\`/gsd task settle ${unit} --reason "verification paused" --reconcile-lifecycle\` ` +
      "(dry-run first; repeat with --apply) is the receipt-gated exit that releases the " +
      "stranded Task for replan/cancel. If this blocker remains after that reconcile, the " +
      "staged row itself is stale: `/gsd recover` with exact Preview approval is the command " +
      "that replaces artifact rows from markdown."
    );
  }
  const row = safeListArtifactRows(record.milestoneId).find((candidate) => candidate.path === record.artifactPath);
  if (row) {
    const legacyReopen = basePath ? legacyReopenImportGuidance(basePath, record.milestoneId, row.imported_at) : null;
    if (legacyReopen) return legacyReopen;
    return (
      "This drift comes from a SUMMARY row in the database. " +
      "`/gsd rebuild markdown` moves the file on disk to quarantine and keeps that row, so this blocker can remain after a rebuild. " +
      "If it remains, the row is stale: `/gsd recover` with exact Preview approval is the only command that replaces artifact rows from markdown."
    );
  }
  return "Run `/gsd rebuild markdown` after review to quarantine stale projections and re-render from the DB; use `/gsd recover` with exact Preview approval only when markdown should repopulate a lost or corrupt DB.";
}

/**
 * Quarantine every projection copy of a classified staged SUMMARY that passes
 * the same proof at each projection root, then clear the staged state (the
 * artifacts row and the Task's DB intent). The copy at the other root is the
 * same drift at the next guard, and no command that runs at one root removes
 * it (#2714). Shared by the abandoned (#2714) and verification-paused (#2864)
 * repairs.
 */
function quarantineStagedTaskSummaryCopies(
  record: ArtifactDbStatusDivergenceDrift,
  basePath: string,
  matches: (candidate: ArtifactDbStatusDivergenceDrift, root: string) => boolean,
): void {
  const canonical = { ...record, artifactPath: undefined };
  for (const root of reopenProjectionRoots(basePath)) {
    if (!matches(canonical, root)) continue;
    const projectionPath = resolveTaskSummaryDriftPath(root, canonical);
    if (projectionPath) quarantineProjectionEvidence(root, projectionPath);
  }
  clearTaskSummaryProjectionState(record.milestoneId, record.sliceId!, record.taskId!);
}

export async function repairArtifactDbDrift(
  record:
    | DiskSliceIdDivergenceDrift
    | ArtifactDbStatusDivergenceDrift
    | CompletedMilestoneReopenedDrift,
  ctx: DriftContext,
): Promise<void> {
  if (record.kind === "disk-slice-id-divergence") {
    if (record.disposition === "delete-empty") {
      removeProjectionTreeSync(record.sliceDir);
    } else if (record.disposition === "quarantine-scaffold") {
      quarantineSliceDir(record, ctx.basePath);
    } else {
      throw new Error(diskSliceIdDivergenceGuidance(record));
    }
    clearPathCache();
    clearParseCache();
    invalidateStateCache();
    return;
  }

  if (record.kind === "completed-milestone-reopened") {
    throw new Error(completedMilestoneReopenedGuidance(record));
  }

  if (isAbandonedStagedTaskSummary(record, ctx.basePath)) {
    // The copy at the other root is the same drift at the next guard, and no
    // command that runs at one root removes it (#2714). Move each copy that
    // passes the same proof.
    quarantineStagedTaskSummaryCopies(record, ctx.basePath, isAbandonedStagedTaskSummary);
    clearPathCache();
    clearParseCache();
    invalidateStateCache();
    return;
  }

  if (isVerificationPausedStagedTaskSummary(record, ctx.basePath)) {
    // #2864: the receipt-gated finalizer pause state — same bookkeeping
    // treatment as the abandoned staging above, so the Task leaves the wedge
    // without hand-editing the DB and the sanctioned settle exit stays
    // reachable.
    quarantineStagedTaskSummaryCopies(record, ctx.basePath, isVerificationPausedStagedTaskSummary);
    clearPathCache();
    clearParseCache();
    invalidateStateCache();
    return;
  }

  throw new Error(
    `Artifact/DB status drift in ${record.milestoneId}` +
      `${record.sliceId ? `/${record.sliceId}` : ""}` +
      `${record.taskId ? `/${record.taskId}` : ""}: ${record.reason}. ` +
      "Runtime will not silently import completion artifacts into DB state. " +
      artifactDbStatusDivergenceExit(record, ctx.basePath),
  );
}

export function describeArtifactDbDriftBlocker(
  record:
    | DiskSliceIdDivergenceDrift
    | ArtifactDbStatusDivergenceDrift
    | CompletedMilestoneReopenedDrift,
  ctx?: DriftContext,
): string | null {
  if (record.kind === "disk-slice-id-divergence") {
    if (record.disposition !== "block-meaningful") return null;
    return diskSliceIdDivergenceGuidance(record);
  }

  if (record.kind === "completed-milestone-reopened") {
    return completedMilestoneReopenedGuidance(record);
  }

  if (ctx && isAbandonedStagedTaskSummary(record, ctx.basePath)) return null;
  if (ctx && isVerificationPausedStagedTaskSummary(record, ctx.basePath)) return null;

  return (
    `Artifact/DB status drift in ${record.milestoneId}` +
    `${record.sliceId ? `/${record.sliceId}` : ""}` +
    `${record.taskId ? `/${record.taskId}` : ""}: ${record.reason}. ` +
    "Runtime will not silently import completion artifacts into DB state. " +
    artifactDbStatusDivergenceExit(record, ctx?.basePath)
  );
}

export const diskSliceIdDivergenceHandler: DriftHandler<DiskSliceIdDivergenceDrift> = {
  kind: "disk-slice-id-divergence",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is DiskSliceIdDivergenceDrift =>
        record.kind === "disk-slice-id-divergence",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};

export const artifactDbStatusDivergenceHandler: DriftHandler<ArtifactDbStatusDivergenceDrift> = {
  kind: "artifact-db-status-divergence",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is ArtifactDbStatusDivergenceDrift =>
        record.kind === "artifact-db-status-divergence",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};

export const completedMilestoneReopenedHandler: DriftHandler<CompletedMilestoneReopenedDrift> = {
  kind: "completed-milestone-reopened",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is CompletedMilestoneReopenedDrift =>
        record.kind === "completed-milestone-reopened",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};
