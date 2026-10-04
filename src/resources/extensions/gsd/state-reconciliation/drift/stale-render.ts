// Project/App: gsd-pi
// File Purpose: Stale-render projection drift: a projection file is missing or
// differs from the database render. Detected and repaired by the Projection
// Worker only (ADR-046). It is not part of pre-dispatch reconciliation, so a
// file fault cannot block database-backed work.

import { join } from "node:path";

import {
  detectStaleRenders,
  renderAllFromDb,
  renderPlanCheckboxes,
  renderRoadmapFromDb,
  renderSliceSummary,
  renderTaskSummary,
  type RenderAllResult,
} from "../../markdown-renderer.js";
import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
} from "../../gsd-db.js";
import {
  ensureWorkflowDbForBase,
} from "../../db-workspace.js";
import { logWarning } from "../../workflow-logger.js";
import type { DriftRecord } from "../types.js";

export type StaleRenderDrift = Extract<DriftRecord, { kind: "stale-render" }>;

// No state-version stamp short-circuit here: `project_authority.revision` is
// not bumped by the projection-affecting writes, and the stamp is a content
// byte a hand-edited file keeps, so a matching stamp is not evidence of
// freshness. Every entry the detector emits is kept.
export function detectStaleRenderDrift(basePath: string): StaleRenderDrift[] {
  const entries = detectStaleRenders(basePath);
  if (entries.length === 0) return [];

  // detectStaleRenders may emit multiple entries for the same path (one per
  // mismatched checkbox). Dedupe by path; the repair re-renders the whole
  // file in a single call. Prefer a reason the repair dispatcher can handle.
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const currentReason = seen.get(entry.path);
    if (
      currentReason === undefined ||
      (!isRepairableStaleRenderReason(currentReason) && isRepairableStaleRenderReason(entry.reason))
    ) {
      seen.set(entry.path, entry.reason);
    }
  }

  return Array.from(seen.entries()).map(([renderPath, reason]) => ({
    kind: "stale-render" as const,
    renderPath,
    reason,
  }));
}

function isRepairableStaleRenderReason(reason: string): boolean {
  return (
    reason.includes("in roadmap") ||
    reason.includes("in plan") ||
    (reason.includes("SUMMARY.md missing") && /^T\d+/.test(reason)) ||
    (reason.includes("SUMMARY.md missing") && /^S\d+/.test(reason)) ||
    reason.includes("UAT.md missing")
  );
}

function canonicalizeMilestoneId(dirSegment: string): string {
  if (getMilestone(dirSegment)) return dirSegment;
  const suffixId = dirSegment.match(/^(M\d+-[a-z0-9]{6})(?:$|-)/)?.[1];
  if (suffixId && getMilestone(suffixId)) return suffixId;

  // Descriptor layout: e.g. M001-DESCRIPTOR → M001
  const baseId = dirSegment.match(/^(M\d+)(?:$|-)/i)?.[1];
  if (baseId && getMilestone(baseId)) return baseId;

  // Flat-phase: e.g. 01-test → M001, 04-abc123-fourth → M004-abc123
  const phaseMatch = dirSegment.match(/^(\d+)-(?:([a-z0-9]{6})-)?/);
  if (phaseMatch) {
    const flatId = `M${String(parseInt(phaseMatch[1]!, 10)).padStart(3, "0")}`;
    if (phaseMatch[2] && getMilestone(`${flatId}-${phaseMatch[2]}`)) return `${flatId}-${phaseMatch[2]}`;
    if (getMilestone(flatId)) return flatId;
  }

  return suffixId ?? baseId ?? dirSegment;
}

