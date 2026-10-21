// Project/App: gsd-pi
// File Purpose: ADR-017 stale-sketch-flag drift handler. Relocated from
// gsd-db.ts where autoHealSketchFlags previously lived with zero callers.
//
// Recovers from two scenarios (per ADR-011):
//   1. Crash between gsd_plan_slice's PLAN.md write and the sketch flag flip.
//   2. Flag-OFF downgrade: when progressive_planning is off, dispatch routes
//      sketch slices to plan-slice, which writes PLAN.md but leaves
//      is_sketch=1 — the next reconciliation pass clears it.

import { existsSync, readFileSync } from "node:fs";

import {
  getSketchedSliceIds,
  isDbAvailable,
  setSliceSketchFlag,
} from "../../gsd-db.js";
import { parseProjectionPlan as parsePlan } from "../../schemas/parsers.js";
import { resolveSliceFile } from "../../paths.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type SketchFlagDrift = Extract<DriftRecord, { kind: "stale-sketch-flag" }>;

export function detectStaleSketchFlags(
  state: GSDState,
  ctx: DriftContext,
): SketchFlagDrift[] {
  if (!isDbAvailable()) return [];
  const mid = state.activeMilestone?.id;
  if (!mid) return [];

  const sliceIds = getSketchedSliceIds(mid);
  return sliceIds
    .filter((sid) => sketchIsPlanned(ctx.basePath, mid, sid))
    .map((sid) => ({ kind: "stale-sketch-flag" as const, mid, sid }));
}

/**
 * True when a task title is a synthetic placeholder emitted by a projection
 * round-trip rather than a real, refined task. `migrate/transformer.buildTaskTitle`
 * produces two shapes when a plan was never decomposed:
 *   - `Plan NN`            (fallback when phase/plan frontmatter is absent)
 *   - `${phase} ${plan}`   (e.g. `00 01`, `00 03b`, `29-auth-system 01`)
 * Neither carries genuine planning intent, so both must be treated as stubs.
 */
function isPlaceholderTaskTitle(title: string): boolean {
  const t = title.trim();
  if (/^Plan\s+\d+[a-z]*$/i.test(t)) return true;
  // buildTaskTitle returns `${phase} ${plan}` when frontmatter has both fields.
  // Phase slugs are digit-led (e.g. `00`, `29-auth-system`); require that so
  // legitimate titles like `Step 1` are not misclassified as stubs.
  return /^\d[\w-]*\s+\d+[a-z]*$/i.test(t);
}

/**
 * A sketch slice counts as "planned" (so its is_sketch flag may be cleared)
 * only when it has a *real* plan on disk — not merely any PLAN file.
 *
 * File existence alone (#1287) is too weak: a stub/placeholder PLAN, a
 * crash-leftover, or a projection round-trip that emits synthetic placeholder
 * task titles (migrate/transformer.buildTaskTitle) all satisfy existsSync yet
 * were never actually refined. Clearing the flag for one strips the `refining`
 * guard in phase derivation and lets a phantom task drive dispatch.
 *
 * A legitimate plan-slice always decomposes into >= 1 genuine task, so require
 * at least one non-placeholder task. This is strictly stricter than the old
 * existence check — the documented crash-recovery scenarios (a real plan-slice
 * that wrote its tasks) still clear, a bare stub no longer does.
 *
 * No state-version stamp short-circuit here (unlike the roadmap/stale-render
 * detectors): the stamp (T008) only proves the projection was rendered from
 * the current DB state, and a stub PLAN rendered from current state is still
 * a stub. This is a content judgment about *what the plan says*, not a
 * freshness judgment, so it must always parse the file.
 */
function sketchIsPlanned(basePath: string, mid: string, sid: string): boolean {
  const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (planPath === null || !existsSync(planPath)) return false;
  try {
    const plan = parsePlan(readFileSync(planPath, "utf-8"));
    return plan.tasks.some((t) => !isPlaceholderTaskTitle(t.title));
  } catch {
    // A PLAN we cannot parse is not a trustworthy "planning done" signal.
    return false;
  }
}

export function repairStaleSketchFlag(record: SketchFlagDrift): void {
  setSliceSketchFlag(record.mid, record.sid, false);
}

export const sketchFlagHandler: DriftHandler<SketchFlagDrift> = {
  kind: "stale-sketch-flag",
  detect: detectStaleSketchFlags,
  repair: (record) => {
    repairStaleSketchFlag(record);
  },
};

/**
 * Legacy entry point preserved for callers that supply a custom hasPlanFile
 * predicate. Prefer the drift handler (sketchFlagHandler) for new code.
 */
export function autoHealSketchFlags(
  milestoneId: string,
  hasPlanFile: (sliceId: string) => boolean,
): void {
  if (!isDbAvailable()) return;
  const sliceIds = getSketchedSliceIds(milestoneId);
  for (const sid of sliceIds) {
    if (hasPlanFile(sid)) {
      setSliceSketchFlag(milestoneId, sid, false);
    }
  }
}
