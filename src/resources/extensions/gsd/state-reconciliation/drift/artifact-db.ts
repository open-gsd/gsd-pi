// Project/App: gsd-pi
// File Purpose: Fail-closed reconciliation guards for DB/artifact and slice-id drift.

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
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "../../gsd-db.js";
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
import type { GSDState } from "../../types.js";
import { isAfter, latestExplicitReopenAt } from "../../milestone-reopen-events.js";
import { isCanonicalStagedTaskSummaryProjection } from "../../task-summary-projection-classification.js";
import { readLatestTaskAttempt } from "../../task-execution-domain-operation.js";
import { quarantineProjectionEvidence } from "../../projection-observation.js";
import { computeProjectionSha, deriveCompatProjectionKey, readCompatMarker } from "../../compat/compat-marker.js";
import { stripProjectionStamp } from "../../markdown-renderer.js";
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

function latestCompletedMilestoneDispatch(
  milestoneId: string,
): CompletedDispatchRow | null {
  const adapter = _getAdapter();
  if (!adapter) return null;
  try {
    const row = adapter
      .prepare(
        `SELECT started_at, ended_at
         FROM unit_dispatches
         WHERE milestone_id = :mid
           AND unit_type = 'complete-milestone'
           AND unit_id = :mid
           AND status = 'completed'
         ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
         LIMIT 1`,
      )
      .get({ ":mid": milestoneId }) as CompletedDispatchRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function hasExplicitReopenAfter(
  basePath: string,
  milestoneId: string,
  completedDispatchAt: string | null | undefined,
): boolean {
  const reopenAt = latestExplicitReopenAt(basePath, milestoneId);
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
  const row = _getAdapter()!.prepare(`
    SELECT 1 AS present
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND (
        EXISTS (
          SELECT 1 FROM workflow_execution_attempts attempt
          WHERE attempt.lifecycle_id = lifecycle.lifecycle_id
            AND attempt.project_id = lifecycle.project_id
        )
        OR (
          lifecycle.lifecycle_status = 'ready'
          AND EXISTS (
            SELECT 1 FROM workflow_domain_events reopened
            WHERE reopened.project_id = lifecycle.project_id
              AND reopened.operation_id = lifecycle.last_operation_id
              AND reopened.event_type = 'task.reopened'
              AND reopened.entity_type = 'task'
              AND reopened.entity_id = :entity_id
          )
        )
      )
    LIMIT 1
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
    ":entity_id": `${milestoneId}/${sliceId}/${taskId}`,
  });
  return row !== undefined;
}

function isAbandonedStagedTaskSummary(
  record: ArtifactDbStatusDivergenceDrift,
  basePath: string,
): boolean {
  if (!record.sliceId || !record.taskId || record.artifactType !== "SUMMARY") return false;
  const task = getSliceTasks(record.milestoneId, record.sliceId)
    .find((candidate) => candidate.id === record.taskId);
  if (task?.status !== "in_progress") return false;
  const attempt = readLatestTaskAttempt({
    milestoneId: record.milestoneId,
    sliceId: record.sliceId,
    taskId: record.taskId,
  });
  if (attempt?.state !== "settled" || attempt.outcome === "succeeded") return false;

  const projectionPath = resolveTaskSummaryDriftPath(basePath, record);
  const canonicalPath = resolveTaskFile(
    basePath,
    record.milestoneId,
    record.sliceId,
    record.taskId,
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
    stripProjectionStamp(content) === stripProjectionStamp(task.full_summary_md)
  ) return true;

  const projectionKey = deriveCompatProjectionKey(
    projectionPath,
    [gsdProjectionRoot(basePath), join(basePath, ".gsd")],
  );
  return readCompatMarker(basePath).projections[projectionKey]?.sha === computeProjectionSha(content);
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
  const milestone = getAllMilestones().find((m) => m.id === milestoneId);
  if (!milestone || isClosedStatus(milestone.status)) return [];

  const latestReopen = latestExplicitReopenAt(basePath, milestoneId);
  const artifacts = safeListArtifactRows(milestoneId).filter((row) =>
    isAfter(row.imported_at, latestReopen),
  );
  const bySlice = new Map(getMilestoneSlices(milestoneId).map((slice) => [slice.id, slice]));
  const drifts: ArtifactDbStatusDivergenceDrift[] = [];
  const seen = new Set<string>();

  for (const slice of bySlice.values()) {
    if (!isClosedStatus(slice.status)) {
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

    const tasks = getSliceTasks(milestoneId, slice.id);
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
      if (isClosedStatus(task.status)) continue;
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
      if (isClosedStatus(task.status)) continue;
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
    if (!slice || isClosedStatus(slice.status)) continue;
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

  for (const milestone of getAllMilestones()) {
    if (isClosedStatus(milestone.status)) continue;

    const completedDispatch = latestCompletedMilestoneDispatch(milestone.id);
    const completedAt = completedDispatch?.ended_at ?? completedDispatch?.started_at ?? null;
    if (
      completedDispatch &&
      !hasExplicitReopenAfter(ctx.basePath, milestone.id, completedAt)
    ) {
      drifts.push({
        kind: "completed-milestone-reopened",
        milestoneId: milestone.id,
        dbStatus: milestone.status,
        completedDispatchAt: completedAt,
      });
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
    const projectionPath = resolveTaskSummaryDriftPath(ctx.basePath, record);
    if (projectionPath) quarantineProjectionEvidence(ctx.basePath, projectionPath);
    clearTaskSummaryProjectionState(record.milestoneId, record.sliceId!, record.taskId!);
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
      "Run `/gsd rebuild markdown` after review to quarantine stale projections and re-render from the DB; use `/gsd recover` with exact Preview approval only when markdown should repopulate a lost or corrupt DB.",
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

  return (
    `Artifact/DB status drift in ${record.milestoneId}` +
    `${record.sliceId ? `/${record.sliceId}` : ""}` +
    `${record.taskId ? `/${record.taskId}` : ""}: ${record.reason}. ` +
    "Runtime will not silently import completion artifacts into DB state. " +
    "Run `/gsd rebuild markdown` after review to quarantine stale projections and re-render from the DB; use `/gsd recover` with exact Preview approval only when markdown should repopulate a lost or corrupt DB."
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
