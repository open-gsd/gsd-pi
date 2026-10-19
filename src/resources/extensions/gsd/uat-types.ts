// Project/App: gsd-pi
// File Purpose: Canonical UAT type definitions shared without importing files.ts.

/**
 * The four UAT classification types recognised by GSD auto-mode.
 * `undefined` is returned (not this union) when no type can be determined.
 */
export type UatType =
  | "artifact-driven"
  | "live-runtime"
  | "human-experience"
  | "mixed"
  | "browser-executable"
  | "runtime-executable";

/** Canonical list of recognised UAT types — uat-policy.ts re-exports this as UAT_TYPES. */
export const UAT_TYPE_KEYWORDS: readonly UatType[] = [
  "artifact-driven",
  "browser-executable",
  "runtime-executable",
  "live-runtime",
  "mixed",
  "human-experience",
];
