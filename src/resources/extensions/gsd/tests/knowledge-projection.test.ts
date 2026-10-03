// ADR-046 — KNOWLEDGE.md parser, projection render and DB reader tests.
//
// Covers:
//   1. parser: splits cells correctly, skips header/separator rows, respects
//      section boundaries
//   2. projection: Rules, Patterns + Lessons render from memories; file rows
//      with no DB row yet and unmodeled file content are kept until imported
//   3. reader: readKnowledgeMarkdown / readKnowledgeEntries return database
//      rows when the file on disk is stale

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  knowledgeMdPath,
  parseKnowledgeRows,
  splitPipeRow,
} from "../knowledge-parser.ts";
import { readKnowledgeEntries, readKnowledgeMarkdown, renderKnowledgeProjection } from "../knowledge-projection.ts";
import { createMemory } from "../memory-store.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-knowledge-stage2b-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    /* noop */
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function writeKnowledgeMd(base: string, body: string): void {
  writeFileSync(join(base, ".gsd", "KNOWLEDGE.md"), body, "utf-8");
}

const FIXTURE = `# Project Knowledge

Append-only register of project-specific rules, patterns, and lessons learned.
Agents read this before every unit. Add entries when you discover something worth remembering.

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | All timestamps in UTC | clarity | 2026-01-01 |
| K002 | M001 | Never trust user input | safety | 2026-01-02 |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Repository pattern | services/ | guards |
| P002 | Adapter at the seam | packages/pi-ai/ | observability |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | Cache poisoning | reused key | versioned key | project |
`;


/** Write the FIXTURE Patterns and Lessons as memories rows (what a capture or import writes). */
function seedFixturePatternsAndLessons(): void {
  for (const [id, pattern, where, notes] of [
    ["P001", "Repository pattern", "services/", "guards"],
    ["P002", "Adapter at the seam", "packages/pi-ai/", "observability"],
  ]) {
    createMemory({
      category: "pattern",
      content: pattern!,
      scope: "project",
      structuredFields: { sourceKnowledgeId: id, sourceKnowledgeTable: "patterns", pattern, where, notes },
    });
  }
  createMemory({
    category: "gotcha",
    content: "Cache poisoning",
    scope: "project",
    structuredFields: {
      sourceKnowledgeId: "L001",
      sourceKnowledgeTable: "lessons",
      whatHappened: "Cache poisoning",
      rootCause: "reused key",
      fix: "versioned key",
      scopeText: "project",
    },
  });
}

// ─── splitPipeRow ──────────────────────────────────────────────────────────

test("splitPipeRow extracts cells from a standard table row", () => {
  const cells = splitPipeRow("| K001 | project | All timestamps in UTC | clarity | 2026-01-01 |");
  assert.deepEqual(cells, ["K001", "project", "All timestamps in UTC", "clarity", "2026-01-01"]);
});

test("splitPipeRow preserves escaped pipes inside a cell", () => {
  const cells = splitPipeRow(`| K001 | project | Use A \\| B operator | safety | 2026-01-01 |`);
  assert.equal(cells[2], "Use A | B operator");
});

// ─── parseKnowledgeRows ────────────────────────────────────────────────────

test("parseKnowledgeRows returns rows per section with the correct table tag", () => {
  const rows = parseKnowledgeRows(FIXTURE);
  assert.equal(rows.length, 5, "two rules + two patterns + one lesson");
  const tables = rows.map((r) => r.table);
  assert.deepEqual(tables, ["rules", "rules", "patterns", "patterns", "lessons"]);
});

test("parseKnowledgeRows captures cell values aligned with the section schema", () => {
  const rows = parseKnowledgeRows(FIXTURE);
  const p1 = rows.find((r) => r.id === "P001");
  assert.ok(p1);
  assert.equal(p1.cells[1], "Repository pattern");
  assert.equal(p1.cells[2], "services/");
});

// ─── renderKnowledgeProjection ─────────────────────────────────────────────

test("projection renders Rules from rule rows; a file Rule with a DB row loses to the DB", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(base, FIXTURE);
    seedFixturePatternsAndLessons();
    createMemory({
      category: "rule",
      content: "All timestamps in UTC, stored as ISO strings",
      scope: "project",
      structuredFields: {
        sourceKnowledgeId: "K001",
        sourceKnowledgeTable: "rules",
        rule: "All timestamps in UTC, stored as ISO strings",
        scopeText: "project",
        why: "clarity",
        added: "2026-02-01",
      },
    });
    renderKnowledgeProjection(base);

    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");
    assert.match(rendered, /\| K001 \| project \| All timestamps in UTC, stored as ISO strings \| clarity \| 2026-02-01 \|/);
    assert.doesNotMatch(rendered, /\| K001 \| project \| All timestamps in UTC \| clarity \| 2026-01-01 \|/);
    // K002 has no DB row yet (not imported): the import bridge keeps it.
    assert.match(rendered, /\| K002 \| M001 \| Never trust user input \| safety \| 2026-01-02 \|/);
  } finally {
    cleanup(base);
  }
});

