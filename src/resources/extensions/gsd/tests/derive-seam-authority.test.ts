// Post-cutover derive-seam authority checks (T007), re-homed from the
// retiring semantic-shadow no-cutover gate (T009 split-retires it).
//
// The live derive seam (state/derive/index.ts) dispatches to
// deriveStateFromDb whenever the project DB is available and fails closed via
// buildDbUnavailableState when it is not. Markdown files on disk are
// read-only projections — never state authority. These tests prove:
//   (a) with a cut-over fixture project, editing projections on disk does not
//       change derived state;
//   (b) with the DB unavailable, the seam fails closed and never reads
//       projections as authority;
//   (c) projections on disk are not opened for parsing on the live derive
//       path at all.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertDecision,
  insertArtifact,
} from '../gsd-db.ts';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-derive-seam-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, '.gsd', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// Markdown projections only. The engine renders these from DB state; their
// content must never steer derivation on the live path.
const ROADMAP_PROJECTION = `# M001: Test Milestone

**Vision:** Projection only — not authority.

## Slices

- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice done.
`;

const PLAN_PROJECTION = `# S01: First Slice

**Goal:** Projection only.
**Demo:** Projection only.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.

- [x] **T02: Done Task** \`est:10m\`
  Already done.
`;

// A STATE.md that lies: claims the project is complete with no active work.
const STATE_PROJECTION = `# Project State

Phase: complete
Active Milestone: none
Active Slice: none
Active Task: none
`;

function writeProjectionFixture(base: string): void {
  writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_PROJECTION);
  writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_PROJECTION);
  writeFile(base, 'STATE.md', STATE_PROJECTION);
}

