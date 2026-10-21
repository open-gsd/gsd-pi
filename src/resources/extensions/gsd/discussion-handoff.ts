// Project/App: gsd-pi
// File Purpose: Owns the guided-discuss to auto-mode handoff.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { startAutoDetached } from "./auto.js";
import { extractDepthVerificationMilestoneId, getPendingGate } from "./bootstrap/write-gate.js";
import { getMilestone, insertMilestone, insertArtifact, isDbAvailable } from "./gsd-db.js";
import { getMilestoneScopedArtifacts } from "./db/queries.js";
import {
  assessMilestoneHandoffReadiness,
  formatAcceptedDiscussHandoffMessage,
} from "./milestone-readiness.js";
import { clearParseCache } from "./files.js";
import { clearPathCache, gsdRoot, resolveGsdRootFile, resolveMilestoneFile, relMilestoneFile } from "./paths.js";
import { _getPendingAutoStart, deletePendingAutoStart, type PendingAutoStartEntry } from "./pending-auto-start.js";
import { logWarning } from "./workflow-logger.js";
import { readManifest } from "./workflow-manifest.js";
import { removeProjectionFileSync } from "./atomic-write.js";
import { invalidateStateCache } from "./state.js";

type AutoStartOptions = Parameters<typeof startAutoDetached>[4];
type AutoStartLauncher = typeof startAutoDetached;

// Cap failed in-flight DB row repair attempts before escalating to the user.
const MAX_DB_ROW_RECOVERIES = 3;
const PROJECT_DEPTH_GATE_IDS = new Set([
  "depth_verification_project_confirm",
  "depth_verification_requirements_confirm",
  "depth_verification_research_decision_confirm",
]);

