// Project/App: gsd-pi
// File Purpose: Auto-loop closeout, milestone report, and merge helpers.

import { importExtensionModule, type ExtensionAPI, type ExtensionContext } from "@gsd/pi-coding-agent";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { existsSync, cpSync, readFileSync } from "node:fs";
import type { AutoSession } from "./session.js";
import type { LoopDeps } from "./loop-deps.js";
import type { GSDState } from "../types.js";
import type { IterationContext } from "./types.js";
import type { PostflightResult, PreflightResult } from "../clean-root-preflight.js";
import { MergeConflictError } from "../git-service.js";
import { findUnmergedCompletedMilestones } from "../unmerged-milestone-guard.js";
import { getIsolationMode } from "../preferences.js";
import { isDbAvailable, getMilestone } from "../gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "../db-workspace.js";
import { isClosedStatus } from "../status-guards.js";
import { gsdRoot, PLANNING_ARTIFACT_SUFFIXES } from "../paths.js";
import { atomicWriteSync } from "../atomic-write.js";
import { logWarning, logError } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { _resolveReportBasePath } from "./phase-helpers.js";

/**
 * If a unit is in-flight, close it out, then stop auto-mode.
 */
export async function closeoutAndStop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
  reason: string,
): Promise<void> {
  if (s.currentUnit) {
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      s.currentUnit.type,
      s.currentUnit.id,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
    );
    s.clearCurrentUnit();
  }
  await deps.stopAuto(ctx, pi, reason);
}

export async function stopOnPostflightRecoveryNeeded(
  ic: IterationContext,
  result: PostflightResult,
  milestoneId: string,
): Promise<{ action: "break"; reason: string } | null> {
  if (!result.needsManualRecovery) return null;
  const { ctx, pi, deps } = ic;
  const reason = `Post-merge stash restore failed for milestone ${milestoneId}`;
  ctx.ui.notify(
    `${reason}. Resolve the working tree before resuming auto-mode. ${result.message}`,
    "error",
  );
  await deps.stopAuto(ctx, pi, reason);
  return { action: "break", reason: "postflight-stash-restore-failed" };
}

export async function restorePreflightStashOrStop(
  ic: IterationContext,
  preflight: PreflightResult,
  milestoneId: string,
): Promise<{ action: "break"; reason: string } | null> {
  if (!preflight.stashPushed) return null;
  const { s, deps } = ic;
  const result = deps.postflightPopStash(
    s.originalBasePath || s.basePath,
    milestoneId,
    preflight.stashMarker,
    ic.ctx.ui.notify.bind(ic.ctx.ui),
  );
  return stopOnPostflightRecoveryNeeded(ic, result, milestoneId);
}

/**
 * Run a milestone merge through Worktree Lifecycle's guarded merge option,
 * which surrounds the inner merge with preflight stash + always-on postflight
 * pop. The previous closeout code popped the stash only after a successful
 * merge, which leaked `gsd-preflight-stash:M00x:*` entries whenever
 * `mergeAndExit` threw — leaving the user's pre-merge working tree silently
 * stashed away after a merge-conflict or other merge error. Lifecycle now
 * restores the stash on every attempted merge path, then this adapter surfaces
 * the merge or stash failure (in priority order) as the loop's stop reason.
 *
 * Returns a `break` action when auto-mode must stop, or `null` when the merge
 * succeeded and the stash (if any) was restored cleanly.
 */
