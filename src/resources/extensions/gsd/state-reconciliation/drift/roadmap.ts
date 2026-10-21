// Project/App: gsd-pi
// File Purpose: ADR-017 roadmap-divergence drift handler. Detects mismatches
// between ROADMAP.md (parsed slice sequence, depends declarations, and
// checkboxes) and the DB slice rows for that milestone, then re-renders the
// ROADMAP projection from the authoritative DB rows.

import { existsSync, readFileSync } from "node:fs";

import {
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "../../gsd-db.js";
import { renderRoadmapFromDb } from "../../markdown-renderer.js";
import { findMilestoneIds } from "../../milestone-ids.js";
import { parseProjectionRoadmap as parseRoadmap } from "../../schemas/parsers.js";
import { resolveMilestoneFile } from "../../paths.js";
import {
  isClosedStatus,
  isHiddenFromRoadmap,
  isSkippedForDispatch,
} from "../../status-guards.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type RoadmapDivergenceDrift = Extract<
  DriftRecord,
  { kind: "roadmap-divergence" }
>;

type RoadmapMissingDrift = Extract<DriftRecord, { kind: "roadmap-missing" }>;

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getSlicesReadyForDivergenceCheck(
  milestoneId: string,
  dbSlices: ReturnType<typeof getMilestoneSlices>,
): Set<string> {
  const ready = new Set<string>();
  for (const slice of dbSlices) {
    // #1623: a skipped slice is never rendered into ROADMAP.md, so it can
    // never satisfy the "ready slice must appear in the roadmap" rule. Treating
    // it as ready made the drift unrepairable — re-rendering reproduced the
    // same omission and /gsd auto paused after the reconciliation cap.
    if (isHiddenFromRoadmap(slice.status)) continue;
    if (isClosedStatus(slice.status) || getSliceTasks(milestoneId, slice.id).length > 0) {
      ready.add(slice.id);
    }
  }
  return ready;
}

// A `<!-- gsd:state-version=R:E -->` stamp is deliberately NOT used to skip
// the comparison below. `project_authority.revision` is only advanced by the
// domain-operation CAS; slice status/depends/sequence writes do not bump it,
// so a stale projection can still carry the current stamp. The stamp is also a
// content byte, not a provenance token — a hand-edited file keeps it. Per the
// T008 invariant (markdown-renderer.ts), matching-stamp-but-diverging-content
// IS drift, so every call compares content.
function milestoneHasDivergence(
  basePath: string,
  milestoneId: string,
): boolean {
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath || !existsSync(roadmapPath)) return false;

  let roadmap: ReturnType<typeof parseRoadmap>;
  try {
    roadmap = parseRoadmap(readFileSync(roadmapPath, "utf-8"));
  } catch {
    return false;
  }

  // Mirror renderRoadmapFromDb's filter (#1619): the ROADMAP projection omits
  // skipped slices, so the detector must compare against the same view.
  // Without this, a skipped slice counts as "ready" (skipped ∈
  // RAW_CLOSED_STATUSES) but never appears in the rendered markdown, so the
  // absence/order checks below report a divergence that re-rendering can never
  // repair — reconcileBeforeDispatch then throws on every dispatch.
  const dbSlices = getMilestoneSlices(milestoneId).filter((s) => s.status !== "skipped");
  const dbSliceMap = new Map(dbSlices.map((s) => [s.id, s]));
  // Sequence positions are compared against the *rendered* slice list, which
  // omits skipped slices (#1623) — indexing the raw DB list would report a
  // permanent off-by-N whenever a milestone contains a skipped slice.
  const renderedSlices = dbSlices.filter((s) => !isHiddenFromRoadmap(s.status));
  const dbSliceOrder = new Map(renderedSlices.map((s, index) => [s.id, index]));
  const readySliceIds = getSlicesReadyForDivergenceCheck(milestoneId, dbSlices);
  if (dbSlices.length > 0 && readySliceIds.size === 0) {
    return false;
  }
  const roadmapSliceIds = new Set<string>();

  for (let i = 0; i < roadmap.slices.length; i++) {
    const roadmapSlice = roadmap.slices[i]!;
    roadmapSliceIds.add(roadmapSlice.id);
    const dbSlice = dbSliceMap.get(roadmapSlice.id);
    if (!dbSlice) return true; // Roadmap has a slice the DB doesn't.
    // A stale roadmap row for a now-skipped slice: re-rendering removes it, so
    // flagging this converges rather than looping.
    if (isHiddenFromRoadmap(dbSlice.status)) return true;
    if (!readySliceIds.has(dbSlice.id)) continue;
    if (dbSliceOrder.get(dbSlice.id) !== i) return true;
    if (!arraysEqual(dbSlice.depends, roadmapSlice.depends)) return true;
    if (isClosedStatus(dbSlice.status) !== roadmapSlice.done) return true;
  }
  for (const dbSlice of dbSlices) {
    if (!readySliceIds.has(dbSlice.id)) continue;
    if (!roadmapSliceIds.has(dbSlice.id)) return true;
  }
  return false;
}

