// GSD MCP Server — reader tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { readProgress } from './state.js';
import { readRoadmap } from './roadmap.js';
import { readHistory } from './metrics.js';
import { readCaptures } from './captures.js';
import { readKnowledge } from './knowledge.js';
import { runDoctorLite } from './doctor-lite.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function tmpProject(): string {
  const dir = join(tmpdir(), `gsd-mcp-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// readProgress tests
// ---------------------------------------------------------------------------

describe('readProgress', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();

    writeFixture(projectDir, '.gsd/STATE.md', `# GSD State

**Active Milestone:** M002: Auth System
**Active Slice:** S01: Login flow
**Phase:** executing
**Requirements Status:** 5 active · 2 validated · 1 deferred · 0 out of scope

## Milestone Registry

- ☑ **M001:** Core Setup
- 🔄 **M002:** Auth System
- ⬜ **M003:** Dashboard

## Blockers

- Waiting on OAuth provider approval

## Next Action

Execute T02 in S01 — implement token refresh.
`);

    // Create filesystem structure
    const m1 = '.gsd/milestones/M001/slices/S01/tasks';
    writeFixture(projectDir, `${m1}/T01-PLAN.md`, '# T01');
    writeFixture(projectDir, `${m1}/T01-SUMMARY.md`, '# T01 done');

    const m2 = '.gsd/milestones/M002/slices/S01/tasks';
    writeFixture(projectDir, `${m2}/T01-PLAN.md`, '# T01');
    writeFixture(projectDir, `${m2}/T01-SUMMARY.md`, '# T01 done');
    writeFixture(projectDir, `${m2}/T02-PLAN.md`, '# T02');

    mkdirSync(join(projectDir, '.gsd/milestones/M003'), { recursive: true });
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('parses active milestone from STATE.md', () => {
    const result = readProgress(projectDir);
    assert.deepEqual(result.activeMilestone, { id: 'M002', title: 'Auth System' });
  });

  it('parses active slice', () => {
    const result = readProgress(projectDir);
    assert.deepEqual(result.activeSlice, { id: 'S01', title: 'Login flow' });
  });

  it('reads the phase as written', () => {
    const result = readProgress(projectDir);
    assert.equal(result.phase, 'executing');
  });

  it('parses milestone counts from registry', () => {
    const result = readProgress(projectDir);
    assert.equal(result.milestones.total, 3);
    assert.equal(result.milestones.done, 1);
    assert.equal(result.milestones.active, 1);
    assert.equal(result.milestones.pending, 1);
  });

  it('counts tasks from filesystem', () => {
    const result = readProgress(projectDir);
    assert.equal(result.tasks.total, 3);
    assert.equal(result.tasks.done, 2);
    assert.equal(result.tasks.pending, 1);
  });

  it('parses blockers', () => {
    const result = readProgress(projectDir);
    assert.equal(result.blockers.length, 1);
    assert.ok(result.blockers[0].includes('OAuth'));
  });

  it('parses requirements', () => {
    const result = readProgress(projectDir);
    assert.equal(result.requirements?.active, 5);
    assert.equal(result.requirements?.validated, 2);
    assert.equal(result.requirements?.deferred, 1);
  });

  it('parses next action', () => {
    const result = readProgress(projectDir);
    assert.ok(result.nextAction.includes('T02'));
  });

  it('returns defaults for missing .gsd/', () => {
    const empty = tmpProject();
    const result = readProgress(empty);
    assert.equal(result.phase, 'unknown');
    assert.equal(result.milestones.total, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// readRoadmap tests
// ---------------------------------------------------------------------------

describe('readRoadmap', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();

    writeFixture(projectDir, '.gsd/milestones/M001/M001-CONTEXT.md', '# M001: Core Setup\n');
    writeFixture(projectDir, '.gsd/milestones/M001/M001-ROADMAP.md', `# M001: Core Setup

## Vision

Build the foundation for the project.

## Slice Overview

| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Database schema | low | — | ☑ | DB ready |
| S02 | API endpoints | medium | S01 | 🟫 | REST API live |
`);

    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md', `# S01: Database schema

## Tasks

- [x] **T01: Create migrations** — Set up schema
- [x] **T02: Seed data** — Initial seed
`);
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md', '# T01 done');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T02-PLAN.md', '# T02');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T02-SUMMARY.md', '# T02 done');

    writeFixture(projectDir, '.gsd/milestones/M001/slices/S02/S02-PLAN.md', `# S02: API endpoints

## Tasks

- [ ] **T01: Auth routes** — Implement auth
- [ ] **T02: User routes** — CRUD users
`);
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S02/tasks/T01-PLAN.md', '# T01');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S02/tasks/T02-PLAN.md', '# T02');
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns milestone structure', () => {
    const result = readRoadmap(projectDir);
    assert.equal(result.milestones.length, 1);
    assert.equal(result.milestones[0].id, 'M001');
    assert.equal(result.milestones[0].title, 'Core Setup');
  });

  it('reads vision from roadmap', () => {
    const result = readRoadmap(projectDir);
    assert.ok(result.milestones[0].vision.includes('foundation'));
  });

  it('parses slices from roadmap table', () => {
    const result = readRoadmap(projectDir);
    const slices = result.milestones[0].slices;
    assert.equal(slices.length, 2);
    assert.equal(slices[0].id, 'S01');
    assert.equal(slices[0].title, 'Database schema');
    assert.equal(slices[1].id, 'S02');
  });

  it('derives slice status from task summaries', () => {
    const result = readRoadmap(projectDir);
    const slices = result.milestones[0].slices;
    assert.equal(slices[0].status, 'done');
    assert.equal(slices[1].status, 'pending');
  });

  it('includes tasks in slices', () => {
    const result = readRoadmap(projectDir);
    const s01Tasks = result.milestones[0].slices[0].tasks;
    assert.equal(s01Tasks.length, 2);
    assert.equal(s01Tasks[0].status, 'done');
  });

  it('filters by milestoneId', () => {
    const result = readRoadmap(projectDir, 'M999');
    assert.equal(result.milestones.length, 0);
  });
});

// ---------------------------------------------------------------------------
// readRoadmap flat-phase layout tests (issue #2424)
// ---------------------------------------------------------------------------

describe('readRoadmap flat-phase layout', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();

    // Flat-phase project: phases/NN-slug/ with NN-MM-SUFFIX.md slice files and
    // SS-TNN-SUFFIX.md task files directly under the milestone dir. No
    // slices/ or tasks/ subdirs. Plan tasks use the renderer's <tasks> block
    // format. 02-SUMMARY.md is a failed verification record — the milestone
    // is NOT done despite the file existing.
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/02-CONTEXT.md', '# M002: CONTEXT heading\n');
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/02-ROADMAP.md', `# M002: Contract closure

## Vision

Close the v0 contract.

## Slice Overview

| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Informed review contract | high | — | ☑ | Review loop |
| S02 | Human cancellation integrity | high | S01 | ⬜ | Cancel path |
| R01 | Remediation pass | medium | — | ☑ | Fix-ups |
`);
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/02-SUMMARY.md', `# M002 Summary

**Verification:** FAILED — 02-VERIFICATION-FAILED.md
`);
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/02-01-PLAN.md', `# S01: Informed review contract

<tasks>
- [x] **T01**: Review loop _(2h)_
  - Files: \`src/review.ts\`
- [x] **T02**: Contract checks
</tasks>
`);
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/S01-T01-SUMMARY.md', '# T01 done');
    writeFixture(projectDir, '.gsd/phases/02-contract-closure/02-02-PLAN.md', `# S02: Human cancellation integrity

<tasks>
- [ ] **T01**: Cancel path
</tasks>
`);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('prefers the ROADMAP H1 for the title', () => {
    const result = readRoadmap(projectDir, 'M002');
    assert.equal(result.milestones[0].title, 'Contract closure');
  });

  it('discovers slices and tasks in the flat layout', () => {
    const result = readRoadmap(projectDir, 'M002');
    const slices = result.milestones[0].slices;
    assert.deepEqual(slices.map((s) => s.id), ['R01', 'S01', 'S02']);
    assert.equal(slices[1].tasks.length, 2);
    assert.equal(slices[2].tasks.length, 1);
  });

  it('parses renderer-format <tasks> blocks with titles', () => {
    const result = readRoadmap(projectDir, 'M002');
    const s01 = result.milestones[0].slices.find((s) => s.id === 'S01');
    assert.deepEqual(
      s01!.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      [
        { id: 'T01', title: 'Review loop', status: 'done' },
        { id: 'T02', title: 'Contract checks', status: 'done' },
      ],
    );
  });

  it('derives slice statuses from flat files, checkboxes, and table marks', () => {
    const result = readRoadmap(projectDir, 'M002');
    const slices = result.milestones[0].slices;
    const byId = new Map(slices.map((s) => [s.id, s]));
    assert.equal(byId.get('S01')!.status, 'done');
    assert.equal(byId.get('S02')!.status, 'pending');
    // R01 has no plan/task files — status falls back to the table's .done mark.
    assert.equal(byId.get('R01')!.status, 'done');
    assert.equal(byId.get('R01')!.title, 'Remediation pass');
  });

  it('derives milestone status from slice content, not SUMMARY existence', () => {
    const result = readRoadmap(projectDir, 'M002');
    // S01 + R01 done, S02 pending → active, even though 02-SUMMARY.md exists.
    assert.equal(result.milestones[0].status, 'active');
  });
});

