// gsd-pi — Milestone merge DB readiness guard.
//
// Owns the invariant that, before leaving worktree context for a milestone
// merge, the project DB is the active DB, the worktree holds no gsd.db of its
// own, and canonical closeout state proves the milestone is safe to merge.

import { CLOSEOUT_CONSISTENCY_BLOCKED_REASON } from "./closeout-consistency-gate.js";
import {
  closeWorkflowDatabase,
  getWorkflowDatabasePath,
  openWorkflowDatabasePath,
} from "./db-workspace.js";
import { readMilestoneMergeObservation } from "./db/milestone-closeout-readiness.js";
import { isMilestoneCloseoutPrepared } from "./db/writers/closeout.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { isDbAvailable } from "./gsd-db.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import { resolveGsdPathContract } from "./paths.js";
import {
  _hasWorktreeLocalDb,
  worktreeLocalDbInstruction,
  worktreeOwnDbPath,
} from "./auto-worktree-cleanup.js";
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
  isMilestoneCloseoutPrepared: typeof isMilestoneCloseoutPrepared;
  logError: typeof logError;
  openWorkflowDatabasePath: typeof openWorkflowDatabasePath;
  proveMilestoneCloseout: typeof proveMilestoneCloseout;
  readMilestoneMergeObservation: typeof readMilestoneMergeObservation;
  resolveGsdPathContract: typeof resolveGsdPathContract;
  hasWorktreeLocalDb: typeof _hasWorktreeLocalDb;
}

const defaultDeps: MergeDbReadyDeps = {
  closeWorkflowDatabase,
  formatCloseoutProofBlock,
  getWorkflowDatabasePath,
  isDbAvailable,
  isMilestoneCloseoutPrepared,
  logError,
  openWorkflowDatabasePath,
  proveMilestoneCloseout,
  readMilestoneMergeObservation,
  resolveGsdPathContract,
  hasWorktreeLocalDb: _hasWorktreeLocalDb,
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

/**
 * Open the project DB, and stop when the worktree holds a gsd.db of its own.
 * That file is never merged here: no project row changes, and the error names
 * the explicit import.
 */
function assertProjectDbIsTheOnlyDb(request: MilestoneDbReadyRequest): void {
  const { milestoneId, projectRoot, worktreeCwd } = request;
  const contract = deps.resolveGsdPathContract(worktreeCwd, projectRoot);
  const worktreeDbPath = worktreeOwnDbPath(worktreeCwd);
  const mainDbPath = contract.projectDb;

  try {
    const activeDbPath = deps.getWorkflowDatabasePath();
    const dbAvailable = deps.isDbAvailable();
    const projectDbActive = dbAvailable
      && activeDbPath !== null
      && !deps.hasWorktreeLocalDb(activeDbPath, mainDbPath);
    if (!projectDbActive) {
      if (dbAvailable) deps.closeWorkflowDatabase();
      if (!deps.openWorkflowDatabasePath(mainDbPath) || !deps.isDbAvailable()) {
        throw new Error(`cannot open project DB at ${mainDbPath}`);
      }
    }
    if (worktreeDbPath && deps.hasWorktreeLocalDb(worktreeDbPath, mainDbPath)) {
      throw new Error(worktreeLocalDbInstruction(worktreeDbPath, milestoneId));
    }
  } catch (err) {
    const message = `Milestone ${milestoneId} merge blocked: ${err instanceof Error ? err.message : String(err)}`;
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

/**
 * An adopted Milestone merges while it is still open, from its Closeout Plan:
 * the merge is a host effect that settles before completion (ADR-046). A
 * Milestone completed without a plan may still merge.
 */
function assertAdoptedMilestoneCloseoutReady(milestoneId: string): void {
  const observation = deps.readMilestoneMergeObservation(milestoneId);
  if (observation.kind === "unadopted" || observation.kind === "completed") {
    return;
  }
  if (observation.kind === "not-completed" && deps.isMilestoneCloseoutPrepared(milestoneId)) {
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
    : "canonical lifecycle is not completed and has no Closeout Plan";
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
  assertProjectDbIsTheOnlyDb(request);
  assertAdoptedMilestoneCloseoutReady(request.milestoneId);
  assertCloseoutProof(request.milestoneId);
}
