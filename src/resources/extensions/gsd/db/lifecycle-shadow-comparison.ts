// Project/App: gsd-pi
// File Purpose: Pure semantic comparison between legacy hierarchy and canonical lifecycle statuses.

import {
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
} from "../status-guards.js";

export type LifecycleShadowComparisonKind =
  | "match"
  | "semantic_match_exact_delta"
  | "missing_shadow"
  | "extra_shadow"
  | "status_mismatch";

// The status vocabulary and the legacy-to-canonical map live in
// status-guards.ts; re-exported here for existing importers.
export { normalizeCanonicalLifecycleStatus, normalizeLegacyLifecycleStatus };
export type { CanonicalLifecycleStatus } from "../status-guards.js";

export interface LifecycleShadowComparison {
  kind: LifecycleShadowComparisonKind;
  legacyStatus: string | null;
  canonicalStatus: string | null;
  normalizedLegacyStatus: string | null;
  normalizedCanonicalStatus: string | null;
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
