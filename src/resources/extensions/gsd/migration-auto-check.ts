import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "./gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { parseProjectionPlan as parsePlan, parseProjectionRoadmap as parseRoadmap } from "./schemas/parsers.js";
import { findMilestoneIds } from "./milestone-ids.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveTaskFiles,
  resolveTasksDir,
  taskIdFromTaskFileName,
} from "./paths.js";
import { isHiddenFromRoadmap } from "./status-guards.js";

export interface HierarchyCounts {
  milestones: number;
  slices: number;
  tasks: number;
}

export interface MigrationAutoCheckResult {
  action: "none" | "recovery-required";
  reason: "no-markdown" | "in-sync" | "db-empty" | "count-mismatch" | "markdown-missing";
  markdown: HierarchyCounts;
  beforeDb: HierarchyCounts;
  afterDb: HierarchyCounts;
  recoveryCommand?: string;
  message?: string;
  recoveryFingerprint?: string;
}

interface HierarchyScan {
  counts: HierarchyCounts;
  // Fully-qualified identities: milestone "M001", slice "M001/S01",
  // task "M001/S01/T01". Used to detect drift the cardinalities miss (a
  // deleted+added pair nets to the same counts but is real divergence).
  milestones: Set<string>;
  slices: Set<string>;
  tasks: Set<string>;
  // Markdown milestones whose dir has no ROADMAP (CONTEXT/CONTEXT-DRAFT only
  // or empty). Always empty for DB scans.
  milestonesWithoutRoadmap: Set<string>;
}

function zeroCounts(): HierarchyCounts {
  return { milestones: 0, slices: 0, tasks: 0 };
}

function emptyScan(): HierarchyScan {
  return {
    counts: zeroCounts(),
    milestones: new Set(),
    slices: new Set(),
    tasks: new Set(),
    milestonesWithoutRoadmap: new Set(),
  };
}

