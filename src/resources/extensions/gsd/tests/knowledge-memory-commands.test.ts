// ADR-046 — KNOWLEDGE rows and the memory commands.
//
// Covers:
//   1. the memory cap and decay never remove or weaken a knowledge row
//   2. `/gsd memory forget`, `cap` and `import` render KNOWLEDGE.md at once
//   3. `/gsd memory export` + `import` keeps the knowledge id of a row

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
import { createMemory, decayStaleMemories, enforceMemoryCap } from "../memory-store.ts";

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

const ctx = { ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
const pi = {} as ExtensionAPI;

function runMemory(base: string, args: string): Promise<void> {
  return withCommandCwd(base, () => handleMemory(args, ctx, pi));
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

test("the memory cap never supersedes a knowledge row, however low it ranks", (t) => {
  const base = makeBase(t);
  seedKnowledgeBelowPlainMemories(base, 6);

  enforceMemoryCap(4);

  assert.deepEqual(activeKnowledgeIds(), ["K001", "L001", "P001"]);
  const plain = _getAdapter()!
    .prepare("SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL AND category = 'convention'")
    .get() as { n: number };
  assert.equal(plain.n, 4, "the cap applies to memories that are not knowledge rows");
});

test("/gsd memory cap keeps knowledge rows in KNOWLEDGE.md", async (t) => {
  const base = makeBase(t);
  seedKnowledgeBelowPlainMemories(base, 6);

  await runMemory(base, "cap 2");

  const rendered = knowledgeMd(base);
  assert.match(rendered, /\| K001 \| project \| Rule stays \|/);
  assert.match(rendered, /\| P001 \| Pattern stays \|/);
  assert.match(rendered, /\| L001 \| Lesson stays \|/);
});

test("decay does not lower the confidence of a knowledge row", (t) => {
  const base = makeBase(t);
  captureKnowledgeEntry(base, "pattern", "Pattern keeps confidence", "project", { confidence: 0.8 });
  const plainId = createMemory({ category: "convention", content: "Plain memory decays", confidence: 0.8 });
  const adapter = _getAdapter()!;
  adapter.prepare("UPDATE memories SET updated_at = '2020-01-01T00:00:00.000Z'").run();
  for (let i = 0; i < 20; i++) {
    adapter
      .prepare("INSERT INTO memory_processed_units (unit_key, activity_file, processed_at) VALUES (:key, 'a.jsonl', :at)")
      .run({ ":key": `unit-${i}`, ":at": `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  }

  const decayed = decayStaleMemories(20);

  assert.deepEqual(decayed, [plainId], "only the plain memory decays");
  const pattern = adapter
    .prepare("SELECT confidence FROM memories WHERE structured_fields LIKE '%\"sourceKnowledgeId\":\"P001\"%'")
    .get() as { confidence: number };
  assert.equal(pattern.confidence, 0.8);
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
