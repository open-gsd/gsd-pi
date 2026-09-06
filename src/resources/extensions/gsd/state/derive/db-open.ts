// Project/App: gsd-pi
// File Purpose: Workflow DB open helpers for state derivation.

import type { GSDState } from '../../types.js';
import { getAllMilestones, isDbAvailable, isSchemaTooNewError, setMilestoneQueueOrder } from '../../gsd-db.js';
import { getWorkflowDatabasePath as getDbPath, openExistingWorkflowDatabase, resolveProjectRootDbPath, type WorkflowDatabaseOpenResult } from '../../db-workspace.js';
import { loadQueueOrder, sortByQueueOrder } from '../../queue-order.js';

export function syncQueueOrderProjectionToDb(basePath: string): void {
  const queueOrder = loadQueueOrder(basePath);
  if (!queueOrder) return;

  const currentIds = getAllMilestones().map((m) => m.id);
  const desiredIds = sortByQueueOrder(currentIds, queueOrder);
  if (currentIds.length === desiredIds.length && currentIds.every((id, i) => id === desiredIds[i])) return;

  setMilestoneQueueOrder(desiredIds);
}

export function ensureExistingWorkflowDbOpen(
  basePath: string,
  options: { throwOnOpenFailure?: boolean; syncQueueOrder?: boolean } = {},
): boolean {
  const syncQueueOrder = options.syncQueueOrder !== false;
  const requestedDbPath = resolveProjectRootDbPath(basePath);
  const currentDbPath = getDbPath();
  if (isDbAvailable() && (currentDbPath === requestedDbPath || currentDbPath === ":memory:")) {
    if (syncQueueOrder) syncQueueOrderProjectionToDb(basePath);
    return true;
  }
  let result: WorkflowDatabaseOpenResult;
  try {
    result = openExistingWorkflowDatabase(basePath);
  } catch (err) {
    // Defensive: if an open path ever throws the typed refuse-newer error
    // directly instead of returning a "schema-too-new" result, it must still
    // refuse loudly rather than degrade to empty state.
    if (isSchemaTooNewError(err)) throw err;
    throw err;
  }
  if (!result.ok && result.reason === "schema-too-new") {
    // Version skew is not generic DB unavailability: throw the typed error
    // (exact engine message attached) so state-read surfaces refuse loudly
    // instead of emitting a degraded all-zero snapshot (T003 spike).
    throw result.error;
  }
  if (!result.ok && options.throwOnOpenFailure && result.reason !== "missing-database" && result.reason !== "missing-gsd-dir") {
    throw result.error ?? new Error(`Unable to open the GSD database: ${result.reason}`);
  }
  if (result.ok && syncQueueOrder) syncQueueOrderProjectionToDb(basePath);
  return result.ok;
}

export function buildDbUnavailableState(): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: ["DB unavailable — runtime markdown state derivation is disabled"],
    nextAction:
      "Open or create the canonical GSD database before deriving workflow state. If this project only has markdown state, run /gsd migrate explicitly.",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 0 } },
  };
}

export function getRequestedMilestoneLock(): string | undefined {
  const lock = process.env.GSD_MILESTONE_LOCK?.trim();
  return lock || undefined;
}
