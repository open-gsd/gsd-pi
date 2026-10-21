// Project/App: gsd-pi
// File Purpose: Shared closeout detection and merge actions for /gsd home and smart entry.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import type { NextAction } from "../shared/next-action-ui.js";
import type { GSDState } from "./types.js";
import { setAutoOutcomeWidget } from "./auto-dashboard.js";
import { invalidateAllCaches } from "./cache.js";
import { isDbAvailable } from "./db/engine.js";
import { getMilestone } from "./db/queries.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { mergeCompletedMilestone } from "./parallel-merge.js";
import { cleanupQuickBranch, detectStrandedQuickBranch, type StrandedQuickBranch } from "./quick.js";
import { isClosedStatus } from "./status-guards.js";
import {
  findUnmergedCompletedMilestones,
  type UnmergedMilestoneBlocker,
} from "./unmerged-milestone-guard.js";
import { appendRequirementsBacklogToSummary } from "./requirements-backlog.js";
import { nativeBranchList, nativeIsRepo } from "./native-git-bridge.js";
import {
  allWorktreesDirs,
  isMilestoneWorktreeResidueCandidate,
  pruneEphemeralGhostWorktreeDirectories,
} from "./worktree-manager.js";

export type CloseoutActionId = "finish_quick" | "finish_milestone";

export interface IdleMilestoneResidueHint {
  message: string;
  milestoneIds: string[];
}

export interface CloseoutContext {
  strandedQuick: StrandedQuickBranch | null;
  unmergedMilestones: UnmergedMilestoneBlocker[];
  idleResidueHint?: IdleMilestoneResidueHint | null;
}

const MILESTONE_MERGE_CLOSEOUT_COMMANDS = [
  "/gsd status for overview",
  "/gsd visualize to inspect",
  "/gsd notifications for history",
  "/gsd start for new work",
];

function listMilestoneWorktreeIds(basePath: string): string[] {
  const ids = new Set<string>();
  for (const wtDir of allWorktreesDirs(basePath)) {
    if (!existsSync(wtDir)) continue;
    for (const entry of readdirSync(wtDir)) {
      if (!MILESTONE_ID_RE.test(entry)) continue;
      const fullPath = join(wtDir, entry);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
        if (!isMilestoneWorktreeResidueCandidate(basePath, fullPath)) continue;
        ids.add(entry);
      } catch {
        // skip unreadable entries
      }
    }
  }
  return [...ids].sort();
}