describe('readRoadmap milestone status fallbacks', () => {
  it('reports done for a zero-slice milestone with a SUMMARY', (t) => {
    const projectDir = tmpProject();
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));
    writeFixture(projectDir, '.gsd/phases/03-solo/03-ROADMAP.md', '# M003: Solo\n');
    writeFixture(projectDir, '.gsd/phases/03-solo/03-SUMMARY.md', '# M003 done\n');
    const result = readRoadmap(projectDir, 'M003');
    assert.equal(result.milestones[0].status, 'done');
  });

  it('reports pending when all slices are pending despite a SUMMARY', (t) => {
    const projectDir = tmpProject();
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));
    writeFixture(projectDir, '.gsd/phases/04-stuck/04-ROADMAP.md', `# M004: Stuck

## Slice Overview

| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Never started | low | — | ⬜ | — |
`);
    writeFixture(projectDir, '.gsd/phases/04-stuck/04-SUMMARY.md', '# M004\n');
    const result = readRoadmap(projectDir, 'M004');
    assert.equal(result.milestones[0].status, 'pending');
  });

  it('reports staged (summary-but-unchecked) tasks as pending', (t) => {
    const projectDir = tmpProject();
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));
    writeFixture(projectDir, '.gsd/phases/05-staged/05-ROADMAP.md', '# M005: Staged\n');
    writeFixture(projectDir, '.gsd/phases/05-staged/05-01-PLAN.md', `# S01

<tasks>
- [ ] **T01**: Candidate result
</tasks>
`);
    writeFixture(projectDir, '.gsd/phases/05-staged/S01-T01-SUMMARY.md', '# staged\n');
    const result = readRoadmap(projectDir, 'M005');
    const s01 = result.milestones[0].slices[0]!;
    assert.equal(s01.tasks[0]!.status, 'pending');
    assert.equal(s01.status, 'pending');
    assert.equal(result.milestones[0].status, 'pending');
  });
});

