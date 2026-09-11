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
 * Returns true when a slice should be skipped during active-slice selection.
 * This includes both closed (complete/done) and deferred slices.
 */
export function isInactiveStatus(status: string): boolean {
  return isClosedStatus(status) || isDeferredStatus(status);
}

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
