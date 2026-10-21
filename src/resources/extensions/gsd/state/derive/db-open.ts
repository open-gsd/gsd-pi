// Project/App: gsd-pi
// File Purpose: Workflow DB open helpers for state derivation.

import type { GSDState } from '../../types.js';
import { getAllMilestones, isDbAvailable, isSchemaTooNewError, setMilestoneQueueOrder } from '../../gsd-db.js';
import { getWorkflowDatabasePath as getDbPath, openExistingWorkflowDatabase, resolveProjectRootDbPath, type WorkflowDatabaseOpenResult } from '../../db-workspace.js';
import { loadQueueOrder, sortByQueueOrder } from '../../queue-order.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function syncQueueOrderProjectionToDb(basePath: string): void {
  const queueOrder = loadQueueOrder(basePath);
  if (!queueOrder) return;

  const currentIds = getAllMilestones().map((m) => m.id);
  const desiredIds = sortByQueueOrder(currentIds, queueOrder);
  if (currentIds.length === desiredIds.length && currentIds.every((id, i) => id === desiredIds[i])) return;

  setMilestoneQueueOrder(desiredIds);
}

/**
 * Compare DB paths by canonical form: resolveProjectRootDbPath canonicalizes
 * (realpath) while the open handle keeps the spelling it was opened with — on
 * macOS a /var vs /private/var mismatch must reuse the same DB, not reopen it.
 * A missing requested path falls back to its raw form so it can never match.
 */
function isSameOpenDatabase(currentDbPath: string | null, requestedDbPath: string): boolean {
  if (!currentDbPath) return false;
  if (currentDbPath === ":memory:" || currentDbPath === requestedDbPath) return true;
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return canonical(currentDbPath) === canonical(requestedDbPath);
}

export function ensureExistingWorkflowDbOpen(
  basePath: string,
  options: { throwOnOpenFailure?: boolean; syncQueueOrder?: boolean } = {},
): boolean {
  const syncQueueOrder = options.syncQueueOrder !== false;
  if (isDbAvailable() && isSameOpenDatabase(getDbPath(), resolveProjectRootDbPath(basePath))) {
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