// ---------------------------------------------------------------------------
// Flat-phase shared readers: gsd_progress + gsd_doctor (issue #2424)
// ---------------------------------------------------------------------------

describe('flat-phase shared readers', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();
    // S03 exists only as a roadmap-table row — no plan or artifact files.
    // A filesystem-only inventory would read the milestone as fully complete.
    writeFixture(projectDir, '.gsd/phases/02-x/02-ROADMAP.md', `# Roadmap

## Slice Overview

| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Partial slice | high | — | ⬜ | — |
| S02 | Checkbox-done slice | medium | S01 | ⬜ | — |
| S03 | Table-only slice | low | S02 | ⬜ | — |
`);
    writeFixture(projectDir, '.gsd/STATE.md', '# GSD State\n');
    // S01: T01 done (checkbox + artifact), T02 pending (checkbox only).
    // An artifact-only task inventory would report the slice done.
    writeFixture(projectDir, '.gsd/phases/02-x/02-01-PLAN.md', `# S01

<tasks>
- [x] **T01**: Review loop
- [ ] **T02**: Contract checks
</tasks>
`);
    writeFixture(projectDir, '.gsd/phases/02-x/S01-T01-SUMMARY.md', '# T01 done\n');
    // S02: T01 checked in the plan but no summary artifact — must still count
    // as done (the plan checkbox is the flat layout's task state carrier).
    writeFixture(projectDir, '.gsd/phases/02-x/02-02-PLAN.md', `# S02

<tasks>
- [x] **T01**: Cancel path
</tasks>
`);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('gsd_progress counts pending checkbox tasks', () => {
    const result = readProgress(projectDir);
    assert.equal(result.tasks.total, 3);
    assert.equal(result.tasks.done, 2);
  });

  it('gsd_doctor does not report half-done slices as all-done', () => {
    const result = runDoctorLite(projectDir);
    const issue = result.issues.find((i) => i.code === 'all_slices_done_missing_summary');
    assert.equal(issue, undefined);
  });
});

