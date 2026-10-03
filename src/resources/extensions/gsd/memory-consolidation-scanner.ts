// gsd-pi — ADR-013 Phase 6 preflight scanner.
//
// Read-only detection of rows in the legacy knowledge surfaces (decisions
// table, `.gsd/KNOWLEDGE.md`) that lack a corresponding `memories` row.
// Runs on session start (and on demand via doctor); never mutates state.
//
// The scanner exists so the destructive Phase 6 cutover (#5755) can prove
// the migration is complete before any tables are dropped. Today's
// `backfillDecisionsToMemories` writes a `structured_fields.sourceDecisionId`
// marker on each migrated row; the scanner uses that marker for decisions
// detection. KNOWLEDGE.md Rules, Patterns and Lessons are captured as
// memories rows with a `sourceKnowledgeId` (K/P/L###). A KNOWLEDGE.md row
// whose id has no such row exists only in the file: it is not imported into
// the database, and the scanner reports it as a gap. Session start never
// imports it.

import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { parseKnowledgeRows, readKnowledgeMd } from "./knowledge-parser.js";
import { appendNotification } from "./notification-store.js";
import { logWarning } from "./workflow-logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeSurfaceReport {
  total: number;
  migrated: number;
  unmigrated: number;
  byTable: { rules: number; patterns: number; lessons: number };
  /** Up to 5 sample row IDs/content for diagnosing what's unmigrated. */
  samples: Array<{ table: "rules" | "patterns" | "lessons"; id: string; row: string }>;
}

export interface DecisionsSurfaceReport {
  total: number;
  migrated: number;
  unmigrated: number;
  /** Up to 5 sample decision IDs with a short content excerpt. */
  samples: Array<{ id: string; decision: string }>;
}

export interface ConsolidationGapReport {
  decisions: DecisionsSurfaceReport;
  knowledge: KnowledgeSurfaceReport;
  /** Sum of unmigrated rows across both surfaces. Zero ⇒ clean preflight. */
  totalGaps: number;
  /** Human-readable single-line summary suitable for notifications + logs. */
  summary: string;
}

// ─── DB queries ──────────────────────────────────────────────────────────────

interface DecisionRow {
  id: string;
  decision: string;
}

