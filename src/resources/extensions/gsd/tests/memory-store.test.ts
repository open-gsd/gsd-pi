import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  SCHEMA_VERSION,
  _getAdapter,
} from '../gsd-db.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { _setMemoriesFtsRebuildBoundaryForTest } from '../db-memory-fts-schema.ts';
import {
  getActiveMemories,
  getActiveMemoriesRanked,
  nextMemoryId,
  createMemory,
  updateMemoryContent,
  reinforceMemory,
  supersedeMemory,
  isUnitProcessed,
  markUnitProcessed,
  decayStaleMemories,
  enforceMemoryCap,
  queryMemoriesRanked,
  applyMemoryActions,
  formatMemoriesForPrompt,
} from '../memory-store.ts';
import type { MemoryAction } from '../memory-store.ts';
import { updateMemoryStructuredFieldsRow } from '../gsd-db.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-memory-store-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDbPath(dbPath: string): void {
  closeDatabase();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: fallback when DB not open
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: fallback returns empty when DB not open', () => {
  closeDatabase();
  assert.ok(!isDbAvailable(), 'DB should not be available');

  assert.deepStrictEqual(getActiveMemories(), [], 'getActiveMemories returns [] when DB closed');
  assert.deepStrictEqual(getActiveMemoriesRanked(), [], 'getActiveMemoriesRanked returns [] when DB closed');
  assert.deepStrictEqual(nextMemoryId(), 'MEM001', 'nextMemoryId returns MEM001 when DB closed');
  assert.deepStrictEqual(createMemory({ category: 'test', content: 'test' }), null, 'createMemory returns null when DB closed');
  assert.ok(!reinforceMemory('MEM001'), 'reinforceMemory returns false when DB closed');
  assert.ok(!isUnitProcessed('test/key'), 'isUnitProcessed returns false when DB closed');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: CRUD operations
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: create and query memories', () => {
  openDatabase(':memory:');

  // Create memories
  const id1 = createMemory({ category: 'gotcha', content: 'esbuild drops .node binaries' });
  assert.ok(id1 !== null, 'createMemory should return an ID');
  assert.deepStrictEqual(id1, 'MEM001', 'first memory ID should be MEM001');

  const id2 = createMemory({ category: 'convention', content: 'use :memory: for tests', confidence: 0.9 });
  assert.deepStrictEqual(id2, 'MEM002', 'second memory ID should be MEM002');

  const id3 = createMemory({ category: 'architecture', content: 'extensions discovered from src/resources/' });
  assert.deepStrictEqual(id3, 'MEM003', 'third memory ID should be MEM003');

  // Query all active
  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 3, 'should have 3 active memories');
  assert.deepStrictEqual(active[0].category, 'gotcha', 'first memory category');
  assert.deepStrictEqual(active[0].content, 'esbuild drops .node binaries', 'first memory content');
  assert.deepStrictEqual(active[1].confidence, 0.9, 'second memory confidence');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: update and reinforce
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: update and reinforce', () => {
  openDatabase(':memory:');

  createMemory({ category: 'gotcha', content: 'original content' });

  // Update content
  const updated = updateMemoryContent('MEM001', 'revised content', 0.95);
  assert.ok(updated, 'updateMemoryContent should return true');

  const active = getActiveMemories();
  assert.deepStrictEqual(active[0].content, 'revised content', 'content should be updated');
  assert.deepStrictEqual(active[0].confidence, 0.95, 'confidence should be updated');

  // Reinforce
  const reinforced = reinforceMemory('MEM001');
  assert.ok(reinforced, 'reinforceMemory should return true');

  const after = getActiveMemories();
  assert.deepStrictEqual(after[0].hit_count, 1, 'hit_count should be 1 after reinforce');

  // Reinforce again
  reinforceMemory('MEM001');
  const after2 = getActiveMemories();
  assert.deepStrictEqual(after2[0].hit_count, 2, 'hit_count should be 2 after second reinforce');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: supersede
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: supersede', () => {
  openDatabase(':memory:');

  createMemory({ category: 'convention', content: 'old convention' });
  createMemory({ category: 'convention', content: 'new convention' });

  supersedeMemory('MEM001', 'MEM002');

  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 1, 'should have 1 active memory after supersede');
  assert.deepStrictEqual(active[0].id, 'MEM002', 'active memory should be MEM002');

  closeDatabase();
});

