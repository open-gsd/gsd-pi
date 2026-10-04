// Project/App: gsd-pi
// File Purpose: Host effects of a Milestone Closeout Plan: the merge and the push, and their Settlement Receipts.

import { execFileSync } from "node:child_process";

import { autoWorktreeBranch } from "./auto-worktree-branch-lifecycle.js";
import { isInAutoWorktree } from "./auto-worktree-entry.js";
import {
  pendingRequiredCloseoutEffects,
  readMilestoneCloseoutPlan,
  recordSettlementReceipt,
  settleCloseout,
  type CloseoutEffectInput,
} from "./closeout-domain-operation.js";
import { readUnsettledEffectsBehind } from "./db/writers/closeout.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { isDbAvailable } from "./gsd-db.js";
import { nativeBranchExists } from "./native-git-bridge.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "./preferences.js";

export const MILESTONE_MERGE_EFFECT = "milestone-merge";
export const INTEGRATION_PUSH_EFFECT = "integration-push";

/**
 * The host effects a Milestone needs before it may complete. A Milestone whose
 * work sits on its own branch needs the merge; a Milestone that ran on the
 * integration branch needs none.
 */
export function milestoneCloseoutEffects(basePath: string, milestoneId: string): CloseoutEffectInput[] {
  const milestoneBranch = autoWorktreeBranch(milestoneId);
  if (!nativeBranchExists(basePath, milestoneBranch)) return [];
  if (getIsolationMode(basePath) === "none" && !isInAutoWorktree(basePath)) return [];
  const git = loadEffectiveGSDPreferences(basePath)?.preferences?.git ?? {};
  return [
    { effectKind: MILESTONE_MERGE_EFFECT, required: true, spec: { milestoneBranch } },
    ...(git.auto_push === true && git.auto_pr !== true
      ? [{ effectKind: INTEGRATION_PUSH_EFFECT, required: false }]
      : []),
  ];
}

export interface SettledMilestoneMerge {
  commitSha: string;
  integrationBranch: string;
  /** Tip of the milestone branch that was merged. */
  milestoneBranchSha: string;
  codeFilesChanged: boolean;
}

function revParse(basePath: string, ref: string): string {
  return execFileSync("git", ["rev-parse", "--verify", ref], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

/** The merge receipt of the current Closeout Plan, or null when the merge has not settled. */
export function readSettledMilestoneMerge(milestoneId: string): SettledMilestoneMerge | null {
  if (!isDbAvailable()) return null;
  const proof = readMilestoneCloseoutPlan(milestoneId)?.effects
    .find((effect) => effect.effectKind === MILESTONE_MERGE_EFFECT)?.receipt?.proof;
  if (!proof) return null;
  return {
    commitSha: String(proof["commitSha"]),
    integrationBranch: String(proof["integrationBranch"]),
    milestoneBranchSha: String(proof["milestoneBranchSha"]),
    codeFilesChanged: proof["codeFilesChanged"] === true,
  };
}

/** True while the current Closeout Plan still waits for a required host effect. */
export function hasPendingCloseoutEffect(milestoneId: string): boolean {
  if (!isDbAvailable()) return false;
  const plan = readMilestoneCloseoutPlan(milestoneId);
  return Boolean(plan && plan.lifecycleStatus !== "completed" && pendingRequiredCloseoutEffects(plan).length > 0);
}

/**
 * Record the merge receipt and complete the Milestone in the settle
 * transaction. No-op for a Milestone without a Closeout Plan.
 */
export function settleMilestoneMerge(request: {
  projectRoot: string;
  milestoneId: string;
  milestoneBranch: string;
  integrationBranch: string;
  /** The merge found the work already on the integration branch. */
  recognized: boolean;
  codeFilesChanged: boolean;
}): void {
  // The merge stash can move an untracked database file away and back, which
  // leaves the open handle on the old inode. Re-attach before reading.
  if (!isDbAvailable()) return;
  refreshWorkflowDatabaseFromDisk();
  const plan = readMilestoneCloseoutPlan(request.milestoneId);
  if (!plan?.effects.some((effect) => effect.effectKind === MILESTONE_MERGE_EFFECT)) return;
  const commitSha = revParse(request.projectRoot, "HEAD");
  recordSettlementReceipt({
    milestoneId: request.milestoneId,
    effectKind: MILESTONE_MERGE_EFFECT,
    outcome: request.recognized ? "recognized" : "performed",
    externalRef: commitSha,
    proof: {
      commitSha,
      integrationBranch: request.integrationBranch,
      milestoneBranchSha: nativeBranchExists(request.projectRoot, request.milestoneBranch)
        ? revParse(request.projectRoot, request.milestoneBranch)
        : commitSha,
      codeFilesChanged: request.codeFilesChanged,
    },
  });
  settleCloseout(request.milestoneId);
}

function pendingIntegrationPushes(integrationBranch: string): Array<{ milestoneId: string; commitSha: string }> {
  if (!isDbAvailable()) return [];
  return readUnsettledEffectsBehind(INTEGRATION_PUSH_EFFECT, MILESTONE_MERGE_EFFECT)
    .filter((pending) => pending.settledProof["integrationBranch"] === integrationBranch)
    .map((pending) => ({
      milestoneId: pending.milestoneId,
      commitSha: String(pending.settledProof["commitSha"]),
    }));
}

/** True when a merged Milestone on this branch still waits for its push. */
export function hasPendingIntegrationPush(integrationBranch: string): boolean {
  return pendingIntegrationPushes(integrationBranch).length > 0;
}

/**
 * Record a successful push of the integration branch. One push carries every
 * merge commit below it, so it settles the push effect of each Milestone
 * already merged to that branch — this is how a failed push is retried by the
 * next closeout.
 */
export function settleIntegrationPush(request: { remote: string; integrationBranch: string }): void {
  for (const pending of pendingIntegrationPushes(request.integrationBranch)) {
    recordSettlementReceipt({
      milestoneId: pending.milestoneId,
      effectKind: INTEGRATION_PUSH_EFFECT,
      outcome: "performed",
      externalRef: `${request.remote}/${request.integrationBranch}`,
      proof: {
        remote: request.remote,
        integrationBranch: request.integrationBranch,
        commitSha: pending.commitSha,
      },
    });
  }
}
