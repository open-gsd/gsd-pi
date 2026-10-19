// GSD Extension — Routing History (Adaptive Learning)
// Tracks success/failure per tier per unit-type pattern to improve
// classification accuracy over time. The history is one runtime_kv row in the
// project database; no file is read or written.

import type { ComplexityTier } from "./types.js";
import { getRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import { isDbAvailable } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TierOutcome {
  success: number;
  fail: number;
}

export interface PatternHistory {
  light: TierOutcome;
  standard: TierOutcome;
  heavy: TierOutcome;
}

export interface RoutingHistoryData {
  version: 1;
  /** Keyed by pattern string, e.g. "execute-task:docs" or "complete-slice" */
  patterns: Record<string, PatternHistory>;
  /** User feedback entries (from /gsd:rate-unit) */
  feedback: FeedbackEntry[];
  /** Last updated timestamp */
  updatedAt: string;
}

export interface FeedbackEntry {
  unitType: string;
  unitId: string;
  tier: ComplexityTier;
  rating: "over" | "under" | "ok";
  timestamp: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HISTORY_KV_KEY = "routing_history";
const ROLLING_WINDOW = 50;        // only consider last N entries per pattern
const FAILURE_THRESHOLD = 0.20;   // >20% failure rate triggers tier bump
const FEEDBACK_WEIGHT = 2;        // feedback signals count 2x vs automatic

// ─── In-Memory State ─────────────────────────────────────────────────────────

let history: RoutingHistoryData | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize routing history from the open project database.
 */
export function initRoutingHistory(): void {
  history = loadHistory();
}

/**
 * Reset routing history state.
 */
export function resetRoutingHistory(): void {
  history = null;
}

/**
 * Record the outcome of a unit dispatch.
 *
 * @param unitType  The unit type (e.g. "execute-task")
 * @param tier      The tier that was used
 * @param success   Whether the unit completed successfully
 * @param tags      Optional tags from task metadata (e.g. ["docs", "test"])
 */
export function recordOutcome(
  unitType: string,
  tier: ComplexityTier,
  success: boolean,
  tags?: string[],
): void {
  if (!history) return;

  // Record for the base unit type
  const basePattern = unitType;
  ensurePattern(basePattern);
  const outcome = history.patterns[basePattern][tier];
  if (success) outcome.success++;
  else outcome.fail++;

  // Record for tag-specific patterns (e.g. "execute-task:docs")
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      const tagPattern = `${unitType}:${tag}`;
      ensurePattern(tagPattern);
      const tagOutcome = history.patterns[tagPattern][tier];
      if (success) tagOutcome.success++;
      else tagOutcome.fail++;
    }
  }

  // Apply rolling window — cap total entries per tier per pattern
  for (const pattern of Object.keys(history.patterns)) {
    const p = history.patterns[pattern];
    for (const t of ["light", "standard", "heavy"] as const) {
      const total = p[t].success + p[t].fail;
      if (total > ROLLING_WINDOW) {
        const scale = ROLLING_WINDOW / total;
        p[t].success = Math.round(p[t].success * scale);
        p[t].fail = Math.round(p[t].fail * scale);
      }
    }
  }

  history.updatedAt = new Date().toISOString();
  saveHistory(history);
}

/**
 * Record user feedback for the last completed unit.
 * Returns false when the rating was not stored in the database.
 */
