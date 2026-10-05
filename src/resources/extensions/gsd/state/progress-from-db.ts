// Project/App: gsd-pi
// File Purpose: DB-authoritative progress reads for integration surfaces
// (`gsd read progress`, packaged MCP `gsd_progress`). ADR-046: the database
// is the sole workflow authority, so integration reads must not serve
// projection data that can lag it.

import { deriveState, invalidateStateCache } from "./derive/index.js";
import { ensureExistingWorkflowDbOpen } from "./derive/db-open.js";
import {
  getProgressHierarchyDetails,
  getProjectAuthorityVersion,
  isDbAvailable,
  _getAdapter,
  readTransaction,
} from "../gsd-db.js";
import { readOpenBlockers, readProgressCounts, type OpenBlockerRow, type ProgressCounts } from "../db/lifecycle-read.js";
import type { ProjectProgressReadMetadata } from "@opengsd/contracts";
import type { GSDState } from "../types.js";

const MAX_REVISION_ATTEMPTS = 3;
const DB_READ_METADATA: ProjectProgressReadMetadata = {
  source: "database",
  authority: "db-authoritative",
};

/**
 * Structural mirror of `ProgressResult`
 * (packages/mcp-server/src/readers/state.ts). Kept local so the extension
 * bundle does not import from packages/; the exact key set is pinned by
 * tests/progress-from-db.test.ts.
 */
export interface DbProgressResult {
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  phase: string;
  milestones: { total: number; done: number; active: number; pending: number; parked: number };
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
  requirements: { active: number; validated: number; deferred: number; outOfScope: number } | null;
  blockers: string[];
  /**
   * The open canonical blocker rows at the revision of this read — the same
   * rows the project snapshot returns, so progress and snapshot give equal
   * blockers at one revision. The projection fallback never sets it.
   */
  blockerRows?: OpenBlockerRow[];
  nextAction: string;
  readMetadata?: ProjectProgressReadMetadata;
}

export interface DbProjectProgressResult extends DbProgressResult {
  milestoneDetails?: Array<{
    id: string;
    title: string;
    status: string;
    truncated: boolean;
    slices: Array<{
      id: string;
      title: string;
      status: string;
      truncated: boolean;
      tasks: Array<{ id: string; title: string; status: string }>;
    }>;
  }>;
  milestoneDetailsTruncated?: boolean;
  milestoneDetailsTasksTruncated?: boolean;
}

function toRef(value: { id: string; title: string } | null): { id: string; title: string } | null {
  return value ? { id: value.id, title: value.title } : null;
}

interface ProgressStabilityToken {
  revision: number;
  authorityEpoch: number;
  dataVersion: number;
}

function readProgressStabilityToken(): ProgressStabilityToken {
  const authority = getProjectAuthorityVersion();
  const row = _getAdapter()?.prepare("PRAGMA data_version").get();
  const dataVersion = Number(row?.["data_version"]);
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) {
    throw new Error("GSD database data version is not available");
  }
  return { ...authority, dataVersion };
}

function stabilityTokensMatch(
  before: ProgressStabilityToken,
  after: ProgressStabilityToken,
): boolean {
  return before.revision === after.revision
    && before.authorityEpoch === after.authorityEpoch
    && before.dataVersion === after.dataVersion;
}

function buildProgressResult(
  state: GSDState,
  counts: ProgressCounts,
  blockerRows: OpenBlockerRow[],
): DbProgressResult {
  return {
    activeMilestone: toRef(state.activeMilestone),
    activeSlice: toRef(state.activeSlice),
    activeTask: toRef(state.activeTask),
    phase: state.phase,
    ...counts,
    requirements:
      state.requirements && state.requirements.total > 0
        ? {
            active: state.requirements.active,
            validated: state.requirements.validated,
            deferred: state.requirements.deferred,
            outOfScope: state.requirements.outOfScope,
          }
        : null,
    blockers: [...state.blockers],
    blockerRows: [...blockerRows],
    nextAction: state.nextAction,
    readMetadata: { ...DB_READ_METADATA },
  };
}

async function readProgressFromDbInternal(
  basePath: string,
  includeHierarchyDetails: boolean,
  throwOnOpenFailure: boolean,
): Promise<DbProgressResult | DbProjectProgressResult | null> {
  const openedRequestedDb = ensureExistingWorkflowDbOpen(basePath, {
    throwOnOpenFailure,
  });
  if (!openedRequestedDb || !isDbAvailable()) return null;

  invalidateStateCache();
  for (let attempt = 1; ; attempt++) {
    const before = readProgressStabilityToken();
    const state = await deriveState(basePath);
    // The counts and the canonical blocker rows come out of one read
    // transaction, so a progress result and a snapshot at the same revision
    // give the same counts and the same blockers.
    const { counts, blockerRows } = readTransaction(() => ({
      counts: readProgressCounts(),
      blockerRows: readOpenBlockers(),
    }));
    const progress = buildProgressResult(state, counts, blockerRows);
    const details = includeHierarchyDetails ? getProgressHierarchyDetails() : undefined;
    const result: DbProgressResult | DbProjectProgressResult = details
      ? {
          ...progress,
          milestoneDetails: details.milestones,
          milestoneDetailsTruncated: details.milestonesTruncated,
          milestoneDetailsTasksTruncated: details.tasksTruncated,
        }
      : progress;
    const after = readProgressStabilityToken();

    if (stabilityTokensMatch(before, after)) return result;
    if (attempt === MAX_REVISION_ATTEMPTS) return result;
    invalidateStateCache();
  }
}

/**
 * Derive the integration progress payload from the database. `deriveState`
 * supplies current refs, phase, blockers, and next action (the same source
 * the runtime and auto-mode use); project-wide milestone/slice/task counts
 * come from the read seam, since `deriveState` may be execution-scoped while
 * `ProgressResult` buckets are project-wide.
 *
 * Note: the derive open path runs pending migrations when required.
 * Results are bound to stable authority and data-version tokens; under
 * sustained concurrent commits or same-process interleaved writes, a snapshot
 * may still straddle revisions.
 */
export async function readProgressFromDb(basePath: string): Promise<DbProgressResult | null> {
  return await readProgressFromDbInternal(basePath, false, false) as DbProgressResult | null;
}

/** Detailed bounded progress is host-only; established CLI and MCP reads retain ProgressResult. */
export async function readProjectProgressFromDb(basePath: string): Promise<DbProjectProgressResult | null> {
  return await readProgressFromDbInternal(basePath, true, true) as DbProjectProgressResult | null;
}
