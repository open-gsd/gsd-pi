// gsd-pi — KNOWLEDGE.md projection renderer (ADR-046).
//
// Renders `.gsd/KNOWLEDGE.md` from the `memories` table:
//   - Rules section:   active memories with `category = "rule"`.
//   - Patterns:        active memories with `category = "pattern"`.
//   - Lessons Learned: active memories with `category = "gotcha"`.
// The `#` cell is `structured_fields.sourceKnowledgeId` (K/P/L###) when set,
// else the memory id. Captures assign a knowledge id (knowledge-capture.ts).
//
// Import bridge (until the explicit KNOWLEDGE import lands): a K/P/L row in
// the existing file whose id has no memories row at all is not imported yet.
// It is kept in the render so the render does not erase it. Once a row with
// that id exists in the database, the database row wins. The file intro and
// free-form (non-table) lines under `## Rules` are kept the same way.
//
// Called after every knowledge capture, by the Projection Worker rebuild, and
// at session start. Output is byte-stable when nothing has changed.

import { atomicWriteSync } from "./atomic-write.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import {
  KNOWLEDGE_SECTIONS,
  knowledgeMdPath,
  parseKnowledgeRows,
  readKnowledgeMd,
  type KnowledgeTable,
} from "./knowledge-parser.js";

const DEFAULT_INTRO = [
  "# Project Knowledge",
  "",
  "Append-only register of project-specific rules, patterns, and lessons learned.",
  "Agents read this before every unit. Add entries when you discover something worth remembering.",
].join("\n");

const TABLES: Record<KnowledgeTable, { heading: string; header: string; separator: string }> = {
  rules: {
    heading: "## Rules",
    header: "| # | Scope | Rule | Why | Added |",
    separator: "|---|-------|------|-----|-------|",
  },
  patterns: {
    heading: "## Patterns",
    header: "| # | Pattern | Where | Notes |",
    separator: "|---|---------|-------|-------|",
  },
  lessons: {
    heading: "## Lessons Learned",
    header: "| # | What Happened | Root Cause | Fix | Scope |",
    separator: "|---|--------------|------------|-----|-------|",
  },
};

const TABLE_BY_CATEGORY: Record<string, KnowledgeTable> = {
  rule: "rules",
  pattern: "patterns",
  gotcha: "lessons",
};

interface RenderRow {
  id: string;
  /** All cells including the leading `#` cell, unescaped. */
  cells: string[];
}

export interface KnowledgeProjectionResult {
  written: boolean;
  content: string;
}

function text(sf: Record<string, unknown>, key: string): string {
  const value = sf[key];
  return typeof value === "string" ? value : "";
}

function memoryCells(table: KnowledgeTable, id: string, content: string, scope: string, sf: Record<string, unknown>): string[] {
  if (table === "rules") {
    return [id, text(sf, "scopeText") || scope, text(sf, "rule") || content, text(sf, "why") || "—", text(sf, "added") || "—"];
  }
  if (table === "patterns") {
    return [id, text(sf, "pattern") || content, text(sf, "where") || "—", text(sf, "notes") || "—"];
  }
  return [id, text(sf, "whatHappened") || content, text(sf, "rootCause") || "—", text(sf, "fix") || "—", text(sf, "scopeText") || scope];
}

/**
 * Read the knowledge rows to render from the database, plus every
 * `sourceKnowledgeId` held by any memories row (active or superseded).
 * Throws when the database is not available.
 */