function insertDbHierarchy(): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('derive-seam-authority', () => {

  // (a) Post-cutover DB authority: the fixture project has an on-disk DB at
  // the current schema with the milestone/slice/task hierarchy (the
  // post-cutover authority state; the cutover receipt itself is audited by
  // T006's own tests — the seam keys on DB authority, not receipt reads).
  // Mutating every markdown projection afterwards must not change the
  // derived state.
  test('derive-seam-authority: projection edits on disk do not change derived state', async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });

    writeProjectionFixture(base);

    // Populate the on-disk project DB, then close it so the live seam
    // re-opens it through ensureExistingWorkflowDbOpen — the real cold-start
    // dispatch path.
    assert.equal(openDatabase(join(base, '.gsd', 'gsd.db')), true);
    insertDbHierarchy();
    closeDatabase();

    invalidateStateCache();
    const before = await deriveState(base);
    assert.equal(before.phase, 'executing', 'seam: DB rows drive the executing phase');
    assert.equal(before.activeMilestone?.id, 'M001');
    assert.equal(before.activeSlice?.id, 'S01');
    assert.equal(before.activeTask?.id, 'T01');

    // Mutate every projection: roadmap all-done, plan flipped (T01 done, T02
    // pending), STATE.md claiming completion. If markdown were authority,
    // any of these would change the derived state.
    writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_PROJECTION.replace('- [ ] **S01:', '- [x] **S01:'));
    writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_PROJECTION
      .replace('- [ ] **T01:', '- [x] **T01:')
      .replace('- [x] **T02:', '- [ ] **T02:'));
    writeFile(base, 'STATE.md', STATE_PROJECTION);
    writeFile(base, 'DECISIONS.md', [
      '# Decisions',
      '',
      '| # | When / Context | Scope | Decision | Choice | Rationale | Revisable | Made By |',
      '|---|----------------|-------|----------|--------|-----------|----------|---------|',
      '| D001 | Now | global | Projection-only decision | Ignore | DB is authority | Yes | human |',
      '',
    ].join('\n'));
    writeFile(base, 'PROJECT.md', [
      '# Project',
      '',
      '## Milestone Sequence',
      '',
      '- [ ] M099: Phantom From Disk - Must not steer derive.',
      '',
    ].join('\n'));

    invalidateStateCache();
    const after = await deriveState(base);

    assert.deepStrictEqual(after, before, 'seam: derived state is byte-identical after projection edits');
    assert.equal(after.activeTask?.id, 'T01', 'seam: plan-projection edit does not flip the active task');
    assert.deepStrictEqual(after.recentDecisions, [], 'seam: DECISIONS.md projection does not populate recentDecisions');
  });

  // (b) DB unavailable: the seam fails closed via buildDbUnavailableState.
  // The projections on disk (including a STATE.md claiming active work) are
  // never read as authority.
  test('derive-seam-authority: DB-unavailable fails closed and ignores projections', async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });

    writeProjectionFixture(base);

    // No project DB exists and none is open — the seam must fail closed.
    closeDatabase();
    invalidateStateCache();
    const state = await deriveState(base);

    assert.equal(state.phase, 'pre-planning', 'fail-closed: phase is pre-planning');
    assert.equal(state.activeMilestone, null, 'fail-closed: STATE.md/ROADMAP claims are not authority');
    assert.equal(state.activeSlice, null, 'fail-closed: no slice imported from projections');
    assert.equal(state.activeTask, null, 'fail-closed: no task imported from projections');
    assert.deepStrictEqual(state.registry, [], 'fail-closed: registry is not built from projections');
    assert.ok(
      state.blockers.some(b => b.includes('DB unavailable')),
      'fail-closed: blocker explains unavailable DB',
    );
    assert.ok(
      state.nextAction.includes('/gsd migrate'),
      'fail-closed: next action points to explicit migration',
    );
  });

  // (c) The live derive path does not open markdown projections for parsing.
  // Spy on both fs.readFileSync and fs.promises.readFile (the two read
  // channels used under the seam) and assert no state projection is read.
  test('derive-seam-authority: live derive path never opens markdown projections', async (t) => {
    const base = createFixtureBase();

    const readPaths: string[] = [];
    const mutableFs = fs as { readFileSync: typeof fs.readFileSync };
    const originalReadFileSync = fs.readFileSync;
    mutableFs.readFileSync = ((path: fs.PathLike, ...args: unknown[]) => {
      readPaths.push(String(path));
      return (originalReadFileSync as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.readFileSync;
    const originalReadFile = fs.promises.readFile;
    const mutablePromises = fs.promises as { readFile: typeof fs.promises.readFile };
    mutablePromises.readFile = ((path: fs.PathLike, ...args: unknown[]) => {
      readPaths.push(String(path));
      return (originalReadFile as unknown as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.promises.readFile;
    syncBuiltinESMExports();

    t.after(() => {
      mutableFs.readFileSync = originalReadFileSync;
      mutablePromises.readFile = originalReadFile;
      syncBuiltinESMExports();
      closeDatabase();
      cleanup(base);
    });

    writeProjectionFixture(base);
    writeFile(base, 'DECISIONS.md', '| D001 | Now | global | Disk | Ignore | x | Yes | human |\n');
    writeFile(base, 'PROJECT.md', '# Project\n\n## Milestone Sequence\n\n- [ ] M099: Disk Only\n');

    assert.equal(openDatabase(':memory:'), true);
    insertDbHierarchy();

    invalidateStateCache();
    const state = await deriveState(base);
    assert.equal(state.phase, 'executing', 'spy-fixture: DB path taken');

    const projectionReads = readPaths.filter(p =>
      /STATE\.md$/i.test(p)
      || /DECISIONS\.md$/i.test(p)
      || /PROJECT\.md$/i.test(p)
      || /-ROADMAP\.md$/i.test(p)
      || /-PLAN\.md$/i.test(p)
      || /-SUMMARY\.md$/i.test(p)
      || /-CONTEXT(-DRAFT)?\.md$/i.test(p)
      || /REQUIREMENTS\.md$/i.test(p)
    );
    assert.deepStrictEqual(
      projectionReads,
      [],
      `live derive path must not open markdown projections, read: ${projectionReads.join(', ')}`,
    );
  });

  test('derive-seam-authority: recentDecisions come from DB rows, not DECISIONS.md', async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });

    writeProjectionFixture(base);
    writeFile(base, 'DECISIONS.md', [
      '# Decisions',
      '',
      '| # | When / Context | Scope | Decision | Choice | Rationale | Revisable | Made By |',
      '|---|----------------|-------|----------|--------|-----------|----------|---------|',
      '| D999 | Disk | global | Projection-only decision | Ignore | not authority | Yes | human |',
      '',
    ].join('\n'));

    assert.equal(openDatabase(':memory:'), true);
    insertDbHierarchy();
    insertDecision({
      id: 'D001',
      when_context: 'Now',
      scope: 'global',
      decision: 'DB is authority',
      choice: 'Query the decisions table',
      rationale: 'Live derive must not parse DECISIONS.md',
      revisable: 'Yes',
      made_by: 'human',
      source: 'discussion',
      superseded_by: null,
    });

    invalidateStateCache();
    const state = await deriveState(base);
    assert.equal(state.recentDecisions.length, 1, 'seam: one DB decision is surfaced');
    assert.match(
      state.recentDecisions[0] ?? '',
      /D001 \(Now\): DB is authority -> Query the decisions table/,
      'seam: recentDecisions format matches DB fields',
    );
    assert.ok(
      !state.recentDecisions.some((line) => line.includes('D999') || line.includes('Projection-only')),
      'seam: DECISIONS.md projection is not mixed into recentDecisions',
    );
  });

  test('derive-seam-authority: PROJECT.md on disk does not promote a queued shell', async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });

    writeFile(base, 'PROJECT.md', [
      '# Project',
      '',
      '## Milestone Sequence',
      '',
      '- [ ] M001: Foundation - Disk projection only.',
      '',
    ].join('\n'));

    assert.equal(openDatabase(':memory:'), true);
    insertMilestone({ id: 'M001', title: 'Foundation', status: 'queued' });

    invalidateStateCache();
    const fromDisk = await deriveState(base);
    assert.equal(fromDisk.activeMilestone, null, 'seam: disk PROJECT.md must not promote a queued shell');

    insertArtifact({
      path: 'PROJECT.md',
      artifact_type: 'PROJECT',
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: [
        '# Project',
        '',
        '## Milestone Sequence',
        '',
        '- [ ] M001: Foundation - Establish the first runnable slice.',
        '',
      ].join('\n'),
    });

    invalidateStateCache();
    const fromDb = await deriveState(base);
    assert.equal(fromDb.activeMilestone?.id, 'M001', 'seam: PROJECT artifact promotes the in-sequence shell');
    assert.equal(fromDb.phase, 'pre-planning', 'seam: in-sequence shell goes to pre-planning');
  });
});