test("projection renders Patterns + Lessons from memories", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(base, FIXTURE);
    seedFixturePatternsAndLessons();
    // Wipe the original Patterns/Lessons table rows from the file so the
    // projection's output can ONLY come from memories. Keep Rules intact.
    writeKnowledgeMd(
      base,
      `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | All timestamps in UTC | clarity | 2026-01-01 |
| K002 | M001 | Never trust user input | safety | 2026-01-02 |
`,
    );

    renderKnowledgeProjection(base);
    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");

    assert.match(rendered, /\| P001 \| Repository pattern \| services\/ \| guards \|/);
    assert.match(rendered, /\| P002 \| Adapter at the seam \| packages\/pi-ai\/ \| observability \|/);
    assert.match(rendered, /\| L001 \| Cache poisoning \| reused key \| versioned key \| project \|/);

    // Section structure must still be the canonical three headings, in order.
    const rulesIdx = rendered.indexOf("## Rules");
    const patternsIdx = rendered.indexOf("## Patterns");
    const lessonsIdx = rendered.indexOf("## Lessons Learned");
    assert.ok(rulesIdx >= 0 && patternsIdx > rulesIdx && lessonsIdx > patternsIdx, "headings must appear in canonical order");
  } finally {
    cleanup(base);
  }
});

test("projection excludes superseded knowledge memories", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(base, FIXTURE);
    seedFixturePatternsAndLessons();

    const adapter = _getAdapter();
    assert.ok(adapter);
    adapter
      .prepare(
        `INSERT INTO memories (
          id, category, content, confidence, source_unit_type, source_unit_id,
          created_at, updated_at, superseded_by, hit_count, scope, tags, structured_fields, last_hit_at
        ) VALUES (
          'MEM999', 'pattern', 'legacy duplicate', 0.8, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'MEM001', 0,
          'project', '[]', :sf, NULL
        )`,
      )
      .run({
        ':sf': JSON.stringify({
          sourceKnowledgeId: 'P001',
          pattern: 'stale pattern content',
          where: 'old/path',
          notes: 'stale',
        }),
      });

    renderKnowledgeProjection(base);
    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");

    assert.match(rendered, /\| P001 \| Repository pattern \| services\/ \| guards \|/);
    assert.ok(!rendered.includes("stale pattern content"), "superseded duplicate must not be projected");
  } finally {
    cleanup(base);
  }
});

test("projection is idempotent when nothing has changed", () => {
  const base = makeTmpBase();
  try {
    // Seed a file the projection will *change* (no canonical headers yet, so
    // the first render must rewrite to add structure).
    writeKnowledgeMd(
      base,
      `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | manual rule | reason | 2026-01-01 |
`,
    );

    const first = renderKnowledgeProjection(base);
    assert.equal(first.written, true, "first render adds the missing Patterns + Lessons section scaffolding");

    const second = renderKnowledgeProjection(base);
    assert.equal(second.written, false, "second render is a no-op when content already matches");
  } finally {
    cleanup(base);
  }
});

test("projection emits empty section tables when no rows exist for that category", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(
      base,
      `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
`,
    );
    renderKnowledgeProjection(base);
    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");

    assert.match(rendered, /## Patterns/);
    assert.match(rendered, /## Lessons Learned/);
    // The empty-table headers must be present.
    assert.match(rendered, /\| # \| Pattern \| Where \| Notes \|/);
    assert.match(rendered, /\| # \| What Happened \| Root Cause \| Fix \| Scope \|/);
  } finally {
    cleanup(base);
  }
});

test("projection escapes pipes in memory content", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(
      base,
      `## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Use A \\| B fallback | adapters/ | watch out |
`,
    );
    createMemory({
      category: "pattern",
      content: "Use A | B fallback",
      scope: "project",
      structuredFields: { sourceKnowledgeId: "P001", pattern: "Use A | B fallback", where: "adapters/", notes: "watch out" },
    });
    renderKnowledgeProjection(base);
    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");

    // Pipe MUST stay escaped in the rendered output so the table doesn't break.
    assert.match(rendered, /\| P001 \| Use A \\\| B fallback \| adapters\/ \| watch out \|/);
  } finally {
    cleanup(base);
  }
});

// ─── Unmodeled content and render baseline ─────────────────────────────────

test("projection keeps unmodeled file content: free-form sections, notes, id-less rows", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(
      base,
      `# Project Knowledge

Intro prose.

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| added without an id | x | y |

Pattern note kept as prose.

## Deployment

### Staging
Always deploy staging first.
`,
    );
    renderKnowledgeProjection(base);
    const rendered = readFileSync(knowledgeMdPath(base), "utf-8");

    assert.match(rendered, /Intro prose\./);
    assert.match(rendered, /\| added without an id \| x \| y \|/);
    assert.match(rendered, /Pattern note kept as prose\./);
    assert.match(rendered, /## Deployment\n\n### Staging\nAlways deploy staging first\./);
    assert.equal(renderKnowledgeProjection(base).written, false, "the kept content is byte-stable");
  } finally {
    cleanup(base);
  }
});