function readDbKnowledge(): { rows: Record<KnowledgeTable, RenderRow[]>; knownIds: Set<string> } {
  const adapter = isDbAvailable() ? _getAdapter() : null;
  if (!adapter) throw new Error("GSD database is not available; cannot render KNOWLEDGE.md");

  const rows: Record<KnowledgeTable, RenderRow[]> = { rules: [], patterns: [], lessons: [] };
  const knownIds = new Set<string>();
  const all = adapter
    .prepare("SELECT id, category, content, scope, superseded_by, structured_fields FROM memories")
    .all() as Array<{
    id: string;
    category: string;
    content: string;
    scope: string | null;
    superseded_by: string | null;
    structured_fields: string | null;
  }>;

  for (const row of all) {
    let sf: Record<string, unknown> = {};
    if (row.structured_fields) {
      try {
        sf = JSON.parse(row.structured_fields) as Record<string, unknown>;
      } catch {
        // Malformed structured fields are reported by the consolidation scanner.
      }
    }
    const knowledgeId = text(sf, "sourceKnowledgeId");
    if (knowledgeId) knownIds.add(knowledgeId);

    const table = TABLE_BY_CATEGORY[row.category];
    if (!table || row.superseded_by) continue;
    const id = knowledgeId || row.id;
    rows[table].push({ id, cells: memoryCells(table, id, row.content, row.scope || "project", sf) });
  }
  return { rows, knownIds };
}

function escapeCell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Import bridge for free-form text: the intro (text before the first `## `
 * heading) and the Rules-section lines that are not table rows. Before
 * ADR-046 both were kept verbatim and reached the agent through
 * loadKnowledgeBlock, so the render keeps them until the KNOWLEDGE import
 * can carry them.
 */
function fileProse(existing: string): { intro: string; ruleNotes: string[] } {
  const lines = existing.split("\n");
  const firstHeading = lines.findIndex((l) => l.trim().startsWith("## "));
  const intro = lines.slice(0, firstHeading === -1 ? lines.length : firstHeading).join("\n").trim();
  const ruleNotes: string[] = [];
  const rulesStart = lines.findIndex((l) => l.trim() === TABLES.rules.heading);
  if (rulesStart !== -1) {
    for (const line of lines.slice(rulesStart + 1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) break;
      // Table lines (header, separator, K### and memory-id rows) are rendered from rows.
      if (!trimmed || /^\|\s*(#|-+|K\d+|MEM\d+)\s*\|/.test(trimmed)) continue;
      ruleNotes.push(line);
    }
  }
  return { intro: intro || DEFAULT_INTRO, ruleNotes };
}

/**
 * Render `KNOWLEDGE.md` from the database. Returns the rendered content and
 * whether the file was written (skipped when byte-identical to disk).
 * Throws when the database is unavailable or the write fails.
 */
export function renderKnowledgeProjection(basePath: string): KnowledgeProjectionResult {
  const { rows, knownIds } = readDbKnowledge();
  const existing = readKnowledgeMd(basePath);

  // Import bridge: keep file rows whose id the database has never held.
  for (const fileRow of parseKnowledgeRows(existing)) {
    if (knownIds.has(fileRow.id)) continue;
    knownIds.add(fileRow.id);
    rows[fileRow.table].push({ id: fileRow.id, cells: fileRow.cells });
  }

  const { intro, ruleNotes } = fileProse(existing);

  const sections = KNOWLEDGE_SECTIONS.map(({ table }) => {
    const { heading, header, separator } = TABLES[table];
    // Knowledge ids (K/P/L###) first, then rows that only have a memory id.
    const tableRows = rows[table]
      .sort((a, b) => Number(a.id.startsWith("MEM")) - Number(b.id.startsWith("MEM")) || a.id.localeCompare(b.id))
      .map((row) => `| ${row.cells.map(escapeCell).join(" | ")} |`);
    const notes = table === "rules" && ruleNotes.length > 0 ? ["", ...ruleNotes] : [];
    return [heading, "", header, separator, ...tableRows, ...notes].join("\n");
  });
  const content = [intro, ...sections].join("\n\n") + "\n";

  if (content === existing) {
    return { written: false, content };
  }
  atomicWriteSync(knowledgeMdPath(basePath), content, "utf-8");
  return { written: true, content };
}

// Re-export the section headings so tests can assert on the canonical
// structure without re-defining the strings.
export { KNOWLEDGE_SECTIONS };