function listMilestoneBranchIds(basePath: string): string[] {
  try {
    return nativeBranchList(basePath, "milestone/*")
      .map((branch) => branch.replace(/^milestone\//, ""))
      .filter((id) => MILESTONE_ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A milestone ID is "stranded residue" only when its worktree/branch artifacts
 * exist for a milestone the DB does not consider currently in flight — i.e. the
 * row is closed (complete/done/skipped/closed) or absent. Active, pending,
 * blocked, parked, queued, and deferred rows describe normal in-flight or
 * intentionally-preserved state, never residue. Returning `false` skips the ID;
 * returning `true` keeps it in the hint.
 */
function isStrandedMilestoneId(milestoneId: string): boolean {
  if (!isDbAvailable()) return true;
  const row = getMilestone(milestoneId);
  if (!row) return true;
  return isClosedStatus(row.status);
}

/** Surface stranded milestone git residue when closeout guards did not classify it. */
export function detectIdleMilestoneResidueHint(basePath: string): IdleMilestoneResidueHint | null {
  if (!nativeIsRepo(basePath)) return null;

  pruneEphemeralGhostWorktreeDirectories(basePath);

  const gsdDir = join(basePath, ".gsd");
  const dbPath = join(gsdDir, "gsd.db");
  if (!existsSync(gsdDir) || !existsSync(dbPath)) {
    return {
      milestoneIds: [],
      message:
        "This git repo has no local GSD workflow database (.gsd/gsd.db). " +
        "Workflow state may live in an external worktree, or run /gsd new-project to initialize here.",
    };
  }

  const worktreeIds = listMilestoneWorktreeIds(basePath);
  const branchIds = listMilestoneBranchIds(basePath);
  const candidateIds = [...new Set([...worktreeIds, ...branchIds])].sort();
  const milestoneIds = candidateIds.filter(isStrandedMilestoneId);
  if (milestoneIds.length === 0) return null;

  const listed = milestoneIds.join(", ");
  const recovery =
    milestoneIds.length === 1
      ? `/gsd dispatch complete-milestone ${milestoneIds[0]}`
      : "/gsd doctor --fix";
  return {
    milestoneIds,
    message:
      `Stranded milestone git residue detected (${listed}: worktree dir and/or milestone/* branch). ` +
      `Run ${recovery} or /gsd status to recover closeout before starting new work.`,
  };
}

export async function loadCloseoutContext(basePath: string): Promise<CloseoutContext> {
  const unmergedMilestones = await findUnmergedCompletedMilestones(basePath);
  const idleResidueHint =
    unmergedMilestones.length === 0 ? detectIdleMilestoneResidueHint(basePath) : null;
  return {
    strandedQuick: detectStrandedQuickBranch(basePath),
    unmergedMilestones,
    idleResidueHint,
  };
}

export function getPrimaryCloseoutRecommendation(
  closeout: CloseoutContext,
): CloseoutActionId | null {
  if (closeout.strandedQuick) return "finish_quick";
  if (closeout.unmergedMilestones.length > 0) return "finish_milestone";
  return null;
}

export function buildCloseoutMenuActions(closeout: CloseoutContext): NextAction[] {
  const actions: NextAction[] = [];
  const primary = getPrimaryCloseoutRecommendation(closeout);

  if (closeout.strandedQuick) {
    const quick = closeout.strandedQuick;
    actions.push({
      id: "finish_quick",
      label: "Merge quick task",
      description: `Squash-merge Q${quick.taskNum} from ${quick.quickBranch} into ${quick.originalBranch}.`,
      recommended: primary === "finish_quick",
    });
  }

  if (closeout.unmergedMilestones.length > 0) {
    const blocker = closeout.unmergedMilestones[0];
    actions.push({
      id: "finish_milestone",
      label: "Merge milestone",
      description: `Merge ${blocker.milestoneId} from ${blocker.branch} into ${blocker.integrationBranch}.`,
      recommended: primary === "finish_milestone",
    });
  }

  return actions;
}

export function buildIdleMenuSummary(state: GSDState, closeout: CloseoutContext): string[] {
  if (closeout.strandedQuick) {
    const quick = closeout.strandedQuick;
    return [
      `Quick task Q${quick.taskNum} finished on ${quick.quickBranch} but is not merged to ${quick.originalBranch}.`,
    ];
  }

  if (closeout.unmergedMilestones.length > 0) {
    const blocker = closeout.unmergedMilestones[0];
    return [
      `${blocker.milestoneId} is complete but not merged into ${blocker.integrationBranch}.`,
    ];
  }

  // Surface idle residue before the completion summary so smart entry shows
  // the same recovery text /gsd home would: a closed/unknown milestone with
  // lingering worktree/branch artifacts must not be hidden behind the
  // "all milestones complete" message.
  if (closeout.idleResidueHint) {
    return [closeout.idleResidueHint.message];
  }

  if (state.phase === "complete") {
    const last = state.lastCompletedMilestone;
    return appendRequirementsBacklogToSummary(state, [
      last
        ? `All milestones complete after ${last.id}: ${last.title}.`
        : "All milestones complete.",
    ]);
  }

  return [state.nextAction || "No active milestone."];
}

export function showMilestoneMergeCloseout(
  ctx: ExtensionCommandContext,
  blocker: UnmergedMilestoneBlocker,
): void {
  ctx.ui.setStatus?.("gsd-auto", undefined);
  ctx.ui.setStatus?.("gsd-step", undefined);
  ctx.ui.setWidget?.("gsd-progress", undefined);

  setAutoOutcomeWidget(ctx, {
    status: "complete",
    title: `Milestone ${blocker.milestoneId} merged`,
    detail: `Merged ${blocker.branch} into ${blocker.integrationBranch}. Product changes are now on ${blocker.integrationBranch}.`,
    nextAction: "Review the closeout, then start the next milestone when ready.",
    commands: MILESTONE_MERGE_CLOSEOUT_COMMANDS,
  });
}

export async function runMergeQuickTask(
  ctx: ExtensionCommandContext,
  basePath: string,
  strandedQuick?: StrandedQuickBranch | null,
): Promise<boolean> {
  const merged = cleanupQuickBranch(basePath);
  if (merged) {
    ctx.ui.notify(
      `Merged quick task Q${strandedQuick?.taskNum ?? "?"} into ${strandedQuick?.originalBranch ?? "main"}.`,
      "info",
    );
    invalidateAllCaches();
    return true;
  }

  ctx.ui.notify(
    "Could not merge the quick-task branch automatically. Run `git status`, resolve any conflicts, then retry /gsd.",
    "error",
  );
  return false;
}

export async function runMergeMilestoneBlocker(
  ctx: ExtensionCommandContext,
  basePath: string,
  blocker: UnmergedMilestoneBlocker,
): Promise<boolean> {
  ctx.ui.notify(
    `Completing preserved milestone merge for ${blocker.milestoneId} from ${blocker.branch} into ${blocker.integrationBranch}.`,
    "info",
  );
  const result = await mergeCompletedMilestone(basePath, blocker.milestoneId);
  if (result.success) {
    invalidateAllCaches();
    showMilestoneMergeCloseout(ctx, blocker);
    ctx.ui.notify(
      `Milestone ${blocker.milestoneId} merged to ${blocker.integrationBranch}. Closeout is complete.`,
      "info",
    );
    return true;
  }

  ctx.ui.notify(
    `Milestone ${blocker.milestoneId} merge failed: ${result.error ?? "unknown error"}`,
    "error",
  );
  return false;
}

export async function runMergeMilestone(
  ctx: ExtensionCommandContext,
  basePath: string,
  milestoneId?: string,
): Promise<boolean> {
  const blockers = await findUnmergedCompletedMilestones(basePath);
  const blocker = milestoneId
    ? blockers.find((candidate) => candidate.milestoneId === milestoneId)
    : blockers[0];
  if (!blocker) {
    ctx.ui.notify("No unmerged completed milestone found.", "warning");
    return false;
  }

  return runMergeMilestoneBlocker(ctx, basePath, blocker);
}

export async function handleCloseoutChoice(
  ctx: ExtensionCommandContext,
  basePath: string,
  choice: string,
  closeout: CloseoutContext,
): Promise<boolean> {
  if (choice === "finish_quick") {
    return runMergeQuickTask(ctx, basePath, closeout.strandedQuick);
  }
  if (choice === "finish_milestone") {
    return runMergeMilestone(ctx, basePath, closeout.unmergedMilestones[0]?.milestoneId);
  }
  return false;
}
