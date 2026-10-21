// Project/App: gsd-pi
// File Purpose: deriveState orchestrator — cache, DB open, pure DB projection.

import type { GSDState } from '../../types.js';
import { isDbAvailable } from '../../gsd-db.js';
import { wasWorkflowDatabaseOpenAttempted } from '../../db-workspace.js';
import { debugCount, debugTime } from '../../debug-logger.js';
import { logWarning } from '../../workflow-logger.js';

import {
  getDeriveTelemetry,
  incrementDbDeriveCount,
  invalidateStateCache,
  readCachedDeriveState,
  resetDeriveTelemetry,
  writeCachedDeriveState,
} from './cache.js';
import {
  buildDbUnavailableState,
  ensureExistingWorkflowDbOpen,
} from './db-open.js';
import { deriveStateFromDb } from './from-db.js';

export interface DeriveStateOptions {
  projectRootForReads?: string;
  /** Read-only surfaces set this so deriving never mutates DB sequence from QUEUE-ORDER.json. */
  syncQueueOrder?: boolean;
}

export {
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
};

export async function deriveState(
  basePath: string,
  opts?: DeriveStateOptions,
): Promise<GSDState> {
  const cacheKey = opts?.projectRootForReads ?? basePath;

  const cached = readCachedDeriveState(cacheKey);
  if (cached) return cached;

  const stopTimer = debugTime("derive-state-impl");
  let result: GSDState;

  // Resolve/open through the canonical read root, matching deriveStateFromDb
  // below — otherwise a worktree basePath with projectRootForReads can open
  // the wrong (or no) DB while deriveStateFromDb still reads the correct one.
  ensureExistingWorkflowDbOpen(opts?.projectRootForReads ?? basePath, {
    syncQueueOrder: opts?.syncQueueOrder,
  });

  if (isDbAvailable()) {
    const stopDbTimer = debugTime("derive-state-db");
    result = await deriveStateFromDb(basePath, opts?.projectRootForReads ?? basePath, {
      syncQueueOrder: opts?.syncQueueOrder,
    });
    stopDbTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
    incrementDbDeriveCount();
  } else {
    if (wasWorkflowDatabaseOpenAttempted()) {
      logWarning("state", "DB unavailable — refusing implicit markdown state derivation");
    }
    result = buildDbUnavailableState();
  }

  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  writeCachedDeriveState(cacheKey, result);
  return result;
}
