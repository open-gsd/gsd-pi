import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import type { DoctorIssue } from "./doctor-types.js";
import {
  deleteArtifactByPath,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  findWrongKindLifecycleProjectionHeads,
  isDbAvailable,
  isMemoriesFtsAvailable,
  repairWrongKindLifecycleProjections,
  _getAdapter,
} from "./gsd-db.js";
import { MEMORIES_FTS_REBUILT_KEY } from "./db-memory-fts-schema.js";
import { isAfter, latestExplicitReopenAt } from "./milestone-reopen-events.js";
import {
  gsdProjectionRoot,
  gsdRoot,
  resolveGsdPathContract,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
} from "./paths.js";
import { deriveState } from "./state.js";
import { isClosedStatus } from "./status-guards.js";
import { workflowEventLogPath } from "./workflow-event-ledger.js";
import { readEvents } from "./workflow-events.js";
import { flushWorkflowProjections } from "./projection-flush.js";
import { parseRoadmapSlices } from "./roadmap-slices.js";
import { parseProjectionPlan } from "./schemas/parsers.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { isCanonicalStagedTaskSummaryProjection } from "./task-summary-projection-classification.js";
import { isMilestoneLifecycleAdopted, readMilestoneCloseoutAuthorization } from "./db/milestone-closeout-readiness.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  captureMilestoneVerificationSourceRevision,
  diagnoseMilestoneVerificationSourceDrift,
  type VerificationSourceDriftDiagnosis,
} from "./verification-source-integrity.js";
import {
  getWorkflowDatabaseStatus,
  openExistingWorkflowDatabase,
  openWorkflowDatabaseIsolated,
} from "./db-workspace.js";
import {
  inspectWorkflowDbLockHolders,
  terminateDormantWorkflowDbLockHolders,
} from "./workflow-db-locks.js";

const USER_AUTHORED_ARTIFACT_TYPES = new Set(["CONTEXT", "RESEARCH"]);

interface RunningAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
  milestone_id: string;
  slice_id: string;
  task_id: string;
}

/**
 * A running Attempt is orphaned when no live process can settle it: its
 * milestone lease is not currently held, or the lease-holding worker's OS
 * process is gone (#1749). Mirrors the lease/liveness semantics auto-mode uses
 * for dead lease holders, but reports instead of interrupting.
 */