test('memory-store: createMemory supersedes prior active row for same sourceKnowledgeId in category', () => {
  openDatabase(':memory:');

  const first = createMemory({
    category: 'pattern',
    content: 'old pattern row',
    structuredFields: { sourceKnowledgeId: 'P005', pattern: 'old' },
  });
  const second = createMemory({
    category: 'pattern',
    content: 'new pattern row',
    structuredFields: { sourceKnowledgeId: 'P005', pattern: 'new' },
  });

  assert.equal(first, 'MEM001');
  assert.equal(second, 'MEM002');

  const adapter = _getAdapter()!;
  const oldRow = adapter
    .prepare('SELECT superseded_by FROM memories WHERE id = :id')
    .get({ ':id': first }) as { superseded_by: string | null } | undefined;
  assert.equal(oldRow?.superseded_by, second, 'older row should be superseded by the newly inserted row');

  const active = getActiveMemories();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, second);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// regression #2756 — superseded decision mirrors must not pass as active
// ═══════════════════════════════════════════════════════════════════════════

function decisionMirrorFields(id: string, decision: string, supersededBy: string | null) {
  return {
    sourceDecisionId: id,
    when_context: '',
    scope: 'project',
    decision,
    choice: decision,
    rationale: 'because',
    made_by: 'agent',
    revisable: 'Yes',
    superseded_by: supersededBy,
  };
}

test('memory-store: superseded decision mirrors are excluded from active queries (#2756)', (t) => {
  t.after(closeDatabase);
  openDatabase(':memory:');

  const d1 = createMemory({
    category: 'architecture',
    content: 'decision D001: use provider A',
    confidence: 0.85,
    structuredFields: decisionMirrorFields('D001', 'use provider A', null),
  });
  const d2 = createMemory({
    category: 'architecture',
    content: 'decision D002: use provider B',
    confidence: 0.85,
    structuredFields: decisionMirrorFields('D002', 'use provider B', null),
  });
  const d3 = createMemory({
    category: 'architecture',
    content: 'decision D003: keep deploys on Fridays',
    confidence: 0.85,
    structuredFields: decisionMirrorFields('D003', 'keep deploys on Fridays', null),
  });
  assert.ok(d1 && d2 && d3, 'mirror seeds should succeed');

  // saveDecisionToDb(supersedes: D001) → supersedeActiveDecision writes ONLY
  // structured_fields.superseded_by on D001's mirror; the memories.superseded_by
  // column stays NULL (context-store.ts: decision mirrors never set the column).
  updateMemoryStructuredFieldsRow(
    d1,
    decisionMirrorFields('D001', 'use provider A', d2),
    new Date().toISOString(),
  );

  // Both active queries: D001's mirror drops out, D002/D003 stay.
  for (const ids of [
    getActiveMemories().map((m) => m.id),
    getActiveMemoriesRanked(30).map((m) => m.id),
    queryMemoriesRanked({ query: '', k: 10 }).map((r) => r.memory.id),
  ]) {
    assert.ok(!ids.includes(d1), 'superseded decision mirror must not be active');
    assert.ok(ids.includes(d2) && ids.includes(d3), 'active mirrors must survive');
  }

  // Keyword path (FTS when available, LIKE fallback otherwise).
  const hits = queryMemoriesRanked({ query: 'provider', k: 10 }).map((r) => r.memory.id);
  assert.ok(!hits.includes(d1), 'superseded mirror must not resurface via keyword search');
  assert.ok(hits.includes(d2), 'the superseding mirror matches the same topic');

  // Explicit opt-in keeps the full supersedes chain visible — both the
  // keyword path and the blank-query ranked path.
  for (const opts of [{ query: 'provider', k: 10, include_superseded: true }, { query: '', k: 10, include_superseded: true }] as const) {
    const withSuperseded = queryMemoriesRanked(opts).map((r) => r.memory.id);
    assert.ok(withSuperseded.includes(d1), `include_superseded: true keeps the full chain visible (${opts.query ? 'keyword' : 'ranked'} path)`);
  }
});

test('memory-store: column supersession still filters non-decision memories (#2756)', (t) => {
  t.after(closeDatabase);
  openDatabase(':memory:');

  const plain1 = createMemory({ category: 'gotcha', content: 'plain memory one' });
  const plain2 = createMemory({ category: 'gotcha', content: 'plain memory two' });
  assert.ok(plain1 && plain2, 'plain seeds should succeed');
  supersedeMemory(plain1, plain2); // sets the real memories.superseded_by column

  const rankedIds = getActiveMemoriesRanked(30).map((m) => m.id);
  assert.ok(!rankedIds.includes(plain1), 'column-superseded rows stay filtered');
  assert.ok(rankedIds.includes(plain2), 'the superseding row stays active');
});

test('memory-store: LIKE fallback also drops superseded decision mirrors (#2756)', (t) => {
  t.after(closeDatabase);
  openDatabase(':memory:');

  // Drop the FTS machinery so keywordSearch takes the LIKE fallback path.
  const adapter = _getAdapter()!;
  adapter.exec('DROP TRIGGER IF EXISTS memories_ai');
  adapter.exec('DROP TRIGGER IF EXISTS memories_ad');
  adapter.exec('DROP TRIGGER IF EXISTS memories_au');
  adapter.exec('DROP TABLE IF EXISTS memories_fts');

  const d1 = createMemory({
    category: 'architecture',
    content: 'decision D001: cache eviction policy',
    structuredFields: decisionMirrorFields('D001', 'cache eviction policy', null),
  });
  const d2 = createMemory({
    category: 'architecture',
    content: 'decision D002: cache eviction policy v2',
    structuredFields: decisionMirrorFields('D002', 'cache eviction policy v2', null),
  });
  assert.ok(d1 && d2, 'mirror seeds should succeed');
  updateMemoryStructuredFieldsRow(
    d1,
    decisionMirrorFields('D001', 'cache eviction policy', d2),
    new Date().toISOString(),
  );

  const hits = queryMemoriesRanked({ query: 'cache eviction', k: 10 }).map((r) => r.memory.id);
  assert.ok(!hits.includes(d1), 'superseded mirror must not resurface via the LIKE fallback');
  assert.ok(hits.includes(d2), 'the superseding mirror matches via the LIKE fallback');
});

test('memory-store: malformed structured_fields does not blank the active set (#2756)', (t) => {
  t.after(closeDatabase);
  openDatabase(':memory:');

  const healthy = createMemory({ category: 'gotcha', content: 'healthy plain memory' });
  const corrupt = createMemory({
    category: 'architecture',
    content: 'decision D009: corrupt mirror',
    structuredFields: decisionMirrorFields('D009', 'corrupt mirror', null),
  });
  assert.ok(healthy && corrupt, 'seeds should succeed');
  // Simulate a corrupted row (manual edit / legacy writer): json_extract would
  // throw on it and collapse the whole query into `catch → []` without the
  // json_valid guard.
  _getAdapter()!
    .prepare('UPDATE memories SET structured_fields = :sf WHERE id = :id')
    .run({ ':sf': '{broken json', ':id': corrupt });

  // The query must not throw: healthy rows survive, and the corrupt row stays
  // active (parseStructuredFields treats unreadable fields as plain memory).
  const ranked = getActiveMemoriesRanked(30);
  const rankedIds = ranked.map((m) => m.id);
  assert.ok(rankedIds.includes(healthy), 'healthy rows must survive a corrupt neighbor');
  assert.ok(rankedIds.includes(corrupt), 'corrupt row stays active (lenient parse semantics)');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: ranked query ordering
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: ranked query ordering', () => {
  openDatabase(':memory:');

  // Low confidence, no hits
  createMemory({ category: 'pattern', content: 'low ranking', confidence: 0.5 });
  // High confidence, no hits
  createMemory({ category: 'gotcha', content: 'high confidence', confidence: 0.95 });
  // Medium confidence, many hits
  createMemory({ category: 'convention', content: 'frequently used', confidence: 0.7 });

  // Reinforce MEM003 multiple times to boost its ranking
  for (let i = 0; i < 10; i++) reinforceMemory('MEM003');

  const ranked = getActiveMemoriesRanked(10);
  assert.deepStrictEqual(ranked.length, 3, 'should have 3 ranked memories');
  // MEM003: 0.7 * (1 + 10*0.1) = 0.7 * 2.0 = 1.4
  // MEM002: 0.95 * (1 + 0*0.1) = 0.95
  // MEM001: 0.5 * (1 + 0*0.1) = 0.5
  assert.deepStrictEqual(ranked[0].id, 'MEM003', 'highest ranked should be MEM003 (reinforced)');
  assert.deepStrictEqual(ranked[1].id, 'MEM002', 'second ranked should be MEM002 (high confidence)');
  assert.deepStrictEqual(ranked[2].id, 'MEM001', 'lowest ranked should be MEM001');

  // Test limit
  const limited = getActiveMemoriesRanked(2);
  assert.deepStrictEqual(limited.length, 2, 'limit should cap results');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: processed unit tracking
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: processed unit tracking', () => {
  openDatabase(':memory:');

  assert.ok(!isUnitProcessed('execute-task/M001/S01/T01'), 'should not be processed initially');

  markUnitProcessed('execute-task/M001/S01/T01', '/path/to/activity.jsonl');

  assert.ok(isUnitProcessed('execute-task/M001/S01/T01'), 'should be processed after marking');
  assert.ok(!isUnitProcessed('execute-task/M001/S01/T02'), 'different key should not be processed');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: enforce memory cap
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: enforce memory cap', () => {
  openDatabase(':memory:');

  // Create 5 memories with varying confidence
  createMemory({ category: 'gotcha', content: 'mem 1', confidence: 0.9 });
  createMemory({ category: 'gotcha', content: 'mem 2', confidence: 0.5 });
  createMemory({ category: 'gotcha', content: 'mem 3', confidence: 0.3 });
  createMemory({ category: 'gotcha', content: 'mem 4', confidence: 0.95 });
  createMemory({ category: 'gotcha', content: 'mem 5', confidence: 0.7 });

  // Enforce cap of 3
  enforceMemoryCap(3);

  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 3, 'should have 3 active memories after cap enforcement');

  // The 2 lowest-ranked (MEM003=0.3 and MEM002=0.5) should be superseded
  const ids = active.map(m => m.id).sort();
  assert.ok(ids.includes('MEM001'), 'MEM001 (0.9) should survive');
  assert.ok(ids.includes('MEM004'), 'MEM004 (0.95) should survive');
  assert.ok(ids.includes('MEM005'), 'MEM005 (0.7) should survive');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: applyMemoryActions transaction
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: applyMemoryActions', () => {
  openDatabase(':memory:');

  const actions: MemoryAction[] = [
    { action: 'CREATE', category: 'gotcha', content: 'first gotcha', confidence: 0.8 },
    { action: 'CREATE', category: 'convention', content: 'first convention', confidence: 0.9 },
  ];

  applyMemoryActions(actions, 'execute-task', 'M001/S01/T01');

  let active = getActiveMemories();
  assert.deepStrictEqual(active.length, 2, 'should have 2 memories after CREATE actions');

  // Now apply UPDATE + REINFORCE
  const updateActions: MemoryAction[] = [
    { action: 'UPDATE', id: 'MEM001', content: 'updated gotcha' },
    { action: 'REINFORCE', id: 'MEM002' },
  ];

  applyMemoryActions(updateActions, 'execute-task', 'M001/S01/T02');

  active = getActiveMemories();
  assert.deepStrictEqual(active.find(m => m.id === 'MEM001')?.content, 'updated gotcha', 'MEM001 should be updated');
  assert.deepStrictEqual(active.find(m => m.id === 'MEM002')?.hit_count, 1, 'MEM002 should be reinforced');

  // SUPERSEDE
  const supersedeActions: MemoryAction[] = [
    { action: 'CREATE', category: 'gotcha', content: 'better gotcha', confidence: 0.95 },
    { action: 'SUPERSEDE', id: 'MEM001', superseded_by: 'MEM003' },
  ];

  applyMemoryActions(supersedeActions, 'execute-task', 'M001/S01/T03');

  active = getActiveMemories();
  assert.deepStrictEqual(active.length, 2, 'should have 2 active after supersede');
  assert.ok(!active.find(m => m.id === 'MEM001'), 'MEM001 should be superseded');
  assert.ok(!!active.find(m => m.id === 'MEM003'), 'MEM003 should be active');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: formatMemoriesForPrompt
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: formatMemoriesForPrompt', () => {
  openDatabase(':memory:');

  createMemory({ category: 'gotcha', content: 'esbuild drops .node binaries' });
  createMemory({ category: 'convention', content: 'use :memory: for tests' });
  createMemory({ category: 'architecture', content: 'extensions in src/resources/' });
  createMemory({ category: 'gotcha', content: 'TypeScript path aliases need .js' });

  const memories = getActiveMemoriesRanked(30);
  const formatted = formatMemoriesForPrompt(memories);

  assert.ok(formatted.includes('## Project Memory (auto-learned)'), 'should have header');
  assert.ok(formatted.includes('### Gotcha'), 'should have gotcha category');
  assert.ok(formatted.includes('### Convention'), 'should have convention category');
  assert.ok(formatted.includes('### Architecture'), 'should have architecture category');
  assert.ok(formatted.includes('- esbuild drops .node binaries'), 'should have gotcha content');
  assert.ok(formatted.includes('- use :memory: for tests'), 'should have convention content');

  // Test empty memories
  closeDatabase();
  openDatabase(':memory:');
  const emptyFormatted = formatMemoriesForPrompt([]);
  assert.deepStrictEqual(emptyFormatted, '', 'empty memories should return empty string');

  // Test token budget truncation
  closeDatabase();
  openDatabase(':memory:');
  for (let i = 0; i < 20; i++) {
    createMemory({ category: 'pattern', content: `A very long memory entry that takes up space #${i}: ${'x'.repeat(200)}` });
  }
  const budgetMemories = getActiveMemoriesRanked(30);
  const truncated = formatMemoriesForPrompt(budgetMemories, 500);
  assert.ok(truncated.length < 2500, `formatted length ${truncated.length} should be under budget`);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: ID generation
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: ID generation', () => {
  openDatabase(':memory:');

  assert.deepStrictEqual(nextMemoryId(), 'MEM001', 'first ID should be MEM001');

  createMemory({ category: 'test', content: 'test' });
  assert.deepStrictEqual(nextMemoryId(), 'MEM002', 'after first create, next should be MEM002');

  // Create several more
  for (let i = 0; i < 98; i++) createMemory({ category: 'test', content: `test ${i}` });
  assert.deepStrictEqual(nextMemoryId(), 'MEM100', 'after 99 creates, next should be MEM100');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: schema migration (v2 → v3)
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: schema includes memories table', () => {
  openDatabase(':memory:');

  const adapter = _getAdapter()!;

  // Verify memories table exists
  const memCount = adapter.prepare('SELECT count(*) as cnt FROM memories').get();
  assert.deepStrictEqual(memCount?.['cnt'], 0, 'memories table should exist and be empty');

  // Verify memory_processed_units table exists
  const procCount = adapter.prepare('SELECT count(*) as cnt FROM memory_processed_units').get();
  assert.deepStrictEqual(procCount?.['cnt'], 0, 'memory_processed_units table should exist and be empty');

  // Verify active_memories view exists
  const viewCount = adapter.prepare('SELECT count(*) as cnt FROM active_memories').get();
  assert.deepStrictEqual(viewCount?.['cnt'], 0, 'active_memories view should exist');

  // Verify schema version is current (includes quality_gates DDL fix and later migrations)
  const version = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assert.deepStrictEqual(version?.["v"], SCHEMA_VERSION, `schema version should be ${SCHEMA_VERSION}`);

  closeDatabase();
});

