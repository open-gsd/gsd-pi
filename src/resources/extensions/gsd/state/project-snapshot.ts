// Project/App: gsd-pi
// File Purpose: DB-authoritative project snapshot read (issue #2102).
// One compact, deterministic payload covering authority, current focus,
// progress counts, blockers, open questions, verification, and the bounded
// milestone registry — modeled on readProgressFromDb.

import { deriveState, invalidateStateCache } from "./derive/index.js";
import { ensureExistingWorkflowDbOpen } from "./derive/db-open.js";
import {
  _getAdapter,
  getAllMilestones,
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestoneStatusCounts,
  getOpenBlockers,
  getOpenQuestions,
  getProjectAuthorityRow,
  getProjectAuthorityVersion,
  getSchemaVersion,
  getVerificationSummary,
  isDbAvailable,
  readTransaction,
  type OpenBlockerRow,
  type OpenQuestionRow,
  type VerificationSummaryCounts,
} from "../gsd-db.js";
import {
  closeWorkflowDatabase as closeDatabase,
  getWorkflowDatabasePath as getDbPath,
  openWorkflowDatabasePath as openDatabase,
} from "../db-workspace.js";
import type { GSDState } from "../types.js";

const MAX_REVISION_ATTEMPTS = 3;

/** Registry cap: snapshots stay bounded for large projects (issue #2102). */
export const MAX_SNAPSHOT_MILESTONES = 50;

export interface DbProjectSnapshotAuthority {
  projectId: string;
  schemaVersion: number | null;
  revision: number;
  authorityEpoch: number;
}

export interface DbProjectSnapshotCurrent {
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  phase: string;
  nextAction: string;
}

export interface DbProjectSnapshotProgress {
  milestones: { total: number; done: number; active: number; pending: number; parked: number };
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
}

export interface DbProjectSnapshotMilestone {
  id: string;
  title: string;
  status: string;
  sequence: number;
}

export interface DbProjectSnapshot {
  authority: DbProjectSnapshotAuthority;
  current: DbProjectSnapshotCurrent;
  progress: DbProjectSnapshotProgress;
  blockers: OpenBlockerRow[];
  openQuestions: OpenQuestionRow[];
  verification: VerificationSummaryCounts;
  milestones: { items: DbProjectSnapshotMilestone[]; truncated: boolean };
  capturedAt: string;
}

export interface ReadProjectSnapshotOptions {
  preserveGlobalDbHandle?: boolean;
}

interface SnapshotStabilityToken {
  revision: number;
  authorityEpoch: number;
  dataVersion: number;
}

function readStabilityToken(): SnapshotStabilityToken {
  const authority = getProjectAuthorityVersion();
  const row = _getAdapter()?.prepare("PRAGMA data_version").get();
  const dataVersion = Number(row?.["data_version"]);
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) {
    throw new Error("GSD database data version is not available");
  }
  return { ...authority, dataVersion };
}

function stabilityTokensMatch(before: SnapshotStabilityToken, after: SnapshotStabilityToken): boolean {
  return before.revision === after.revision
    && before.authorityEpoch === after.authorityEpoch
    && before.dataVersion === after.dataVersion;
}

interface SnapshotDbRead {
  authority: DbProjectSnapshotAuthority;
  progress: DbProjectSnapshotProgress;
  blockers: OpenBlockerRow[];
  openQuestions: OpenQuestionRow[];
  verification: VerificationSummaryCounts;
  milestones: DbProjectSnapshot["milestones"];
}

function readSnapshotDb(): SnapshotDbRead {
  return readTransaction(() => {
    const authorityRow = getProjectAuthorityRow();
    if (!authorityRow) {
      throw new Error("GSD project authority row is not available");
    }
    const authority: DbProjectSnapshotAuthority = {
      projectId: authorityRow.projectId,
      schemaVersion: getSchemaVersion(),
      revision: authorityRow.revision,
      authorityEpoch: authorityRow.authorityEpoch,
    };

    const counts = getHierarchyCompletionCounts();
    const milestoneCounts = getMilestoneStatusCounts();
    const slicesActive = getInFlightSliceCount();
    const slicesPending = counts.slicesTotal - counts.slices - slicesActive;
    const progress: DbProjectSnapshotProgress = {
      milestones: milestoneCounts,
      slices: {
        total: counts.slicesTotal,
        done: counts.slices,
        active: slicesActive,
        pending: slicesPending,
      },
      tasks: {
        total: counts.tasksTotal,
        done: counts.tasks,
        pending: counts.tasksTotal - counts.tasks,
      },
    };

    const all = getAllMilestones();
    const truncated = all.length > MAX_SNAPSHOT_MILESTONES;
    const milestones = {
      items: all.slice(0, MAX_SNAPSHOT_MILESTONES).map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        sequence: m.sequence,
      })),
      truncated,
    };

    return {
      authority,
      progress,
      blockers: getOpenBlockers(),
      openQuestions: getOpenQuestions(),
      verification: getVerificationSummary(),
      milestones,
    };
  });
}

function toRef(value: { id: string; title: string } | null): { id: string; title: string } | null {
  return value ? { id: value.id, title: value.title } : null;
}

function buildCurrent(state: GSDState): DbProjectSnapshotCurrent {
  return {
    activeMilestone: toRef(state.activeMilestone),
    activeSlice: toRef(state.activeSlice),
    activeTask: toRef(state.activeTask),
    phase: state.phase,
    nextAction: state.nextAction,
  };
}

/**
 * Read the compact DB-authoritative project snapshot. The DB-backed sections
 * (authority, progress, blockers, questions, verification, milestones) are
 * captured inside one read transaction; `deriveState` runs outside it and
 * supplies current refs/phase/nextAction, so `capturedAt` reflects when the
 * snapshot was assembled and the current section may tear relative to the
 * transactional sections under concurrent commits — the stability-retry loop
 * bounds but does not eliminate that (same contract as readProgressFromDb).
 * Reads never mutate: the queue-order projection sync stays a runtime
 * derive/dispatch repair, so the snapshot reports DB-authoritative order
 * as-is even when QUEUE-ORDER.json is newer.
 */
export async function readProjectSnapshotFromDb(
  basePath: string,
  opts: ReadProjectSnapshotOptions = {},
): Promise<DbProjectSnapshot | null> {
  const previousDbPath = opts.preserveGlobalDbHandle ? getDbPath() : null;
  try {
    const openedRequestedDb = ensureExistingWorkflowDbOpen(basePath, { syncQueueOrder: false });
    if (!openedRequestedDb || !isDbAvailable()) return null;

    invalidateStateCache();
    for (let attempt = 1; ; attempt++) {
      const before = readStabilityToken();
      const dbRead = readSnapshotDb();
      const state = await deriveState(basePath, { syncQueueOrder: false });
      const after = readStabilityToken();

      if (stabilityTokensMatch(before, after) || attempt === MAX_REVISION_ATTEMPTS) {
        return {
          ...dbRead,
          current: buildCurrent(state),
          capturedAt: new Date().toISOString(),
        };
      }
      invalidateStateCache();
    }
  } finally {
    if (opts.preserveGlobalDbHandle && getDbPath() !== previousDbPath) {
      if (previousDbPath) {
        openDatabase(previousDbPath);
      } else {
        closeDatabase();
      }
    }
  }
}