export async function _runMilestoneMergeWithStashRestore(
  ic: IterationContext,
  milestoneId: string,
  options: { preserveCloseoutTranscript?: boolean } = {},
): Promise<{ action: "break"; reason: string } | null> {
  const { ctx, pi, s, deps } = ic;

  // Resolve the project root once, before the merge can flip session path
  // pointers (worktree teardown mutates s.basePath / s.scope). The guarded
  // merge's preflight/postflight stash restore, the pre-merge ignored-markdown
  // snapshot, the dirty-projection check, and the rebuild must all target this
  // same tree; otherwise `.gsd` markdown restored on one tree can be silently
  // overwritten by a rebuild on another. canonicalProjectRoot is the
  // authoritative `.gsd`/DB writer path (see AutoSession.canonicalProjectRoot).
  const projectRoot = s.originalBasePath || s.canonicalProjectRoot || s.basePath;
  const ignoredProjectionSnapshot = snapshotIgnoredGsdMarkdownProjections(projectRoot);
  const mergeResult = deps.lifecycle.exitMilestone(
    milestoneId,
    {
      merge: true,
      guardedMerge: {
        projectRoot,
        preflightCleanRoot: deps.preflightCleanRoot,
        postflightPopStash: deps.postflightPopStash,
      },
    },
    ctx.ui,
  );

  if (mergeResult.ok) {
    await markMilestoneMergedAndRebuild(s, projectRoot, ignoredProjectionSnapshot);
    return null;
  }

  if (mergeResult.reason === "postflight-stash-restore-failed") {
    await markMilestoneMergedAndRebuild(s, projectRoot, ignoredProjectionSnapshot);
  }

  if (mergeResult.reason === "preflight-dirty-overlap" || mergeResult.reason === "preflight-unmerged-conflicts") {
    const reason = mergeResult.reason === "preflight-unmerged-conflicts"
      ? `Pre-merge unresolved Git conflicts block milestone ${milestoneId}`
      : `Pre-merge dirty working tree overlaps milestone ${milestoneId}`;
    await deps.stopAuto(ctx, pi, reason, {
      preserveCompletedMilestoneBranch: true,
      preserveCloseoutTranscript: options.preserveCloseoutTranscript,
    });
    return { action: "break", reason: mergeResult.reason };
  }

  // Merge failure takes priority over stash recovery — the merge is the
  // authoritative gate. If the stash also needed manual recovery, the user
  // already saw the postflightPopStash notify above.
  if (mergeResult.reason === "merge-conflict") {
    const mergeError = mergeResult.cause;
    if (mergeError instanceof MergeConflictError) {
      // A merge conflict is a recoverable human checkpoint, not an
      // infrastructure failure — the user resolves the conflict and runs
      // `/gsd auto` to resume. Pause (don't stop): stopAuto tears down the
      // session and, because `milestoneMergedInPhases` stays false here,
      // re-runs the already-failed worktree merge in its cleanup step
      // (#2645), then drops the user out of the interactive TUI onto a
      // "stopped" surface.
      const conflictReason = `Merge conflict on milestone ${milestoneId}: ${mergeError.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`;
      ctx.ui.notify(conflictReason, "error");
      await deps.pauseAuto(ctx, pi, {
        message: conflictReason,
        category: "unknown",
      });
      return { action: "break", reason: "merge-conflict" };
    }
  }

  if (mergeResult.reason === "merge-failed" || mergeResult.reason === "merge-conflict") {
    const mergeError = mergeResult.cause;
    logError("engine", "Milestone merge failed with non-conflict error", {
      milestone: milestoneId,
      error: String(mergeError),
    });
    // Like a merge conflict, a non-conflict merge failure (index lock,
    // network, permissions) is recoverable — the user fixes the cause and
    // runs `/gsd auto` to resume. Pause (don't stop) so the session stays
    // resumable and stopAuto's teardown does not re-run the failed merge.
    const mergeFailReason = `Merge error on milestone ${milestoneId}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}. Resolve and run /gsd auto to resume.`;
    ctx.ui.notify(mergeFailReason, "error");
    await deps.pauseAuto(ctx, pi, {
      message: mergeFailReason,
      category: "unknown",
    });
    return { action: "break", reason: "merge-failed" };
  }

  if (mergeResult.postflight) {
    return stopOnPostflightRecoveryNeeded(ic, mergeResult.postflight, milestoneId);
  }
  return null;
}

type GsdMarkdownSnapshot = Map<string, string>;

