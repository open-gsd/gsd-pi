/**
 * Status predicates and the canonical status vocabulary for GSD state-machine
 * guards (ADR-030).
 *
 * The DB column is free-form `string` so legacy/imported rows still load.
 * Canonical "complete"/"skipped" and legacy/imported "done", "closed", and
 * "cancelled" indicate closure. `RAW_CLOSED_STATUSES` is the single source for both
 * `isClosedStatus()` and the SQL terminal-status fragment
 * (`db/sql-constants.ts` derives `TERMINAL_STATUS_SQL` from it), replacing the
 * prior independent definitions.
 *
 * `toStatus()` is the single seam where a free-form string becomes the canonical
 * `Status` vocabulary; the Status Transition Core writes canonical, so the store
 * converges over time without a forced migration.
 */

/**
 * Canonical, normalized entity-status vocabulary across milestones, slices, and
 * tasks — the single source for both the `Status` type and the runtime
 * membership set. The in-memory domain speaks `Status`; the DB column stays
 * free-form.
 */
export const CANONICAL_STATUSES = [
  "pending", "queued", "active", "parked", "in_progress", "blocked", "complete", "skipped", "deferred",
] as const;
export type Status = (typeof CANONICAL_STATUSES)[number];
const CANONICAL_STATUS_SET: ReadonlySet<string> = new Set(CANONICAL_STATUSES);

/**
 * Raw status values that mean a unit is closed — the single source of truth.
 * Includes legacy/imported aliases ("done", "closed", "cancelled") alongside
 * canonical "complete"/"skipped" and the operator closeout disposition
 * "blocker-accepted" (#2202) because the DB column is free-form and older
 * rows / imports still carry them. Order matters: `TERMINAL_STATUS_SQL` is
 * derived from this array verbatim.
 */
export const RAW_CLOSED_STATUSES = [
  "complete", "done", "skipped", "closed", "cancelled", "blocker-accepted",
] as const;
const RAW_CLOSED_SET: ReadonlySet<string> = new Set(RAW_CLOSED_STATUSES);

/** Free-form aliases mapped to their canonical Status on read. */
const ALIAS_TO_CANONICAL: Readonly<Record<string, Status>> = {
  done: "complete",
  closed: "complete",
  cancelled: "skipped",
  planned: "pending",
  "in-progress": "in_progress",
};

/**
 * Normalize a free-form DB status string into the canonical `Status`
 * vocabulary. Maps known aliases (done/closed → complete, cancelled → skipped,
 * planned → pending, in-progress → in_progress). An unrecognized/legacy value
 * is **quarantined** — preserved verbatim rather than silently remapped to a
 * wrong canonical state — so reads never fail and reconciliation/telemetry can
 * surface it.
 */
export function toStatus(raw: string): Status {
  const value = raw.trim();
  if (CANONICAL_STATUS_SET.has(value)) return value as Status;
  const alias = ALIAS_TO_CANONICAL[value];
  if (alias) return alias;
  return value as Status;
}

/**
 * Canonical lifecycle status vocabulary (ADR-046): the values the workflow
 * lifecycle tables accept. Legacy hierarchy rows reach it only through
 * `normalizeLegacyLifecycleStatus()` / `adoptionLifecycleStatus()` below.
 */
export const LIFECYCLE_STATUSES = [
  "pending", "ready", "in_progress", "paused", "completed", "cancelled", "blocker-accepted",
] as const;
export type CanonicalLifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
const LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set(LIFECYCLE_STATUSES);

/**
 * The one legacy-to-canonical status map. Every raw closed status has an entry
 * (a legacy "cancelled" row is cancelled, not unknown). An unlisted raw value
 * normalizes to null so callers can surface it instead of guessing.
 */
const LEGACY_TO_LIFECYCLE_STATUS: Readonly<Record<string, CanonicalLifecycleStatus>> = {
  pending: "pending",
  queued: "pending",
  planned: "pending",
  active: "in_progress",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  blocked: "paused",
  parked: "paused",
  complete: "completed",
  done: "completed",
  closed: "completed",
  skipped: "cancelled",
  deferred: "cancelled",
  cancelled: "cancelled",
  // #2202: operator closeout disposition — the Task closed by accepting a
  // discovered blocker; terminal in both vocabularies.
  "blocker-accepted": "blocker-accepted",
};