// ---------------------------------------------------------------------------
// readHistory tests
// ---------------------------------------------------------------------------

describe('readHistory', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, '.gsd/metrics.json', JSON.stringify({
      version: 1,
      projectStartedAt: 1700000000000,
      units: [
        {
          type: 'execute-task',
          id: 'M001/S01/T01',
          model: 'claude-sonnet-4',
          startedAt: 1700001000000,
          finishedAt: 1700002000000,
          tokens: { input: 10000, output: 3000, cacheRead: 2000, cacheWrite: 1000, total: 16000 },
          cost: 0.05,
          toolCalls: 8,
          apiRequests: 3,
        },
        {
          type: 'execute-task',
          id: 'M001/S01/T02',
          model: 'claude-sonnet-4',
          startedAt: 1700003000000,
          finishedAt: 1700004000000,
          tokens: { input: 15000, output: 5000, cacheRead: 3000, cacheWrite: 1500, total: 24500 },
          cost: 0.08,
          toolCalls: 12,
          apiRequests: 5,
        },
      ],
    }));
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns all entries sorted by most recent', () => {
    const result = readHistory(projectDir);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].id, 'M001/S01/T02'); // most recent first
  });

  it('computes totals', () => {
    const result = readHistory(projectDir);
    assert.equal(result.totals.units, 2);
    assert.equal(result.totals.cost, 0.13);
    assert.equal(result.totals.tokens.total, 40500);
  });

  it('respects limit', () => {
    const result = readHistory(projectDir, 1);
    assert.equal(result.entries.length, 1);
    assert.equal(result.totals.units, 2); // totals still reflect all
  });

  it('returns empty for missing metrics', () => {
    const empty = tmpProject();
    mkdirSync(join(empty, '.gsd'), { recursive: true });
    const result = readHistory(empty);
    assert.equal(result.entries.length, 0);
    assert.equal(result.totals.units, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// readCaptures tests
// ---------------------------------------------------------------------------

describe('readCaptures', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, '.gsd/CAPTURES.md', `# Captures

### CAP-aaa11111

**Text:** Add rate limiting to API
**Captured:** 2026-04-01T10:00:00Z
**Status:** pending

### CAP-bbb22222

**Text:** Refactor auth module
**Captured:** 2026-04-02T10:00:00Z
**Status:** resolved
**Classification:** inject
**Resolution:** Added to M003 roadmap
**Rationale:** Important for security
**Resolved:** 2026-04-03T10:00:00Z
**Milestone:** M003

### CAP-ccc33333

**Text:** Nice to have: dark mode
**Captured:** 2026-04-02T11:00:00Z
**Status:** resolved
**Classification:** defer
**Resolution:** Deferred to future
**Rationale:** Not blocking
**Resolved:** 2026-04-03T11:00:00Z
`);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('reads all captures', () => {
    const result = readCaptures(projectDir, 'all');
    assert.equal(result.captures.length, 3);
    assert.equal(result.counts.total, 3);
  });

  it('filters pending captures', () => {
    const result = readCaptures(projectDir, 'pending');
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].id, 'CAP-aaa11111');
  });

  it('filters actionable captures (inject, replan, quick-task)', () => {
    const result = readCaptures(projectDir, 'actionable');
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].id, 'CAP-bbb22222');
  });

  it('counts correctly regardless of filter', () => {
    const result = readCaptures(projectDir, 'pending');
    assert.equal(result.counts.total, 3);
    assert.equal(result.counts.pending, 1);
    assert.equal(result.counts.actionable, 1);
  });

  it('returns empty for missing CAPTURES.md', () => {
    const empty = tmpProject();
    mkdirSync(join(empty, '.gsd'), { recursive: true });
    const result = readCaptures(empty);
    assert.equal(result.captures.length, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// readKnowledge tests
// ---------------------------------------------------------------------------

describe('readKnowledge', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, '.gsd/KNOWLEDGE.md', `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | auth | Hash passwords with bcrypt | Security requirement | manual |
| K002 | db | Use transactions for multi-table | Data consistency | auto |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Singleton services | services/ | Prevents duplication |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | CI tests failed | Env diff | Added setup script | testing |
`);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('reads all knowledge entries', () => {
    const result = readKnowledge(projectDir);
    assert.equal(result.entries.length, 4);
  });

  it('counts by type', () => {
    const result = readKnowledge(projectDir);
    assert.equal(result.counts.rules, 2);
    assert.equal(result.counts.patterns, 1);
    assert.equal(result.counts.lessons, 1);
  });

  it('parses rule fields correctly', () => {
    const result = readKnowledge(projectDir);
    const k001 = result.entries.find((e) => e.id === 'K001');
    assert.ok(k001);
    assert.equal(k001.type, 'rule');
    assert.equal(k001.scope, 'auth');
    assert.ok(k001.content.includes('bcrypt'));
  });

  it('reads a row that has only a memory id, typed by its section', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.gsd'), { recursive: true });
    writeFileSync(
      join(dir, '.gsd', 'KNOWLEDGE.md'),
      [
        '# Project Knowledge',
        '',
        '## Patterns',
        '',
        '| # | Pattern | Where | Notes |',
        '|---|---------|-------|-------|',
        '| P001 | Captured pattern | src | — |',
        '| MEM042 | Extracted pattern | src | — |',
        '',
      ].join('\n'),
    );

    const result = readKnowledge(dir);

    assert.deepEqual(result.entries.map((entry) => [entry.id, entry.type]), [['P001', 'pattern'], ['MEM042', 'pattern']]);
    assert.equal(result.counts.patterns, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for missing KNOWLEDGE.md', () => {
    const empty = tmpProject();
    mkdirSync(join(empty, '.gsd'), { recursive: true });
    const result = readKnowledge(empty);
    assert.equal(result.entries.length, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runDoctorLite tests
// ---------------------------------------------------------------------------

describe('runDoctorLite', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();

    // M001: complete milestone (has summary)
    writeFixture(projectDir, '.gsd/PROJECT.md', '# Test Project');
    writeFixture(projectDir, '.gsd/STATE.md', '# GSD State');
    writeFixture(projectDir, '.gsd/milestones/M001/M001-CONTEXT.md', '# M001');
    writeFixture(projectDir, '.gsd/milestones/M001/M001-ROADMAP.md', '# Roadmap');
    writeFixture(projectDir, '.gsd/milestones/M001/M001-SUMMARY.md', '# Done');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md', '# Plan');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01');
    writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md', '# T01 done');

    // M002: incomplete — has all tasks done but no SUMMARY
    writeFixture(projectDir, '.gsd/milestones/M002/M002-CONTEXT.md', '# M002');
    writeFixture(projectDir, '.gsd/milestones/M002/M002-ROADMAP.md', '# Roadmap');
    writeFixture(projectDir, '.gsd/milestones/M002/slices/S01/S01-PLAN.md', '# Plan');
    writeFixture(projectDir, '.gsd/milestones/M002/slices/S01/tasks/T01-PLAN.md', '# T01');
    writeFixture(projectDir, '.gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md', '# T01 done');

    // M003: empty — no context, no slices
    mkdirSync(join(projectDir, '.gsd/milestones/M003'), { recursive: true });
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('detects all-slices-done-missing-summary', () => {
    const result = runDoctorLite(projectDir);
    const issue = result.issues.find((i) => i.code === 'all_slices_done_missing_summary');
    assert.ok(issue, 'Should detect M002 missing summary');
    assert.equal(issue.unitId, 'M002');
  });

  it('detects missing context', () => {
    const result = runDoctorLite(projectDir);
    const issue = result.issues.find(
      (i) => i.code === 'missing_context' && i.unitId === 'M003',
    );
    assert.ok(issue, 'Should detect M003 missing context');
  });

  it('scopes to a single milestone', () => {
    const result = runDoctorLite(projectDir, 'M001');
    const m002Issues = result.issues.filter((i) => i.unitId.startsWith('M002'));
    assert.equal(m002Issues.length, 0, 'Should not include M002 when scoped to M001');
  });

  it('returns ok:true for healthy project', () => {
    const healthy = tmpProject();
    writeFixture(healthy, '.gsd/PROJECT.md', '# Project');
    writeFixture(healthy, '.gsd/STATE.md', '# State');
    const result = runDoctorLite(healthy);
    assert.equal(result.ok, true);
    rmSync(healthy, { recursive: true, force: true });
  });

  it('handles missing .gsd/ gracefully', () => {
    const empty = tmpProject();
    const result = runDoctorLite(empty);
    assert.equal(result.ok, true);
    assert.ok(
      result.issues.some(
        (issue) => issue.code === 'no_gsd_directory' || issue.code === 'missing_project_md',
      ),
    );
    rmSync(empty, { recursive: true, force: true });
  });
});
