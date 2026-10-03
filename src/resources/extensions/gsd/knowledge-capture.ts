// gsd-pi — KNOWLEDGE capture: the one write path for Rules, Patterns and Lessons.
//
// `/gsd knowledge`, `capture_thought` and MCP `gsd_capture_thought` all call
// `captureKnowledgeEntry`. Each capture writes one `memories` row carrying a
// `sourceKnowledgeId` (K###, P### or L###) and then renders KNOWLEDGE.md from
// the database, so the file shows the entry at once.
//
// Next-ID assignment takes the max <prefix>### from the memories table and
// from the existing `.gsd/KNOWLEDGE.md`. The file side is the import bridge:
// it reserves ids of file rows that are not imported into the database yet,
// so a new capture cannot take the id of a row the render still keeps.

import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { createMemory } from "./memory-store.js";
import { parseKnowledgeRows, readKnowledgeMd } from "./knowledge-parser.js";
import { renderKnowledgeProjection } from "./knowledge-projection.js";

export type KnowledgeEntryType = "rule" | "pattern" | "lesson";

/** Memory category used for each knowledge entry type. */
const KNOWLEDGE_CATEGORY: Record<KnowledgeEntryType, string> = {
  rule: "rule",
  pattern: "pattern",
  lesson: "gotcha",
};

export interface CaptureKnowledgeOptions {
  confidence?: number;
  tags?: string[];
  /** Extra structured cells (e.g. where/notes, rootCause/fix). The knowledge id is always assigned here. */
  structuredFields?: Record<string, unknown> | null;
}

export interface CaptureKnowledgeResult {
  /** The assigned <prefix>### identifier (e.g. "P004"). */
  id: string;
  /** The memories row id (e.g. "MEM012"). */
  memoryId: string;
  /** Set when the row was written but KNOWLEDGE.md could not be rendered. */
  projectionError?: string;
}

/**
 * Write a Rule, Pattern or Lesson as one memories row with the next
 * knowledge id, then render KNOWLEDGE.md. Throws when the text is empty, the
 * database is not available, or the insert fails. A render failure after the
 * row is written is returned as `projectionError`, not thrown.
 */
export function captureKnowledgeEntry(
  basePath: string,
  type: KnowledgeEntryType,
  entryText: string,
  scope: string,
  options: CaptureKnowledgeOptions = {},
): CaptureKnowledgeResult {
  const cleaned = entryText.trim();
  if (!cleaned) throw new Error(`${type} text is required`);
  if (!isDbAvailable()) throw new Error(`GSD database is not available; cannot capture ${type}`);

  const scopeText = scope.trim() || "project";
  const prefix = type === "rule" ? "K" : type === "pattern" ? "P" : "L";
  const id = nextKnowledgeId(basePath, prefix);
  const cells: Record<string, unknown> =
    type === "rule"
      ? { sourceKnowledgeTable: "rules", rule: cleaned, scopeText, why: "", added: "manual" }
      : type === "pattern"
        ? { sourceKnowledgeTable: "patterns", pattern: cleaned, where: "", notes: "" }
        : { sourceKnowledgeTable: "lessons", whatHappened: cleaned, rootCause: "", fix: "", scopeText };

  const memoryId = createMemory({
    category: KNOWLEDGE_CATEGORY[type],
    content: cleaned,
    scope: scopeText,
    confidence: options.confidence ?? 0.85,
    tags: options.tags,
    structuredFields: { ...cells, ...options.structuredFields, sourceKnowledgeId: id },
  });
  if (!memoryId) throw new Error(`GSD database is not available; cannot capture ${type}`);

  try {
    renderKnowledgeProjection(basePath);
    return { id, memoryId };
  } catch (e) {
    return { id, memoryId, projectionError: (e as Error).message };
  }
}

/**
 * Compute the next <prefix>### identifier: the max numeric suffix in the
 * memories table and in not-yet-imported KNOWLEDGE.md rows, plus one.
 * Padded to three digits. Exported for tests.
 */
export function nextKnowledgeId(basePath: string, prefix: "K" | "P" | "L"): string {
  const next = Math.max(maxIdInFile(basePath, prefix), maxIdInMemories(prefix)) + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

function maxIdInFile(basePath: string, prefix: "K" | "P" | "L"): number {
  let max = 0;
  for (const row of parseKnowledgeRows(readKnowledgeMd(basePath))) {
    if (!row.id.startsWith(prefix)) continue;
    const num = parseInt(row.id.slice(1), 10);
    if (Number.isFinite(num) && num > max) max = num;
  }
  return max;
}

function maxIdInMemories(prefix: "K" | "P" | "L"): number {
  const adapter = _getAdapter();
  if (!adapter) throw new Error("GSD database is not available; cannot allocate a knowledge id");
  const rows = adapter
    .prepare("SELECT structured_fields FROM memories WHERE structured_fields LIKE :pattern")
    .all({ ":pattern": `%"sourceKnowledgeId":"${prefix}%` }) as Array<{ structured_fields: string | null }>;
  let max = 0;
  for (const row of rows) {
    if (!row.structured_fields) continue;
    let sf: Record<string, unknown>;
    try {
      sf = JSON.parse(row.structured_fields) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sourceId = sf["sourceKnowledgeId"];
    if (typeof sourceId !== "string" || !sourceId.startsWith(prefix)) continue;
    const num = parseInt(sourceId.slice(1), 10);
    if (Number.isFinite(num) && num > max) max = num;
  }
  return max;
}