test('memory-store: reopening rebuilds FTS index for pre-FTS memories', () => {
  const dbPath = tempDbPath();
  try {
    openDatabase(dbPath);
    const id = createMemory({ category: 'gotcha', content: 'pre FTS auth memory must become searchable' });
    assert.equal(id, 'MEM001');

    const adapter = _getAdapter()!;
    const fts = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!fts) return;

    adapter.exec('DROP TRIGGER IF EXISTS memories_ai');
    adapter.exec('DROP TRIGGER IF EXISTS memories_ad');
    adapter.exec('DROP TRIGGER IF EXISTS memories_au');
    adapter.exec('DROP TABLE IF EXISTS memories_fts');
    adapter.prepare(
      "DELETE FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'",
    ).run();
    closeDatabase();

    openDatabase(dbPath);
    const reopened = _getAdapter()!;
    const marker = reopened.prepare(
      "SELECT value_json FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'",
    ).get();
    assert.ok(marker, 'FTS rebuild marker should be set after reopening');

    const hits = queryMemoriesRanked({ query: 'auth', k: 5 }).map((hit) => hit.memory.id);
    assert.deepEqual(hits, ['MEM001']);
  } finally {
    cleanupDbPath(dbPath);
  }
});

test('memory-store: repairing FTS schema replaces a stale rebuild marker', () => {
  const dbPath = tempDbPath();
  try {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const fts = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!fts) return;

    adapter.exec('DROP TRIGGER IF EXISTS memories_ai');
    adapter.exec('DROP TRIGGER IF EXISTS memories_ad');
    adapter.exec('DROP TRIGGER IF EXISTS memories_au');
    adapter.exec('DROP TABLE IF EXISTS memories_fts');
    adapter.prepare(`
      UPDATE runtime_kv
      SET value_json = '"stale-marker"'
      WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'
    `).run();
    const markerBefore = adapter.prepare(
      "SELECT value_json FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'",
    ).get()?.['value_json'];
    assert.ok(markerBefore);
    const id = createMemory({ category: 'gotcha', content: 'stale marker repair must restore search' });
    closeDatabase();

    openDatabase(dbPath);
    const markerAfter = _getAdapter()!.prepare(
      "SELECT value_json FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'",
    ).get()?.['value_json'];
    assert.notEqual(markerAfter, markerBefore);
    const hits = queryMemoriesRanked({ query: 'restore', k: 5 }).map((hit) => hit.memory.id);
    assert.deepEqual(hits, [id]);
  } finally {
    cleanupDbPath(dbPath);
  }
});