test("a file without a Rules heading keeps all of its content in the render", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(base, "Free-form knowledge with no headings at all.\n");
    renderKnowledgeProjection(base);
    assert.match(readFileSync(knowledgeMdPath(base), "utf-8"), /^Free-form knowledge with no headings at all\./);
  } finally {
    cleanup(base);
  }
});

test("a render records its baseline, so the next render does not quarantine GSD's own output", () => {
  const base = makeTmpBase();
  const quarantine = join(base, ".gsd", "quarantine");
  try {
    renderKnowledgeProjection(base);
    createMemory({ category: "rule", content: "Rule one", scope: "project", structuredFields: { sourceKnowledgeId: "K001", rule: "Rule one" } });
    assert.equal(renderKnowledgeProjection(base).written, true);
    assert.equal(existsSync(quarantine), false, "a render over GSD's own render is not an external edit");

    writeKnowledgeMd(base, readFileSync(knowledgeMdPath(base), "utf-8") + "\nHand edit.\n");
    createMemory({ category: "rule", content: "Rule two", scope: "project", structuredFields: { sourceKnowledgeId: "K002", rule: "Rule two" } });
    renderKnowledgeProjection(base);
    assert.equal(existsSync(quarantine), true, "a hand-edited file is still preserved before it is replaced");
  } finally {
    cleanup(base);
  }
});

// ─── DB reader ─────────────────────────────────────────────────────────────

test("readKnowledgeMarkdown and readKnowledgeEntries return database rows when the file is stale", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(base, FIXTURE);
    seedFixturePatternsAndLessons();
    renderKnowledgeProjection(base);
    // A row captured after the last render, and a file that still shows the old P001.
    createMemory({
      category: "rule",
      content: "Fresh rule",
      scope: "project",
      structuredFields: { sourceKnowledgeId: "K003", rule: "Fresh rule", scopeText: "project", why: "new", added: "today" },
    });
    _getAdapter()!.prepare("UPDATE memories SET structured_fields = json_set(structured_fields, '$.pattern', 'Repository pattern v2') WHERE structured_fields LIKE '%\"P001\"%'").run();

    const markdown = readKnowledgeMarkdown(base);
    assert.match(markdown, /\| K003 \| project \| Fresh rule \| new \| today \|/);
    assert.match(markdown, /\| P001 \| Repository pattern v2 \|/);
    assert.doesNotMatch(readFileSync(knowledgeMdPath(base), "utf-8"), /Fresh rule/, "the file itself is stale");

    const entries = readKnowledgeEntries(base);
    assert.deepEqual(entries.rules.map((cells) => cells[0]), ["K001", "K002", "K003"]);
    assert.equal(entries.patterns[0]![1], "Repository pattern v2");
    assert.deepEqual(entries.lessons.map((cells) => cells[0]), ["L001"]);
  } finally {
    cleanup(base);
  }
});

test("readKnowledgeMarkdown returns empty when there is no knowledge", () => {
  const base = makeTmpBase();
  try {
    assert.equal(readKnowledgeMarkdown(base), "");
  } finally {
    cleanup(base);
  }
});

test("render: the compat baseline is recorded only when the bytes changed", () => {
  const base = makeTmpBase();
  try {
    createMemory({ category: "rule", content: "Baseline rule", structuredFields: { sourceKnowledgeId: "K001" } });
    const markerPath = join(base, ".gsd", ".compat.json");

    assert.equal(renderKnowledgeProjection(base).written, true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { projections: Record<string, unknown> };
    assert.ok(marker.projections["KNOWLEDGE.md"], "a written render records its baseline");

    rmSync(markerPath);
    assert.equal(renderKnowledgeProjection(base).written, false);
    assert.equal(existsSync(markerPath), false, "an unchanged render does not touch the marker");
  } finally {
    cleanup(base);
  }
});

test("render: a marker that cannot be written is a warning, not a render failure", () => {
  const base = makeTmpBase();
  _resetLogs();
  try {
    createMemory({ category: "rule", content: "Rendered rule", structuredFields: { sourceKnowledgeId: "K001" } });
    // A directory at the marker path makes the marker write fail.
    mkdirSync(join(base, ".gsd", ".compat.json", "blocker"), { recursive: true });

    const result = renderKnowledgeProjection(base);

    assert.equal(result.written, true);
    assert.match(readFileSync(knowledgeMdPath(base), "utf-8"), /\| K001 \| project \| Rendered rule \|/);
    const warnings = peekLogs().filter((entry) => entry.severity === "warn").map((entry) => entry.message);
    assert.ok(warnings.some((message) => /compat baseline not recorded/.test(message)), warnings.join("\n"));
  } finally {
    _resetLogs();
    cleanup(base);
  }
});