export function recordFeedback(
  unitType: string,
  unitId: string,
  tier: ComplexityTier,
  rating: "over" | "under" | "ok",
): boolean {
  if (!history) return false;

  history.feedback.push({
    unitType,
    unitId,
    tier,
    rating,
    timestamp: new Date().toISOString(),
  });

  // Cap feedback array at 200 entries
  if (history.feedback.length > 200) {
    history.feedback = history.feedback.slice(-200);
  }

  // Apply feedback as weighted outcome
  const pattern = unitType;
  ensurePattern(pattern);

  if (rating === "over") {
    // User says this could have used a simpler model → record as success at current tier
    // and also as success at one tier lower (encourages more downgrading)
    const lower = tierBelow(tier);
    if (lower) {
      const outcomes = history.patterns[pattern][lower];
      outcomes.success += FEEDBACK_WEIGHT;
    }
  } else if (rating === "under") {
    // User says this needed a better model → record as failure at current tier
    const outcomes = history.patterns[pattern][tier];
    outcomes.fail += FEEDBACK_WEIGHT;
  }
  // "ok" = no adjustment needed

  history.updatedAt = new Date().toISOString();
  return saveHistory(history);
}

/**
 * Get the recommended tier adjustment for a given pattern.
 * Returns the tier to bump to if the failure rate exceeds threshold,
 * or null if no adjustment is needed.
 */
export function getAdaptiveTierAdjustment(
  unitType: string,
  currentTier: ComplexityTier,
  tags?: string[],
): ComplexityTier | null {
  if (!history) return null;

  // Check tag-specific patterns first (more specific)
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      const tagPattern = `${unitType}:${tag}`;
      const adjustment = checkPatternFailureRate(tagPattern, currentTier);
      if (adjustment) return adjustment;
    }
  }

  // Fall back to base pattern
  return checkPatternFailureRate(unitType, currentTier);
}

/**
 * Clear all routing history (user-triggered reset).
 */
export function clearRoutingHistory(): boolean {
  history = createEmptyHistory();
  return saveHistory(history);
}

/**
 * Get current history data (for display/debugging).
 */
export function getRoutingHistory(): RoutingHistoryData | null {
  return history;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function checkPatternFailureRate(
  pattern: string,
  tier: ComplexityTier,
): ComplexityTier | null {
  if (!history?.patterns[pattern]) return null;

  const outcomes = history.patterns[pattern][tier];
  const total = outcomes.success + outcomes.fail;
  if (total < 3) return null; // Not enough data

  const failureRate = outcomes.fail / total;
  if (failureRate > FAILURE_THRESHOLD) {
    // Bump to next tier
    return tierAbove(tier);
  }

  return null;
}

function tierAbove(tier: ComplexityTier): ComplexityTier | null {
  switch (tier) {
    case "light": return "standard";
    case "standard": return "heavy";
    case "heavy": return null;
  }
}

function tierBelow(tier: ComplexityTier): ComplexityTier | null {
  switch (tier) {
    case "light": return null;
    case "standard": return "light";
    case "heavy": return "standard";
  }
}

function ensurePattern(pattern: string): void {
  if (!history) return;
  if (!history.patterns[pattern]) {
    history.patterns[pattern] = {
      light: { success: 0, fail: 0 },
      standard: { success: 0, fail: 0 },
      heavy: { success: 0, fail: 0 },
    };
  }
}

function createEmptyHistory(): RoutingHistoryData {
  return {
    version: 1,
    patterns: {},
    feedback: [],
    updatedAt: new Date().toISOString(),
  };
}

function isRoutingHistoryData(data: unknown): data is RoutingHistoryData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as RoutingHistoryData).version === 1 &&
    typeof (data as RoutingHistoryData).patterns === "object" &&
    (data as RoutingHistoryData).patterns !== null
  );
}

function loadHistory(): RoutingHistoryData {
  const stored = getRuntimeKv("global", "", HISTORY_KV_KEY);
  return isRoutingHistoryData(stored) ? stored : createEmptyHistory();
}

function saveHistory(data: RoutingHistoryData): boolean {
  // Without a database the history lives for this process only.
  if (!isDbAvailable()) return false;
  try {
    setRuntimeKv("global", "", HISTORY_KV_KEY, data);
    return true;
  } catch (err) {
    // Learning data only: a failed write must not stop the unit that reports its outcome.
    logWarning("db", `routing history not stored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