test('memory-store: failed FTS repair durably invalidates its stale marker', () => {
  const dbPath = tempDbPath();
  try {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const fts = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!fts) return;

    adapter.exec('DROP TRIGGER IF EXISTS memories_ai');
    adapter.exec('DROP TRIGGER IF EXISTS memories_ad');
    adapter.exec('DROP TRIGGER IF EXISTS memories_au');
    adapter.exec('DROP TABLE IF EXISTS memories_fts');
    adapter.prepare(`
      UPDATE runtime_kv
      SET value_json = '"stale-marker"'
      WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'
    `).run();
    const id = createMemory({ category: 'gotcha', content: 'failed repair must retry before readiness' });
    closeDatabase();

    _setMemoriesFtsRebuildBoundaryForTest(() => {
      throw new Error('forced FTS rebuild failure');
    });
    assert.throws(() => openDatabase(dbPath), /forced FTS rebuild failure/);

    const raw = new DatabaseSync(dbPath);
    try {
      const marker = raw.prepare(
        "SELECT value_json FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = 'memories_fts_rebuilt_at'",
      ).get();
      assert.equal(marker, undefined);
    } finally {
      raw.close();
    }

    assert.throws(() => openDatabase(dbPath), /forced FTS rebuild failure/);
    _setMemoriesFtsRebuildBoundaryForTest(null);
    assert.equal(openDatabase(dbPath), true);
    const hits = queryMemoriesRanked({ query: 'readiness', k: 5 }).map((hit) => hit.memory.id);
    assert.deepEqual(hits, [id]);
  } finally {
    _setMemoriesFtsRebuildBoundaryForTest(null);
    cleanupDbPath(dbPath);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// regression #4967 — createMemory must not silently swallow SQL errors
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: createMemory throws on memory-table SQL errors (regression #4967)', () => {
  openDatabase(':memory:');

  const adapter = _getAdapter()!;
  // Drop FTS + dependents first to satisfy SQLite's trigger ordering, then
  // the base memories table. IF EXISTS makes setup robust against schema
  // versions that may not have created every dependent (e.g. embeddings).
  adapter.prepare('DROP TABLE IF EXISTS memory_embeddings').run();
  adapter.prepare('DROP TABLE IF EXISTS memories_fts').run();
  adapter.prepare('DROP TABLE IF EXISTS memories').run();

  // Pre-fix behaviour: returns null and the caller has no idea why.
  // Post-fix behaviour: throws so the caller can surface the real SQL message.
  assert.throws(
    () => createMemory({ category: 'gotcha', content: 'broken store' }),
    /memories|no such table/i,
    'createMemory must surface SQL errors instead of returning null',
  );

  closeDatabase();
});

test('memory-store: malformed writes fail loud without an unfenced VACUUM retry', () => {
  openDatabase(':memory:');

  const adapter = _getAdapter()!;
  const originalPrepareMethod = adapter.prepare;
  const originalPrepare = adapter.prepare.bind(adapter);
  let selectFailures = 0;
  let vacuumRuns = 0;

  adapter.prepare = ((sql: string) => {
    if (sql === 'SELECT seq FROM memories WHERE id = :id' && selectFailures === 0) {
      const stmt = originalPrepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (..._params: unknown[]) => {
          selectFailures++;
          throw new Error('database disk image is malformed');
        },
        all: (...params: unknown[]) => stmt.all(...params),
      };
    }

    if (sql === 'VACUUM') {
      const stmt = originalPrepare(sql);
      return {
        run: (...params: unknown[]) => {
          vacuumRuns++;
          return stmt.run(...params);
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    }

    return originalPrepare(sql);
  }) as typeof adapter.prepare;

  try {
    assert.throws(
      () => createMemory({ category: 'gotcha', content: 'surface malformed store' }),
      /database disk image is malformed/,
      'createMemory must preserve the original malformed-store error',
    );

    const rows = adapter.prepare('SELECT id FROM memories ORDER BY seq').all();
    assert.deepStrictEqual(rows, [], 'the failed transaction must roll back its temporary memory');
    assert.equal(selectFailures, 1, 'test should simulate one malformed SELECT after INSERT');
    assert.equal(vacuumRuns, 0, 'malformed writes must not bypass the replacement fence with VACUUM');
  } finally {
    adapter.prepare = originalPrepareMethod;
    closeDatabase();
  }
});

test('memory-store: applyMemoryActions stays non-fatal when memory store is broken (regression #4967)', () => {
  openDatabase(':memory:');

  const adapter = _getAdapter()!;
  // Drop FTS + dependents first to satisfy SQLite's trigger ordering, then
  // the base memories table. IF EXISTS makes setup robust against schema
  // versions that may not have created every dependent (e.g. embeddings).
  adapter.prepare('DROP TABLE IF EXISTS memory_embeddings').run();
  adapter.prepare('DROP TABLE IF EXISTS memories_fts').run();
  adapter.prepare('DROP TABLE IF EXISTS memories').run();

  // applyMemoryActions wraps createMemory in a transaction with an outer
  // catch. Even with createMemory now throwing, applyMemoryActions must not
  // crash the auto-mode flow that calls it (memory extraction is best-effort).
  const actions: MemoryAction[] = [
    { action: 'CREATE', category: 'gotcha', content: 'inside-transaction call' },
  ];
  assert.doesNotThrow(
    () => applyMemoryActions(actions),
    'applyMemoryActions must absorb thrown errors so callers continue',
  );

  closeDatabase();
});
