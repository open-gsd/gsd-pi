// Project/App: gsd-pi
// File Purpose: Deep module owning projection observation, preservation, rendering, and durable delivery.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { renderCapturesProjection } from "./captures.js";
import { collectRenderedProjectionFiles, noteRenderedProjectionFile } from "./compat/compat-marker.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import {
  regenerateDecisionsMarkdown,
  regenerateRequirementsMarkdown,
  regenerateRootArtifactsMarkdown,
} from "./db-writer.js";
import { milestoneLeaseTtlSeconds } from "./db/milestone-leases.js";
import { getRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import {
  claimProjectionWork,
  expiredProjectionClaim,
  listDueProjectionWork,
  listExpiredProjectionClaims,
  listProjectionWorkHeads,
  requeueProjectionWork,
  settleFailedProjectionWork,
  settleRenderedProjectionWork,
  type ProjectionWorkClaim,
} from "./db/writers/projection-work-delivery.js";
import { getAllMilestones, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { knowledgeMdPath } from "./knowledge-parser.js";
import { renderKnowledgeProjection } from "./knowledge-projection.js";
import { renderOverridesProjection } from "./overrides.js";
import {
  renderAllFromDb,
  renderMilestoneFilesFromDb,
  renderMilestoneFromDb,
  renderSliceFilesFromDb,
  renderTaskFilesFromDb,
  type RenderAllResult,
} from "./markdown-renderer.js";
import { gsdProjectionRoot, gsdRoot, normalizeRealPath, resolveGsdPathContract } from "./paths.js";
import {
  preserveProjectionEvidence,
  type PreservedProjectionEvidence,
  type ProjectionObservationResult,
} from "./projection-observation.js";
import {
  MARKDOWN_PROJECTION_KIND,
  MILESTONE_LIFECYCLE_PROJECTION_KIND,
  SLICE_LIFECYCLE_PROJECTION_KIND,
  TASK_LIFECYCLE_PROJECTION_KIND,
} from "./projection-identity.js";
import { renderQueueOrderFromDb } from "./queue-order.js";
import { PROJECTION_LOCK_TRANSIENT_BACKOFF_MS } from "./recovery-policy.js";
import { deriveState, invalidateStateCache } from "./state.js";
import { isDiscardedMilestoneStatus } from "./status-guards.js";
import { detectArtifactDbDrift } from "./state-reconciliation/drift/artifact-db.js";
import {
  detectRoadmapDivergenceDrift,
  detectRoadmapMissingDrift,
  repairRoadmapDrift,
} from "./state-reconciliation/drift/roadmap.js";
import { detectStaleRenderDrift, repairStaleRender } from "./state-reconciliation/drift/stale-render.js";
import type { DriftRecord } from "./state-reconciliation/types.js";
import {
  renderStateProjection,
  renderTopLevelQueueFromDb,
  renderTopLevelRoadmapFromDb,
} from "./workflow-projections.js";

export interface RebuildMarkdownProjectionsResult {
  rendered: number;
  skipped: number;
  errors: string[];
  quarantined: number;
  quarantinedPaths: string[];
  refreshedPassthrough: string[];
  delivered: number;
}

export interface ProjectionDrainResult {
  /** Projection Work rows settled as rendered at the project root. */
  delivered: number;
  errors: string[];
  /** Renderer targets (for example hierarchy/m001/s01) that failed in this drain. */
  failedTargets: string[];
}

/** The renderer that owns one Projection Work row. Rows with the same target share one render per drain. */
export interface ProjectionRenderTarget {
  target: string;
  render: (root: string) => Promise<RenderAllResult | void>;
}

// Kinds whose key names a milestone, slice, or task after its first segment.
// The projection of such a row is the file set of that one item.
const HIERARCHY_KINDS = new Set([
  MILESTONE_LIFECYCLE_PROJECTION_KIND,
  SLICE_LIFECYCLE_PROJECTION_KIND,
  TASK_LIFECYCLE_PROJECTION_KIND,
  "task-execution",
  "task-recovery",
  "task-verification",
  "lifecycle-shadow-repair",
]);

// Kinds whose key names a milestone and then an id that is not a slice.
const MILESTONE_KINDS = new Set(["milestone-validation", "milestone-subjective-uat"]);

// Kinds whose operations change no hierarchy file. Their projection is the
// root files that list the milestones: STATE.md, root ROADMAP.md and QUEUE.md.
const STATE_KINDS = new Set(["state", "milestone-status", "migration-audit"]);

/** Key prefix of the doctor repair work that renders every file of one milestone. */
export const MILESTONE_REBUILD_KEY_PREFIX = "rebuild/";

/**
 * The milestone that a key segment names, or null when the row is obsolete:
 * the milestone is not in the database, or it was discarded. An obsolete row
 * renders no file and settles with the hash of an empty file set.
 */
function findProjectedMilestone(segment: string) {
  const milestone = getAllMilestones().find((row) => row.id.toLowerCase() === segment);
  return milestone && !isDiscardedMilestoneStatus(milestone.status) ? milestone : null;
}

/**
 * The file set of one milestone, slice, or task. A slice or task id that is
 * not in the database (for example a task that a replan removed) falls back to
 * the file set of its parent, which lists it.
 */
function hierarchyTarget(ids: string[]): ProjectionRenderTarget | null {
  const [milestoneSegment, sliceSegment, taskSegment] = ids;
  if (!milestoneSegment) return null;
  return {
    target: ["hierarchy", ...ids.slice(0, 3)].join("/"),
    render: async (root) => {
      const milestone = findProjectedMilestone(milestoneSegment);
      if (!milestone) return;
      const slice = getMilestoneSlices(milestone.id).find((row) => row.id.toLowerCase() === sliceSegment);
      if (!slice) return renderMilestoneFilesFromDb(root, milestone.id);
      const task = getSliceTasks(milestone.id, slice.id).find((row) => row.id.toLowerCase() === taskSegment);
      if (!task) return renderSliceFilesFromDb(root, milestone.id, slice.id);
      return renderTaskFilesFromDb(root, milestone.id, slice.id, task.id);
    },
  };
}

async function renderStateFile(root: string): Promise<void> {
  renderTopLevelRoadmapFromDb(root);
  renderTopLevelQueueFromDb(root);
  if ((await renderStateProjection(root)).stale) throw new Error("STATE.md was not rendered");
  const statePath = join(gsdRoot(root), "STATE.md");
  noteRenderedProjectionFile(statePath, readFileSync(statePath, "utf-8"));
}

async function renderKnowledgeFile(root: string): Promise<void> {
  noteRenderedProjectionFile(knowledgeMdPath(root), renderKnowledgeProjection(root).content);
}

/**
 * QUEUE-ORDER.json is the projection of milestones.sequence (milestone.reorder).
 * The root files list the milestones in that sequence, so they render too.
 */
async function renderQueueOrderFile(root: string): Promise<void> {
  const queueOrderPath = renderQueueOrderFromDb(root);
  noteRenderedProjectionFile(queueOrderPath, readFileSync(queueOrderPath, "utf-8"));
  await renderStateFile(root);
}

/**
 * Kind-to-renderer registry. Each kind that production code enqueues has a
 * renderer. Returns null for any other kind or key: such a row is never
 * claimed and stays pending, so it is never reported as rendered.
 */
export function projectionRendererFor(kind: string, key: string): ProjectionRenderTarget | null {
  const segments = key.split("/");
  if (HIERARCHY_KINDS.has(kind)) return hierarchyTarget(segments.slice(1));
  if (MILESTONE_KINDS.has(kind)) return hierarchyTarget(segments.slice(1, 2));
  if (STATE_KINDS.has(kind)) return { target: "state", render: renderStateFile };
  if (kind === "queue-order") return { target: "queue-order", render: renderQueueOrderFile };
  if (kind !== MARKDOWN_PROJECTION_KIND) return null;
  if (segments[0] === "legacy-import") return { target: "all", render: renderAllFromDb };
  if (key.startsWith(MILESTONE_REBUILD_KEY_PREFIX)) {
    if (!segments[1]) return null;
    return {
      target: key,
      render: async (root) => {
        const milestone = findProjectedMilestone(segments[1]!);
        if (milestone) return renderMilestoneFromDb(root, milestone.id);
      },
    };
  }
  // decision.save enqueues "decisions"; the legacy import enqueues "planning/decisions".
  if (key === "decisions" || key === "planning/decisions") {
    return { target: "decisions", render: regenerateDecisionsMarkdown };
  }
  if (key === "knowledge") return { target: "knowledge", render: renderKnowledgeFile };
  if (key === "overrides") return { target: "overrides", render: async (root) => renderOverridesProjection(root) };
  if (key === "captures") return { target: "captures", render: async (root) => renderCapturesProjection(root) };
  if (segments[0] !== "planning") return null;
  if (key === "planning/requirements") {
    return {
      target: "requirements",
      render: async (root) => {
        await regenerateRequirementsMarkdown(root);
      },
    };
  }
  // artifact.save enqueues this key for PROJECT.md and the root drafts.
  if (key === "planning/root-artifacts") {
    return {
      target: "root-artifacts",
      render: async (root) => {
        await regenerateRootArtifactsMarkdown(root);
      },
    };
  }
  return hierarchyTarget(segments.slice(1));
}

/** True when the render target writes files of the milestone, or files of the whole project. */
export function projectionTargetCoversMilestone(target: string, milestoneId: string): boolean {
  const segments = target.split("/");
  if (segments[0] !== "hierarchy" && segments[0] !== "rebuild") return target === "all" || target === "state";
  return segments[1] === milestoneId.toLowerCase();
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** sha256 over each written file's root-relative path and the sha256 of its bytes. */
function fileSetHash(root: string, files: Map<string, string>): string {
  const base = realPath(root);
  const entries = [...files]
    .map(([path, sha]) => [relative(base, realPath(path)), sha] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

/** Render one target at one root, once per drain, and return its file-set hash. */
function renderTarget(
  renders: Map<string, Promise<string>>,
  root: string,
  renderer: ProjectionRenderTarget,
): Promise<string> {
  let pending = renders.get(renderer.target);
  if (!pending) {
    pending = (async () => {
      let result: RenderAllResult | void = undefined;
      const files = await collectRenderedProjectionFiles(async () => {
        result = await renderer.render(root);
      });
      const errors = (result as RenderAllResult | undefined)?.errors ?? [];
      if (errors.length > 0) throw new Error(errors.join("; "));
      return fileSetHash(root, files);
    })();
    renders.set(renderer.target, pending);
  }
  return pending;
}

/**
 * Retry time after a failed attempt, or null for dead_letter. The wait follows
 * the projection retry schedule in recovery-policy.ts; when the schedule is
 * used up, the row stops retrying.
 */
function retryAt(attemptCount: number, now: Date): Date | null {
  const waitMs = PROJECTION_LOCK_TRANSIENT_BACKOFF_MS[attemptCount - 1];
  return waitMs === undefined ? null : new Date(now.getTime() + waitMs);
}

function recordFailure(claim: ProjectionWorkClaim, error: string, now: Date): void {
  settleFailedProjectionWork(claim, error, now, retryAt(claim.attemptCount + 1, now));
}

const ROOT_RECEIPTS_KEY = "projection-root-receipts";
const ALL_DELIVERY_STATES = ["pending", "claimed", "rendered", "dead_letter"] as const;

/** A failed render of one row at a derived root. An empty retry time means it stopped retrying. */
interface RootFailure {
  attemptCount: number;
  lastError: string;
  nextAttemptAt: string;
}
/** Per Projection Work id: the file-set hash rendered at the root, or the failure of the last attempt. */
type RootReceipts = Record<string, string | RootFailure>;

/**
 * A worktree holds a derived copy of the project-root projections. Render each
 * current row there once and keep a receipt (row id to file-set hash) for that
 * root. A failed render is kept as a failure receipt and retried on the same
 * schedule as project-root work. The worktree copy does not wait for the
 * project-root render of the row.
 */
async function refreshDerivedRoot(root: string, result: ProjectionDrainResult, now: Date): Promise<void> {
  const rootId = realPath(root);
  const receipts = getRuntimeKv<RootReceipts>("global", rootId, ROOT_RECEIPTS_KEY) ?? {};
  const current: RootReceipts = {};
  const renders = new Map<string, Promise<string>>();
  for (const head of listProjectionWorkHeads(ALL_DELIVERY_STATES)) {
    const id = head.projection_work_id;
    const prior = receipts[id];
    if (typeof prior === "string") {
      current[id] = prior;
      continue;
    }
    const renderer = projectionRendererFor(head.projection_kind, head.projection_key);
    if (!renderer) continue;
    if (prior && (prior.nextAttemptAt === "" || Date.parse(prior.nextAttemptAt) > now.getTime())) {
      current[id] = prior;
      continue;
    }
    try {
      current[id] = await renderTarget(renders, root, renderer);
    } catch (error) {
      const lastError = (error as Error).message;
      const attemptCount = (prior?.attemptCount ?? 0) + 1;
      current[id] = {
        attemptCount,
        lastError,
        nextAttemptAt: retryAt(attemptCount, now)?.toISOString() ?? "",
      };
      result.errors.push(`${head.projection_key} at ${root}: ${lastError}`);
      result.failedTargets.push(renderer.target);
    }
  }
  setRuntimeKv("global", rootId, ROOT_RECEIPTS_KEY, current);
}

/** Receipts of one derived root (worktree), by Projection Work id: a file-set hash, or the last failure. */
export function readProjectionRootReceipts(root: string): RootReceipts {
  return getRuntimeKv<RootReceipts>("global", realPath(root), ROOT_RECEIPTS_KEY) ?? {};
}

/**
 * Deliver due Projection Work one row at a time: claim the row, render the
 * files its kind and key name, and settle it with the hash of those files, or
 * record the error with a retry time. Rows settle at the project root; from a
 * worktree, the worktree copy is rendered too. `now` is the drain time.
 */
export async function drainProjectionWork(
  basePath: string,
  options: { now?: Date } = {},
): Promise<ProjectionDrainResult> {
  const now = options.now ?? new Date();
  const result: ProjectionDrainResult = { delivered: 0, errors: [], failedTargets: [] };
  const { projectRoot, workRoot, isWorktree } = resolveGsdPathContract(basePath);

  for (const head of listExpiredProjectionClaims(now)) {
    recordFailure(
      expiredProjectionClaim(head),
      `claim by ${head.claim_owner ?? "unknown owner"} expired before settlement`,
      now,
    );
  }

  const owner = `projection-worker:${process.pid}:${randomUUID()}`;
  const claimExpiresAt = new Date(now.getTime() + milestoneLeaseTtlSeconds() * 1000);
  const renders = new Map<string, Promise<string>>();
  for (const head of listDueProjectionWork(now)) {
    const renderer = projectionRendererFor(head.projection_kind, head.projection_key);
    if (!renderer) continue;
    const claim = claimProjectionWork(head, owner, now, claimExpiresAt);
    if (!claim) continue;
    try {
      const hash = await renderTarget(renders, projectRoot, renderer);
      if (settleRenderedProjectionWork(claim, hash, now)) result.delivered += 1;
    } catch (error) {
      const message = (error as Error).message;
      recordFailure(claim, message, now);
      result.errors.push(`${head.projection_key}: ${message}`);
      result.failedTargets.push(renderer.target);
    }
  }

  if (isWorktree) await refreshDerivedRoot(workRoot, result, now);
  return result;
}

/**
 * Repair delivery: enqueue new work for each dead-lettered row and for the
 * whole file set of each given milestone, forget the failures of the worktree
 * copy, then drain. A row that renders this time is no longer dead-lettered.
 */
export async function repairProjectionWork(
  basePath: string,
  milestoneIds: readonly string[] = [],
): Promise<ProjectionDrainResult> {
  const byKey = new Map<string, { projectionKey: string; projectionKind: string }>();
  for (const head of listProjectionWorkHeads(["dead_letter"])) {
    if (projectionRendererFor(head.projection_kind, head.projection_key) === null) continue;
    byKey.set(head.projection_key, { projectionKey: head.projection_key, projectionKind: head.projection_kind });
  }
  for (const id of milestoneIds) {
    const projectionKey = `${MILESTONE_REBUILD_KEY_PREFIX}${id.toLowerCase()}`;
    byKey.set(projectionKey, { projectionKey, projectionKind: MARKDOWN_PROJECTION_KIND });
  }
  const requeue = [...byKey.values()];
  const notRequeued: ProjectionDrainResult = { delivered: 0, errors: [], failedTargets: [] };
  try {
    requeueProjectionWork(requeue);
  } catch (error) {
    notRequeued.errors.push(`Projection Work was not requeued: ${(error as Error).message}`);
    notRequeued.failedTargets.push(...requeue.map((projection) => projection.projectionKey));
  }
  const { workRoot, isWorktree } = resolveGsdPathContract(basePath);
  if (isWorktree) {
    const rootId = realPath(workRoot);
    const receipts = getRuntimeKv<RootReceipts>("global", rootId, ROOT_RECEIPTS_KEY) ?? {};
    setRuntimeKv("global", rootId, ROOT_RECEIPTS_KEY, Object.fromEntries(
      Object.entries(receipts).filter(([, receipt]) => typeof receipt === "string"),
    ));
  }
  const drained = await drainProjectionWork(basePath);
  return {
    delivered: drained.delivered,
    errors: [...notRequeued.errors, ...drained.errors],
    failedTargets: [...notRequeued.failedTargets, ...drained.failedTargets],
  };
}

export interface ProjectionWorkBacklogEntry {
  projectionKey: string;
  projectionKind: string;
  deliveryState: string;
  attemptCount: number;
  lastError: string;
  nextAttemptAt: string;
  /** False when no registered renderer owns the row; it stays pending. */
  hasRenderer: boolean;
  /** Set when the entry is the failed worktree copy of the row, not the project-root delivery. */
  root?: string;
}

/**
 * Current Projection Work that is not rendered: pending, in flight, or
 * dead-lettered at the project root, and, for a worktree `basePath`, each row
 * whose worktree copy failed.
 */
export function readProjectionWorkBacklog(basePath?: string): ProjectionWorkBacklogEntry[] {
  const entries: ProjectionWorkBacklogEntry[] = listProjectionWorkHeads(["pending", "claimed", "dead_letter"]).map((head) => ({
    projectionKey: head.projection_key,
    projectionKind: head.projection_kind,
    deliveryState: head.delivery_state,
    attemptCount: head.attempt_count,
    lastError: head.last_error,
    nextAttemptAt: head.next_attempt_at,
    hasRenderer: projectionRendererFor(head.projection_kind, head.projection_key) !== null,
  }));
  if (!basePath) return entries;
  const { workRoot, isWorktree } = resolveGsdPathContract(basePath);
  if (!isWorktree) return entries;
  const receipts = readProjectionRootReceipts(workRoot);
  for (const head of listProjectionWorkHeads(ALL_DELIVERY_STATES)) {
    const failure = receipts[head.projection_work_id];
    if (!failure || typeof failure === "string") continue;
    entries.push({
      projectionKey: head.projection_key,
      projectionKind: head.projection_kind,
      deliveryState: failure.nextAttemptAt === "" ? "dead_letter" : "pending",
      attemptCount: failure.attemptCount,
      lastError: failure.lastError,
      nextAttemptAt: failure.nextAttemptAt,
      hasRenderer: true,
      root: workRoot,
    });
  }
  return entries;
}

function resolveDiskArtifactPath(basePath: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) return artifactPath;
  const candidates = [
    join(gsdProjectionRoot(basePath), artifactPath),
    join(gsdRoot(basePath), artifactPath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export interface ProjectionPreservationResult extends ProjectionObservationResult {
  /** Failures of the render that follows the copy. They are reported and never stop work. */
  errors: string[];
}

/** Render every projection file from the database: the hierarchy, the root files, KNOWLEDGE.md, STATE.md, OVERRIDES.md and CAPTURES.md. */
async function renderEveryProjection(basePath: string): Promise<RenderAllResult> {
  const rendered = await renderAllFromDb(basePath);
  try {
    if (renderKnowledgeProjection(basePath).written) rendered.rendered++;
    else rendered.skipped++;
  } catch (err) {
    rendered.errors.push(`knowledge: ${(err as Error).message}`);
  }
  // STATE.md is part of the full render, with or without a Projection Work row of kind "state".
  if ((await renderStateProjection(basePath)).stale) rendered.errors.push("STATE.md: render failed");
  try {
    renderOverridesProjection(basePath);
  } catch (err) {
    rendered.errors.push(`overrides: ${(err as Error).message}`);
  }
  try {
    renderCapturesProjection(basePath);
  } catch (err) {
    rendered.errors.push(`captures: ${(err as Error).message}`);
  }
  return rendered;
}

/**
 * Move changed projection bytes to quarantine, then render the database
 * content again at once, so a changed file is never left missing. A render
 * failure is returned in `errors`; the next drift repair or rebuild retries.
 */
async function preserveAndRender(
  basePath: string,
  holdTracked: boolean,
): Promise<ProjectionPreservationResult> {
  const observation = await preserveProjectionEvidence(basePath, [], false, holdTracked);
  if (observation.preserved.length === 0) return { ...observation, errors: [] };
  try {
    return { ...observation, errors: (await renderEveryProjection(basePath)).errors };
  } catch (error) {
    return { ...observation, errors: [(error as Error).message] };
  }
}

/**
 * Preserve changed projection bytes and render the database content again.
 * Does not participate in workflow progression. With `dryRun`, reports what
 * would be preserved and writes nothing.
 */
export async function preserveProjectionChanges(
  basePath: string,
  dryRun = false,
): Promise<ProjectionPreservationResult> {
  if (dryRun) return { ...(await preserveProjectionEvidence(basePath, [], true)), errors: [] };
  return preserveAndRender(basePath, false);
}

/**
 * Before dispatch: preserve changed projection bytes and render the database
 * content again, but hold a changed git-tracked projection (team mode) in
 * place. A non-empty `held` means the caller must stop: see
 * describeHeldProjectionChanges. In that pass no file is moved or rendered, so
 * the held file is not overwritten. Nothing else in the result may stop dispatch.
 */
export function preserveProjectionChangesBeforeDispatch(
  basePath: string,
): Promise<ProjectionPreservationResult> {
  return preserveAndRender(basePath, true);
}

/** The user notice for projection files that were changed outside GSD and rendered again from the database. */
export function describePreservedProjectionChanges(
  basePath: string,
  preserved: readonly PreservedProjectionEvidence[],
): string {
  const root = normalizeRealPath(basePath);
  const rel = (path: string) => relative(root, normalizeRealPath(path)).split(sep).join("/");
  return [
    `Projection files changed outside GSD: ${preserved.length}. The database is authoritative, so GSD rendered them again.`,
    "Each changed file was moved to the quarantine path shown below. To make a change real, apply it with the workflow tools (plan, replan, requirement, or decision tools).",
    ...preserved.map((evidence) => `  ${rel(evidence.sourcePath)} -> ${rel(evidence.quarantinePath)}`),
  ].join("\n");
}

export interface ProjectionDriftRepairResult {
  /** Drift whose file was rendered again from the database. */
  repaired: DriftRecord[];
  /** Detect and render failures. They are reported and never stop work. */
  errors: string[];
}

/**
 * Render again every projection file that is missing or that differs from the
 * database: slice plans, task and slice summaries, UAT files, and roadmaps.
 * This is the only place that detects projection drift. It never throws for a
 * file or render fault, so projection state cannot block database-backed work.
 * Drift that has no narrower renderer shares one full render per pass.
 */
export async function repairProjectionDrift(
  basePath: string,
  renderAll: (basePath: string) => Promise<RenderAllResult> = renderAllFromDb,
): Promise<ProjectionDriftRepairResult> {
  const result: ProjectionDriftRepairResult = { repaired: [], errors: [] };
  let fullRender: Promise<RenderAllResult> | undefined;
  const renderAllOnce = (path: string) => (fullRender ??= renderAll(path));
  const detect = <T extends DriftRecord>(kind: T["kind"], find: (basePath: string) => T[]): T[] => {
    try {
      return find(basePath);
    } catch (error) {
      result.errors.push(`${kind} detection: ${(error as Error).message}`);
      return [];
    }
  };
  const repair = async <T extends DriftRecord>(
    records: T[],
    render: (record: T, basePath: string) => Promise<void>,
  ): Promise<void> => {
    for (const record of records) {
      try {
        await render(record, basePath);
        result.repaired.push(record);
      } catch (error) {
        result.errors.push(`${record.kind}: ${(error as Error).message}`);
      }
    }
  };
  // Detect every kind before any repair, so a kind is not judged on a tree
  // that another repair has half rendered.
  const staleRenders = detect("stale-render", detectStaleRenderDrift);
  const roadmaps = [
    ...detect("roadmap-missing", detectRoadmapMissingDrift),
    ...detect("roadmap-divergence", detectRoadmapDivergenceDrift),
  ];
  await repair(staleRenders, (record, path) => repairStaleRender(record, path, renderAllOnce));
  await repair(roadmaps, repairRoadmapDrift);
  return result;
}

/** The one "changed outside GSD" state: no dispatch on old content until the user chooses. */
export function describeHeldProjectionChanges(basePath: string, held: readonly string[]): string {
  const root = normalizeRealPath(basePath);
  const files = held.map((path) => relative(root, normalizeRealPath(path)).split(sep).join("/")).join(", ");
  return [
    `Projection files changed outside GSD: ${files}.`,
    "The database is authoritative, so GSD stopped before dispatch instead of overwriting them.",
    "To keep the change, review it and run `/gsd recover` to import it through Import Preview.",
    "To discard it, run `/gsd rebuild markdown` (the changed bytes are kept under .gsd/quarantine/).",
  ].join(" ");
}

/** Rebuild all readable projections from database authority, then repair and drain durable work. */
export async function rebuildMarkdownProjectionsFromDb(
  basePath: string,
): Promise<RebuildMarkdownProjectionsResult> {
  invalidateStateCache();
  refreshWorkflowDatabaseFromDisk();

  const state = await deriveState(basePath);
  const legacyDriftPaths = detectArtifactDbDrift(state, { basePath, state })
    .flatMap((drift) => drift.kind === "artifact-db-status-divergence"
      && drift.artifactType === "SUMMARY"
      && drift.artifactPath
      ? [resolveDiskArtifactPath(basePath, drift.artifactPath)]
      : []);
  const observation = await preserveProjectionEvidence(basePath, legacyDriftPaths);
  const preserved = observation.preserved;

  const rendered = await renderEveryProjection(basePath);
  const drained = await repairProjectionWork(basePath);
  invalidateStateCache();

  return {
    ...rendered,
    errors: [...rendered.errors, ...drained.errors],
    quarantined: preserved.length,
    quarantinedPaths: preserved.map((evidence) => evidence.quarantinePath),
    refreshedPassthrough: observation.refreshedPassthrough,
    delivered: drained.delivered,
  };
}
