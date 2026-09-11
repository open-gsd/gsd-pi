// Project/App: gsd-pi
// File Purpose: Pure semantic comparison between legacy hierarchy and canonical lifecycle statuses.

export type LifecycleShadowComparisonKind =
  | "match"
  | "semantic_match_exact_delta"
  | "missing_shadow"
  | "extra_shadow"
  | "status_mismatch";

export type CanonicalLifecycleStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "paused"
  | "completed"
  | "cancelled"
  | "blocker-accepted";

export interface LifecycleShadowComparison {
  kind: LifecycleShadowComparisonKind;
  legacyStatus: string | null;
  canonicalStatus: string | null;
  normalizedLegacyStatus: string | null;
  normalizedCanonicalStatus: string | null;
}

const LEGACY_STATUS_MAP: Readonly<Record<string, CanonicalLifecycleStatus>> = {
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
  // #2202: operator closeout disposition — the Task closed by accepting a
  // discovered blocker; terminal in both vocabularies.
  "blocker-accepted": "blocker-accepted",
};

const CANONICAL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "ready",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
  "blocker-accepted",
]);

export function normalizeLegacyLifecycleStatus(status: string | null): CanonicalLifecycleStatus | null {
  if (status === null) return null;
  return LEGACY_STATUS_MAP[status] ?? null;
}

export function normalizeCanonicalLifecycleStatus(status: string | null): CanonicalLifecycleStatus | null {
  if (status === null || !CANONICAL_STATUSES.has(status)) return null;
  return status as CanonicalLifecycleStatus;
}

function isSemanticMatch(
  normalizedLegacyStatus: string | null,
  normalizedCanonicalStatus: string | null,
): boolean {
  if (normalizedLegacyStatus === null || normalizedCanonicalStatus === null) return false;
  if (normalizedLegacyStatus === normalizedCanonicalStatus) return true;
  return normalizedCanonicalStatus === "ready" && (
    normalizedLegacyStatus === "pending" || normalizedLegacyStatus === "in_progress"
  );
}

export function compareLifecycleShadow(
  legacyStatus: string | null,
  canonicalStatus: string | null,
): LifecycleShadowComparison {
  const normalizedLegacyStatus = normalizeLegacyLifecycleStatus(legacyStatus);
  const normalizedCanonicalStatus = normalizeCanonicalLifecycleStatus(canonicalStatus);
  let kind: LifecycleShadowComparisonKind;

  if (legacyStatus !== null && canonicalStatus === null) {
    kind = "missing_shadow";
  } else if (legacyStatus === null && canonicalStatus !== null) {
    kind = "extra_shadow";
  } else if (
    legacyStatus === canonicalStatus &&
    normalizedLegacyStatus !== null &&
    normalizedCanonicalStatus !== null
  ) {
    kind = "match";
  } else if (isSemanticMatch(normalizedLegacyStatus, normalizedCanonicalStatus)) {
    kind = "semantic_match_exact_delta";
  } else {
    kind = "status_mismatch";
  }

  return {
    kind,
    legacyStatus,
    canonicalStatus,
    normalizedLegacyStatus,
    normalizedCanonicalStatus,
  };
}
