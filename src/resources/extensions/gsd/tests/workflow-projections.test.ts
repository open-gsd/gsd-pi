// GSD Extension — workflow-projections unit tests
// Tests the pure rendering functions plus DB-backed projection recovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { regenerateIfMissing, renderPlanContent, renderPlanProjection, renderStateProjection, renderSummaryContent, renderSummaryProjection } from '../workflow-projections.ts';
import type { SliceRow, TaskRow } from '../gsd-db.ts';
import { closeDatabase, getArtifactsByPathPrefix, insertMilestone, insertSlice, insertTask, openDatabase } from '../gsd-db.ts';
import { clearPathCache, _clearGsdRootCache, normalizeRealPath, resolveMilestoneFile, resolveTaskFile } from '../paths.ts';
import { invalidateStateCache } from '../state.ts';
import { clearParseCache } from '../files.ts';

// ─── Test fixtures ────────────────────────────────────────────────────────

function makeSlice(overrides: Partial<SliceRow> = {}): SliceRow {
  return {
    id: 'S01',
    milestone_id: 'M001',
    title: 'Auth Layer',
    status: 'active',
    risk: 'high',
    depends: [],
    demo: 'Login flow works end-to-end',
    goal: 'Implement JWT authentication',
    full_summary_md: '',
    full_uat_md: '',
    success_criteria: '',
    proof_level: '',
    integration_closure: '',
    observability_impact: '',
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    sequence: 1,
    replan_triggered_at: null,
    is_sketch: 0,
    sketch_scope: '',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T01',
    slice_id: 'S01',
    milestone_id: 'M001',
    title: 'Create JWT middleware',
    status: 'pending',
    description: 'Implement JWT validation middleware',
    estimate: '2h',
    files: ['src/middleware/auth.ts'],
    verify: 'npm test src/middleware/auth.test.ts',
    one_liner: '',
    narrative: '',
    verification_result: '',
    duration: '',
    completed_at: null,
    blocker_discovered: false,
    deviations: '',
    known_issues: '',
    key_files: [],
    key_decisions: [],
    full_summary_md: '',
    full_plan_md: '',
    inputs: [],
    expected_output: [],
    observability_impact: '',
    sequence: 1,
    blocker_source: '',
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
    ...overrides,
  };
}

// ─── renderPlanContent: structure ────────────────────────────────────────

test('workflow-projections: renderPlanContent starts with H1 containing slice id and title', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.startsWith('# S01: Auth Layer'), `expected H1, got: ${content.slice(0, 60)}`);
});

test('workflow-projections: renderPlanContent includes Goal line', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('**Goal:** Implement JWT authentication'));
});

test('workflow-projections: renderPlanContent includes Demo line', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('**Demo:** After this: Login flow works end-to-end'));
});

test('workflow-projections: renderPlanContent falls back to TBD when goal and full_summary_md are empty', () => {
  const slice = makeSlice({ goal: '', full_summary_md: '' });
  const content = renderPlanContent(slice, []);
  assert.ok(content.includes('**Goal:** TBD'));
});

test('workflow-projections: renderPlanContent falls back to TBD when goal is empty (full_summary_md ignored #2945)', () => {
  const slice = makeSlice({ goal: '', full_summary_md: 'Fallback goal text' });
  const content = renderPlanContent(slice, []);
  // #2945: full_summary_md is no longer used as a fallback — it contains
  // multi-line rendered markdown that corrupts single-line fields.
  assert.ok(content.includes('**Goal:** TBD'), `expected TBD fallback, got: ${content}`);
});

test('workflow-projections: renderPlanContent includes ## Tasks section', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('## Tasks'));
});

// ─── renderPlanContent: task checkboxes ──────────────────────────────────