export function scheduleAutoStartAfterIdle(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  verboseMode: boolean,
  options?: AutoStartOptions,
  launch: AutoStartLauncher = startAutoDetached,
): void {
  const waitForIdle =
    typeof (ctx as { waitForIdle?: unknown }).waitForIdle === "function"
      ? ctx.waitForIdle.bind(ctx)
      : async () => {};
  void waitForIdle()
    .then(() => {
      setTimeout(() => launch(ctx, pi, basePath, verboseMode, options), 0);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Auto-start failed while waiting for the prior turn to settle: ${message}`, "error");
      logWarning("guided", `auto-start idle wait failed: ${message}`);
    });
}

function manifestContainsMilestone(basePath: string, milestoneId: string): boolean {
  try {
    const manifest = readManifest(basePath);
    return (
      Array.isArray(manifest?.milestones) &&
      manifest.milestones.some(m => m.id === milestoneId)
    );
  } catch (e) {
    logWarning("guided", `R3b: failed to read state manifest: ${(e as Error).message}`);
    return false;
  }
}

function notifyDbRowRecoveryFailed(entry: PendingAutoStartEntry): void {
  entry.ctx.ui.notify(
    `Milestone ${entry.milestoneId}: DB row recovery failed ${entry.r3bRecoveryCount} times. ` +
    `Re-run /gsd to reset the recovery counter, or run /gsd-debug to diagnose without resetting.`,
    "error",
  );
}

function noteDbRowRecoveryMiss(entry: PendingAutoStartEntry): void {
  entry.r3bRecoveryCount += 1;
  if (entry.r3bRecoveryCount >= MAX_DB_ROW_RECOVERIES) {
    notifyDbRowRecoveryFailed(entry);
  }
}

function ensureMilestoneRowForAcceptedHandoff(
  entry: PendingAutoStartEntry,
  contextFile: string | null,
): boolean {
  if (!isDbAvailable()) {
    logWarning(
      "guided",
      `R3b: milestone ${entry.milestoneId} DB-row recovery skipped because DB is unavailable`,
    );
    return false;
  }

  const { basePath, milestoneId } = entry;
  const milestoneRow = getMilestone(milestoneId);
  if (milestoneRow) return true;

  if (manifestContainsMilestone(basePath, milestoneId)) {
    logWarning(
      "guided",
      `R3b: getMilestone(${milestoneId}) returned null but manifest has the row — treating as stale read`,
    );
    return true;
  }

  if (!contextFile) {
    entry.ctx.ui.notify(
      `Milestone ${milestoneId}: discuss artifacts on disk but no DB row exists. ` +
      `PROJECT.md may have failed to register milestones. ` +
      `Re-save PROJECT.md with canonical "- [ ] M001: Title — One-liner" lines, ` +
      `then re-run /gsd to recover.`,
      "error",
    );
    return false;
  }

  if (entry.r3bRecoveryCount >= MAX_DB_ROW_RECOVERIES) {
    logWarning(
      "guided",
      `R3b: milestone ${milestoneId} DB-row recovery limit reached ` +
      `(${entry.r3bRecoveryCount}/${MAX_DB_ROW_RECOVERIES}); user already notified`,
    );
    return false;
  }

  logWarning(
    "guided",
    `R3b: ${milestoneId} has CONTEXT.md but no DB row — inserting placeholder "queued" row ` +
    `(attempt ${entry.r3bRecoveryCount + 1}/${MAX_DB_ROW_RECOVERIES})`,
  );

  let inserted = false;
  try {
    inserted = insertMilestone({ id: milestoneId, title: milestoneId, status: "queued" });
  } catch (e) {
    logWarning("guided", `R3b: insertMilestone failed: ${(e as Error).message}`);
  }

  if (inserted) return true;
  if (getMilestone(milestoneId)) return true;

  noteDbRowRecoveryMiss(entry);
  return false;
}

/**
 * Extract milestone IDs from PROJECT.md milestone sequence table.
 * Looks for rows like "| M001 | Name | Status |" and extracts the ID column.
 */
function parseMilestoneSequenceFromProject(content: string): string[] {
  const ids: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\|\s*(M\d{3}[A-Z0-9-]*)\s*\|/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function hasBlockingDepthGate(entry: PendingAutoStartEntry): boolean {
  const basePathForGate = entry.scope.workspace.projectRoot;
  const pendingGateId = getPendingGate(basePathForGate);
  if (!pendingGateId) return false;

  const pendingMilestoneId = extractDepthVerificationMilestoneId(pendingGateId);
  return pendingMilestoneId === entry.milestoneId || PROJECT_DEPTH_GATE_IDS.has(pendingGateId);
}

function discussionManifestPath(entry: PendingAutoStartEntry): string {
  return join(entry.scope.workspace.contract.projectGsd, "DISCUSSION-MANIFEST.json");
}

function warnForMissingProjectMilestones(entry: PendingAutoStartEntry): string[] {
  const { ctx, basePath } = entry;
  const projectFile = resolveGsdRootFile(basePath, "PROJECT");
  if (!projectFile) return [];

  try {
    const projectContent = readFileSync(projectFile, "utf-8");
    const projectIds = parseMilestoneSequenceFromProject(projectContent);
    if (projectIds.length <= 1) return projectIds;

    const missing = projectIds.filter(id => {
      const hasContext = !!resolveMilestoneFile(basePath, id, "CONTEXT");
      const hasDraft = !!resolveMilestoneFile(basePath, id, "CONTEXT-DRAFT");
      const hasDir = existsSync(join(gsdRoot(basePath), "milestones", id));
      return !hasContext && !hasDraft && !hasDir;
    });
    if (missing.length > 0) {
      ctx.ui.notify(
        `Multi-milestone validation: ${missing.join(", ")} not found in filesystem. ` +
        `Discussion may not have completed all readiness gates.`,
        "warning",
      );
    }
    return projectIds;
  } catch (e) {
    logWarning("guided", `PROJECT.md parsing failed: ${(e as Error).message}`);
    return [];
  }
}

function discussionManifestIsComplete(entry: PendingAutoStartEntry, projectIds: string[]): boolean {
  const manifestPath = discussionManifestPath(entry);
  if (!existsSync(manifestPath)) return true;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const total = typeof manifest.total === "number" ? manifest.total : 0;
    const completed = typeof manifest.gates_completed === "number" ? manifest.gates_completed : 0;

    if (total > 1 && completed < total) {
      return false;
    }

    if (projectIds.length > 0) {
      const manifestIds = Object.keys(manifest.milestones ?? {});
      const untracked = projectIds.filter(id => !manifestIds.includes(id));
      if (untracked.length > 0) {
        entry.ctx.ui.notify(
          `Discussion manifest missing gates for: ${untracked.join(", ")}`,
          "warning",
        );
      }
    }
  } catch (e) {
    logWarning("guided", `discussion manifest verification failed: ${(e as Error).message}`);
  }
  return true;
}

function cleanupAcceptedHandoffArtifacts(entry: PendingAutoStartEntry): void {
  const { basePath, milestoneId } = entry;
  try {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    if (draftFile) removeProjectionFileSync(draftFile);
  } catch (e) {
    logWarning("guided", `CONTEXT-DRAFT.md unlink failed: ${(e as Error).message}`);
  }

  const manifestPath = discussionManifestPath(entry);
  if (existsSync(manifestPath)) {
    try {
      unlinkSync(manifestPath);
    } catch (e) {
      logWarning("guided", `manifest unlink failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Register an out-of-band CONTEXT.md as a DB artifact (#2107).
 *
 * When context was written outside gsd_summary_save (e.g. directly by the
 * discuss handoff), the file exists on disk but the artifacts table has no
 * CONTEXT row. State derivation is DB-authoritative (#4179), so deriveState
 * keeps reporting needs-discussion and auto-start re-enters discuss forever.
 * Registering the row mirrors what gsd_summary_save would have persisted;
 * insertArtifact computes content_hash and imported_at internally.
 * Best-effort: a registration failure must not break handoff acceptance.
 */
function registerDbContextArtifact(
  basePath: string,
  milestoneId: string,
  contextFile: string,
): void {
  try {
    if (getMilestoneScopedArtifacts(milestoneId).some(a => a.artifact_type === "CONTEXT")) return;

    insertArtifact({
      path: relMilestoneFile(basePath, milestoneId, "CONTEXT").replace(/^\.gsd\//, ""),
      artifact_type: "CONTEXT",
      milestone_id: milestoneId,
      slice_id: null,
      task_id: null,
      full_content: readFileSync(contextFile, "utf-8"),
    });
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
  } catch (e) {
    logWarning(
      "guided",
      `failed to register out-of-band CONTEXT artifact for ${milestoneId}: ${(e as Error).message}`,
    );
  }
}

/** Called from agent_end to check if auto-mode should start after discuss. */
export function checkAutoStartAfterDiscuss(lookupBasePath?: string): boolean {
  // Clear the path cache so layout-aware resolution sees fresh directory
  // listings — the cache may have been primed before discuss wrote its
  // artifacts (e.g. CONTEXT.md), causing resolveMilestoneFile to miss them.
  clearPathCache();
  const entry = _getPendingAutoStart(lookupBasePath);
  if (!entry) return false;

  const { ctx, pi, basePath, milestoneId, step } = entry;
  // Use layout-aware resolution so flat-phase projects (phases/NN-slug/)
  // are found as well as legacy projects (milestones/MID/).
  const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!contextFile && !roadmapFile) return false;

  if (hasBlockingDepthGate(entry)) return false;
  if (!ensureMilestoneRowForAcceptedHandoff(entry, contextFile)) return false;
  if (contextFile && isDbAvailable()) registerDbContextArtifact(basePath, milestoneId, contextFile);

  const projectIds = warnForMissingProjectMilestones(entry);
  if (!discussionManifestIsComplete(entry, projectIds)) return false;

  cleanupAcceptedHandoffArtifacts(entry);
  deletePendingAutoStart(basePath);

  const readiness = assessMilestoneHandoffReadiness({
    milestoneId,
    contextFile,
    roadmapFile,
  });
  ctx.ui.notify(
    formatAcceptedDiscussHandoffMessage(milestoneId, readiness),
    "success",
  );
  if (entry.startAuto !== false) {
    scheduleAutoStartAfterIdle(ctx, pi, basePath, false, { step: step ?? true });
  }
  return true;
}
