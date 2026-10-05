// Project/App: gsd-pi
// File Purpose: DB-authoritative project snapshot read (issue #2102).
// One compact, deterministic payload covering authority, current focus,
// progress counts, blockers, open questions, verification, and the bounded
// milestone registry — modeled on readProgressFromDb.

import { deriveState, invalidateStateCache } from "./derive/index.js";
import { ensureExistingWorkflowDbOpen } from "./derive/db-open.js";
import { noteSessionRead } from "../db/domain-operation.js";
import {
  _getAdapter,
  getProjectAuthorityRow,
  getProjectAuthorityVersion,
  getSchemaVersion,
  getVerificationSummary,
  isDbAvailable,
  readTransaction,
  type VerificationSummaryCounts,
} from "../gsd-db.js";
import {
  readMilestones,
  readOpenBlockers,
  readOpenQuestions,
  readProgressCounts,
  type OpenBlockerRow,
  type OpenQuestionRow,
  type ProgressCounts,
} from "../db/lifecycle-read.js";
import {
  closeWorkflowDatabase as closeDatabase,
  getWorkflowDatabasePath as getDbPath,
  openWorkflowDatabasePath as openDatabase,
} from "../db-workspace.js";
import { normalizeCanonicalLifecycleStatus, type CanonicalLifecycleStatus } from "../status-guards.js";
import type { GSDState } from "../types.js";
import { LIFECYCLE_STATUS_VERSION } from "@opengsd/contracts";

const MAX_REVISION_ATTEMPTS = 3;

/** Registry cap: snapshots stay bounded for large projects (issue #2102). */
export const MAX_SNAPSHOT_MILESTONES = 50;
export const MAX_SNAPSHOT_OPEN_ITEMS = 50;

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

export type DbProjectSnapshotProgress = ProgressCounts;

export interface DbProjectSnapshotMilestone {
  id: string;
  title: string;
  /** Legacy status label. Kept for one contract version; `lifecycleStatus` replaces it. */
  status: string;
  /** Status in the canonical lifecycle vocabulary (`lifecycleStatusVersion`); null when it is not known. */
  lifecycleStatus: CanonicalLifecycleStatus | null;
  sequence: number;
  /** Milestone Kind from the current milestone context; "delivery" when none is recorded. */
  kind: string;
}

export interface DbProjectSnapshot {
  authority: DbProjectSnapshotAuthority;
  current: DbProjectSnapshotCurrent;
  progress: DbProjectSnapshotProgress;
  blockers: OpenBlockerRow[];
  blockersTruncated?: boolean;
  openQuestions: OpenQuestionRow[];
  openQuestionsTruncated?: boolean;
  verification: VerificationSummaryCounts;
  /** Version of the lifecycle status vocabulary that `milestones.items[].lifecycleStatus` uses. */
  lifecycleStatusVersion: typeof LIFECYCLE_STATUS_VERSION;
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

/** Milestone Kind per milestone, from the head (not superseded) context row. */
function readMilestoneKinds(): Map<string, string> {
  const rows = _getAdapter()!.prepare(`
    SELECT context.milestone_id, context.milestone_kind
    FROM workflow_milestone_contexts context
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_milestone_contexts successor
      WHERE successor.supersedes_context_id = context.context_id
    )
  `).all();
  return new Map(rows.map((row) => [String(row["milestone_id"]), String(row["milestone_kind"])]));
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

    const progress = readProgressCounts();

    const all = readMilestones();
    const kinds = readMilestoneKinds();
    const truncated = all.length > MAX_SNAPSHOT_MILESTONES;
    const milestones = {
      items: all.slice(0, MAX_SNAPSHOT_MILESTONES).map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        lifecycleStatus: normalizeCanonicalLifecycleStatus(m.lifecycleStatus),
        sequence: m.sequence,
        kind: kinds.get(m.id) ?? "delivery",
      })),
      truncated,
    };

    // The display read of the canonical blockers and questions goes through
    // the read interface, not the query module directly.
    const blockers = readOpenBlockers();
    const openQuestions = readOpenQuestions();

    return {
      authority,
      progress,
      blockers: blockers.slice(0, MAX_SNAPSHOT_OPEN_ITEMS),
      blockersTruncated: blockers.length > MAX_SNAPSHOT_OPEN_ITEMS,
      openQuestions: openQuestions.slice(0, MAX_SNAPSHOT_OPEN_ITEMS),
      openQuestionsTruncated: openQuestions.length > MAX_SNAPSHOT_OPEN_ITEMS,
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
 * Milestone order comes from milestones.sequence, never from QUEUE-ORDER.json.
 */
export async function readProjectSnapshotFromDb(
  basePath: string,
  opts: ReadProjectSnapshotOptions = {},
): Promise<DbProjectSnapshot | null> {
  const previousDbPath = opts.preserveGlobalDbHandle ? getDbPath() : null;
  try {
    const openedRequestedDb = ensureExistingWorkflowDbOpen(basePath);
    if (!openedRequestedDb || !isDbAvailable()) return null;

    invalidateStateCache();
    for (let attempt = 1; ; attempt++) {
      const before = readStabilityToken();
      const dbRead = readSnapshotDb();
      const state = await deriveState(basePath);
      const after = readStabilityToken();

      if (stabilityTokensMatch(before, after) || attempt === MAX_REVISION_ATTEMPTS) {
        noteSessionRead(dbRead.authority.revision);
        return {
          ...dbRead,
          lifecycleStatusVersion: LIFECYCLE_STATUS_VERSION,
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