async function markMilestoneMergedAndRebuild(
  s: AutoSession,
  rebuildBasePath: string,
  ignoredProjectionSnapshot: GsdMarkdownSnapshot | null,
): Promise<void> {
  s.milestoneMergedInPhases = true;
  if (hasDirtyGsdMarkdownProjections(rebuildBasePath, ignoredProjectionSnapshot)) {
    logWarning(
      "engine",
      "skipping markdown projection rebuild after milestone merge because restored .gsd edits are dirty",
    );
    return;
  }

  try {
    const { rebuildMarkdownProjectionsFromDb } = await import("../commands-maintenance.js");
    await rebuildMarkdownProjectionsFromDb(rebuildBasePath);
  } catch (err) {
    logWarning(
      "engine",
      `markdown projection rebuild after milestone merge failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function hasDirtyGsdMarkdownProjections(
  basePath: string,
  ignoredProjectionSnapshot: GsdMarkdownSnapshot | null,
): boolean {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".gsd"],
      { cwd: basePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const entries = output.split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length <= 3) continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (isGeneratedGsdMarkdownProjection(path)) return true;
      if ((status === "R " || status === "C ") && i + 1 < entries.length) {
        const dest = entries[++i];
        if (isGeneratedGsdMarkdownProjection(dest)) return true;
      }
    }
  } catch (err) {
    void err;
    // Fall through to ignored-file snapshot comparison below.
  }
  return ignoredGsdMarkdownProjectionSnapshotChanged(basePath, ignoredProjectionSnapshot);
}

function isGeneratedGsdMarkdownProjection(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === ".gsd/DECISIONS.md") return true;
  if (!normalized.startsWith(".gsd/milestones/") && !normalized.startsWith(".gsd/phases/")) {
    return false;
  }
  return isGeneratedPlanningArtifactFileName(basename(normalized));
}

function isGeneratedPlanningArtifactFileName(fileName: string): boolean {
  if (!fileName.endsWith(".md")) return false;
  const stem = fileName.slice(0, -".md".length).toUpperCase();
  for (const suffix of PLANNING_ARTIFACT_SUFFIXES) {
    if (!stem.endsWith(`-${suffix}`)) continue;
    const idPrefix = stem.slice(0, -suffix.length - 1);
    return /^(?:[MST]\d+|\d{2,})(?:-[A-Z0-9]+)*$/.test(idPrefix);
  }
  return false;
}

function snapshotIgnoredGsdMarkdownProjections(basePath: string): GsdMarkdownSnapshot | null {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".gsd"],
      { cwd: basePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const snapshot: GsdMarkdownSnapshot = new Map();
    for (const path of output.split("\0")) {
      if (!isGeneratedGsdMarkdownProjection(path)) continue;
      snapshot.set(path, hashFile(join(basePath, path)));
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ignoredGsdMarkdownProjectionSnapshotChanged(
  basePath: string,
  before: GsdMarkdownSnapshot | null,
): boolean {
  if (!before) return true;
  const after = snapshotIgnoredGsdMarkdownProjections(basePath);
  if (!after || after.size !== before.size) return true;
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) return true;
  }
  return false;
}

export async function _runMilestoneMergeOnceWithStashRestore(
  ic: IterationContext,
  milestoneId: string,
  options: { preserveCloseoutTranscript?: boolean } = {},
): Promise<{ action: "break"; reason: string } | null> {
  if (ic.s.milestoneMergedInPhases) {
    debugLog("autoLoop", {
      phase: "milestone-merge-skip",
      reason: "already-merged-in-phases",
      milestoneId,
    });
    return null;
  }
  return _runMilestoneMergeWithStashRestore(ic, milestoneId, options);
}

export async function shouldSkipTerminalMilestoneCloseout(
  s: AutoSession,
  state: Pick<GSDState, "phase" | "lastCompletedMilestone" | "activeMilestone">,
  mid?: string | null,
): Promise<{ skip: boolean; milestoneId?: string }> {
  const closeoutMilestoneId = mid ?? s.currentMilestoneId ?? state.lastCompletedMilestone?.id;
  if (s.completionStopInProgress) {
    return { skip: true, milestoneId: closeoutMilestoneId };
  }
  if (!closeoutMilestoneId) {
    return { skip: false };
  }
  if (isDbAvailable()) refreshWorkflowDatabaseFromDisk();
  const closeoutBasePath = s.originalBasePath || s.canonicalProjectRoot || s.basePath;
  let closeoutMergePending = false;
  if (getIsolationMode(closeoutBasePath) !== "none") {
    try {
      const blockers = await findUnmergedCompletedMilestones(closeoutBasePath);
      closeoutMergePending = blockers.some((blocker) => blocker.milestoneId === closeoutMilestoneId);
    } catch {
      // Fail open: without git/DB inspection we cannot safely treat closeout as done.
      closeoutMergePending = true;
    }
  }
  const milestoneAlreadyClosedOut = isDbAvailable()
    && isClosedStatus(getMilestone(closeoutMilestoneId)?.status ?? "")
    && !closeoutMergePending;
  if (milestoneAlreadyClosedOut) {
    return { skip: true, milestoneId: closeoutMilestoneId };
  }
  return { skip: false, milestoneId: closeoutMilestoneId };
}

/**
 * Generate and write an HTML milestone report snapshot.
 */
export async function generateMilestoneReport(
  s: AutoSession,
  ctx: ExtensionContext,
  milestoneId: string,
): Promise<void> {
  const { loadVisualizerData } = await importExtensionModule<typeof import("../visualizer-data.js")>(import.meta.url, "../visualizer-data.js");
  const { generateHtmlReport } = await importExtensionModule<typeof import("../export-html.js")>(import.meta.url, "../export-html.js");
  const { writeReportSnapshot } = await importExtensionModule<typeof import("../reports.js")>(import.meta.url, "../reports.js");
  const { basename } = await import("node:path");

  const reportBasePath = _resolveReportBasePath(s);

  const snapData = await loadVisualizerData(reportBasePath);
  const completedMs = snapData.milestones.find(
    (m: { id: string }) => m.id === milestoneId,
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
  const projName = basename(reportBasePath);
  const doneSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: { done: boolean }[] }) =>
      acc + m.slices.filter((sl: { done: boolean }) => sl.done).length,
    0,
  );
  const totalSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: unknown[] }) => acc + m.slices.length,
    0,
  );
  const outPath = writeReportSnapshot({
    basePath: reportBasePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: reportBasePath,
      gsdVersion,
      milestoneId,
      indexRelPath: "index.html",
    }),
    milestoneId,
    milestoneTitle: msTitle,
    kind: "milestone",
    projectName: projName,
    projectPath: reportBasePath,
    gsdVersion,
    totalCost: snapData.totals?.cost ?? 0,
    totalTokens: snapData.totals?.tokens.total ?? 0,
    totalDuration: snapData.totals?.duration ?? 0,
    doneSlices,
    totalSlices,
    doneMilestones: snapData.milestones.filter(
      (m: { status: string }) => m.status === "complete",
    ).length,
    totalMilestones: snapData.milestones.length,
    phase: snapData.phase,
  });
  ctx.ui.notify(
    `Report saved: .gsd/reports/${basename(outPath)} — open index.html to browse progression.`,
    "info",
  );
}
