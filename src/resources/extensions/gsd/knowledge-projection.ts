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
// that id exists in the database, the database row wins. Content the render
// does not model (the intro, non-table lines in the three sections, and any
// other `## ` section) is kept verbatim the same way, so a render never drops
// file content that the database does not hold. The file is never imported
// into the database implicitly.
//
// Readers (prompt inlines, visualizer, MCP gsd_knowledge, web) use
// readKnowledgeMarkdown / readKnowledgeEntries, which build the same content
// from the database, so a stale file on disk does not change what they see.
//
// Called after every knowledge capture, after memory commands that change
// knowledge rows, by the Projection Worker rebuild, and at session start.
// Output is byte-stable when nothing has changed.

import { dirname } from "node:path";

import { writeProjectionFileSync } from "./compat/compat-marker.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { gsdRoot } from "./paths.js";
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

interface FileProse {
  /** Text before the first `## ` heading; empty when the file has none. */
  intro: string;
  /** Non-table lines under each modeled section, in file order. */
  notes: Record<KnowledgeTable, string[]>;
  /** Every other `## ` section, verbatim, in file order. */
  otherSections: string[];
}

/**
 * Import bridge for file content the render does not model: the intro, the
 * non-table lines under Rules, Patterns and Lessons Learned, and any other
 * `## ` section. The render keeps them verbatim until the KNOWLEDGE import
 * can carry them, so a render never drops them.
 */
function fileProse(existing: string): FileProse {
  const lines = existing.split("\n");
  const firstHeading = lines.findIndex((l) => l.trim().startsWith("## "));
  const intro = lines.slice(0, firstHeading === -1 ? lines.length : firstHeading).join("\n").trim();
  const notes: Record<KnowledgeTable, string[]> = { rules: [], patterns: [], lessons: [] };
  const otherSections: string[][] = [];
  let section: (typeof KNOWLEDGE_SECTIONS)[number] | undefined;
  let other: string[] | undefined;
  for (const line of firstHeading === -1 ? [] : lines.slice(firstHeading)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      section = KNOWLEDGE_SECTIONS.find((s) => s.heading === trimmed);
      other = section ? undefined : [line];
      if (other) otherSections.push(other);
      continue;
    }
    if (other) {
      other.push(line);
      continue;
    }
    if (!section) continue;
    // Table lines (header, separator, K/P/L### and memory-id rows) are rendered from rows.
    if (new RegExp(`^\\|\\s*(#|-+|${section.idPrefix}\\d+|MEM\\d+)\\s*\\|`).test(trimmed)) continue;
    notes[section.table].push(line);
  }
  // Blank lines inside a note block are kept; the ones around it are layout.
  for (const table of Object.keys(notes) as KnowledgeTable[]) {
    const text = notes[table].join("\n").replace(/^\s*\n/, "").trimEnd();
    notes[table] = text.trim() ? text.split("\n") : [];
  }
  return { intro, notes, otherSections: otherSections.map((s) => s.join("\n").trim()) };
}

/**
 * The rows to show for each table: active database rows plus, until the
 * KNOWLEDGE import exists, file rows whose id the database has never held.
 * Knowledge ids (K/P/L###) first, then rows that only have a memory id.
 * Throws when the database is not available.
 */
function knowledgeRows(existing: string): Record<KnowledgeTable, RenderRow[]> {
  const { rows, knownIds } = readDbKnowledge();
  for (const fileRow of parseKnowledgeRows(existing)) {
    if (knownIds.has(fileRow.id)) continue;
    knownIds.add(fileRow.id);
    rows[fileRow.table].push({ id: fileRow.id, cells: fileRow.cells });
  }
  for (const table of Object.keys(rows) as KnowledgeTable[]) {
    rows[table].sort((a, b) => Number(a.id.startsWith("MEM")) - Number(b.id.startsWith("MEM")) || a.id.localeCompare(b.id));
  }
  return rows;
}

function buildKnowledgeMarkdown(existing: string): { content: string; empty: boolean } {
  const rows = knowledgeRows(existing);
  const { intro, notes, otherSections } = fileProse(existing);
  const sections = KNOWLEDGE_SECTIONS.map(({ table }) => {
    const { heading, header, separator } = TABLES[table];
    const tableRows = rows[table].map((row) => `| ${row.cells.map(escapeCell).join(" | ")} |`);
    const tableNotes = notes[table].length > 0 ? ["", ...notes[table]] : [];
    return [heading, "", header, separator, ...tableRows, ...tableNotes].join("\n");
  });
  const content = [intro || DEFAULT_INTRO, ...sections, ...otherSections].join("\n\n") + "\n";
  const empty = !intro
    && otherSections.length === 0
    && KNOWLEDGE_SECTIONS.every(({ table }) => rows[table].length === 0 && notes[table].length === 0);
  return { content, empty };
}