function resolveRoadmapMilestoneIdFromPath(normPath: string): string {
  // Flat-phase: phases/NN-slug/NN-ROADMAP.md
  // Legacy: milestones/MID/MID-ROADMAP.md
  const milestoneMatch = normPath.match(/phases\/([^/]+)\//)
    || normPath.match(/milestones\/([^/]+)\//);
  if (!milestoneMatch) {
    throw new Error(
      `stale-render drift: roadmap path missing milestone segment: ${normPath}`,
    );
  }

  const fileMatch = normPath.match(/(?:^|\/)([^/]+)-ROADMAP\.md$/i);
  // For flat-phase, derive milestone id from phase number prefix
  const phaseNumMatch = milestoneMatch[1]!.match(/^(\d+)-/);
  const phaseDerivedId = phaseNumMatch ? `M${String(parseInt(phaseNumMatch[1]!, 10)).padStart(3, "0")}` : null;
  const candidates = [
    fileMatch?.[1],
    milestoneMatch[1],
    phaseDerivedId,
    fileMatch?.[1]?.match(/^(M\d+)/i)?.[1],
    milestoneMatch[1]!.match(/^(M\d+)/i)?.[1],
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    if (getMilestone(candidate)) return candidate;
  }

  return fileMatch?.[1] ?? milestoneMatch[1];
}

function ensureDbForStaleRenderRepair(basePath: string): boolean {
  return ensureWorkflowDbForBase(basePath);
}

function retryDbForStaleRenderRepair(basePath: string): boolean {
  return ensureWorkflowDbForBase(basePath, { refresh: true });
}

export async function repairStaleRender(
  record: StaleRenderDrift,
  basePath: string,
  renderAll: (basePath: string) => Promise<RenderAllResult> = renderAllFromDb,
): Promise<void> {
  if (!ensureDbForStaleRenderRepair(basePath)) {
    throw new Error(`stale-render drift: database unavailable for repair (${basePath})`);
  }

  const normPath = record.renderPath.replace(/\\/g, "/");
  const reason = record.reason;

  if (reason.includes("in roadmap")) {
    await renderRoadmapFromDb(
      basePath,
      resolveRoadmapMilestoneIdFromPath(normPath),
    );
    return;
  }

  if (reason.includes("in plan")) {
    // Flat-phase: phases/NN-slug/NN-MM-PLAN.md
    // Legacy: milestones/X/slices/Y/PLAN.md
    const pathMatch = normPath.match(/phases\/([^/]+)\/(\d+)-(\d+)-PLAN/)
      || normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
    if (!pathMatch) {
      throw new Error(
        `stale-render drift: plan path missing milestone/slice segments: ${record.renderPath}`,
      );
    }
    const milestoneId = canonicalizeMilestoneId(pathMatch[1]!);
    const sliceId = pathMatch[2] && pathMatch[3] && /^\d+$/.test(pathMatch[2])
      ? `S${String(parseInt(pathMatch[3]!, 10)).padStart(2, "0")}`
      : pathMatch[2]!;
    let wrote = false;
    try {
      wrote = await renderPlanCheckboxes(
        basePath,
        milestoneId,
        sliceId,
        record.renderPath,
      );
    } catch (err) {
      if (!retryDbForStaleRenderRepair(basePath)) throw err;
      wrote = await renderPlanCheckboxes(
        basePath,
        milestoneId,
        sliceId,
        record.renderPath,
      );
    }
    if (!wrote && retryDbForStaleRenderRepair(basePath)) {
      wrote = await renderPlanCheckboxes(
        basePath,
        milestoneId,
        sliceId,
        record.renderPath,
      );
    }
    if (!wrote) {
      throw new Error(
        `stale-render drift: plan re-render wrote nothing for ${milestoneId}/${pathMatch[2]} ` +
          `(${record.renderPath}); slice has no tasks or its path is unresolvable`,
      );
    }
    return;
  }

  if (reason.includes("SUMMARY.md missing") && /^T\d+/.test(reason)) {
    // Flat-phase: phases/NN-slug/ (no tasks/ subdir, task summaries in phase dir)
    // Legacy: milestones/X/slices/Y/tasks/
    const pathMatch = normPath.match(/phases\/([^/]+)\//)
      || normPath.match(
        /milestones\/([^/]+)\/slices\/([^/]+)\/tasks\//,
      );
    const taskMatch = reason.match(/^(T\d+)/);
    if (!pathMatch || !taskMatch) {
      throw new Error(
        `stale-render drift: task summary path/reason malformed: ${record.renderPath} reason=${reason}`,
      );
    }
    const milestoneId = canonicalizeMilestoneId(pathMatch[1]!);
    // In flat-phase there's no slice segment in the path; find the task's slice from DB.
    let sliceId: string;
    if (pathMatch[2]) {
      sliceId = pathMatch[2];
    } else {
      // Flat-phase: scan milestone's slices for the task
      let foundSliceId: string | undefined;
      for (const s of getMilestoneSlices(milestoneId)) {
        if (getSliceTasks(milestoneId, s.id).some(t => t.id === taskMatch[1])) {
          foundSliceId = s.id;
          break;
        }
      }
      if (!foundSliceId) {
        throw new Error(
          `stale-render drift: task ${taskMatch[1]} not found in any slice of ${milestoneId} (${record.renderPath})`,
        );
      }
      sliceId = foundSliceId;
    }
    const wrote = await renderTaskSummary(basePath, milestoneId, sliceId, taskMatch[1]!);
    if (!wrote) {
      throw new Error(
        `stale-render drift: task summary re-render wrote nothing for ` +
          `${milestoneId}/${sliceId}/${taskMatch[1]} (${record.renderPath}); ` +
          `task has no summary in DB or its slice path is unresolvable`,
      );
    }
    return;
  }

  if (reason.includes("SUMMARY.md missing") && /^S\d+/.test(reason)) {
    // Flat-phase: phases/NN-slug/NN-MM-SUMMARY.md or phases/NN-slug/NN-SUMMARY.md
    // Legacy: milestones/X/slices/Y/SUMMARY.md
    const pathMatch = normPath.match(/phases\/([^/]+)\/(\d+)-(\d+)-SUMMARY/)
      || normPath.match(/phases\/([^/]+)\/(\d+)-SUMMARY/)
      || normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
    if (!pathMatch) {
      throw new Error(
        `stale-render drift: slice summary path missing milestone/slice segments: ${record.renderPath}`,
      );
    }
    // Flat-phase: groups are (phaseDir, phaseNum, planNum) for NN-MM-SUMMARY,
    // or (phaseDir, phaseNum) for NN-SUMMARY (phase-level). In the latter case,
    // derive slice from the reason text which starts with S\d+.
    // Legacy: groups are (milestoneDir, sliceDir).
    let milestoneId: string;
    let sliceId: string;
    milestoneId = canonicalizeMilestoneId(pathMatch[1]!);
    if (pathMatch[3] && /^\d+$/.test(pathMatch[2]!)) {
      // NN-MM-SUMMARY: pathMatch[3] is the plan number
      sliceId = `S${String(parseInt(pathMatch[3]!, 10)).padStart(2, "0")}`;
    } else if (pathMatch[2] && /^S\d+/.test(pathMatch[2])) {
      // Legacy: pathMatch[2] is the slice dir name
      sliceId = pathMatch[2];
    } else {
      // NN-SUMMARY (phase-level): derive slice from reason
      const reasonSlice = reason.match(/^(S\d+)/);
      sliceId = reasonSlice ? reasonSlice[1] : "S01";
    }
    const wrote = await renderSliceSummary(basePath, milestoneId, sliceId);
    if (!wrote) {
      throw new Error(
        `stale-render drift: slice summary re-render wrote nothing for ` +
          `${milestoneId}/${sliceId} (${record.renderPath}); slice has no summary/UAT ` +
          `in DB or its path is unresolvable`,
      );
    }
    return;
  }

  if (reason.includes("UAT.md missing")) {
    // Flat-phase: phases/NN-slug/NN-MM-UAT.md or phases/NN-slug/NN-UAT.md
    // Legacy: milestones/X/slices/Y/UAT.md
    const pathMatch = normPath.match(/phases\/([^/]+)\/(\d+)-(\d+)-UAT/)
      || normPath.match(/phases\/([^/]+)\/(\d+)-UAT/)
      || normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
    if (!pathMatch) {
      throw new Error(
        `stale-render drift: UAT path missing milestone/slice segments: ${record.renderPath}`,
      );
    }
    const milestoneId = canonicalizeMilestoneId(pathMatch[1]!);
    let sliceId: string;
    if (pathMatch[3] && /^\d+$/.test(pathMatch[2]!)) {
      sliceId = `S${String(parseInt(pathMatch[3]!, 10)).padStart(2, "0")}`;
    } else if (pathMatch[2] && /^S\d+/.test(pathMatch[2])) {
      sliceId = pathMatch[2];
    } else {
      const reasonSlice = reason.match(/(S\d+)/);
      sliceId = reasonSlice ? reasonSlice[1] : "S01";
    }
    // A missing UAT.md is projection drift. The DB row is the authority, so
    // the repair renders the file again and never writes to the slice row.
    const wrote = await renderSliceSummary(basePath, milestoneId, sliceId);
    if (!wrote) {
      throw new Error(
        `stale-render drift: UAT re-render wrote nothing for ` +
          `${milestoneId}/${sliceId} (${record.renderPath}); slice has no summary/UAT ` +
          `in DB or its path is unresolvable`,
      );
    }
    return;
  }

  // Any other file that differs from the database (for example a milestone or
  // slice artifact) has no narrower renderer: render every projection again.
  const rendered = await renderAll(basePath);
  if (rendered.errors.length > 0) throw new Error(rendered.errors.join("; "));
}

// ─── Legacy entry point ──────────────────────────────────────────────────────

/**
 * Legacy bulk entry preserved for existing tests
 * (tests/markdown-renderer.test.ts, tests/integration/integration-proof.test.ts).
 * Production code runs the repair through the Projection Worker. Matches the
 * pre-ADR-017 behavior: silent per-entry error handling, returns the count of
 * successful repairs.
 */
export async function repairStaleRenders(basePath: string): Promise<number> {
  const drifts = detectStaleRenderDrift(basePath);
  if (drifts.length === 0) return 0;

  let repaired = 0;
  for (const drift of drifts) {
    try {
      await repairStaleRender(drift, basePath);
      repaired++;
    } catch (err) {
      logWarning(
        "renderer",
        `repair failed for ${drift.renderPath}: ${(err as Error).message}`,
      );
    }
  }

  if (repaired > 0) {
    process.stderr.write(
      `markdown-renderer: repaired ${repaired} stale render(s)\n`,
    );
  }

  return repaired;
}