function sameCounts(a: HierarchyCounts, b: HierarchyCounts): boolean {
  return a.milestones === b.milestones && a.slices === b.slices && a.tasks === b.tasks;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function scanIdentitiesMatch(a: HierarchyScan, b: HierarchyScan): boolean {
  return (
    setsEqual(a.milestones, b.milestones) &&
    setsEqual(a.slices, b.slices) &&
    setsEqual(a.tasks, b.tasks)
  );
}

/** True if any element of `a` is absent from `b`. */
function hasExtra(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (!b.has(value)) return true;
  return false;
}

function scanHasExtraIdentities(a: HierarchyScan, b: HierarchyScan): boolean {
  return (
    hasExtra(a.milestones, b.milestones) ||
    hasExtra(a.slices, b.slices) ||
    hasExtra(a.tasks, b.tasks)
  );
}

function recoveryFingerprint(markdownScan: HierarchyScan, dbScan: HierarchyScan): string {
  const sorted = (values: ReadonlySet<string>): string[] => [...values].sort();
  const identities = {
    markdown: {
      milestones: sorted(markdownScan.milestones),
      slices: sorted(markdownScan.slices),
      tasks: sorted(markdownScan.tasks),
    },
    db: {
      milestones: sorted(dbScan.milestones),
      slices: sorted(dbScan.slices),
      tasks: sorted(dbScan.tasks),
    },
  };
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

function excludeUnplannedMilestonesFromDbScan(
  markdownScan: HierarchyScan,
  dbScan: HierarchyScan,
): void {
  const excludedMilestoneIds = new Set<string>();
  for (const milestone of getAllMilestones()) {
    if (markdownScan.milestones.has(milestone.id)) continue;
    const slices = getMilestoneSlices(milestone.id);
    if (milestone.vision.trim() || slices.some((slice) => slice.status !== "skipped")) continue;
    excludedMilestoneIds.add(milestone.id);
  }
  if (excludedMilestoneIds.size === 0) return;

  // Identities are `${milestoneId}/…`, so the milestone is the leading segment.
  const milestoneOf = (identity: string): string => {
    const slash = identity.indexOf("/");
    return slash === -1 ? identity : identity.slice(0, slash);
  };

  for (const id of excludedMilestoneIds) {
    if (dbScan.milestones.delete(id)) dbScan.counts.milestones--;
  }
  // Single pass over each set. Deleting the current element during Set
  // iteration is well-defined, so no intermediate array copy is needed.
  for (const identity of dbScan.slices) {
    if (excludedMilestoneIds.has(milestoneOf(identity)) && dbScan.slices.delete(identity))
      dbScan.counts.slices--;
  }
  for (const identity of dbScan.tasks) {
    if (excludedMilestoneIds.has(milestoneOf(identity)) && dbScan.tasks.delete(identity))
      dbScan.counts.tasks--;
  }
}

function paddedMilestoneId(id: string): string | null {
  return /^\d+$/.test(id) ? `M${id.padStart(3, "0")}` : null;
}

function replaceSetPrefix(values: Set<string>, from: string, to: string): void {
  for (const value of [...values]) {
    if (value !== from && !value.startsWith(`${from}/`)) continue;
    values.delete(value);
    values.add(`${to}${value.slice(from.length)}`);
  }
}

/**
 * Rewrite one milestone identity across EVERY markdown identity set. The
 * roadmapless subset is a view of `milestones`, so it must speak the same
 * aligned vocabulary; otherwise the discussion-phase exclusion below keys off
 * the stale bare id, fails its `dbScan.milestones.has(...)` membership check,
 * and decrements the milestone count even though the aligned identity remains
 * in the set, reporting false drift for a milestone that is actually in sync.
 * Centralising the set list here keeps every alignment path from silently
 * missing a set (the defect that regressed the suffixed roadmapless case).
 */
function realignMilestonePrefix(markdownScan: HierarchyScan, from: string, to: string): void {
  replaceSetPrefix(markdownScan.milestones, from, to);
  replaceSetPrefix(markdownScan.slices, from, to);
  replaceSetPrefix(markdownScan.tasks, from, to);
  replaceSetPrefix(markdownScan.milestonesWithoutRoadmap, from, to);
}

function alignNumericMarkdownIdsWithDb(markdownScan: HierarchyScan, dbScan: HierarchyScan): void {
  for (const dbId of dbScan.milestones) {
    const paddedId = paddedMilestoneId(dbId);
    if (!paddedId || dbScan.milestones.has(paddedId) || !markdownScan.milestones.has(paddedId)) continue;
    realignMilestonePrefix(markdownScan, paddedId, dbId);
  }
}

function bareMilestoneId(id: string): string | null {
  const match = id.match(/^(M\d{3})-[a-z0-9]{6}$/);
  return match?.[1] ?? null;
}

function alignBareMarkdownIdsWithSuffixedDb(markdownScan: HierarchyScan, dbScan: HierarchyScan): void {
  for (const dbId of dbScan.milestones) {
    const bareId = bareMilestoneId(dbId);
    if (!bareId || dbScan.milestones.has(bareId) || !markdownScan.milestones.has(bareId)) continue;
    realignMilestonePrefix(markdownScan, bareId, dbId);
  }
}

export function scanMarkdownHierarchy(basePath: string): HierarchyScan {
  const scan = emptyScan();
  // findMilestoneIds handles both flat-phase (NN-slug) and legacy (M###) dirs.
  for (const milestoneId of findMilestoneIds(basePath)) {
    scan.counts.milestones++;
    scan.milestones.add(milestoneId);

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) {
      scan.milestonesWithoutRoadmap.add(milestoneId);
      continue;
    }

    const roadmap = parseRoadmap(readFileSync(roadmapPath, "utf-8"));
    scan.counts.slices += roadmap.slices.length;

    for (const slice of roadmap.slices) {
      scan.slices.add(`${milestoneId}/${slice.id}`);
      // Sketch slices carry only a stub PLAN until refined; match migrateHierarchyToDb
      // and do not count placeholder tasks from the <tasks> block (#1286).
      if (slice.isSketch) continue;
      const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
      if (!planPath || !existsSync(planPath)) continue;
      const plan = parsePlan(readFileSync(planPath, "utf-8"));
      const taskIds = new Set(plan.tasks.map((task) => task.id));
      const tasksDir = resolveTasksDir(basePath, milestoneId, slice.id);
      if (tasksDir !== null) {
        for (const fileName of resolveTaskFiles(tasksDir, "PLAN")) {
          const taskId = taskIdFromTaskFileName(fileName, "PLAN");
          if (taskId !== null) taskIds.add(taskId);
        }
      }
      scan.counts.tasks += taskIds.size;
      for (const taskId of taskIds) {
        scan.tasks.add(`${milestoneId}/${slice.id}/${taskId}`);
      }
    }
  }

  return scan;
}

export function scanDbHierarchy(): HierarchyScan {
  if (!isDbAvailable()) return emptyScan();
  const scan = emptyScan();
  const milestones = getAllMilestones();
  scan.counts.milestones = milestones.length;

  for (const milestone of milestones) {
    scan.milestones.add(milestone.id);
    // Match renderRoadmapFromDb so skipped slices/tasks omitted from ROADMAP/PLAN
    // are not counted as markdown-hierarchy drift (#1860).
    const slices = getMilestoneSlices(milestone.id).filter(
      (slice) => !isHiddenFromRoadmap(slice.status),
    );
    scan.counts.slices += slices.length;
    for (const slice of slices) {
      scan.slices.add(`${milestone.id}/${slice.id}`);
      const tasks = getSliceTasks(milestone.id, slice.id).filter(
        (task) => !isHiddenFromRoadmap(task.status),
      );
      scan.counts.tasks += tasks.length;
      for (const task of tasks) {
        scan.tasks.add(`${milestone.id}/${slice.id}/${task.id}`);
      }
    }
  }

  return scan;
}

export function countMarkdownHierarchy(basePath: string): HierarchyCounts {
  return scanMarkdownHierarchy(basePath).counts;
}

export function countDbHierarchy(): HierarchyCounts {
  return scanDbHierarchy().counts;
}

export async function checkMarkdownHierarchyAgainstDb(
  basePath: string,
): Promise<MigrationAutoCheckResult> {
  const markdownScan = scanMarkdownHierarchy(basePath);

  // Always open the DB before deciding. An empty markdown tree does NOT imply
  // an empty project — the DB may hold authoritative rows whose markdown was
  // lost, which is itself recoverable drift. The previous early return here
  // skipped the DB entirely and silently hid a populated-DB/empty-markdown
  // project.
  const opened = await ensureDbOpen(basePath);
  if (!opened || !isDbAvailable()) {
    throw new Error(`failed to open or create the GSD database at ${basePath}`);
  }

  // The markdown projections may have just been written by a workflow/MCP
  // server in another process. Reopen before comparing so startup does not
  // warn from a stale long-lived SQLite handle.
  refreshWorkflowDatabaseFromDisk();

  const dbScan = scanDbHierarchy();
  alignNumericMarkdownIdsWithDb(markdownScan, dbScan);
  alignBareMarkdownIdsWithSuffixedDb(markdownScan, dbScan);

  // renderRoadmapFromDb deliberately skips milestones with no non-skipped
  // slices and no vision, refusing to create a misleading stub ROADMAP (#852).
  // Exclude the same hierarchy branches from projection parity so a newly
  // admitted, not-yet-planned milestone is not reported as repairable drift.
  excludeUnplannedMilestonesFromDbScan(markdownScan, dbScan);
  const beforeDb = dbScan.counts;

  // Discussion-phase scratch: a milestone dir with no ROADMAP and no DB row is
  // a pre-registration discussion artifact (CONTEXT/CONTEXT-DRAFT only — the
  // queued DB row is inserted only at discussion handoff). Treating it as
  // drift would warn on every live discussion and recommend
  // `/gsd recover` with exact Preview approval, an import that materializes abandoned-discussion
  // dirs as ghost active milestones. Exclude such dirs from this comparison
  // only; recover preflights use the raw scans and still see them.
  for (const id of markdownScan.milestonesWithoutRoadmap) {
    if (dbScan.milestones.has(id)) continue;
    markdownScan.milestones.delete(id);
    markdownScan.counts.milestones--;
  }
  const markdown = markdownScan.counts;

  const markdownEmpty = sameCounts(markdown, zeroCounts());
  const dbEmpty = sameCounts(beforeDb, zeroCounts());

  // Genuinely empty project: nothing on disk, nothing in the DB.
  if (markdownEmpty && dbEmpty) {
    return { action: "none", reason: "no-markdown", markdown, beforeDb, afterDb: beforeDb };
  }

  // In sync only when both cardinalities AND identities agree. Identity
  // comparison catches drift the counts miss (e.g. a slice deleted from the DB
  // and a different one added nets to the same count but is real divergence,
  // and a missing PLAN.md vs DB tasks shows up as a task-identity gap).
  if (sameCounts(markdown, beforeDb) && scanIdentitiesMatch(markdownScan, dbScan)) {
    return { action: "none", reason: "in-sync", markdown, beforeDb, afterDb: beforeDb };
  }

  // Choose the safe repair direction by identity, not cardinality. Whenever the
  // authoritative DB holds identities markdown lacks, re-project from the DB.
  // Reserve explicit legacy import for a lost or corrupt DB whose intended
  // source is markdown.
  const dbHasExtra = scanHasExtraIdentities(dbScan, markdownScan);
  const driftFingerprint = recoveryFingerprint(markdownScan, dbScan);

  const countsLine =
    `Markdown planning artifacts (${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T) ` +
    `do not match the authoritative DB (${beforeDb.milestones}M/${beforeDb.slices}S/${beforeDb.tasks}T). `;

  // The DB holds rows markdown lacks (richer, identity-diverged, or markdown
  // entirely missing): re-project from the authoritative DB.
  if (dbHasExtra) {
    return {
      action: "recovery-required",
      reason: markdownEmpty ? "markdown-missing" : "count-mismatch",
      markdown,
      beforeDb,
      afterDb: beforeDb,
      recoveryCommand: "/gsd rebuild markdown",
      recoveryFingerprint: driftFingerprint,
      message:
        countsLine +
        "The DB holds rows the markdown lacks, so the markdown projection is stale. " +
        "Run `/gsd rebuild markdown` to re-project from the authoritative DB. " +
        "Do NOT run `/gsd recover` here — legacy import is not a repair for stale markdown projections.",
    };
  }

  // DB is empty (or markdown is strictly richer): markdown is the surviving
  // source to import.
  const reason = dbEmpty ? "db-empty" : "count-mismatch";
  return {
    action: "recovery-required",
    reason,
    markdown,
    beforeDb,
    afterDb: beforeDb,
    recoveryCommand: "/gsd recover",
    recoveryFingerprint: driftFingerprint,
    message:
      countsLine +
      "Runtime startup will not import markdown automatically; run `/gsd recover` and approve its exact Preview hash if markdown should repopulate the database.",
  };
}