/** The block a prompt shows in place of project knowledge when the database cannot be read. */
export function knowledgeUnavailableBlock(reason: string): string {
  return `Project Knowledge unavailable: ${reason}. Do not reconstruct them from \`.gsd/\` markdown files.`;
}

/**
 * The local rows for the memory import. `contents` is the category and
 * content of each active memories row and of each file-only K/P/L row: a
 * superseded or forgotten row is not a duplicate of an imported row. `ids` is
 * every knowledge id a memories row (active or superseded) or a file row
 * holds. Throws when the database is not available.
 */
export function readLocalKnowledgeIndex(basePath: string): { contents: Array<{ category: string; content: string }>; ids: Set<string> } {
  const adapter = isDbAvailable() ? _getAdapter() : null;
  if (!adapter) throw new Error("GSD database is not available; cannot read local knowledge rows");
  const contents = adapter
    .prepare("SELECT category, content FROM memories WHERE superseded_by IS NULL")
    .all() as Array<{ category: string; content: string }>;
  const ids = readDbKnowledge().knownIds;
  for (const row of parseKnowledgeRows(readKnowledgeMd(basePath))) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    const category = Object.keys(TABLE_BY_CATEGORY).find((key) => TABLE_BY_CATEGORY[key] === row.table)!;
    contents.push({ category, content: row.cells[row.table === "rules" ? 2 : 1] ?? "" });
  }
  return { contents, ids };
}

/**
 * The one knowledge reader: KNOWLEDGE.md content built from the database
 * (plus the import bridge), whatever the file on disk holds. Returns "" when
 * there is no knowledge to show. Throws when the database is not available.
 */
export function readKnowledgeMarkdown(basePath: string): string {
  const { content, empty } = buildKnowledgeMarkdown(readKnowledgeMd(basePath));
  return empty ? "" : content;
}

/**
 * Structured form of readKnowledgeMarkdown: the cells of every row per table
 * (leading `#` cell included). Throws when the database is not available.
 */
export function readKnowledgeEntries(basePath: string): Record<KnowledgeTable, string[][]> {
  const rows = knowledgeRows(readKnowledgeMd(basePath));
  return {
    rules: rows.rules.map((row) => row.cells),
    patterns: rows.patterns.map((row) => row.cells),
    lessons: rows.lessons.map((row) => row.cells),
  };
}

/**
 * The Patterns and Lessons Learned rows that exist only in the file: no
 * memories row holds their id, so the MEMORY block cannot show them. Returned
 * as their table sections for the system prompt, until the explicit KNOWLEDGE
 * import exists. Returns "" when there are none. Throws when the database is
 * not available.
 */
export function readUnimportedPatternsAndLessons(basePath: string): string {
  const { knownIds } = readDbKnowledge();
  const fileRows = parseKnowledgeRows(readKnowledgeMd(basePath)).filter((row) => !knownIds.has(row.id));
  return (["patterns", "lessons"] as const)
    .map((table) => ({ ...TABLES[table], rows: fileRows.filter((row) => row.table === table) }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ heading, header, separator, rows }) => [heading, "", header, separator, ...rows.map((row) => row.raw)].join("\n"))
    .join("\n\n");
}

/**
 * Render `KNOWLEDGE.md` from the database. Returns the rendered content and
 * whether the file was written (skipped when byte-identical to disk). When
 * the bytes changed, records the render baseline so the next render does not
 * copy GSD's own output to quarantine; a baseline that cannot be recorded is
 * a warning, because the file is rendered. The external-edit observer skips
 * KNOWLEDGE.md, so the baseline never makes it move or hold the file.
 * `bridgeBasePath` names the checkout whose file supplies the import bridge
 * when `basePath` has no KNOWLEDGE.md yet (a new worktree). Throws when the
 * database is unavailable or the write fails.
 */
export function renderKnowledgeProjection(basePath: string, bridgeBasePath = basePath): KnowledgeProjectionResult {
  const existing = readKnowledgeMd(basePath);
  const { content } = buildKnowledgeMarkdown(existing || readKnowledgeMd(bridgeBasePath));
  const path = knowledgeMdPath(basePath);
  const written = content !== existing;
  if (written) writeProjectionFileSync(dirname(gsdRoot(basePath)), path, content, []);
  return { written, content };
}

// Re-export the section headings so tests can assert on the canonical
// structure without re-defining the strings.
export { KNOWLEDGE_SECTIONS };
