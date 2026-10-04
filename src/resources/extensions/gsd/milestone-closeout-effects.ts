// Project/App: gsd-pi
// File Purpose: Host effects of a Milestone Closeout Plan: the merge, the GitHub close and the push, and their Settlement Receipts.

import { execFileSync } from "node:child_process";

import { autoWorktreeBranch } from "./auto-worktree-branch-lifecycle.js";
import { isInAutoWorktree } from "./auto-worktree-entry.js";
import {
  pendingRequiredCloseoutEffects,
  readMilestoneCloseoutPlan,
  recordSettlementReceipt,
  settleCloseout,
  supersedeCloseoutPlan,
  type CloseoutEffectInput,
} from "./closeout-domain-operation.js";
import { readUnsettledEffectsBehind } from "./db/writers/closeout.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { isDbAvailable } from "./gsd-db.js";
import { nativeBranchExists, nativeIsAncestor } from "./native-git-bridge.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "./preferences.js";
import { logWarning } from "./workflow-logger.js";
import { getMilestoneRecord, loadSyncMapping } from "../github-sync/mapping.js";
import { closeMilestoneFromRecord } from "../github-sync/sync.js";

export const MILESTONE_MERGE_EFFECT = "milestone-merge";
export const GITHUB_MILESTONE_CLOSE_EFFECT = "github-milestone-close";
export const INTEGRATION_PUSH_EFFECT = "integration-push";

/**
 * The GitHub close of a synced Milestone. The effect carries the GitHub
 * numbers, so the close does not need the mapping file of a removed worktree.
 */
function githubMilestoneCloseEffect(basePath: string, milestoneId: string): CloseoutEffectInput[] {
  if (!loadEffectiveGSDPreferences(basePath)?.preferences?.github?.enabled) return [];
  const mapping = loadSyncMapping(basePath);
  const record = mapping ? getMilestoneRecord(mapping, milestoneId) : null;
  if (!mapping || !record || record.state === "closed") return [];
  return [{
    effectKind: GITHUB_MILESTONE_CLOSE_EFFECT,
    required: false,
    spec: {
      repo: mapping.repo,
      issueNumber: record.issueNumber,
      ghMilestoneNumber: record.ghMilestoneNumber,
    },
  }];
}

/**
 * The host effects a Milestone needs before it may complete. A Milestone whose
 * work sits on its own branch needs the merge; a Milestone that ran on the
 * integration branch needs none. The list is in dependency order: receipts
 * must follow it, so the push comes before the GitHub close that can fail
 * without the push.
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
    ...githubMilestoneCloseEffect(basePath, milestoneId),
  ];
}

export interface SettledMilestoneMerge {
  /** The work was found on the integration branch; GSD did not merge it. */
  recognized: boolean;
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
  const receipt = readMilestoneCloseoutPlan(milestoneId)?.effects
    .find((effect) => effect.effectKind === MILESTONE_MERGE_EFFECT)?.receipt;
  if (!receipt) return null;
  const { proof } = receipt;
  return {
    recognized: receipt.outcome === "recognized",
    commitSha: String(proof["commitSha"]),
    integrationBranch: String(proof["integrationBranch"]),
    milestoneBranchSha: String(proof["milestoneBranchSha"]),
    codeFilesChanged: proof["codeFilesChanged"] === true,
  };
}

/**
 * True when GSD merged the whole milestone branch: the merge has a Settlement
 * Receipt, the branch still points at the merged commit and the merge commit
 * is still on the integration branch. A squash merge leaves no git ancestry,
 * so the receipt is the only durable record of that merge. A recognized
 * receipt is not enough: GSD did not make that merge.
 */
export function isMilestoneBranchSettled(projectRoot: string, milestoneId: string, milestoneBranch: string): boolean {
  const settled = readSettledMilestoneMerge(milestoneId);
  if (!settled || settled.recognized) return false;
  // A reset of the integration branch can drop the merge commit; then the
  // branch is the only place the work lives.
  if (!nativeIsAncestor(projectRoot, settled.commitSha, settled.integrationBranch)) return false;
  try {
    return revParse(projectRoot, milestoneBranch) === settled.milestoneBranchSha;
  } catch {
    // The branch cannot be read; let the caller inspect git.
    return false;
  }
}

