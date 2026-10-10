// gsd-pi — loadMemoryBlock tests (ADR-013 step 4 auto-injection parity)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase, updateMemoryStructuredFieldsRow } from '../gsd-db.ts';
import { createMemory } from '../memory-store.ts';
import { loadMemoryBlock } from '../bootstrap/system-context.ts';

// ─── Success path: critical memories surface in the labeled block ──────────

test('loadMemoryBlock: renders MEMORY block when critical memories exist', async () => {
  openDatabase(':memory:');
  try {
    const id = createMemory({
      category: 'architecture',
      content: 'Use the memories table as the single source of truth for decisions.',
      confidence: 0.95,
    });
    assert.ok(id, 'createMemory should seed a memory');

    const block = await loadMemoryBlock('');
    assert.ok(block.length > 0, 'block should be non-empty when critical memories exist');
    assert.match(block, /\[MEMORY — Critical and prompt-relevant memories/);
    assert.match(block, /memories table as the single source of truth/);
  } finally {
    closeDatabase();
  }
});

// ─── Failure / degraded path: no DB → returns "" without throwing ───────────

test('loadMemoryBlock: returns empty string when no DB is available', async () => {
  closeDatabase();
  const block = await loadMemoryBlock('anything');
  assert.equal(block, '', 'no DB → empty block (graceful degradation)');
});

// ─── Regression #2756: superseded decision mirrors are not injected ─────────

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

test('loadMemoryBlock: omits decision mirrors superseded via structured_fields (#2756)', async (t) => {
  t.after(closeDatabase);
  openDatabase(':memory:');

  const d1 = createMemory({
    category: 'architecture',
    content: 'D001: deploy on Fridays',
    confidence: 0.9,
    structuredFields: decisionMirrorFields('D001', 'deploy on Fridays', null),
  });
  const d2 = createMemory({
    category: 'architecture',
    content: 'D002: deploy on Tuesdays',
    confidence: 0.9,
    structuredFields: decisionMirrorFields('D002', 'deploy on Tuesdays', null),
  });
  assert.ok(d1 && d2, 'mirror seeds should succeed');

  // D002 supersedes D001 — saveDecisionToDb writes only the structured_fields
  // marker; the memories.superseded_by column stays NULL for mirrors.
  updateMemoryStructuredFieldsRow(
    d1,
    decisionMirrorFields('D001', 'deploy on Fridays', d2),
    new Date().toISOString(),
  );

  const block = await loadMemoryBlock('');
  assert.match(block, /D002: deploy on Tuesdays/, 'active decision mirror stays injected');
  assert.doesNotMatch(block, /D001: deploy on Fridays/, 'superseded decision mirror must not be injected');
});