export function detectRoadmapDivergenceDrift(
  _state: GSDState,
  ctx: DriftContext,
): RoadmapDivergenceDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: RoadmapDivergenceDrift[] = [];
  for (const milestoneId of findMilestoneIds(ctx.basePath)) {
    // Skip milestones that don't yet have a DB row — that's the
    // unregistered-milestone drift handler's responsibility.
    const milestone = getMilestone(milestoneId);
    if (!milestone) continue;
    if (isSkippedForDispatch(milestone.status)) continue;
    if (milestoneHasDivergence(ctx.basePath, milestoneId)) {
      drifts.push({ kind: "roadmap-divergence", milestoneId });
    }
  }
  return drifts;
}

/**
 * Repair a milestone's roadmap divergence by regenerating the projection from
 * DB rows. ROADMAP.md is a projection; runtime reconciliation must not import
 * slice presence, sequence, dependencies, or checkbox state from markdown.
 */
export async function repairRoadmapDivergence(
  record: RoadmapDivergenceDrift,
  ctx: DriftContext,
): Promise<void> {
  await renderRoadmapFromDb(ctx.basePath, record.milestoneId);
}

export const roadmapDivergenceHandler: DriftHandler<RoadmapDivergenceDrift> = {
  kind: "roadmap-divergence",
  detect: detectRoadmapDivergenceDrift,
  repair: repairRoadmapDivergence,
};

/**
 * #1634: a milestone whose ROADMAP.md is missing entirely produced ZERO drift
 * records — the divergence detector only compares files that exist, and its
 * milestone scan is filesystem-driven, so a plan persisted to the DB whose
 * render then failed (persistMilestonePlan commits rows before rendering)
 * stayed permanently orphaned: doctor reported missing_roadmap, but no
 * reconciliation pass ever re-rendered the projection. This detector walks the
 * DB (the authority) instead of the disk.
 */
/**
 * Shared eligibility predicate: can this milestone's ROADMAP be re-rendered
 * from the DB? Single source for the drift detector AND doctor's missing_roadmap
 * fix (#1634) — a divergent copy is exactly the detector/repairer asymmetry
 * this handler exists to end. Excludes closed milestones (cleanup archives
 * their phase dirs) and parked/deferred ones (skipped for dispatch), and
 * mirrors renderRoadmapFromDb's unplanned-milestone refusal (#852).
 */
export function isRoadmapRenderable(
  milestone: { id: string; status: string; vision: string },
): boolean {
  if (isSkippedForDispatch(milestone.status)) return false;
  if (isClosedStatus(milestone.status)) return false;
  const renderableSlices = getMilestoneSlices(milestone.id).filter(
    (slice) => !isHiddenFromRoadmap(slice.status),
  );
  return renderableSlices.length > 0 || milestone.vision.trim() !== '';
}

export function detectRoadmapMissingDrift(
  _state: GSDState,
  ctx: DriftContext,
): RoadmapMissingDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: RoadmapMissingDrift[] = [];
  for (const milestone of getAllMilestones()) {
    if (!isRoadmapRenderable(milestone)) continue;
    const roadmapPath = resolveMilestoneFile(ctx.basePath, milestone.id, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) {
      drifts.push({ kind: "roadmap-missing", milestoneId: milestone.id });
    }
  }
  return drifts;
}

/**
 * Repair by re-rendering the projection from DB rows. The write target creates
 * the phase dir when it is absent, so this converges even when the original
 * render failed before the milestone dir ever existed.
 */
export async function repairRoadmapMissing(
  record: RoadmapMissingDrift,
  ctx: DriftContext,
): Promise<void> {
  await renderRoadmapFromDb(ctx.basePath, record.milestoneId);
}

export const roadmapMissingHandler: DriftHandler<RoadmapMissingDrift> = {
  kind: "roadmap-missing",
  detect: detectRoadmapMissingDrift,
  repair: repairRoadmapMissing,
};