export function normalizeLegacyLifecycleStatus(status: string | null): CanonicalLifecycleStatus | null {
  if (status === null) return null;
  return LEGACY_TO_LIFECYCLE_STATUS[status] ?? null;
}

export function normalizeCanonicalLifecycleStatus(status: string | null): CanonicalLifecycleStatus | null {
  if (status === null || !LIFECYCLE_STATUS_SET.has(status)) return null;
  return status as CanonicalLifecycleStatus;
}

/** An adoption seam met a legacy status that the one map does not list. */
export class UnknownLegacyStatusError extends Error {
  readonly row: string;
  readonly rawStatus: string | null;
  constructor(row: string, rawStatus: string | null) {
    super(`cannot adopt ${row}: unknown legacy status ${JSON.stringify(rawStatus)}`);
    this.name = "UnknownLegacyStatusError";
    this.row = row;
    this.rawStatus = rawStatus;
  }
}

/**
 * The lifecycle status a legacy hierarchy row is adopted with — the single
 * mapping every adoption seam uses. An unknown or null legacy status refuses
 * with `UnknownLegacyStatusError`. A seam that plans the row passes
 * `openStatus`: a completed or cancelled row keeps its status and every other
 * row adopts as `openStatus`. Without `openStatus` the row keeps its legacy
 * meaning, except that in-flight adopts as `ready`. Adoption never yields
 * `in_progress`: that state is only truthful with an Attempt behind it, and
 * adoption creates none.
 */
export function adoptionLifecycleStatus(
  row: string,
  legacyStatus: string | null,
  openStatus?: "ready" | "pending",
): Exclude<CanonicalLifecycleStatus, "in_progress"> {
  const normalized = normalizeLegacyLifecycleStatus(legacyStatus);
  if (normalized === null) throw new UnknownLegacyStatusError(row, legacyStatus);
  if (openStatus) return normalized === "completed" || normalized === "cancelled" ? normalized : openStatus;
  return normalized === "in_progress" ? "ready" : normalized;
}

/** Returns true when a milestone, slice, or task status indicates closure. */
export function isClosedStatus(status: string): boolean {
  return RAW_CLOSED_SET.has(status);
}

/**
 * Returns true when a slice is omitted from the rendered ROADMAP projection.
 *
 * #1623: `renderRoadmapFromDb` drops skipped slices, but roadmap-divergence
 * detection treated them as "ready" (because `isClosedStatus("skipped")` is
 * true) and therefore expected them to appear in ROADMAP.md. A skipped slice
 * then produced permanent drift: re-rendering could never add a row the
 * renderer deliberately omits, so `/gsd auto` paused with "drift persisted
 * after cap=2 passes". Both sides now share this single predicate.
 */
export function isHiddenFromRoadmap(status: string): boolean {
  return status === "skipped";
}

/** Returns true when a slice status indicates it was deferred by a decision. */
export function isDeferredStatus(status: string): boolean {
  return status === "deferred";
}

/**
 * Returns true when a slice needs no further work: it is closed, or it was
 * deferred by a decision. Deferred is terminal in the read model (it maps to
 * canonical `cancelled`), so it does not block later slices or closeout. Every
 * reader that asks "is this slice still open?" uses this predicate.
 */
export function isInactiveStatus(status: string): boolean {
  return isClosedStatus(status) || isDeferredStatus(status);
}

/**
 * Returns true when a milestone was discarded: its row is a tombstone that
 * keeps the id reserved. A discarded milestone is not complete, is not listed
 * in state or top-level renders, and has no projection files.
 */
export function isDiscardedMilestoneStatus(status: string): boolean {
  return normalizeLegacyLifecycleStatus(status) === "cancelled";
}

/** Every raw status that marks a milestone as discarded; the source of `DISCARDED_MILESTONE_STATUS_SQL`. */
export const RAW_DISCARDED_MILESTONE_STATUSES = Object.keys(LEGACY_TO_LIFECYCLE_STATUS).filter(isDiscardedMilestoneStatus);

/** Returns true when a prior milestone should not block dispatch ordering. */
export function isSkippedForDispatch(status: string): boolean {
  return isClosedStatus(status) || status === "parked" || isDeferredStatus(status);
}

/**
 * Returns true when a milestone is future/backlog work (not currently executing).
 * Includes legacy/project-specific alias "planned" for compatibility.
 */
export function isFutureMilestoneStatus(status: string): boolean {
  return status === "pending" || status === "queued" || status === "planned";
}
