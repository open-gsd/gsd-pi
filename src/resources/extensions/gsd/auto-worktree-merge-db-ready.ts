// gsd-pi — Milestone merge DB readiness guard.
//
// Owns the invariant that, before leaving worktree context for a milestone
// merge, the project DB is the active DB, worktree DB state is reconciled, and
// canonical closeout state proves the milestone is safe to merge.

import { join } from "node:path";

import { CLOSEOUT_CONSISTENCY_BLOCKED_REASON } from "./closeout-consistency-gate.js";
import {
  closeWorkflowDatabase,
  getWorkflowDatabasePath,
  openWorkflowDatabasePath,
} from "./db-workspace.js";
import { readMilestoneMergeObservation } from "./db/milestone-closeout-readiness.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  isDbAvailable,
  reconcileWorktreeDb,
} from "./gsd-db.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import { resolveGsdPathContract } from "./paths.js";
import { _shouldReconcileWorktreeDb } from "./auto-worktree-cleanup.js";
import { logError } from "./workflow-logger.js";

export interface MilestoneDbReadyRequest {
  milestoneId: string;
  projectRoot: string;
  worktreeCwd: string;
}

interface MergeDbReadyDeps {
  closeWorkflowDatabase: typeof closeWorkflowDatabase;
  formatCloseoutProofBlock: typeof formatCloseoutProofBlock;
  getWorkflowDatabasePath: typeof getWorkflowDatabasePath;
  isDbAvailable: typeof isDbAvailable;
  logError: typeof logError;
  openWorkflowDatabasePath: typeof openWorkflowDatabasePath;
  proveMilestoneCloseout: typeof proveMilestoneCloseout;
  readMilestoneMergeObservation: typeof readMilestoneMergeObservation;
  reconcileWorktreeDb: typeof reconcileWorktreeDb;
  resolveGsdPathContract: typeof resolveGsdPathContract;
  shouldReconcileWorktreeDb: typeof _shouldReconcileWorktreeDb;
}

const defaultDeps: MergeDbReadyDeps = {
  closeWorkflowDatabase,
  formatCloseoutProofBlock,
  getWorkflowDatabasePath,
  isDbAvailable,
  logError,
  openWorkflowDatabasePath,
  proveMilestoneCloseout,
  readMilestoneMergeObservation,
  reconcileWorktreeDb,
  resolveGsdPathContract,
  shouldReconcileWorktreeDb: _shouldReconcileWorktreeDb,
};

let deps: MergeDbReadyDeps = defaultDeps;

export function _setMergeDbReadyDepsForTests(
  overrides: Partial<MergeDbReadyDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetMergeDbReadyDepsForTests(): void {
  deps = defaultDeps;
}

function reconcileWorktreeDatabase(request: MilestoneDbReadyRequest): void {
  const { milestoneId, projectRoot, worktreeCwd } = request;
  const contract = deps.resolveGsdPathContract(worktreeCwd, projectRoot);
  const worktreeDbPath = join(contract.worktreeGsd ?? join(worktreeCwd, ".gsd"), "gsd.db");
  const mainDbPath = contract.projectDb;

  try {
    const activeDbPath = deps.getWorkflowDatabasePath();
    const dbAvailable = deps.isDbAvailable();
    const projectDbActive = dbAvailable
      && activeDbPath !== null
      && !deps.shouldReconcileWorktreeDb(activeDbPath, mainDbPath);
    if (!projectDbActive) {
      if (dbAvailable) deps.closeWorkflowDatabase();
      if (!deps.openWorkflowDatabasePath(mainDbPath) || !deps.isDbAvailable()) {
        throw new Error(`cannot open project DB at ${mainDbPath}`);
      }
    }
    if (deps.shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath)) {
      deps.reconcileWorktreeDb(mainDbPath, worktreeDbPath);
    }
  } catch (err) {
    const message = `DB reconciliation failed before milestone ${milestoneId} merge: ${err instanceof Error ? err.message : String(err)}`;
    deps.logError("worktree", message);
    throw new GSDError(
      GSD_GIT_ERROR,
      `${message}. Recovery reason: ${CLOSEOUT_CONSISTENCY_BLOCKED_REASON}.`,
    );
  }
}

function assertCloseoutProof(milestoneId: string): void {
  const closeoutProof = deps.proveMilestoneCloseout(milestoneId);
  if (!closeoutProof.ok) {
    throw new GSDError(GSD_GIT_ERROR, deps.formatCloseoutProofBlock(closeoutProof));
  }
}

function assertAdoptedMilestoneCompleted(milestoneId: string): void {
  const observation = deps.readMilestoneMergeObservation(milestoneId);
  if (observation.kind === "unadopted" || observation.kind === "completed") {
    return;
  }
  if (observation.kind === "unavailable") {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Milestone ${milestoneId} merge blocked: project DB verification is unavailable. ` +
      `Recovery reason: ${CLOSEOUT_CONSISTENCY_BLOCKED_REASON}.`,
    );
  }
  const detail = observation.kind === "mismatch"
    ? "canonical and legacy status mismatch"
    : "canonical lifecycle is not completed";
  throw new GSDError(
    GSD_GIT_ERROR,
    `Milestone ${milestoneId} merge blocked: ${detail} ` +
    `(canonical=${observation.canonicalStatus}, legacy=${observation.legacyStatus}). ` +
    `Recovery reason: ${CLOSEOUT_CONSISTENCY_BLOCKED_REASON}.`,
  );
}

export function assertMilestoneDbReadyForMerge(
  request: MilestoneDbReadyRequest,
): void {
  reconcileWorktreeDatabase(request);
  assertAdoptedMilestoneCompleted(request.milestoneId);
  assertCloseoutProof(request.milestoneId);
}
