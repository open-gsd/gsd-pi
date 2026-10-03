// Project/App: gsd-pi
// File Purpose: Deep module owning projection observation, preservation, rendering, and durable delivery.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { collectRenderedProjectionFiles } from "./compat/compat-marker.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { regenerateDecisionsMarkdown } from "./db-writer.js";
import { milestoneLeaseTtlSeconds } from "./db/milestone-leases.js";
import { getRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import {
  claimProjectionWork,
  expiredProjectionClaim,
  listDueProjectionWork,
  listExpiredProjectionClaims,
  listProjectionWorkHeads,
  settleFailedProjectionWork,
  settleRenderedProjectionWork,
  type ProjectionWorkClaim,
} from "./db/writers/projection-work-delivery.js";
import { getAllMilestones } from "./gsd-db.js";
import { renderKnowledgeProjection } from "./knowledge-projection.js";
import { renderAllFromDb, renderMilestoneFromDb, type RenderAllResult } from "./markdown-renderer.js";
import { gsdProjectionRoot, gsdRoot, normalizeRealPath, resolveGsdPathContract } from "./paths.js";
import {
  preserveProjectionEvidence,
  type ProjectionObservationResult,
} from "./projection-observation.js";
import {
  MARKDOWN_PROJECTION_KIND,
  MILESTONE_LIFECYCLE_PROJECTION_KIND,
  SLICE_LIFECYCLE_PROJECTION_KIND,
  TASK_LIFECYCLE_PROJECTION_KIND,
} from "./projection-identity.js";
import { PROJECTION_LOCK_TRANSIENT_BACKOFF_MS } from "./recovery-policy.js";
import { deriveState, invalidateStateCache } from "./state.js";
import { detectArtifactDbDrift } from "./state-reconciliation/drift/artifact-db.js";

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
}

/** The renderer that owns one Projection Work row. Rows with the same target share one render per drain. */
export interface ProjectionRenderTarget {
  target: string;
  render: (root: string) => Promise<RenderAllResult | void>;
}

// Kinds whose operations change only hierarchy rows of one milestone. The
// milestone file set (roadmap, artifacts, plans, summaries) is their projection.
const MILESTONE_SCOPED_KINDS = new Set([
  MILESTONE_LIFECYCLE_PROJECTION_KIND,
  SLICE_LIFECYCLE_PROJECTION_KIND,
  TASK_LIFECYCLE_PROJECTION_KIND,
  "task-execution",
  "lifecycle-shadow-repair",
]);

function milestoneTarget(segment: string | undefined): ProjectionRenderTarget | null {
  if (!segment) return null;
  return {
    target: `milestone/${segment}`,
    render: async (root) => {
      const milestone = getAllMilestones().find((row) => row.id.toLowerCase() === segment);
      if (!milestone) throw new Error(`milestone ${segment} is not in the database`);
      return renderMilestoneFromDb(root, milestone.id);
    },
  };
}

/**
 * Kind-to-renderer registry. Returns null when no renderer owns the row's kind
 * and key: such a row is never claimed and stays pending, so it is never
 * reported as rendered. Kinds without a renderer today: state, milestone-status,
 * milestone-validation, milestone-subjective-uat, task-recovery,
 * task-verification, migration-audit, and the planning/requirements key.
 */
export function projectionRendererFor(kind: string, key: string): ProjectionRenderTarget | null {
  const segments = key.split("/");
  if (MILESTONE_SCOPED_KINDS.has(kind)) return milestoneTarget(segments[1]);
  if (kind !== MARKDOWN_PROJECTION_KIND) return null;
  if (segments[0] === "legacy-import") return { target: "all", render: renderAllFromDb };
  if (segments[0] !== "planning") return null;
  if (key === "planning/decisions") return { target: "decisions", render: regenerateDecisionsMarkdown };
  if (key === "planning/requirements") return null;
  return milestoneTarget(segments[1]);
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
type RootReceipts = Record<string, string>;

/**
 * A worktree holds a derived copy of the project-root projections. Render each
 * current rendered row there once and keep a receipt (row id to file-set hash)
 * for that root. Receipts are soft state: losing one only causes a re-render.
 */
async function refreshDerivedRoot(root: string, result: ProjectionDrainResult): Promise<void> {
  const rootId = realPath(root);
  const receipts = getRuntimeKv<RootReceipts>("global", rootId, ROOT_RECEIPTS_KEY) ?? {};
  const current: RootReceipts = {};
  const renders = new Map<string, Promise<string>>();
  for (const head of listProjectionWorkHeads(["rendered"])) {
    const id = head.projection_work_id;
    if (receipts[id]) {
      current[id] = receipts[id]!;
      continue;
    }
    const renderer = projectionRendererFor(head.projection_kind, head.projection_key);
    if (!renderer) continue;
    try {
      current[id] = await renderTarget(renders, root, renderer);
    } catch (error) {
      result.errors.push(`${head.projection_key} at ${root}: ${(error as Error).message}`);
    }
  }
  setRuntimeKv("global", rootId, ROOT_RECEIPTS_KEY, current);
}

/** Rendered-state receipts of one derived root (worktree), by Projection Work id. */
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
  const result: ProjectionDrainResult = { delivered: 0, errors: [] };
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
    }
  }

  if (isWorktree) await refreshDerivedRoot(workRoot, result);
  return result;
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
}

/** Current Projection Work that is not rendered: pending, in flight, or dead-lettered. */
export function readProjectionWorkBacklog(): ProjectionWorkBacklogEntry[] {
  return listProjectionWorkHeads(["pending", "claimed", "dead_letter"]).map((head) => ({
    projectionKey: head.projection_key,
    projectionKind: head.projection_kind,
    deliveryState: head.delivery_state,
    attemptCount: head.attempt_count,
    lastError: head.last_error,
    nextAttemptAt: head.next_attempt_at,
    hasRenderer: projectionRendererFor(head.projection_kind, head.projection_key) !== null,
  }));
}

function resolveDiskArtifactPath(basePath: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) return artifactPath;
  const candidates = [
    join(gsdProjectionRoot(basePath), artifactPath),
    join(gsdRoot(basePath), artifactPath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Preserve changed projection bytes without participating in workflow progression. */
export function preserveProjectionChanges(
  basePath: string,
  dryRun = false,
): Promise<ProjectionObservationResult> {
  return preserveProjectionEvidence(basePath, [], dryRun);
}

/**
 * Before dispatch: preserve changed projection bytes, but hold a changed
 * git-tracked projection (team mode) in place. A non-empty `held` means the
 * caller must stop: see describeHeldProjectionChanges.
 */
export function preserveProjectionChangesBeforeDispatch(
  basePath: string,
): Promise<ProjectionObservationResult> {
  return preserveProjectionEvidence(basePath, [], false, true);
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

/** Rebuild all readable projections from database authority, then drain durable work. */
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

  const rendered = await renderAllFromDb(basePath);
  try {
    if (renderKnowledgeProjection(basePath).written) rendered.rendered++;
    else rendered.skipped++;
  } catch (err) {
    rendered.errors.push(`knowledge: ${(err as Error).message}`);
  }
  const drained = await drainProjectionWork(basePath);
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