/**
 * The recorded merge commit left the integration branch and the milestone
 * work is on that branch again (merged by hand). Supersede the Closeout Plan
 * and record the merge as recognized at the integration branch tip. The old
 * receipt stays under the superseded plan.
 */
export function recognizeMilestoneMergeAgain(request: {
  projectRoot: string;
  milestoneId: string;
  milestoneBranch: string;
  settled: SettledMilestoneMerge;
}): SettledMilestoneMerge {
  const { projectRoot, milestoneId, settled } = request;
  supersedeCloseoutPlan(milestoneId);
  const commitSha = revParse(projectRoot, settled.integrationBranch);
  recordSettlementReceipt({
    milestoneId,
    effectKind: MILESTONE_MERGE_EFFECT,
    outcome: "recognized",
    externalRef: commitSha,
    proof: {
      commitSha,
      integrationBranch: settled.integrationBranch,
      milestoneBranchSha: revParse(projectRoot, request.milestoneBranch),
      codeFilesChanged: settled.codeFilesChanged,
    },
  });
  return readSettledMilestoneMerge(milestoneId)!;
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
  completeSettledCloseout(request.projectRoot, request.milestoneId);
}

/** True when the Closeout Plan owns the GitHub close of the Milestone. */
export function closeoutPlanClosesGitHubMilestone(milestoneId: string): boolean {
  return isDbAvailable() && Boolean(
    readMilestoneCloseoutPlan(milestoneId)?.effects
      .some((effect) => effect.effectKind === GITHUB_MILESTONE_CLOSE_EFFECT),
  );
}

/**
 * Close the Milestone on GitHub once it is completed and every effect ahead of
 * the close has a receipt. The receipt makes the close run once; a failed
 * close keeps no receipt and never fails the closeout.
 */
function settleGitHubMilestoneClose(projectRoot: string, milestoneId: string): void {
  const plan = readMilestoneCloseoutPlan(milestoneId);
  const effect = plan?.effects.find((candidate) => candidate.effectKind === GITHUB_MILESTONE_CLOSE_EFFECT);
  if (plan?.lifecycleStatus !== "completed" || !effect || effect.receipt) return;
  if (plan.effects.some((earlier) => earlier.ordinal < effect.ordinal && !earlier.receipt)) return;
  try {
    const repo = String(effect.spec["repo"]);
    const issueNumber = Number(effect.spec["issueNumber"]);
    const ghMilestoneNumber = Number(effect.spec["ghMilestoneNumber"]);
    if (!closeMilestoneFromRecord(projectRoot, repo, milestoneId, { issueNumber, ghMilestoneNumber })) {
      logWarning("worktree", `GitHub milestone for ${milestoneId} was not closed; it stays open on ${repo}.`);
      return;
    }
    recordSettlementReceipt({
      milestoneId,
      effectKind: GITHUB_MILESTONE_CLOSE_EFFECT,
      outcome: "performed",
      externalRef: `${repo}#${issueNumber}`,
      proof: { repo, issueNumber, ghMilestoneNumber },
    });
  } catch (err) {
    logWarning(
      "worktree",
      `GitHub milestone close for ${milestoneId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Complete the Milestone when its required effects have receipts, then run the
 * follow-on effects that wait for completion. No-op without a Closeout Plan.
 */
export function completeSettledCloseout(projectRoot: string, milestoneId: string): void {
  settleCloseout(milestoneId);
  settleGitHubMilestoneClose(projectRoot, milestoneId);
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
 * next closeout. The GitHub close that waited for the push runs after it.
 */
export function settleIntegrationPush(request: {
  projectRoot: string;
  remote: string;
  integrationBranch: string;
}): void {
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
    settleGitHubMilestoneClose(request.projectRoot, pending.milestoneId);
  }
}