function reportOrphanedRunningAttempts(
  adapter: ReturnType<typeof _getAdapter> & object,
  basePath: string,
  issues: DoctorIssue[],
): void {
  const running = adapter.prepare(`
    SELECT attempt.attempt_id, attempt.worker_id, attempt.milestone_lease_token,
           lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE attempt.attempt_state = 'running'
      AND lifecycle.item_kind = 'task'
  `).all() as unknown as RunningAttemptRow[];
  if (running.length === 0) return;

  let projectRoot = basePath;
  try {
    projectRoot = realpathSync(basePath);
  } catch {
    // keep the unresolved basePath
  }

  for (const attempt of running) {
    const lease = attempt.worker_id === null || attempt.milestone_lease_token === null
      ? undefined
      : adapter.prepare(`
          SELECT 1 AS held
          FROM milestone_leases
          WHERE milestone_id = :milestone_id
            AND worker_id = :worker_id
            AND fencing_token = :fencing_token
            AND status = 'held'
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).get({
          ":milestone_id": attempt.milestone_id,
          ":worker_id": attempt.worker_id,
          ":fencing_token": attempt.milestone_lease_token,
        });
    if (lease) {
      const worker = adapter.prepare(`
        SELECT pid, status, project_root_realpath
        FROM workers WHERE worker_id = :worker_id
      `).get({ ":worker_id": attempt.worker_id }) as
        | { pid: number; status: string; project_root_realpath: string }
        | undefined;
      const processDead = worker !== undefined &&
        worker.status === "active" &&
        worker.project_root_realpath === projectRoot &&
        Number.isInteger(worker.pid) && worker.pid > 0 &&
        worker.pid !== process.pid &&
        (() => {
          try {
            process.kill(worker.pid, 0);
            return false;
          } catch (err) {
            return (err as NodeJS.ErrnoException).code !== "EPERM";
          }
        })();
      if (!processDead) continue;
    }
    const unitId = `${attempt.milestone_id}/${attempt.slice_id}/${attempt.task_id}`;
    issues.push({
      severity: "error",
      code: "orphaned_running_attempt",
      scope: "task",
      unitId,
      message:
        `Task ${unitId} has an orphaned running Attempt (${attempt.attempt_id}) with no live process or lease. ` +
        "Settle it with gsd_task_settle (dry-run first, then apply: true) — doctor --fix will not settle it for you.",
      file: ".gsd/gsd.db",
      fixable: false,
    });
  }
}


function relativeFile(basePath: string, filePath: string): string {
  return relative(basePath, filePath).split("\\").join("/");
}

function normalizedArtifactType(artifactType: string): string {
  return artifactType.trim().toUpperCase();
}

function isUserAuthoredArtifactType(artifactType: string): boolean {
  return USER_AUTHORED_ARTIFACT_TYPES.has(normalizedArtifactType(artifactType));
}

function userContentRecoveryCommand(artifactType: string): string {
  return normalizedArtifactType(artifactType) === "CONTEXT" ? "/gsd discuss" : "/gsd auto";
}

function userContentMissingMessage(path: string, artifactType: string): string {
  const type = normalizedArtifactType(artifactType) || "UNKNOWN";
  return `Artifact \`${path}\` is a user-authored ${type} file recorded in the database but missing from disk. Re-run \`${userContentRecoveryCommand(type)}\` in this milestone to regenerate it.`;
}

function artifactPathRelativeToGsd(artifactPath: string): string {
  const parts = artifactPath.split(/[\\/]+/);
  const gsdIndex = parts.lastIndexOf(".gsd");
  if (gsdIndex < 0 || gsdIndex === parts.length - 1) return artifactPath;
  return parts.slice(gsdIndex + 1).join("/");
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function reportCheckboxDbStatusDivergence(
  issues: DoctorIssue[],
  basePath: string,
  filePath: string,
  scope: "slice" | "task",
  unitId: string,
  status: string,
  checkboxDone: boolean,
): void {
  const dbDone = isClosedStatus(status);
  if (checkboxDone === dbDone) return;

  issues.push({
    severity: "error",
    code: "checkbox_db_status_divergence",
    scope,
    unitId,
    message: `${scope === "slice" ? "Slice" : "Task"} ${unitId} is ${dbDone ? "closed" : "open"} in the database (status: ${status}) but the markdown checkbox is ${checkboxDone ? "checked" : "unchecked"}.`,
    file: relativeFile(basePath, filePath),
    fixable: false,
  });
}

function bareDuplicateMilestoneId(milestoneId: string): string | null {
  const match = milestoneId.match(/^(M\d{3})-[a-z0-9]{6}$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function checkboxDbStatusMilestoneIds(basePath: string, milestoneIds: string[]): string[] {
  if (!hasFlatPhaseLayout(basePath)) return milestoneIds;

  // Flat-phase directories are keyed by phase number. A restored
  // M003-xxxxxx row alongside M003 is a stale duplicate for the same
  // phases/03-* projection, so checking both can compare DB status against two
  // competing PLAN files and report a persistent false divergence.
  const allIds = new Set(milestoneIds.map((id) => id.toUpperCase()));
  return milestoneIds.filter((milestoneId) => {
    const bareId = bareDuplicateMilestoneId(milestoneId);
    return !bareId || !allIds.has(bareId);
  });
}

function checkProjectionCheckboxDbStatus(basePath: string, milestoneIds: string[], issues: DoctorIssue[]): void {
  for (const milestoneId of milestoneIds) {
    const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, milestoneId);
    const roadmapPath = resolveMilestoneFile(artifactBasePath, milestoneId, "ROADMAP");
    const slices = getMilestoneSlices(milestoneId);

    if (roadmapPath && existsSync(roadmapPath)) {
      try {
        const roadmap = readFileSync(roadmapPath, "utf-8");
        const sliceDoneById = new Map(parseRoadmapSlices(roadmap).map((entry) => [entry.id, entry.done]));
        for (const slice of slices) {
          const checkboxDone = sliceDoneById.get(slice.id);
          if (checkboxDone === undefined) continue;
          reportCheckboxDbStatusDivergence(
            issues,
            basePath,
            roadmapPath,
            "slice",
            `${milestoneId}/${slice.id}`,
            slice.status,
            checkboxDone,
          );
        }
      } catch {
        // Non-fatal — checkbox drift diagnostics must never block doctor.
      }
    }

    for (const slice of slices) {
      const planPath = resolveSliceFile(artifactBasePath, milestoneId, slice.id, "PLAN");
      if (!planPath || !existsSync(planPath)) continue;
      try {
        const plan = readFileSync(planPath, "utf-8");
        // parseProjectionPlan reads the projection's task checkboxes (the flat-phase
        // <tasks> block / ## Tasks section), so a stray task-style checkbox
        // line elsewhere in PLAN.md (e.g. a Must-Haves or Verification bullet
        // above <tasks>) can no longer hide real drift or fake a divergence.
        const taskDoneById = new Map(parseProjectionPlan(plan).tasks.map((entry) => [entry.id, entry.done]));
        for (const task of getSliceTasks(milestoneId, slice.id)) {
          const checkboxDone = taskDoneById.get(task.id);
          if (checkboxDone === undefined) continue;
          reportCheckboxDbStatusDivergence(
            issues,
            basePath,
            planPath,
            "task",
            `${milestoneId}/${slice.id}/${task.id}`,
            task.status,
            checkboxDone,
          );
        }
      } catch {
        // Non-fatal — checkbox drift diagnostics must never block doctor.
      }
    }
  }
}

function isClearedByMilestoneShellProjectionFlush(
  basePath: string,
  issue: DoctorIssue,
  reRenderedMilestoneIds: Set<string>,
): boolean {
  if (issue.code !== "checkbox_db_status_divergence") return false;
  if (issue.scope !== "slice") return false;

  const milestoneId = issue.unitId.split("/")[0] ?? "";
  if (!reRenderedMilestoneIds.has(milestoneId)) return false;

  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath || !issue.file) return false;

  return issue.file === relativeFile(basePath, roadmapPath);
}

function artifactExistsOnDisk(basePath: string, artifactPath: string, row?: ArtifactRow): boolean {
  return resolveArtifactDiskPath(basePath, artifactPath, row) !== null;
}

function resolveLiteralArtifactDiskPath(basePath: string, artifactPath: string, row?: ArtifactRow): string | null {
  const relativeArtifactPath = artifactPathRelativeToGsd(artifactPath);
  if (isAbsolute(relativeArtifactPath)) {
    return existsSync(relativeArtifactPath) ? relativeArtifactPath : null;
  }
  for (const root of [gsdProjectionRoot(basePath), gsdRoot(basePath)]) {
    const candidate = join(root, relativeArtifactPath);
    if (isPathInside(root, candidate) && existsSync(candidate)) return candidate;
  }
  if (row?.milestone_id) {
    const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, row.milestone_id);
    if (artifactBasePath !== basePath) {
      for (const root of [gsdProjectionRoot(artifactBasePath), gsdRoot(artifactBasePath)]) {
        const candidate = join(root, relativeArtifactPath);
        if (isPathInside(root, candidate) && existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function relativeToGsdRoot(basePath: string, diskPath: string): string | null {
  for (const root of [gsdProjectionRoot(basePath), gsdRoot(basePath)]) {
    if (!isPathInside(root, diskPath)) continue;
    return relative(root, diskPath).split("\\").join("/");
  }
  return null;
}

function isFlatPhaseDiskPath(basePath: string, diskPath: string): boolean {
  return relativeToGsdRoot(basePath, diskPath)?.startsWith(`${LAYOUT_SEGMENTS.level1}/`) ?? false;
}

function hasFlatPhaseLayout(basePath: string): boolean {
  return existsSync(join(gsdProjectionRoot(basePath), LAYOUT_SEGMENTS.level1));
}

function resolveFlatPhaseArtifactDiskPath(basePath: string, row: ArtifactRow): string | null {
  if (!hasFlatPhaseLayout(basePath)) return null;
  if (!row.milestone_id) return null;
  const artifactType = normalizedArtifactType(row.artifact_type);
  if (!artifactType) return null;

  if (row.slice_id && row.task_id) {
    const candidate = resolveTaskFile(basePath, row.milestone_id, row.slice_id, row.task_id, artifactType);
    return candidate && isFlatPhaseDiskPath(basePath, candidate) ? candidate : null;
  }

  const candidate = row.slice_id
    ? resolveSliceFile(basePath, row.milestone_id, row.slice_id, artifactType)
    : resolveMilestoneFile(basePath, row.milestone_id, artifactType);

  return candidate && isFlatPhaseDiskPath(basePath, candidate) ? candidate : null;
}

function resolveArtifactDiskPath(basePath: string, artifactPath: string, row?: ArtifactRow): string | null {
  if (row && isMilestonesArtifactPath(row.path)) {
    const flatPath = resolveFlatPhaseArtifactDiskPath(basePath, row);
    if (flatPath) return flatPath;
  }
  return resolveLiteralArtifactDiskPath(basePath, artifactPath, row);
}

function artifactUnitId(row: { milestone_id: string | null; slice_id: string | null; task_id: string | null }): string {
  if (!row.milestone_id) return "project";
  if (row.slice_id && row.task_id) return `${row.milestone_id}/${row.slice_id}/${row.task_id}`;
  if (row.slice_id) return `${row.milestone_id}/${row.slice_id}`;
  return row.milestone_id;
}

function artifactScope(row: { milestone_id: string | null; slice_id: string | null; task_id: string | null }): DoctorIssue["scope"] {
  if (row.task_id) return "task";
  if (row.slice_id) return "slice";
  if (row.milestone_id) return "milestone";
  return "project";
}

type ArtifactRow = {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
};

function sameArtifactIdentity(left: ArtifactRow, right: ArtifactRow): boolean {
  return left.artifact_type === right.artifact_type &&
    left.milestone_id === right.milestone_id &&
    left.slice_id === right.slice_id &&
    left.task_id === right.task_id;
}

function isMilestonesArtifactPath(artifactPath: string): boolean {
  return artifactPathRelativeToGsd(artifactPath).startsWith("milestones/");
}

function expectedMilestonesArtifactPath(row: ArtifactRow): string | null {
  if (!row.milestone_id) return null;
  const artifactType = normalizedArtifactType(row.artifact_type);
  if (!artifactType) return null;
  if (row.slice_id && row.task_id) {
    return `milestones/${row.milestone_id}/slices/${row.slice_id}/tasks/${row.task_id}-${artifactType}.md`;
  }
  if (row.slice_id) {
    return `milestones/${row.milestone_id}/slices/${row.slice_id}/${row.slice_id}-${artifactType}.md`;
  }
  return `milestones/${row.milestone_id}/${row.milestone_id}-${artifactType}.md`;
}

function hasPresentMilestonesReplacement(basePath: string, row: ArtifactRow, artifactRows: ArtifactRow[]): boolean {
  const expectedPath = expectedMilestonesArtifactPath(row);
  if (expectedPath && artifactExistsOnDisk(basePath, expectedPath)) return true;

  return artifactRows.some(
    (other) =>
      other.path !== row.path &&
      isMilestonesArtifactPath(other.path) &&
      sameArtifactIdentity(row, other) &&
      artifactExistsOnDisk(basePath, other.path),
  );
}

function hasPresentFlatPhaseReplacement(basePath: string, row: ArtifactRow, artifactRows: ArtifactRow[]): boolean {
  if (resolveFlatPhaseArtifactDiskPath(basePath, row)) return true;

  return artifactRows.some(
    (other) =>
      other.path !== row.path &&
      !isMilestonesArtifactPath(other.path) &&
      sameArtifactIdentity(row, other) &&
      artifactExistsOnDisk(basePath, other.path, other),
  );
}

function hasNoFlatPhaseFileEquivalent(row: ArtifactRow): boolean {
  const artifactType = normalizedArtifactType(row.artifact_type);
  if (row.slice_id && row.task_id) {
    return artifactType === "PLAN" || artifactType === "SUMMARY";
  }
  return Boolean(row.slice_id && !row.task_id && artifactType === "SUMMARY");
}

function staleMilestonesArtifactRowFixable(basePath: string, row: ArtifactRow, artifactRows: ArtifactRow[]): boolean {
  if (!isMilestonesArtifactPath(row.path)) return false;
  if (!hasFlatPhaseLayout(basePath)) return false;
  if (hasPresentFlatPhaseReplacement(basePath, row, artifactRows)) return true;
  return hasNoFlatPhaseFileEquivalent(row) && !resolveLiteralArtifactDiskPath(basePath, row.path);
}

function stalePhasesArtifactRowFixable(basePath: string, row: ArtifactRow, artifactRows: ArtifactRow[]): boolean {
  const issuePath = artifactPathRelativeToGsd(row.path);
  return issuePath.startsWith(`${LAYOUT_SEGMENTS.level1}/`) &&
    (hasPresentFlatPhaseReplacement(basePath, row, artifactRows) ||
      hasPresentMilestonesReplacement(basePath, row, artifactRows));
}

function staleArtifactRowFixable(basePath: string, row: ArtifactRow, artifactRows: ArtifactRow[]): boolean {
  return staleMilestonesArtifactRowFixable(basePath, row, artifactRows) ||
    stalePhasesArtifactRowFixable(basePath, row, artifactRows);
}

function staleArtifactPruneMessage(row: ArtifactRow): string {
  return isMilestonesArtifactPath(row.path)
    ? `pruned stale legacy artifact row ${row.path}`
    : `pruned stale flat-phase artifact row ${row.path}`;
}

/**
 * Detects (and under repair, heals) lifecycle/* projection heads that carry a
 * non-canonical kind — the durable signature of a project imported by a build
 * older than the #1659 fix, which enqueued every imported projection as
 * "markdown". trg_workflow_projection_lineage makes kind immutable per chain,
 * so such a head wedges slice/task closeout ("projection work must extend the
 * current logical target head") until the kind is rewritten (#1661).
 * Exported for direct testing.
 */
export function checkLifecycleProjectionKinds(
  issues: DoctorIssue[],
  fixesApplied: string[],
  repair: boolean,
): void {
  let heads = findWrongKindLifecycleProjectionHeads();
  if (heads.length === 0) return;
  if (repair) {
    try {
      for (const repaired of repairWrongKindLifecycleProjections()) {
        fixesApplied.push(
          `rewrote projection kind for ${repaired.projectionKey} (${repaired.projectionKind} → ${repaired.expectedKind}) — pre-#1659 legacy import remediation`,
        );
      }
      heads = findWrongKindLifecycleProjectionHeads();
    } catch {
      // Non-fatal — fall through and report the unrepaired heads below.
    }
  }
  for (const head of heads) {
    issues.push({
      severity: "error",
      code: "lifecycle_projection_wrong_kind",
      scope: "project",
      unitId: head.projectionKey,
      message:
        `Projection head ${head.projectionKey} carries kind "${head.projectionKind}" but the canonical lifecycle writer enqueues "${head.expectedKind}". ` +
        `This project was imported by a pre-#1659 build; slice/task closeout will abort with "projection work must extend the current logical target head" until repaired. ` +
        `Run \`gsd doctor --fix\` to rewrite the projection chain to its canonical kind.`,
      file: ".gsd/gsd.db",
      fixable: true,
    });
  }
}

export function createValidationSourceDriftDoctorIssue(
  milestoneId: string,
  mismatch: { expectedSourceRevision: string; testedSourceRevision: string },
  drift: VerificationSourceDriftDiagnosis,
): DoctorIssue {
  const paths = drift.paths.length > 0
    ? ` Offending source paths: ${drift.paths.join(", ")}.`
    : " Inspect `git status` and the latest commit for the offending source paths.";
  const recovery = drift.autoCommitDetected
    ? " GSD's pre-merge auto-commit is the current HEAD. If it captured unintended files, run `git reset --mixed HEAD^` to preserve them as working-tree changes, remove or ignore unwanted files, then retry."
    : " Restore or remove unintended working-tree changes before retrying.";
  return {
    severity: "error",
    code: "validation_source_revision_mismatch",
    scope: "milestone",
    unitId: milestoneId,
    message:
      `Milestone ${milestoneId} validation source revision does not match the current tree ` +
      `(expected ${mismatch.expectedSourceRevision}; tested ${mismatch.testedSourceRevision}).${paths}${recovery} ` +
      `If the current content is intended, run \`/gsd validate-milestone ${milestoneId}\`, then \`/gsd auto\`.`,
    file: drift.paths[0],
    fixable: true,
  };
}

export function reportMilestoneValidationSourceDrift(basePath: string, issues: DoctorIssue[]): void {
  for (const milestone of getAllMilestones()) {
    if (!isClosedStatus(milestone.status) || !isMilestoneLifecycleAdopted(milestone.id)) continue;
    const sourceRoot = resolveCanonicalMilestoneRoot(basePath, milestone.id);
    const preferences = loadEffectiveGSDPreferences(sourceRoot)?.preferences;
    const source = captureMilestoneVerificationSourceRevision(sourceRoot, preferences);
    if (!source.ok) continue;
    const authorization = readMilestoneCloseoutAuthorization({
      milestoneId: milestone.id,
      sourceRevision: source.sourceRevision,
    });
    if (authorization.authorized) continue;
    const mismatch = authorization.blockers.find(
      (blocker) => blocker.kind === "validation-source-revision-mismatch",
    );
    if (!mismatch || mismatch.kind !== "validation-source-revision-mismatch") continue;
    issues.push(createValidationSourceDriftDoctorIssue(
      milestone.id,
      mismatch,
      diagnoseMilestoneVerificationSourceDrift(sourceRoot, preferences),
    ));
  }
}

export async function checkEngineHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  options?: {
    repair?: boolean;
    repairDbLock?: boolean;
    lockRecovery?: {
      inspectHolders: typeof inspectWorkflowDbLockHolders;
      terminateHolders: typeof terminateDormantWorkflowDbLockHolders;
      reopen: typeof openExistingWorkflowDatabase;
    };
  },
): Promise<void> {
  const dbPath = resolveGsdPathContract(basePath).projectDb;

  if (!isDbAvailable() && existsSync(dbPath)) {
    const status = getWorkflowDatabaseStatus();
    if (status.lastPhase === "locked") {
      const readOnly = openWorkflowDatabaseIsolated(dbPath);
      const staleWorkerStartedAtByPid = new Map<number, number>();
      if (readOnly) {
        try {
          const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
          const rows = readOnly.prepare(
            `SELECT pid, started_at FROM workers
             WHERE host = :host
               AND status IN ('active', 'stopping')
               AND last_heartbeat_at < :cutoff`,
          ).all({ ":host": hostname(), ":cutoff": cutoff });
          for (const row of rows) {
            const pid = Number(row["pid"]);
            const startedAtMs = Date.parse(String(row["started_at"]));
            if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startedAtMs)) {
              staleWorkerStartedAtByPid.set(
                pid,
                Math.max(staleWorkerStartedAtByPid.get(pid) ?? 0, startedAtMs),
              );
            }
          }
        } catch {
          // Older schemas may not have the worker registry; report holders but do not terminate them.
        }
      }
      const readOnlyProbeSucceeded = readOnly !== null;
      readOnly?.close();
      const lockRecovery = options?.lockRecovery;
      const holders = (lockRecovery?.inspectHolders ?? inspectWorkflowDbLockHolders)(dbPath);
      let repaired = false;
      let remainingAfterFix: number[] = [];
      if (options?.repairDbLock && readOnlyProbeSucceeded) {
        const result = await (lockRecovery?.terminateHolders ?? terminateDormantWorkflowDbLockHolders)(
          holders,
          staleWorkerStartedAtByPid,
        );
        remainingAfterFix = result.remaining;
        if (result.signaled.length > 0 && (lockRecovery?.reopen ?? openExistingWorkflowDatabase)(basePath).ok) {
          fixesApplied.push(`released workflow database lock held by dormant PID(s): ${result.signaled.join(", ")}`);
          repaired = true;
        }
      }

      if (!repaired) {
        const pids = holders.map((holder) => holder.pid);
        const killablePids = holders
          .filter((holder) => holder.sameUser)
          .map((holder) => holder.pid);
        const holderDetail = pids.length > 0
          ? ` Lock-holder PID(s): ${pids.join(", ")}.`
          : process.platform === "win32"
            ? " Automatic holder discovery is unavailable on Windows; use Resource Monitor to identify the process using gsd.db."
            : " No lock-holder PID could be discovered with lsof/fuser.";
        const killDetail = remainingAfterFix.length > 0
          ? ` SIGTERM did not stop PID(s) ${remainingAfterFix.join(", ")}; stop them manually: ${remainingAfterFix.map((pid) => `kill ${pid}`).join("; ")}.`
          : killablePids.length > 0
            ? ` Stop them manually if active: ${killablePids.map((pid) => `kill ${pid}`).join("; ")}.`
            : "";
        issues.push({
          severity: "error",
          code: "db_locked",
          scope: "project",
          unitId: "project",
          message:
            `Workflow database is write-locked by another process; the read-only probe ${readOnlyProbeSucceeded ? "succeeded" : "also failed"}.` +
            holderDetail + killDetail,
          file: ".gsd/gsd.db",
          fixable: process.platform !== "win32",
        });
      }
    } else {
      issues.push({
        severity: "warning",
        code: "db_unavailable",
        scope: "project",
        unitId: "project",
        message: "Database unavailable — using filesystem state derivation (degraded mode). State queries may be slower and less reliable.",
        file: ".gsd/gsd.db",
        fixable: false,
      });
    }
  }

  // ── DB constraint violation detection (full doctor only, not pre-dispatch per D-10) ──
  try {
    if (isDbAvailable()) {
      const adapter = _getAdapter()!;

      try {
        if (isMemoriesFtsAvailable(adapter)) {
          const runtimeKv = adapter
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_kv'")
            .get();
          const marker = runtimeKv
            ? adapter.prepare(
                "SELECT 1 as present FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
              ).get({ ":key": MEMORIES_FTS_REBUILT_KEY })
            : undefined;
          if (!marker) {
            issues.push({
              severity: "warning",
              code: "memories_fts_rebuild_missing",
              scope: "project",
              unitId: "project",
              message: `Memory full-text index exists but runtime_kv has no ${MEMORIES_FTS_REBUILT_KEY} marker. The index may be stale or incomplete, so memory search can silently degrade to the LIKE fallback.`,
              file: ".gsd/gsd.db",
              fixable: false,
            });
          }
        }
      } catch {
        // Non-fatal — memory FTS health check failed
      }

      // Pre-#1659 legacy import remediation (#1661): wrong-kind lifecycle
      // projection heads wedge closeout; detect always, rewrite under --fix.
      try {
        checkLifecycleProjectionKinds(issues, fixesApplied, options?.repair === true);
      } catch {
        // Non-fatal — lifecycle projection kind check failed
      }

      try {
        reportMilestoneValidationSourceDrift(basePath, issues);
      } catch {
        // Non-fatal — closeout source drift diagnostics failed
      }

      // a. Orphaned tasks (task.slice_id points to non-existent slice)
      try {
        const orphanedTasks = adapter
          .prepare(
            `SELECT t.id, t.slice_id, t.milestone_id
             FROM tasks t
             LEFT JOIN slices s ON t.milestone_id = s.milestone_id AND t.slice_id = s.id
             WHERE s.id IS NULL`,
          )
          .all() as Array<{ id: string; slice_id: string; milestone_id: string }>;

        for (const row of orphanedTasks) {
          issues.push({
            severity: "error",
            code: "db_orphaned_task",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} references slice ${row.slice_id} in milestone ${row.milestone_id} but no such slice exists in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — orphaned task check failed
      }

      // b. Orphaned slices (slice.milestone_id points to non-existent milestone)
      try {
        const orphanedSlices = adapter
          .prepare(
            `SELECT s.id, s.milestone_id
             FROM slices s
             LEFT JOIN milestones m ON s.milestone_id = m.id
             WHERE m.id IS NULL`,
          )
          .all() as Array<{ id: string; milestone_id: string }>;

        for (const row of orphanedSlices) {
          issues.push({
            severity: "error",
            code: "db_orphaned_slice",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Slice ${row.id} references milestone ${row.milestone_id} but no such milestone exists in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — orphaned slice check failed
      }

      // c. Tasks marked complete without summaries
      try {
        const doneTasks = adapter
          .prepare(
            `SELECT id, slice_id, milestone_id FROM tasks
             WHERE status = 'done' AND (summary IS NULL OR summary = '')`,
          )
          .all() as Array<{ id: string; slice_id: string; milestone_id: string }>;

        for (const row of doneTasks) {
          issues.push({
            severity: "warning",
            code: "db_done_task_no_summary",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} is marked done but has no summary in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — done-task-no-summary check failed
      }

      // d. Duplicate entity IDs (safety check)
      try {
        const dupMilestones = adapter
          .prepare("SELECT id, COUNT(*) as cnt FROM milestones GROUP BY id HAVING cnt > 1")
          .all() as Array<{ id: string; cnt: number }>;
        for (const row of dupMilestones) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "milestone",
            unitId: row.id,
            message: `Duplicate milestone ID "${row.id}" appears ${row.cnt} times in the database`,
            fixable: false,
          });
        }

        const dupSlices = adapter
          .prepare("SELECT id, milestone_id, COUNT(*) as cnt FROM slices GROUP BY id, milestone_id HAVING cnt > 1")
          .all() as Array<{ id: string; milestone_id: string; cnt: number }>;
        for (const row of dupSlices) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Duplicate slice ID "${row.id}" in milestone ${row.milestone_id} appears ${row.cnt} times`,
            fixable: false,
          });
        }

        const dupTasks = adapter
          .prepare("SELECT id, slice_id, milestone_id, COUNT(*) as cnt FROM tasks GROUP BY id, slice_id, milestone_id HAVING cnt > 1")
          .all() as Array<{ id: string; slice_id: string; milestone_id: string; cnt: number }>;
        for (const row of dupTasks) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Duplicate task ID "${row.id}" in slice ${row.slice_id} appears ${row.cnt} times`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — duplicate ID check failed
      }

      // e. Orphaned running Task Attempts (#1749): a running Attempt whose
      // milestone lease is gone or whose worker process is dead wedges every
      // downstream lifecycle operation ("running Attempt descendant"). The
      // operator repair is gsd_task_settle; doctor --fix must never settle on
      // its own — settling is a human judgment call.
      try {
        reportOrphanedRunningAttempts(adapter, basePath, issues);
      } catch {
        // Non-fatal — orphaned running Attempt check failed
      }

      // e. Completed milestone dispatch history but DB reopened without an explicit reopen event.
      try {
        const reopened = adapter
          .prepare(
            `SELECT m.id, m.status, ud.started_at, ud.ended_at
             FROM milestones m
             JOIN unit_dispatches ud ON ud.milestone_id = m.id
             WHERE m.status NOT IN ('complete', 'done', 'skipped', 'closed')
               AND ud.unit_type = 'complete-milestone'
               AND ud.unit_id = m.id
               AND ud.status = 'completed'
               AND ud.id = (
                 SELECT latest.id
                 FROM unit_dispatches latest
                 WHERE latest.milestone_id = m.id
                   AND latest.unit_type = 'complete-milestone'
                   AND latest.unit_id = m.id
                   AND latest.status = 'completed'
                 ORDER BY COALESCE(latest.ended_at, latest.started_at) DESC, latest.id DESC
                 LIMIT 1
               )
             ORDER BY m.id`,
          )
          .all() as Array<{ id: string; status: string; started_at: string | null; ended_at: string | null }>;

        for (const row of reopened) {
          const completedAt = row.ended_at ?? row.started_at ?? null;
          const reopenAt = latestExplicitReopenAt(basePath, row.id);
          if (reopenAt && (!completedAt || Date.parse(reopenAt) > Date.parse(completedAt))) continue;
          issues.push({
            severity: "error",
            code: "completed_milestone_reopened",
            scope: "milestone",
            unitId: row.id,
            message: `Milestone ${row.id} has completed complete-milestone dispatch history but DB status is ${row.status}. Explicitly reopen or recover before planning it again.`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — completed-milestone reopen check failed
      }

      // f. Artifact rows reference files that no longer exist on disk.
      const missingUserContentArtifacts: Array<{ path: string; artifactType: string }> = [];
      try {
        const artifactRows = adapter
          .prepare(
            `SELECT path, artifact_type, milestone_id, slice_id, task_id
             FROM artifacts
             WHERE path != ''
             ORDER BY path`,
          )
          .all() as ArtifactRow[];

        for (const row of artifactRows) {
          const unitId = artifactUnitId(row);
          const issuePath = artifactPathRelativeToGsd(row.path);
          if (artifactExistsOnDisk(basePath, row.path)) continue;
          if (options?.repair && staleArtifactRowFixable(basePath, row, artifactRows)) {
            // Route the write through the Single Writer owner (gsd-db.ts) instead
            // of issuing raw DELETE SQL here — doctor is a read-only consumer and
            // the single-writer invariant forbids write SQL outside the allowlist.
            deleteArtifactByPath(row.path);
            fixesApplied.push(staleArtifactPruneMessage(row));
            continue;
          }
          if (artifactExistsOnDisk(basePath, row.path, row)) continue;
          if (isUserAuthoredArtifactType(row.artifact_type)) {
            const artifactType = normalizedArtifactType(row.artifact_type);
            missingUserContentArtifacts.push({ path: issuePath, artifactType });
            issues.push({
              severity: "warning",
              code: "artifact_user_content_missing",
              scope: artifactScope(row),
              unitId,
              message: userContentMissingMessage(issuePath, artifactType),
              file: issuePath,
              fixable: false,
            });
            continue;
          }
          issues.push({
            severity: "error",
            code: "artifact_file_missing",
            scope: artifactScope(row),
            unitId,
            message: `Artifact ${issuePath} is recorded in the database as ${row.artifact_type || "UNKNOWN"} but no matching file exists on disk`,
            file: issuePath,
            fixable: staleArtifactRowFixable(basePath, row, artifactRows),
          });
        }
      } catch {
        // Non-fatal — artifact file existence check failed
      }
      if (options?.repair) {
        for (const artifact of missingUserContentArtifacts) {
          fixesApplied.push(
            `skipped user-authored ${artifact.artifactType} artifact ${artifact.path} (content cannot be regenerated from the database)`,
          );
        }
      }

      // g. Completion artifacts disagree with open DB hierarchy rows.
      try {
        const rows = adapter
          .prepare(
            `SELECT a.path, a.artifact_type, a.milestone_id, a.slice_id, a.task_id,
                    a.full_content, a.imported_at,
                    m.status AS milestone_status,
                    s.status AS slice_status,
                    t.status AS task_status, t.full_summary_md AS task_full_summary_md,
                    (SELECT COUNT(*) FROM tasks tt WHERE tt.milestone_id = a.milestone_id AND tt.slice_id = a.slice_id) AS task_count
             FROM artifacts a
             JOIN milestones m ON m.id = a.milestone_id
             LEFT JOIN slices s ON s.milestone_id = a.milestone_id AND s.id = a.slice_id
             LEFT JOIN tasks t ON t.milestone_id = a.milestone_id AND t.slice_id = a.slice_id AND t.id = a.task_id
             WHERE a.artifact_type = 'SUMMARY'
               AND m.status NOT IN ('complete', 'done', 'skipped', 'closed')`,
          )
          .all() as Array<{
            path: string;
            artifact_type: string;
            milestone_id: string;
            slice_id: string | null;
            task_id: string | null;
            full_content: string;
            imported_at: string | null;
            slice_status: string | null;
            task_status: string | null;
            task_full_summary_md: string | null;
            task_count: number;
          }>;

        const seen = new Set<string>();
        for (const row of rows) {
          if (!artifactExistsOnDisk(basePath, row.path, row)) continue;
          const reopenAt = latestExplicitReopenAt(basePath, row.milestone_id);
          if (!isAfter(row.imported_at, reopenAt)) continue;
          const isSliceSummary = row.slice_id && !row.task_id && row.slice_status && !["complete", "done", "skipped", "closed"].includes(row.slice_status);
          const isTaskSummary = row.slice_id && row.task_id && (!row.task_status || !["complete", "done", "skipped", "closed"].includes(row.task_status));
          const isTaskArtifactWithoutDbTasks = row.slice_id && row.task_id && Number(row.task_count) === 0;
          if (
            isTaskSummary &&
            row.task_status &&
            row.slice_id &&
            row.task_id &&
            isCanonicalStagedTaskSummaryProjection(basePath, {
              path: row.path,
              milestoneId: row.milestone_id,
              sliceId: row.slice_id,
              taskId: row.task_id,
              fullContent: row.full_content,
            }, {
              milestoneId: row.milestone_id,
              sliceId: row.slice_id,
              taskId: row.task_id,
              status: row.task_status,
              fullSummaryMd: row.task_full_summary_md ?? "",
            })
          ) {
            continue;
          }
          if (!isSliceSummary && !isTaskSummary && !isTaskArtifactWithoutDbTasks) continue;

          const unitId = row.task_id
            ? `${row.milestone_id}/${row.slice_id}/${row.task_id}`
            : row.slice_id
              ? `${row.milestone_id}/${row.slice_id}`
              : row.milestone_id;
          if (seen.has(unitId)) continue;
          seen.add(unitId);
          issues.push({
            severity: "error",
            code: "artifact_db_status_divergence",
            scope: row.task_id ? "task" : row.slice_id ? "slice" : "milestone",
            unitId,
            message: `Completion artifact ${row.path} exists while DB state for ${unitId} is still open or missing. Runtime will not import it silently; run explicit recovery/repair after review.`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — artifact/DB status drift check failed
      }
    }
  } catch {
    // Non-fatal — DB constraint checks failed entirely
  }

  // Checkbox-vs-DB divergence detection runs before projection drift auto-fix
  // so stale re-renders cannot overwrite manually edited markdown first. Runs
  // inside its own try/catch: getAllMilestones / getMilestoneSlices /
  // getSliceTasks issue prepared queries that can throw on a corrupt or locked
  // DB, and like every other DB-touching check here this diagnostic must never
  // block doctor.
  try {
    if (isDbAvailable()) {
      checkProjectionCheckboxDbStatus(
        basePath,
        checkboxDbStatusMilestoneIds(basePath, getAllMilestones().map((milestone) => milestone.id)),
        issues,
      );
    }
  } catch {
    // Non-fatal: checkbox-vs-DB divergence check must never block doctor
  }

  // ── Projection drift detection ──────────────────────────────────────────
  // If the DB is available, check whether markdown projections are stale
  // relative to the event log and re-render them.
  const reRenderedMilestoneIds: string[] = [];
  try {
    if (isDbAvailable()) {
      const eventLogPath = workflowEventLogPath(basePath);
      const events = readEvents(eventLogPath);
      if (events.length > 0) {
        const lastEventTs = new Date(events[events.length - 1]!.ts).getTime();
        const state = await deriveState(basePath);
        for (const milestone of state.registry) {
          if (milestone.status === "complete") continue;
          const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
          if (!roadmapPath || !existsSync(roadmapPath)) {
            try {
              const flushed = await flushWorkflowProjections(basePath, { milestoneId: milestone.id });
              if (!flushed.stale) {
                fixesApplied.push(`re-rendered missing projections for ${milestone.id}`);
                reRenderedMilestoneIds.push(milestone.id);
              }
            } catch {
              // Non-fatal — projection re-render failed
            }
            continue;
          }
          const projectionMtime = statSync(roadmapPath).mtimeMs;
          if (lastEventTs > projectionMtime) {
            try {
              const flushed = await flushWorkflowProjections(basePath, { milestoneId: milestone.id });
              if (!flushed.stale) {
                fixesApplied.push(`re-rendered stale projections for ${milestone.id}`);
                reRenderedMilestoneIds.push(milestone.id);
              }
            } catch {
              // Non-fatal — projection re-render failed
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — projection drift check must never block doctor
  }

  if (reRenderedMilestoneIds.length > 0) {
    const reRendered = new Set(reRenderedMilestoneIds);
    for (let i = issues.length - 1; i >= 0; i--) {
      const issue = issues[i]!;
      // flushWorkflowProjections re-renders milestone shell projections (not
      // slice PLAN.md files), so only clear stale ROADMAP checkbox diagnostics.
      if (isClearedByMilestoneShellProjectionFlush(basePath, issue, reRendered)) {
        issues.splice(i, 1);
        continue;
      }
      if (issue.code === "artifact_file_missing" && issue.file && artifactExistsOnDisk(basePath, issue.file)) {
        issues.splice(i, 1);
      }
    }
  }
}