function getActiveDecisions(): DecisionRow[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    const rows = adapter
      .prepare(
        "SELECT id, decision FROM decisions WHERE superseded_by IS NULL",
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .map((row): DecisionRow => ({
        id: String(row["id"] ?? ""),
        decision: String(row["decision"] ?? ""),
      }))
      .filter((row) => row.id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Source IDs already present in memory `structured_fields`. Collected with one
 * pass over the memories table so the scanner does not perform a non-indexable
 * LIKE probe for every decision and KNOWLEDGE.md row.
 */
interface MemorySourceMarkers {
  decisionIds: Set<string>;
  knowledgeIds: Set<string>;
}

function emptyMemorySourceMarkers(): MemorySourceMarkers {
  return { decisionIds: new Set(), knowledgeIds: new Set() };
}

function getMemorySourceMarkers(): MemorySourceMarkers {
  const markers = emptyMemorySourceMarkers();
  if (!isDbAvailable()) return markers;
  const adapter = _getAdapter();
  if (!adapter) return markers;
  try {
    const rows = adapter
      .prepare("SELECT structured_fields FROM memories WHERE structured_fields IS NOT NULL")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      collectMemorySourceMarker(markers, row["structured_fields"]);
    }
  } catch {
    return markers;
  }
  return markers;
}

function collectMemorySourceMarker(markers: MemorySourceMarkers, raw: unknown): void {
  if (typeof raw !== "string" || raw.length === 0) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const fields = parsed as Record<string, unknown>;
    const decisionId = fields["sourceDecisionId"];
    if (typeof decisionId === "string" && decisionId.length > 0) {
      markers.decisionIds.add(decisionId);
    }
    const knowledgeId = fields["sourceKnowledgeId"];
    if (typeof knowledgeId === "string" && knowledgeId.length > 0) {
      markers.knowledgeIds.add(knowledgeId);
    }
  } catch {
    return;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

const SAMPLE_LIMIT = 5;

/**
 * Scan the legacy knowledge surfaces and return a structured report of what's
 * already in the `memories` table vs what's still unmigrated. Pure detection
 * — no DB writes, no file writes, no notifications.
 */
export function scanConsolidationGaps(basePath: string): ConsolidationGapReport {
  // ── Decisions ────────────────────────────────────────────────────────
  const decisions = getActiveDecisions();
  const knowledgeRows = parseKnowledgeRows(readKnowledgeMd(basePath));
  const memorySourceMarkers = decisions.length > 0 || knowledgeRows.length > 0
    ? getMemorySourceMarkers()
    : emptyMemorySourceMarkers();
  const decisionSamples: DecisionsSurfaceReport["samples"] = [];
  let decisionMigrated = 0;
  for (const decision of decisions) {
    if (memorySourceMarkers.decisionIds.has(decision.id)) {
      decisionMigrated += 1;
      continue;
    }
    if (decisionSamples.length < SAMPLE_LIMIT) {
      decisionSamples.push({
        id: decision.id,
        decision: decision.decision.length > 80 ? decision.decision.slice(0, 79) + "…" : decision.decision,
      });
    }
  }

  // ── KNOWLEDGE.md ─────────────────────────────────────────────────────
  const knowledgeByTable = { rules: 0, patterns: 0, lessons: 0 };
  const knowledgeSamples: KnowledgeSurfaceReport["samples"] = [];
  let knowledgeMigrated = 0;
  for (const row of knowledgeRows) {
    knowledgeByTable[row.table] += 1;
    // Captured knowledge rows carry `sourceKnowledgeId`; a file row whose id
    // has no memories row is not imported yet and is reported as a gap.
    if (memorySourceMarkers.knowledgeIds.has(row.id)) {
      knowledgeMigrated += 1;
      continue;
    }
    if (knowledgeSamples.length < SAMPLE_LIMIT) {
      knowledgeSamples.push({
        table: row.table,
        id: row.id,
        row: row.raw.length > 100 ? row.raw.slice(0, 99) + "…" : row.raw,
      });
    }
  }

  const decisionsReport: DecisionsSurfaceReport = {
    total: decisions.length,
    migrated: decisionMigrated,
    unmigrated: decisions.length - decisionMigrated,
    samples: decisionSamples,
  };
  const knowledgeReport: KnowledgeSurfaceReport = {
    total: knowledgeRows.length,
    migrated: knowledgeMigrated,
    unmigrated: knowledgeRows.length - knowledgeMigrated,
    byTable: knowledgeByTable,
    samples: knowledgeSamples,
  };

  const totalGaps = decisionsReport.unmigrated + knowledgeReport.unmigrated;

  // Summary line is intentionally short so it fits in a single notification
  // (notification-store truncates messages over 500 chars). Detail is
  // accessible via getProviderSwitchStats-style callers, not embedded here.
  const parts: string[] = [];
  if (decisionsReport.unmigrated > 0) {
    parts.push(`${decisionsReport.unmigrated} of ${decisionsReport.total} active decisions`);
  }
  if (knowledgeReport.unmigrated > 0) {
    parts.push(`${knowledgeReport.unmigrated} of ${knowledgeReport.total} KNOWLEDGE.md rows`);
  }
  const summary =
    parts.length === 0
      ? "Memory consolidation: all decisions and KNOWLEDGE.md rows are in memories."
      : `Memory consolidation: ${parts.join(" and ")} not yet in memories table. Run /doctor for details.`;

  return { decisions: decisionsReport, knowledge: knowledgeReport, totalGaps, summary };
}

/**
 * Run the scanner and emit a persistent notification + workflow-logger
 * warning when gaps exist. Best-effort: never throws; a broken scanner
 * cannot block agent startup.
 *
 * Returns the full {@link ConsolidationGapReport} regardless of whether gaps
 * exist (including when `totalGaps === 0`). Returns `null` only when
 * `scanConsolidationGaps` itself throws. `appendNotification` and
 * `logWarning` are called only when `report.totalGaps > 0`.
 *
 * Idempotent at the surface: the notification store applies its own
 * 30-second dedup window keyed on (severity, source, message), so repeated
 * boots with identical gaps produce one notification, not a flood.
 */
export function reportConsolidationGaps(basePath: string): ConsolidationGapReport | null {
  try {
    const report = scanConsolidationGaps(basePath);
    if (report.totalGaps === 0) return report;
    appendNotification(report.summary, "warning", "workflow-logger", { kind: "memory-consolidation" });
    logWarning("memory-consolidation", report.summary);
    return report;
  } catch (e) {
    logWarning(
      "memory-consolidation",
      `scanner failed: ${(e as Error).message}`,
    );
    return null;
  }
}