test('workflow-projections: pending task renders with [ ] checkbox', () => {
  const task = makeTask({ status: 'pending' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [ ] **T01:'), `expected unchecked, got: ${content}`);
});

test('workflow-projections: done task renders with [x] checkbox', () => {
  const task = makeTask({ status: 'done' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [x] **T01:'), `expected checked, got: ${content}`);
});

test('workflow-projections: complete status renders with [x] checkbox', () => {
  const task = makeTask({ status: 'complete' }); // 'complete' and 'done' both → checked
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [x] **T01:'));
});

// ─── renderPlanContent: task sublines ────────────────────────────────────

test('workflow-projections: task with estimate renders Estimate subline', () => {
  const task = makeTask({ estimate: '2h' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Estimate: 2h'));
});

test('workflow-projections: task with empty estimate omits Estimate subline', () => {
  const task = makeTask({ estimate: '' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Estimate:'));
});

test('workflow-projections: task with files renders Files subline', () => {
  const task = makeTask({ files: ['src/auth.ts', 'src/auth.test.ts'] });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Files: src/auth.ts, src/auth.test.ts'));
});

test('workflow-projections: task with empty files array omits Files subline', () => {
  const task = makeTask({ files: [] });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Files:'));
});

test('workflow-projections: task with verify renders Verify subline', () => {
  const task = makeTask({ verify: 'npm test' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Verify: npm test'));
});

test('workflow-projections: task with no verify omits Verify subline', () => {
  const task = makeTask({ verify: '' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Verify:'));
});

test('workflow-projections: task with duration renders Duration subline', () => {
  const task = makeTask({ duration: '45m' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Duration: 45m'));
});

test('workflow-projections: multiple tasks rendered in order', () => {
  const t1 = makeTask({ id: 'T01', title: 'First task', sequence: 1 });
  const t2 = makeTask({ id: 'T02', title: 'Second task', sequence: 2 });
  const content = renderPlanContent(makeSlice(), [t1, t2]);
  const idxT1 = content.indexOf('**T01:');
  const idxT2 = content.indexOf('**T02:');
  assert.ok(idxT1 < idxT2, 'T01 should appear before T02');
});

// ─── renderSummaryContent: frontmatter whitespace (#2253) ────────────────

// #2253: empty duration/completed_at must emit bare `duration:` / `completed_at:`
// lines (valid YAML null, whitespace-clean). The old `key: ${value || ""}`
// template left a trailing space that tripped `git diff --check` and gsd
// doctor's whitespace guard on every pre-completion T##-SUMMARY.md.
test('renderSummaryContent: empty duration and completed_at emit bare frontmatter keys with no trailing space', () => {
  const task = makeTask({ duration: '', completed_at: null });
  const content = renderSummaryContent(task, 'S01', 'M001');
  const lines = content.split('\n');
  assert.ok(lines.includes('duration:'),
    `expected bare "duration:" line, got: ${JSON.stringify(lines.find(l => l.startsWith('duration')))}`);
  assert.ok(lines.includes('completed_at:'),
    `expected bare "completed_at:" line, got: ${JSON.stringify(lines.find(l => l.startsWith('completed_at')))}`);
  assert.ok(!content.includes('duration: \n'), 'no trailing space after bare duration:');
  assert.ok(!content.includes('completed_at: \n'), 'no trailing space after bare completed_at:');
});

test('renderSummaryContent: populated duration and completed_at render values unchanged', () => {
  const task = makeTask({ duration: '5m 30s', completed_at: '2026-01-15T10:30:00.000Z' });
  const content = renderSummaryContent(task, 'S01', 'M001');
  const lines = content.split('\n');
  assert.ok(lines.includes('duration: 5m 30s'), `expected "duration: 5m 30s", got: ${JSON.stringify(lines.find(l => l.startsWith('duration')))}`);
  assert.ok(lines.includes('completed_at: 2026-01-15T10:30:00.000Z'), `expected timestamp, got: ${JSON.stringify(lines.find(l => l.startsWith('completed_at')))}`);
});

test('workflow-projections: renderPlanProjection preserves an unowned obsolete plan', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  const planPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01'), { recursive: true });
  openDatabase(dbPath);

  try {
    const manualContent = '# Manual plan\n\nThis file is not a database projection.\n';
    writeFileSync(planPath, manualContent, 'utf8');

    renderPlanProjection(base, 'M001', 'S01');

    assert.equal(readFileSync(planPath, 'utf8'), manualContent);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// Regression for #6146: a deleted slice PLAN must be regenerated from the DB
// with its per-task plan files. The simplified projection path only rewrote the
// slice PLAN and silently dropped task plans.
test('workflow-projections: regenerateIfMissing PLAN restores slice plan and task plan files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Recoverable slice',
      status: 'pending',
      demo: 'Plans regenerate after deletion.',
      planning: { goal: 'Recover deleted projections from DB.' },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'First task',
      status: 'pending',
      planning: { description: 'Do the first thing.', estimate: '1h' },
    });
    insertTask({
      id: 'T02',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Second task',
      status: 'pending',
      planning: { description: 'Do the second thing.', estimate: '2h' },
    });

    // Legacy layout: renderer writes milestones/M001/slices/S01/S01-PLAN.md
    // (relSliceFile detects milestones/ prefix → uses legacy S01-PLAN.md filename).
    const slicePlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');

    assert.ok(!existsSync(slicePlanPath), 'precondition: slice plan absent');

    const regenerated = await regenerateIfMissing(base, 'M001', 'S01', 'PLAN');

    assert.equal(regenerated, true, 'regenerateIfMissing reports the PLAN was rebuilt');
    assert.ok(existsSync(slicePlanPath), 'slice PLAN restored on disk');
    // Flat-phase: tasks are checkboxes inside the plan file, not separate task plan files.
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: regenerateIfMissing ROADMAP is idempotent for flat-phase roadmap projections', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-flat-roadmap-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  const phaseDir = join(base, '.gsd', 'phases', '01-milestone');
  mkdirSync(phaseDir, { recursive: true });
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active', planning: { vision: 'Ship a layout-aware roadmap.' } });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Flat slice',
      status: 'pending',
      demo: 'Roadmap exists at the flat-phase path.',
      planning: { goal: 'Keep ROADMAP regeneration idempotent.' },
    });

    const roadmapPath = join(phaseDir, '01-ROADMAP.md');
    writeFileSync(roadmapPath, '# existing flat roadmap\n');

    const regenerated = await regenerateIfMissing(base, 'M001', 'S01', 'ROADMAP');

    assert.equal(regenerated, false, 'existing flat-phase ROADMAP is detected without rewriting');
    assert.equal(readFileSync(roadmapPath, 'utf-8'), '# existing flat roadmap\n');
    assert.equal(normalizeRealPath(resolveMilestoneFile(base, 'M001', 'ROADMAP') ?? ''), normalizeRealPath(roadmapPath));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: regenerateIfMissing ROADMAP regenerates missing flat-phase roadmap projections', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-missing-roadmap-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  const phaseDir = join(base, '.gsd', 'phases', '01-milestone');
  mkdirSync(phaseDir, { recursive: true });
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active', planning: { vision: 'Ship a layout-aware roadmap.' } });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Flat slice',
      status: 'pending',
      demo: 'Roadmap regenerates at the flat-phase path.',
      planning: { goal: 'Recover ROADMAP from DB.' },
    });

    const roadmapPath = join(phaseDir, '01-ROADMAP.md');
    const legacyRoadmapPath = join(base, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    assert.ok(!existsSync(roadmapPath), 'precondition: flat-phase ROADMAP is absent');

    const regenerated = await regenerateIfMissing(base, 'M001', 'S01', 'ROADMAP');

    assert.equal(regenerated, true, 'missing flat-phase ROADMAP is regenerated');
    assert.match(readFileSync(roadmapPath, 'utf-8'), /Ship a layout-aware roadmap/);
    assert.equal(existsSync(legacyRoadmapPath), false, 'regeneration does not create a legacy ROADMAP path');
    assert.equal(normalizeRealPath(resolveMilestoneFile(base, 'M001', 'ROADMAP') ?? ''), normalizeRealPath(roadmapPath));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: regenerateIfMissing SUMMARY is idempotent for flat-phase task summaries', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-flat-summary-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  const phaseDir = join(base, '.gsd', 'phases', '01-milestone');
  mkdirSync(phaseDir, { recursive: true });
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Flat slice',
      status: 'complete',
      demo: 'Summary regenerates once.',
      planning: { goal: 'Recover flat-phase summaries from DB.' },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Completed task',
      status: 'complete',
      oneLiner: 'Completed the flat task.',
      narrative: 'The task was completed through the DB-backed projection path.',
      verificationResult: 'passed',
      duration: '5m',
      keyFiles: ['src/example.ts'],
      keyDecisions: ['Use centralized task summary paths.'],
      fullSummaryMd: '---\nid: T01\nparent: S01\nmilestone: M001\n---\n\n# T01: Completed the flat task.\n',
    });

    const summaryPath = join(phaseDir, 'S01-T01-SUMMARY.md');
    assert.ok(!existsSync(summaryPath), 'precondition: flat-phase task summary absent');

    const first = await regenerateIfMissing(base, 'M001', 'S01', 'SUMMARY');
    const second = await regenerateIfMissing(base, 'M001', 'S01', 'SUMMARY');

    assert.equal(first, true, 'first call regenerates the missing task summary');
    assert.equal(second, false, 'second call sees the flat-phase task summary and does not rewrite it');
    assert.equal(normalizeRealPath(resolveTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY') ?? ''), normalizeRealPath(summaryPath));
    const diskContent = readFileSync(summaryPath, 'utf-8');
    const [artifact] = getArtifactsByPathPrefix('phases/01-milestone/S01-T01-SUMMARY.md');
    assert.match(diskContent, /# T01: Completed the flat task\./);
    assert.match(diskContent, /<!-- gsd:state-version=\d+:\d+ -->/);
    assert.equal(artifact?.full_content, diskContent, 'artifact lineage stores the exact stamped disk bytes');
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: flat-phase SUMMARY regeneration ignores stale nested task summaries', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-flat-stale-nested-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  const phaseDir = join(base, '.gsd', 'phases', '01-milestone');
  const nestedTasksDir = join(phaseDir, 'tasks');
  mkdirSync(nestedTasksDir, { recursive: true });
  writeFileSync(join(nestedTasksDir, 'T01-SUMMARY.md'), '# stale nested summary\n');
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Flat slice',
      status: 'complete',
      demo: 'Summary regenerates at phase root.',
      planning: { goal: 'Recover canonical flat-phase summaries from DB.' },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Completed task',
      status: 'complete',
    });

    const rootSummaryPath = join(phaseDir, 'S01-T01-SUMMARY.md');
    assert.ok(!existsSync(rootSummaryPath), 'precondition: canonical flat-phase task summary absent');

    const regenerated = await regenerateIfMissing(base, 'M001', 'S01', 'SUMMARY');

    assert.equal(regenerated, true, 'missing phase-root summary is regenerated despite stale nested summary');
    assert.equal(normalizeRealPath(resolveTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY') ?? ''), normalizeRealPath(rootSummaryPath));
    assert.match(readFileSync(rootSummaryPath, 'utf-8'), /# T01: Completed task/);
    assert.equal(readFileSync(join(nestedTasksDir, 'T01-SUMMARY.md'), 'utf-8'), '# stale nested summary\n');
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderSummaryProjection uses milestone title when creating fresh flat-phase dirs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projections-fresh-summary-'));
  const dbPath = join(base, '.gsd', 'gsd.db');
  mkdirSync(join(base, '.gsd'), { recursive: true });
  openDatabase(dbPath);
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Flat slice',
      status: 'complete',
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Completed task',
      status: 'complete',
    });

    const titleSummaryPath = join(base, '.gsd', 'phases', '01-milestone', 'S01-T01-SUMMARY.md');
    const idSummaryPath = join(base, '.gsd', 'phases', '01-m001', 'S01-T01-SUMMARY.md');

    await renderSummaryProjection(base, 'M001', 'S01', 'T01');

    assert.ok(existsSync(titleSummaryPath), 'fresh summary projection uses the milestone title slug');
    assert.equal(existsSync(idSummaryPath), false, 'fresh summary projection does not create an id-slug orphan dir');
    assert.equal(normalizeRealPath(resolveTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY') ?? ''), normalizeRealPath(titleSummaryPath));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection does not clobber non-empty STATE.md when manifest has milestones', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-stale-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(statePath, '# GSD State\n\n**Active Milestone:** M001: Existing\n');
    writeFileSync(join(gsdDir, 'state-manifest.json'), JSON.stringify({
      version: 1,
      exported_at: new Date().toISOString(),
      milestones: [{ id: 'M001', title: 'Existing' }],
      slices: [],
      tasks: [],
      decisions: [],
      verification_evidence: [],
    }));

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('M001: Existing'));
    assert.ok(!content.includes('No milestones found'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection rewrites empty STATE.md when manifest has milestones', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-empty-state-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(statePath, '');
    writeFileSync(join(gsdDir, 'state-manifest.json'), JSON.stringify({
      version: 1,
      exported_at: new Date().toISOString(),
      milestones: [{ id: 'M001', title: 'Existing' }],
      slices: [],
      tasks: [],
      decisions: [],
      verification_evidence: [],
    }));

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('# GSD State'));
    assert.ok(content.includes('**Active Milestone:** None'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection rewrites non-empty STATE.md when manifest is missing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-missing-manifest-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(statePath, '# GSD State\n\n**Active Milestone:** M001: Existing\n');

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('# GSD State'));
    assert.ok(content.includes('**Active Milestone:** None'));
    assert.ok(!content.includes('M001: Existing'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection rewrites non-empty STATE.md when manifest is malformed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-malformed-manifest-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(statePath, '# GSD State\n\n**Active Milestone:** M001: Existing\n');
    writeFileSync(join(gsdDir, 'state-manifest.json'), '{not json');

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('# GSD State'));
    assert.ok(content.includes('**Active Milestone:** None'));
    assert.ok(!content.includes('M001: Existing'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection rewrites non-empty STATE.md when manifest milestones is not an array', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-non-array-milestones-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(statePath, '# GSD State\n\n**Active Milestone:** M001: Existing\n');
    writeFileSync(join(gsdDir, 'state-manifest.json'), JSON.stringify({
      version: 1,
      exported_at: new Date().toISOString(),
      milestones: 'M001',
      slices: [],
      tasks: [],
      decisions: [],
      verification_evidence: [],
    }));

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('# GSD State'));
    assert.ok(content.includes('**Active Milestone:** None'));
    assert.ok(!content.includes('M001: Existing'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test('workflow-projections: renderStateProjection writes active milestone from DB when manifest matches', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-projection-db-milestone-'));
  const gsdDir = join(base, '.gsd');
  const statePath = join(gsdDir, 'STATE.md');
  openDatabase(':memory:');
  try {
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, 'state-manifest.json'), JSON.stringify({
      version: 1,
      exported_at: new Date().toISOString(),
      milestones: [{ id: 'M001', title: 'DB Milestone' }],
      slices: [],
      tasks: [],
      decisions: [],
      verification_evidence: [],
    }));
    insertMilestone({ id: 'M001', title: 'DB Milestone', status: 'active' });

    await renderStateProjection(base);

    const content = readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('**Active Milestone:** M001: DB Milestone'));
    assert.ok(content.includes('**M001:** DB Milestone'));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
