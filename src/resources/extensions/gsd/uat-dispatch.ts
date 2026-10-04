// Project/App: gsd-pi
// File Purpose: Resolve whether a completed slice needs run-uat dispatch.

import {
  getSlice,
  getSliceRunUatAssessment,
  getSliceScopedArtifacts,
} from "./gsd-db.js";
import type { GSDPreferences } from "./preferences.js";
import {
  classifyUatContentForRun,
  shouldDispatchUatForContent,
  type UatType,
} from "./uat-policy.js";
import { isAcceptableUatVerdict } from "./verdict-parser.js";
import { logWarning } from "./workflow-logger.js";

export interface UatDispatchCandidate {
  sliceId: string;
}

export type RunUatDispatch = { sliceId: string; uatType: UatType };
export interface RunUatDispatchOptions {
  retryNonPass?: boolean;
}

/**
 * UAT spec of a slice, from the database: the slice UAT column, else a saved
 * UAT artifact row. The rendered UAT file is a projection and is not read.
 */
export function readSliceUatSpec(milestoneId: string, sliceId: string): string {
  return getSlice(milestoneId, sliceId)?.full_uat_md
    || getSliceScopedArtifacts(milestoneId, sliceId).find((row) => row.artifact_type === "UAT")?.full_content
    || "";
}

/**
 * True when the slice's recorded UAT verdict predates the milestone's current
 * accepted closeout authorization (validation pass receipt or active waiver).
 * Such a verdict was already in front of the validator when it accepted the
 * milestone, so re-running it cannot change closeout and only re-trips the
 * completed-no-advance liveness backstop (#2347). When authorization, receipt
 * timestamp, or slice UAT timestamp cannot be established, this fails open so
 * the existing retry behavior is unchanged.
 */
async function uatRetryPredatesAcceptedValidation(
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (!isDbAvailable()) return false;
    const {
      readMilestoneCloseoutAuthorization,
      readMilestoneValidationReceiptRecordedAt,
    } = await import("./db/milestone-closeout-readiness.js");
    const authorization = readMilestoneCloseoutAuthorization({ milestoneId });
    if (!authorization.authorized) return false;
    const validationRecordedAt = readMilestoneValidationReceiptRecordedAt(milestoneId);
    if (!validationRecordedAt) return false;
    const { getSliceRunUatAssessmentRecordedAt } = await import("./gsd-db.js");
    const sliceUatRecordedAt = getSliceRunUatAssessmentRecordedAt(milestoneId, sliceId);
    if (!sliceUatRecordedAt) return false;
    // Compare parsed instants, not raw strings: assessment rows may carry
    // non-canonical timestamps (offsets, truncated precision, or restore
    // artifacts). Unparseable either side fails open to preserve retries.
    const sliceUatAt = Date.parse(sliceUatRecordedAt);
    const validationAt = Date.parse(validationRecordedAt);
    if (!Number.isFinite(sliceUatAt) || !Number.isFinite(validationAt)) return false;
    return sliceUatAt < validationAt;
  } catch (err) {
    logWarning(
      "prompt",
      `uatRetryPredatesAcceptedValidation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function resolveCandidateRunUatDispatch(
  milestoneId: string,
  candidate: UatDispatchCandidate,
  prefs: GSDPreferences | undefined,
  options: RunUatDispatchOptions,
): Promise<RunUatDispatch | null> {
  const uatContent = readSliceUatSpec(milestoneId, candidate.sliceId);
  if (!uatContent) return null;

  const uatType = classifyUatContentForRun(
    uatContent,
    getSlice(milestoneId, candidate.sliceId)?.full_summary_md ?? "",
  ).effectiveType;
  // The saved run-uat row is the only UAT verdict. A verdict line in a
  // rendered UAT or ASSESSMENT file decides nothing.
  const verdict = getSliceRunUatAssessment(milestoneId, candidate.sliceId)?.status;
  if (verdict) {
    if (!options.retryNonPass || isAcceptableUatVerdict(verdict, uatType)) return null;
    if (await uatRetryPredatesAcceptedValidation(milestoneId, candidate.sliceId)) return null;
  }
  if (!shouldDispatchUatForContent(uatContent, prefs)) return null;

  return {
    sliceId: candidate.sliceId,
    uatType,
  };
}

async function getDbCompletedSliceCandidates(
  milestoneId: string,
): Promise<UatDispatchCandidate[] | null> {
  const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
  if (!isDbAvailable()) return null;

  const slices = getMilestoneSlices(milestoneId);
  // No DB slice rows for this milestone: the DB has no authoritative view, so
  // return null to let the caller defer to the roadmap fallback.
  if (slices.length === 0) return null;

  // The DB has slice rows and is therefore authoritative for this milestone.
  // Return a (possibly empty) array rather than null: an empty result must NOT
  // fall through to the roadmap fallback, because the DB, not stale roadmap
  // checkboxes, is the source of truth for which slices are complete.
  return slices
    .filter((slice) => slice.status === "complete")
    .map((slice) => ({ sliceId: slice.id }))
    .reverse();
}

export async function findRunUatDispatchFromCandidates(
  _base: string,
  milestoneId: string,
  candidates: readonly UatDispatchCandidate[],
  prefs: GSDPreferences | undefined,
  options: RunUatDispatchOptions = {},
): Promise<RunUatDispatch | null> {
  for (const candidate of candidates) {
    const dispatch = await resolveCandidateRunUatDispatch(
      milestoneId,
      candidate,
      prefs,
      options,
    );
    if (dispatch) return dispatch;
  }
  return null;
}

/**
 * Check if the most recently completed slice needs a UAT run.
 * Returns { sliceId, uatType } if UAT should be dispatched, null otherwise.
 *
 * When the DB has slice rows for the milestone it is authoritative: only its
 * completed slices are considered and the `fallbackCandidates` (roadmap-derived)
 * are ignored, even when no DB slice is complete. The fallback candidates are
 * only consulted when the DB has no slice rows for the milestone, is
 * unavailable, or errors.
 *
 * Skips when:
 * - No completed slices exist in DB or the caller-provided fallback candidates
 * - uat_dispatch is not enabled and the UAT spec does not require runtime/browser evidence
 * - The slice has no UAT spec in the database
 * - A run-uat verdict row already exists, unless milestone closeout requested
 *   a retry of a non-acceptable verdict
 */
export async function checkNeedsRunUat(
  base: string,
  milestoneId: string,
  prefs: GSDPreferences | undefined,
  fallbackCandidates: readonly UatDispatchCandidate[] = [],
  options: RunUatDispatchOptions = {},
): Promise<RunUatDispatch | null> {
  try {
    const dbCandidates = await getDbCompletedSliceCandidates(milestoneId);
    // A non-null result (including an empty array) means the DB is authoritative
    // for this milestone; only fall through to the roadmap fallback when the DB
    // has no slice rows at all (null).
    if (dbCandidates !== null) {
      return findRunUatDispatchFromCandidates(
        base,
        milestoneId,
        dbCandidates,
        prefs,
        options,
      );
    }
  } catch (err) {
    logWarning(
      "prompt",
      `checkNeedsRunUat DB lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return findRunUatDispatchFromCandidates(
    base,
    milestoneId,
    fallbackCandidates,
    prefs,
    options,
  );
}
