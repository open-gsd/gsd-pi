// GSD MCP Server — .gsd/ path cache tests

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetReaderCaches,
  findMilestoneIds,
  findSliceIds,
  findTaskFiles,
  resolveSliceFile,
} from './paths.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function writeFixture(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('reader path caches', () => {
  beforeEach(() => {
    _resetReaderCaches();
  });

  it('returns defensive copies of cached milestone and slice ids', () => {
    const tmp = makeTempDir('gsd-path-cache');
    try {
      const gsdRoot = join(tmp, '.gsd');
      mkdirSync(join(gsdRoot, 'milestones', 'M001', 'slices', 'S01'), { recursive: true });
      mkdirSync(join(gsdRoot, 'milestones', 'M002'), { recursive: true });

      const milestoneIds = findMilestoneIds(gsdRoot);
      milestoneIds.push('M999');
      assert.deepEqual(findMilestoneIds(gsdRoot), ['M001', 'M002']);

      const sliceIds = findSliceIds(gsdRoot, 'M001');
      sliceIds.push('S99');
      assert.deepEqual(findSliceIds(gsdRoot, 'M001'), ['S01']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns defensive copies of cached task file objects', () => {
    const tmp = makeTempDir('gsd-path-task-cache');
    try {
      const gsdRoot = join(tmp, '.gsd');
      writeFixture(gsdRoot, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01');

      const taskFiles = findTaskFiles(gsdRoot, 'M001', 'S01');
      taskFiles[0].hasSummary = true;
      taskFiles.push({ id: 'T99', hasPlan: true, hasSummary: true });

      assert.deepEqual(findTaskFiles(gsdRoot, 'M001', 'S01'), [
        { id: 'T01', hasPlan: true, hasSummary: false },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('discovers flat-phase slice ids from plan/summary and task files', (t) => {
    const tmp = makeTempDir('gsd-path-flat-slices');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    // Milestone-level files must not register as slices.
    writeFixture(gsdRoot, 'phases/02-contract/02-ROADMAP.md', '# Roadmap');
    writeFixture(gsdRoot, 'phases/02-contract/02-SUMMARY.md', '# Summary');
    // Slice plans/summaries: NN-MM-SUFFIX.md
    writeFixture(gsdRoot, 'phases/02-contract/02-01-PLAN.md', '# S01');
    writeFixture(gsdRoot, 'phases/02-contract/02-01-SUMMARY.md', '# S01 done');
    writeFixture(gsdRoot, 'phases/02-contract/02-02-PLAN.md', '# S02');
    // Task artifacts: SS-TNN-SUFFIX.md (S03 has artifacts but no plan file)
    writeFixture(gsdRoot, 'phases/02-contract/S01-T01-SUMMARY.md', '# T01');
    writeFixture(gsdRoot, 'phases/02-contract/S03-T01-SUMMARY.md', '# T01');

    assert.deepEqual(findSliceIds(gsdRoot, 'M002'), ['S01', 'S02', 'S03']);
  });

  it('resolves flat-phase slice files (NN-MM-SUFFIX.md)', (t) => {
    const tmp = makeTempDir('gsd-path-flat-slice-file');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    writeFixture(gsdRoot, 'phases/02-contract/02-01-PLAN.md', '# S01 plan');

    assert.equal(
      resolveSliceFile(gsdRoot, 'M002', 'S01', 'PLAN'),
      join(gsdRoot, 'phases', '02-contract', '02-01-PLAN.md'),
    );
    assert.equal(resolveSliceFile(gsdRoot, 'M002', 'S02', 'PLAN'), null);
  });

  it('finds flat-phase task files merged with plan checkbox inventory', (t) => {
    const tmp = makeTempDir('gsd-path-flat-tasks');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    writeFixture(gsdRoot, 'phases/02-contract/02-01-PLAN.md', `# S01

<tasks>
- [x] **T01**: Review loop
- [ ] **T02**: Contract checks
</tasks>

- [ ] **T99**: a note outside the tasks block is not a task
`);
    writeFixture(gsdRoot, 'phases/02-contract/S01-T01-SUMMARY.md', '# T01 done');
    // T02 is staged: the writer writes the summary before host verification,
    // leaving the checkbox unchecked. The checkbox wins — not done.
    writeFixture(gsdRoot, 'phases/02-contract/S01-T02-SUMMARY.md', '# T02 staged');
    // Another slice's task must not leak into S01.
    writeFixture(gsdRoot, 'phases/02-contract/S02-T01-PLAN.md', '# T01');

    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S01'), [
      { id: 'T01', hasPlan: true, hasSummary: true, done: true },
      { id: 'T02', hasPlan: true, hasSummary: true, done: false },
    ]);
    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S03'), []);
  });

  it('merges legacy-format flat plan checkboxes (no <tasks> block)', (t) => {
    const tmp = makeTempDir('gsd-path-flat-legacy-plan');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    writeFixture(gsdRoot, 'phases/02-contract/02-01-PLAN.md', `# S01

## Tasks

- [x] **T01: Old style** — description
`);

    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S01'), [
      { id: 'T01', hasPlan: true, hasSummary: false, done: true },
    ]);
  });

  it('re-reads flat task inventory after the plan file is edited', (t) => {
    const tmp = makeTempDir('gsd-path-flat-cache');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    const planRel = 'phases/02-contract/02-01-PLAN.md';
    writeFixture(gsdRoot, planRel, `# S01

<tasks>
- [x] **T01**: Review loop
</tasks>
`);
    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S01'), [
      { id: 'T01', hasPlan: true, hasSummary: false, done: true },
    ]);

    // Content-only edit: the directory mtime is unchanged, the plan mtime is
    // not. Force a distinct mtime — CI filesystems have coarse timestamp
    // granularity, so a quick rewrite alone may not advance it.
    writeFixture(gsdRoot, planRel, `# S01

<tasks>
- [x] **T01**: Review loop
- [ ] **T02**: Contract checks
</tasks>
`);
    utimesSync(join(gsdRoot, planRel), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S01'), [
      { id: 'T01', hasPlan: true, hasSummary: false, done: true },
      { id: 'T02', hasPlan: true, hasSummary: false, done: false },
    ]);
  });

  it('reconciles non-canonical and canonical slice file ids', (t) => {
    const tmp = makeTempDir('gsd-path-flat-canonical');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    // The writer pads canonical S-ids, so "S1" and "S01" share 02-01-PLAN.md.
    writeFixture(gsdRoot, 'phases/02-contract/02-01-PLAN.md', '# S01\n');
    writeFixture(gsdRoot, 'phases/02-contract/02-S1-SUMMARY.md', '# S1 done');
    writeFixture(gsdRoot, 'phases/02-contract/S1-T01-SUMMARY.md', '# T01');

    assert.deepEqual(findSliceIds(gsdRoot, 'M002'), ['S01']);
    // The plan file has no checkbox lines, so hasPlan is not claimed.
    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S01'), [
      { id: 'T01', hasPlan: false, hasSummary: true },
    ]);
    assert.deepEqual(findTaskFiles(gsdRoot, 'M002', 'S1'), [
      { id: 'T01', hasPlan: false, hasSummary: true },
    ]);
  });

  it('does not flat-scan a legacy milestone that has a slices/ directory', (t) => {
    const tmp = makeTempDir('gsd-path-mixed-layout');
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const gsdRoot = join(tmp, '.gsd');
    mkdirSync(join(gsdRoot, 'milestones', 'M001', 'slices', 'S01'), { recursive: true });
    // Flat-looking artifact at the milestone root must be ignored when the
    // legacy slices/ layout is present.
    writeFixture(gsdRoot, 'milestones/M001/S01-T01-SUMMARY.md', '# T01');

    assert.deepEqual(findSliceIds(gsdRoot, 'M001'), ['S01']);
    assert.deepEqual(findTaskFiles(gsdRoot, 'M001', 'S01'), []);
  });
});
