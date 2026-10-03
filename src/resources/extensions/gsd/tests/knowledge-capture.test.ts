// Project/App: gsd-pi
// File Purpose: Behavior gate for KNOWLEDGE capture: Rules, Patterns and Lessons are database rows,
// written by one capture path (command, native tool, MCP tool), and KNOWLEDGE.md is rendered from
// the database after every capture and in the full rebuild.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { registerMemoryTools } from "../bootstrap/memory-tools.ts";
import { handleKnowledge } from "../commands-handlers.ts";
import { withCommandCwd } from "../commands/context.ts";
import { _getAdapter, closeDatabase, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { captureKnowledgeEntry, nextKnowledgeId } from "../knowledge-capture.ts";
import { knowledgeMdPath } from "../knowledge-parser.ts";
import { renderKnowledgeProjection } from "../knowledge-projection.ts";
import { createMemory, enforceMemoryCap } from "../memory-store.ts";
import { rebuildMarkdownProjectionsFromDb } from "../projection-worker.ts";
import { invalidateStateCache } from "../state.ts";
import { executeMemoryCapture } from "../tools/memory-tools.ts";

interface KnowledgeRowSnapshot {
  category: string;
  content: string;
  sourceKnowledgeId: string;
}

function knowledgeRows(): KnowledgeRowSnapshot[] {
  const adapter = _getAdapter();
  assert.ok(adapter, "database must be open");
  const rows = adapter
    .prepare("SELECT category, content, structured_fields FROM memories WHERE superseded_by IS NULL ORDER BY seq")
    .all() as Array<{ category: string; content: string; structured_fields: string | null }>;
  return rows.map((row) => ({
    category: row.category,
    content: row.content,
    sourceKnowledgeId: row.structured_fields ? String(JSON.parse(row.structured_fields).sourceKnowledgeId ?? "") : "",
  }));
}

function readKnowledge(base: string): string {
  return readFileSync(knowledgeMdPath(base), "utf-8");
}

/** Section body of one `## ` heading in KNOWLEDGE.md. */
function section(content: string, heading: string): string {
  const start = content.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `missing ${heading}`);
  const next = content.indexOf("\n## ", start + 1);
  return content.slice(start, next === -1 ? undefined : next);
}

