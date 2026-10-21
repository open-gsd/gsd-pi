// Project/App: gsd-pi
// File Purpose: Regression for #1291 — a full markdown re-import must NOT rewrite
// the completed_at of an already-complete slice or milestone with the current
// import time. The task path was fixed for this (#1222/#1228) via
// preserveCompletionMetadata; the slice and milestone backfills in
// migrateHierarchyToDb had no such guard, so every re-import re-stamped every
// complete slice/milestone. The fix threads preserveCompletion through
// updateSliceStatus/updateMilestoneStatus so an existing completed_at survives.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  getAllMilestones,
  getMilestoneSlices,
  updateSliceStatus,
  updateMilestoneStatus,
} from '../gsd-db.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-preserve-completion-'));
  tmpDirs.push(base);
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, '.gsd', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// All slices [x] → milestone imports complete, slices import complete.
const ROADMAP_ALL_DONE = `# M001: Finished Milestone

**Vision:** Done work.

## Slices

- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [x] **S02: Second Slice** \`risk:medium\` \`depends:[S01]\`
  > After this: Also done.
`;

const REAL_S01 = '2026-07-05T19:52:04.672Z';
const REAL_S02 = '2026-07-05T20:36:51.313Z';
const REAL_M001 = '2026-07-05T21:00:00.000Z';

describe('migrateHierarchyToDb: re-import preserves existing completion timestamps (#1291)', () => {
  test('a re-import does not rewrite already-complete slice completed_at', () => {
    const base = createFixtureBase();
    writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_ALL_DONE);

    openDatabase(join(base, '.gsd', 'gsd.db'));
    migrateHierarchyToDb(base);

    // Simulate the durable completion timestamps the real run wrote hours apart.
    updateSliceStatus('M001', 'S01', 'complete', REAL_S01);
    updateSliceStatus('M001', 'S02', 'complete', REAL_S02);

    // A second full re-import (the class of event that bit the reporter).
    migrateHierarchyToDb(base);

    const slices = getMilestoneSlices('M001');
    const s01 = slices.find((s) => s.id === 'S01')!;
    const s02 = slices.find((s) => s.id === 'S02')!;
    assert.equal(s01.completed_at, REAL_S01, 'S01 completed_at must survive re-import unchanged');
    assert.equal(s02.completed_at, REAL_S02, 'S02 completed_at must survive re-import unchanged');
  });

  test('a re-import does not rewrite an already-complete milestone completed_at', () => {
    const base = createFixtureBase();
    writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_ALL_DONE);

    openDatabase(join(base, '.gsd', 'gsd.db'));
    migrateHierarchyToDb(base);

    updateMilestoneStatus('M001', 'complete', REAL_M001);

    migrateHierarchyToDb(base);

    const m001 = getAllMilestones().find((m) => m.id === 'M001')!;
    assert.equal(m001.completed_at, REAL_M001, 'M001 completed_at must survive re-import unchanged');
  });

  test('an initial import of a complete slice still backfills a completed_at when the row has none', () => {
    // The guard preserves an existing timestamp but must not suppress the
    // legitimate first-time backfill for a slice imported as complete.
    const base = createFixtureBase();
    writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_ALL_DONE);

    openDatabase(join(base, '.gsd', 'gsd.db'));
    migrateHierarchyToDb(base);

    const slices = getMilestoneSlices('M001');
    for (const s of slices) {
      assert.ok(s.completed_at, `complete slice ${s.id} should receive a backfilled completed_at on first import`);
    }
    const m001 = getAllMilestones().find((m) => m.id === 'M001')!;
    assert.ok(m001.completed_at, 'complete milestone should receive a backfilled completed_at on first import');
  });
});
