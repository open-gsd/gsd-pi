// ADR-046 — KNOWLEDGE rows and the memory commands.
//
// Covers:
//   1. the memory cap and decay never remove or weaken a Rule; Patterns and
//      Lessons are subject to both
//   2. `/gsd memory forget`, `cap` and `import` render KNOWLEDGE.md at once
//   3. the unit-closeout refresh is enqueued for the Projection Worker
//   4. `/gsd memory export` + `import` keeps the knowledge id of a row, adds
//      nothing on a re-import, and never takes the id of a local row

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { handleMemory } from "../commands-memory.ts";
import { withCommandCwd } from "../commands/context.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { captureKnowledgeEntry } from "../knowledge-capture.ts";
import { enqueueKnowledgeRefresh } from "../memory-extractor.ts";
import { createMemory, decayStaleMemories, enforceMemoryCap } from "../memory-store.ts";
import { drainProjectionWork } from "../projection-worker.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";

function makeBase(t: { after: (fn: () => void) => void }): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-memory-cmd-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

const pi = {} as ExtensionAPI;

/** Run one `/gsd memory` command and return the messages it showed. */
async function runMemory(base: string, args: string): Promise<string[]> {
  const messages: string[] = [];
  const ctx = { ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionCommandContext;
  await withCommandCwd(base, () => handleMemory(args, ctx, pi));
  return messages;
}

function activeMemoryCount(): number {
  return (_getAdapter()!.prepare("SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL").get() as { n: number }).n;
}

function exportFile(base: string, memories: Array<Record<string, unknown>>): string {
  const path = join(base, "import.json");
  writeFileSync(path, JSON.stringify({ version: 1, memories, relations: [] }), "utf-8");
  return path;
}

function knowledgeMd(base: string): string {
  return readFileSync(join(base, ".gsd", "KNOWLEDGE.md"), "utf-8");
}

function activeKnowledgeIds(): string[] {
  return (_getAdapter()!
    .prepare("SELECT json_extract(structured_fields, '$.sourceKnowledgeId') AS id FROM memories WHERE superseded_by IS NULL AND structured_fields LIKE '%\"sourceKnowledgeId\"%' ORDER BY id")
    .all() as Array<{ id: string }>).map((row) => row.id);
}

/** Three knowledge rows with the lowest rank, then `count` higher-ranked plain memories. */
function seedKnowledgeBelowPlainMemories(base: string, count: number): void {
  captureKnowledgeEntry(base, "rule", "Rule stays", "project", { confidence: 0.1 });
  captureKnowledgeEntry(base, "pattern", "Pattern stays", "project", { confidence: 0.1 });
  captureKnowledgeEntry(base, "lesson", "Lesson stays", "project", { confidence: 0.1 });
  for (let i = 0; i < count; i++) {
    createMemory({ category: "convention", content: `Plain memory ${i}`, confidence: 0.9 });
  }
}

test("the memory cap never supersedes a Rule; Patterns and Lessons are subject to it", (t) => {
  const base = makeBase(t);
  seedKnowledgeBelowPlainMemories(base, 6);

  enforceMemoryCap(4);

  assert.deepEqual(activeKnowledgeIds(), ["K001"], "the lowest-ranked Pattern and Lesson are superseded, the Rule stays");
  const plain = _getAdapter()!
    .prepare("SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL AND category = 'convention'")
    .get() as { n: number };
  assert.equal(plain.n, 4, "the Rule is not counted against the cap");
});

test("/gsd memory cap renders KNOWLEDGE.md again: the Rule stays, capped Patterns and Lessons leave", async (t) => {
  const base = makeBase(t);
  seedKnowledgeBelowPlainMemories(base, 6);
  assert.match(knowledgeMd(base), /\| P001 \| Pattern stays \|/);

  await runMemory(base, "cap 2");

  const rendered = knowledgeMd(base);
  assert.match(rendered, /\| K001 \| project \| Rule stays \|/);
  assert.doesNotMatch(rendered, /Pattern stays/);
  assert.doesNotMatch(rendered, /Lesson stays/);
});

test("decay lowers the confidence of a Pattern and never of a Rule", (t) => {
  const base = makeBase(t);
  const rule = captureKnowledgeEntry(base, "rule", "Rule keeps confidence", "project", { confidence: 0.8 });
  const pattern = captureKnowledgeEntry(base, "pattern", "Pattern decays", "project", { confidence: 0.8 });
  const plainId = createMemory({ category: "convention", content: "Plain memory decays", confidence: 0.8 });
  const adapter = _getAdapter()!;
  adapter.prepare("UPDATE memories SET updated_at = '2020-01-01T00:00:00.000Z'").run();
  for (let i = 0; i < 20; i++) {
    adapter
      .prepare("INSERT INTO memory_processed_units (unit_key, activity_file, processed_at) VALUES (:key, 'a.jsonl', :at)")
      .run({ ":key": `unit-${i}`, ":at": `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  }

  const decayed = decayStaleMemories(20);

  assert.deepEqual([...decayed].sort(), [pattern.memoryId, plainId].sort());
  const confidence = (id: string) =>
    (adapter.prepare("SELECT confidence FROM memories WHERE id = :id").get({ ":id": id }) as { confidence: number }).confidence;
  assert.equal(confidence(rule.memoryId), 0.8);
  assert.ok(confidence(pattern.memoryId) < 0.8, "the Pattern lost confidence");
});

test("the closeout refresh goes through the Projection Worker, not a direct write", async (t) => {
  const base = makeBase(t);
  seedKnowledgeBelowPlainMemories(base, 6);
  await drainProjectionWork(base);
  enforceMemoryCap(4);
  const beforeEnqueue = knowledgeMd(base);
  assert.match(beforeEnqueue, /Pattern stays/, "the cap alone does not write the file");

  enqueueKnowledgeRefresh();

  assert.equal(knowledgeMd(base), beforeEnqueue, "the enqueue does not write the file");
  await drainProjectionWork(base);
  assert.doesNotMatch(knowledgeMd(base), /Pattern stays/, "the worker renders the capped Pattern out of the file");
  assert.match(knowledgeMd(base), /\| K001 \| project \| Rule stays \|/);
});

test("a failed closeout enqueue logs that the memories are committed and the render is not enqueued", (t) => {
  makeBase(t);
  _resetLogs();
  t.after(() => _resetLogs());

  assert.doesNotThrow(() => enqueueKnowledgeRefresh(() => {
    throw new Error("queue is down");
  }));

  const warnings = peekLogs().filter((entry) => entry.severity === "warn").map((entry) => entry.message);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /memories committed, render not enqueued/);
  assert.match(warnings[0]!, /queue is down/);
  assert.doesNotMatch(warnings[0]!, /roll(ed)? ?back/i);
});

test("/gsd memory forget removes the row from KNOWLEDGE.md at once", async (t) => {
  const base = makeBase(t);
  const kept = captureKnowledgeEntry(base, "pattern", "Pattern kept", "project");
  const forgotten = captureKnowledgeEntry(base, "pattern", "Pattern forgotten", "project");
  assert.match(knowledgeMd(base), /Pattern forgotten/);

  await runMemory(base, `forget ${forgotten.memoryId}`);

  const rendered = knowledgeMd(base);
  assert.doesNotMatch(rendered, /Pattern forgotten/);
  assert.match(rendered, new RegExp(`\\| ${kept.id} \\| Pattern kept \\|`));
});

test("/gsd memory export then import keeps the knowledge id and renders KNOWLEDGE.md", async (t) => {
  const source = makeBase(t);
  captureKnowledgeEntry(source, "rule", "Exported rule", "project");
  const exportPath = join(source, "memories.json");
  await runMemory(source, `export ${exportPath}`);
  const exported = readFileSync(exportPath, "utf-8");
  closeDatabase();

  const target = makeBase(t);
  const importPath = join(target, "memories.json");
  writeFileSync(importPath, exported, "utf-8");
  await runMemory(target, `import ${importPath}`);

  assert.deepEqual(activeKnowledgeIds(), ["K001"]);
  assert.match(knowledgeMd(target), /\| K001 \| project \| Exported rule \|/);
});

test("/gsd memory import of the project's own export adds nothing", async (t) => {
  const base = makeBase(t);
  captureKnowledgeEntry(base, "rule", "Local rule", "project");
  createMemory({ category: "convention", content: "Local convention" });
  const exportPath = join(base, "memories.json");
  await runMemory(base, `export ${exportPath}`);
  const before = knowledgeMd(base);

  const messages = await runMemory(base, `import ${exportPath}`);

  assert.equal(activeMemoryCount(), 2);
  assert.deepEqual(activeKnowledgeIds(), ["K001"]);
  assert.equal(knowledgeMd(base), before);
  assert.match(messages.join("\n"), /Imported 0 memories/);
  assert.match(messages.join("\n"), /Skipped 2 already present locally/);
});

test("/gsd memory import finds a duplicate by category and content, whatever the case and spacing", async (t) => {
  const base = makeBase(t);
  captureKnowledgeEntry(base, "pattern", "Use the  shared renderer", "project");

  await runMemory(base, `import ${exportFile(base, [
    { category: "pattern", content: "use the shared   RENDERER", structured_fields: { sourceKnowledgeId: "P007" } },
    { category: "gotcha", content: "Use the shared renderer" },
  ])}`);

  assert.deepEqual(activeKnowledgeIds(), ["P001"], "the same content in the same category is not added again");
  assert.equal(activeMemoryCount(), 2, "the same content in another category is a different row");
});

test("/gsd memory import gives a colliding knowledge id a new local id and reports the remap", async (t) => {
  const base = makeBase(t);
  const local = captureKnowledgeEntry(base, "rule", "Local rule", "project");

  const messages = await runMemory(base, `import ${exportFile(base, [
    { category: "rule", content: "Imported rule", structured_fields: { sourceKnowledgeId: "K001", rule: "Imported rule" } },
  ])}`);

  assert.deepEqual(activeKnowledgeIds(), ["K001", "K002"]);
  const localRow = _getAdapter()!
    .prepare("SELECT content, superseded_by FROM memories WHERE id = :id")
    .get({ ":id": local.memoryId }) as { content: string; superseded_by: string | null };
  assert.deepEqual({ ...localRow }, { content: "Local rule", superseded_by: null }, "the local row is not superseded");
  const rendered = knowledgeMd(base);
  assert.match(rendered, /\| K001 \| project \| Local rule \|/);
  assert.match(rendered, /\| K002 \| project \| Imported rule \|/);
  assert.match(messages.join("\n"), /K001 → K002/);
});

test("/gsd memory import treats a file-only KNOWLEDGE.md row as a local row", async (t) => {
  const base = makeBase(t);
  writeFileSync(
    join(base, ".gsd", "KNOWLEDGE.md"),
    [
      "# Project Knowledge",
      "",
      "## Rules",
      "",
      "| # | Scope | Rule | Why | Added |",
      "|---|-------|------|-----|-------|",
      "| K001 | project | File only rule | — | — |",
      "",
    ].join("\n"),
  );

  const messages = await runMemory(base, `import ${exportFile(base, [
    { category: "rule", content: "File only rule", structured_fields: { sourceKnowledgeId: "K005" } },
    { category: "rule", content: "Imported rule", structured_fields: { sourceKnowledgeId: "K001", rule: "Imported rule" } },
  ])}`);

  assert.deepEqual(activeKnowledgeIds(), ["K002"], "the duplicate of the file row is skipped; the collision gets a new id");
  const rendered = knowledgeMd(base);
  assert.match(rendered, /\| K001 \| project \| File only rule \|/);
  assert.match(rendered, /\| K002 \| project \| Imported rule \|/);
  assert.match(messages.join("\n"), /K001 → K002/);
});