describe("knowledge capture", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-capture-")));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  });

  afterEach(() => {
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });

  test("a rule, a pattern and a lesson each write one DB row and show in KNOWLEDGE.md at once", () => {
    const rule = captureKnowledgeEntry(base, "rule", "Always pin SQLite version", "M001");
    const pattern = captureKnowledgeEntry(base, "pattern", "Repository pattern at the seam", "project");
    const lesson = captureKnowledgeEntry(base, "lesson", "Cache poisoning via reused key", "M001/S01");

    assert.deepEqual([rule.id, pattern.id, lesson.id], ["K001", "P001", "L001"]);
    assert.deepEqual(knowledgeRows(), [
      { category: "rule", content: "Always pin SQLite version", sourceKnowledgeId: "K001" },
      { category: "pattern", content: "Repository pattern at the seam", sourceKnowledgeId: "P001" },
      { category: "gotcha", content: "Cache poisoning via reused key", sourceKnowledgeId: "L001" },
    ]);

    const md = readKnowledge(base);
    assert.match(section(md, "## Rules"), /\| K001 \| M001 \| Always pin SQLite version \| — \| manual \|/);
    assert.match(section(md, "## Patterns"), /\| P001 \| Repository pattern at the seam \| — \| — \|/);
    assert.match(section(md, "## Lessons Learned"), /\| L001 \| Cache poisoning via reused key \| — \| — \| M001\/S01 \|/);
  });

  test("/gsd knowledge rule writes a rule row (not a file append) and KNOWLEDGE.md shows it", async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      cwd: base,
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    } as unknown as ExtensionCommandContext;

    await withCommandCwd(base, () => handleKnowledge("rule Use real DB for integration tests", ctx));

    assert.deepEqual(knowledgeRows(), [
      { category: "rule", content: "Use real DB for integration tests", sourceKnowledgeId: "K001" },
    ]);
    assert.match(section(readKnowledge(base), "## Rules"), /\| K001 \| global \| Use real DB for integration tests \|/);
    assert.deepEqual(notifications.at(-1), {
      message: 'Saved rule K001 to KNOWLEDGE.md: "Use real DB for integration tests"',
      level: "success",
    });
  });

  test("native capture_thought rule, pattern and gotcha get K/P/L ids and render at once", async () => {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ isError?: boolean; details: Record<string, unknown> }> }> = [];
    registerMemoryTools({ registerTool: (tool: (typeof tools)[number]) => tools.push(tool) } as never);
    const captureThought = tools.find((tool) => tool.name === "capture_thought");
    assert.ok(captureThought, "capture_thought must be registered");

    for (const [category, content] of [
      ["rule", "Never commit gsd.db"],
      ["pattern", "Seam types at the vendor boundary"],
      ["gotcha", "WAL file grows without checkpoint"],
    ]) {
      const result = await captureThought.execute("call", { category, content }, undefined, undefined, { cwd: base });
      assert.equal(result.isError, undefined, `capture_thought ${category} must succeed`);
    }

    assert.deepEqual(
      knowledgeRows().map((row) => [row.category, row.sourceKnowledgeId]),
      [["rule", "K001"], ["pattern", "P001"], ["gotcha", "L001"]],
    );
    const md = readKnowledge(base);
    assert.match(section(md, "## Rules"), /\| K001 \| project \| Never commit gsd\.db \|/);
    assert.match(section(md, "## Patterns"), /\| P001 \| Seam types at the vendor boundary \|/);
    assert.match(section(md, "## Lessons Learned"), /\| L001 \| WAL file grows without checkpoint \|/);
  });

  test("capture_thought keeps non-knowledge categories out of KNOWLEDGE.md", () => {
    const result = executeMemoryCapture({ category: "environment", content: "Node 22 is required" }, base);
    assert.equal(result.isError, undefined);
    assert.equal(knowledgeRows()[0]?.sourceKnowledgeId, "");
    assert.equal(existsSync(knowledgeMdPath(base)), false);
  });

  test("delete KNOWLEDGE.md and rebuild: the file equals the DB render, including Rules", async () => {
    captureKnowledgeEntry(base, "rule", "Always pin SQLite version", "project");
    captureKnowledgeEntry(base, "pattern", "Adapter at the seam", "project");
    captureKnowledgeEntry(base, "lesson", "Stale cache after rename", "project");
    const rendered = readKnowledge(base);

    unlinkSync(knowledgeMdPath(base));
    const rebuild = await rebuildMarkdownProjectionsFromDb(base);

    assert.deepEqual(rebuild.errors, []);
    assert.equal(readKnowledge(base), rendered);
    assert.match(section(rendered, "## Rules"), /\| K001 \| project \| Always pin SQLite version \|/);
  });

  test("a hand edit of an imported row does not win: the next render restores the DB row", () => {
    captureKnowledgeEntry(base, "rule", "Always pin SQLite version", "project");
    writeFileSync(knowledgeMdPath(base), readKnowledge(base).replace("Always pin SQLite version", "Hand edited"), "utf-8");

    captureKnowledgeEntry(base, "pattern", "Adapter at the seam", "project");

    const rules = section(readKnowledge(base), "## Rules");
    assert.match(rules, /\| K001 \| project \| Always pin SQLite version \|/);
    assert.doesNotMatch(rules, /Hand edited/);
  });

  test("import bridge: file rows not in the DB are kept and reserve their ids", () => {
    writeFileSync(
      knowledgeMdPath(base),
      [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "| K001 | project | Legacy file rule | history | 2026-01-01 |",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "| P004 | Legacy pattern | services/ | preserved |",
        "",
      ].join("\n"),
      "utf-8",
    );

    const rule = captureKnowledgeEntry(base, "rule", "New database rule", "project");
    const pattern = captureKnowledgeEntry(base, "pattern", "New database pattern", "project");

    assert.equal(rule.id, "K002", "unimported K001 keeps its id");
    assert.equal(pattern.id, "P005", "unimported P004 keeps its id");
    const md = readKnowledge(base);
    assert.match(section(md, "## Rules"), /\| K001 \| project \| Legacy file rule \| history \| 2026-01-01 \|\n\| K002 \| project \| New database rule \|/);
    assert.match(section(md, "## Patterns"), /\| P004 \| Legacy pattern \| services\/ \| preserved \|\n\| P005 \| New database pattern \|/);
  });

  test("import bridge: a custom intro and free-form Rules lines survive the render", () => {
    writeFileSync(
      knowledgeMdPath(base),
      [
        "# Project Knowledge",
        "",
        "Custom intro: read the vendor policy first.",
        "",
        "## Rules",
        "",
        "- Bullet rule: never touch vendor/",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
      ].join("\n"),
      "utf-8",
    );

    captureKnowledgeEntry(base, "rule", "New database rule", "project");
    const first = readKnowledge(base);
    captureKnowledgeEntry(base, "pattern", "Adapter at the seam", "project");
    const md = readKnowledge(base);

    assert.match(md, /^# Project Knowledge\n\nCustom intro: read the vendor policy first\.\n\n## Rules\n/);
    const rules = section(md, "## Rules");
    assert.match(rules, /\| K001 \| project \| New database rule \|/);
    assert.equal(rules.split("- Bullet rule: never touch vendor/").length, 2, "free-form rule line is kept exactly once");
    assert.equal(section(md, "## Rules"), section(first, "## Rules"), "a later render keeps the Rules section stable");
  });

  test("the memory cap never supersedes Rules, so they stay in KNOWLEDGE.md", () => {
    for (const text of ["Rule one", "Rule two", "Rule three"]) {
      captureKnowledgeEntry(base, "rule", text, "project");
    }
    for (let i = 0; i < 60; i++) {
      createMemory({ category: "convention", content: `convention ${i}`, confidence: 0.9 });
    }

    enforceMemoryCap(50);
    renderKnowledgeProjection(base);

    const active = knowledgeRows();
    assert.deepEqual(active.filter((row) => row.category === "rule").map((row) => row.sourceKnowledgeId), ["K001", "K002", "K003"]);
    assert.equal(active.filter((row) => row.category !== "rule").length, 50, "the cap still applies to other memories");
    const rules = section(readKnowledge(base), "## Rules");
    for (const id of ["K001", "K002", "K003"]) assert.match(rules, new RegExp(`\\| ${id} \\| project \\| Rule `));
  });

  test("with a closed DB the capture fails loud and writes nothing", () => {
    closeDatabase();

    assert.throws(() => captureKnowledgeEntry(base, "rule", "Should not land", "project"), /database is not available/);
    const toolResult = executeMemoryCapture({ category: "rule", content: "Should not land" }, base);
    assert.equal(toolResult.isError, true);
    assert.equal(existsSync(knowledgeMdPath(base)), false);
  });

  test("repeated captures advance the id monotonically per prefix", () => {
    const ids = [
      captureKnowledgeEntry(base, "pattern", "First", "project").id,
      captureKnowledgeEntry(base, "pattern", "Second", "project").id,
      captureKnowledgeEntry(base, "lesson", "L entry", "project").id,
    ];
    assert.deepEqual(ids, ["P001", "P002", "L001"]);
    assert.equal(nextKnowledgeId(base, "P"), "P003");
    assert.equal(nextKnowledgeId(base, "L"), "L002");
    assert.equal(nextKnowledgeId(base, "K"), "K001");
  });

  test("a capture waits for another process that holds the write lock and takes the next id", async () => {
    // The second process holds the write lock with an uncommitted K001 rule, then commits.
    const child = spawn(process.execPath, ["--no-warnings", "-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO memories (id, category, content, confidence, created_at, updated_at, structured_fields) VALUES (?, 'rule', 'Rule from the other process', 0.85, ?, ?, ?)")
        .run("MEM-OTHER", now, now, JSON.stringify({ sourceKnowledgeTable: "rules", rule: "Rule from the other process", scopeText: "project", sourceKnowledgeId: "K001" }));
      process.stdout.write("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);
    `, join(base, ".gsd", "gsd.db")], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = once(child, "exit");
    await once(child.stdout, "data");

    const result = captureKnowledgeEntry(base, "rule", "Rule from this process", "project");
    const [exitCode] = await exited;

    assert.equal(exitCode, 0);
    assert.equal(result.id, "K002");
    assert.deepEqual(knowledgeRows().map((row) => `${row.sourceKnowledgeId} ${row.content}`), [
      "K001 Rule from the other process",
      "K002 Rule from this process",
    ]);
    const rules = section(readKnowledge(base), "## Rules");
    assert.match(rules, /Rule from the other process/);
    assert.match(rules, /Rule from this process/);
  });

  test("deleting KNOWLEDGE.md does not reset ids: the DB holds them", () => {
    captureKnowledgeEntry(base, "rule", "First rule", "project");
    unlinkSync(knowledgeMdPath(base));
    assert.equal(captureKnowledgeEntry(base, "rule", "Second rule", "project").id, "K002");
  });

  test("empty entry text is rejected without a row", () => {
    assert.throws(() => captureKnowledgeEntry(base, "pattern", "   ", "project"), /text is required/);
    assert.deepEqual(knowledgeRows(), []);
  });
});
