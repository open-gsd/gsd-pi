import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

function pathsEqual(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
}
import {
  openDatabase,
  closeDatabase,
  getMilestone,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  getArtifact,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  updateSliceStatus,
  insertGateRow,
  saveGateResult,
  transaction,
  _getAdapter,
} from '../gsd-db.ts';
import {
  renderRoadmapCheckboxes,
  renderPlanCheckboxes,
  renderTaskSummary,
  renderSliceSummary,
  renderAllFromDb,
  renderPlanFromDb,
  renderTaskPlanFromDb,
  renderRoadmapFromDb,
  detectStaleRenders,
  detectProjectionDrift,
  getCurrentProjectStateVersion,
  stripProjectionStamp,
} from '../markdown-renderer.ts';
import { repairStaleRenders } from '../state-reconciliation/drift/stale-render.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import {
  parseProjectionRoadmap as parseRoadmap,
  parseProjectionPlan as parsePlan,
} from '../schemas/parsers.ts';
import {
  parseSummary,
  parseTaskPlanFile,
  clearParseCache,
  extractSection,
} from '../files.ts';
import { clearPathCache, _clearGsdRootCache } from '../paths.ts';
import { invalidateStateCache } from '../state.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Safety net: close the DB after every test so a failure doesn't leak the
// connection and block the next test's openDatabase call.
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-renderer-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

function clearAllCaches(): void {
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();
}

/**
 * Create on-disk directory structure for a milestone/slice/task tree
 * so that path resolvers work correctly.
 */
function scaffoldDirs(tmpDir: string, mid: string, sliceIds: string[]): void {
  // Flat-phase: derive phase dir name from milestone title in DB
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const milestone = getMilestone(mid);
  const title = milestone?.title || 'test';
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'phase';
  const msDir = path.join(tmpDir, '.gsd', 'phases', `${String(phaseNum).padStart(2, '0')}-${slug}`);
  fs.mkdirSync(msDir, { recursive: true });
  // Flat-phase: no slices/ or tasks/ subdirs
  for (const sid of sliceIds) {
    fs.mkdirSync(msDir, { recursive: true });
  }
}

// ─── Fixture: Roadmap Template ────────────────────────────────────────────

function makeRoadmapContent(slices: Array<{ id: string; title: string; done: boolean }>): string {
  const lines: string[] = [];
  lines.push('# M001 Roadmap');
  lines.push('');
  lines.push('**Vision:** Test milestone');
  lines.push('');
  lines.push('## Slices');
  lines.push('');
  for (const s of slices) {
    const checkbox = s.done ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Fixture: Plan Template ───────────────────────────────────────────────

function makePlanContent(
  sliceId: string,
  tasks: Array<{ id: string; title: string; done: boolean }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${sliceId}: Test Slice`);
  lines.push('');
  lines.push('**Goal:** Test slice goal');
  lines.push('**Demo:** Test demo');
  lines.push('');
  lines.push('## Must-Haves');
  lines.push('');
  lines.push('- Everything works');
  lines.push('');
  lines.push('## Tasks');
  lines.push('');
  for (const t of tasks) {
    const checkbox = t.done ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} **${t.id}: ${t.title}** \`est:1h\``);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Fixture: Task Summary Template ───────────────────────────────────────

function makeTaskSummaryContent(taskId: string): string {
  return [
    '---',
    `id: ${taskId}`,
    'parent: S01',
    'milestone: M001',
    'duration: 45m',
    'verification_result: all-pass',
    `completed_at: ${new Date().toISOString()}`,
    'blocker_discovered: false',
    'provides: []',
    'requires: []',
    'affects: []',
    'key_files:',
    '  - src/test.ts',
    'key_decisions: []',
    'patterns_established: []',
    'drill_down_paths: []',
    'observability_surfaces: []',
    '---',
    '',
    `# ${taskId}: Test Task Summary`,
    '',
    '**Implemented test functionality**',
    '',
    '## What Happened',
    '',
    'Built the test feature.',
    '',
    '## Deviations',
    '',
    'None.',
    '',
    '## Files Created/Modified',
    '',
    '- `src/test.ts` — main implementation',
    '',
    '## Verification Evidence',
    '',
    '| Command | Exit | Verdict | Duration |',
    '|---------|------|---------|----------|',
    '| `npm test` | 0 | ✅ pass | 2.1s |',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// DB Accessor Tests
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: DB accessor basics ──', () => {
  openDatabase(':memory:');

  // getAllMilestones — empty
  const empty = getAllMilestones();
  assert.deepStrictEqual(empty.length, 0, 'getAllMilestones returns empty when no milestones');

  // Insert and retrieve
  insertMilestone({ id: 'M001', title: 'Test MS', status: 'active' });
  insertMilestone({ id: 'M002', title: 'Second MS', status: 'active' });

  const all = getAllMilestones();
  assert.deepStrictEqual(all.length, 2, 'getAllMilestones returns 2 milestones');
  assert.deepStrictEqual(all[0].id, 'M001', 'first milestone is M001');
  assert.deepStrictEqual(all[1].id, 'M002', 'second milestone is M002');
  assert.deepStrictEqual(all[0].title, 'Test MS', 'milestone title correct');
  assert.deepStrictEqual(all[0].status, 'active', 'milestone status correct');

  // getMilestoneSlices — empty
  const noSlices = getMilestoneSlices('M001');
  assert.deepStrictEqual(noSlices.length, 0, 'getMilestoneSlices returns empty when no slices');

  // Insert slices and retrieve
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice 1', status: 'complete' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice 2', status: 'pending' });
  insertSlice({ id: 'S01', milestoneId: 'M002', title: 'M2 Slice', status: 'pending' });

  const m1Slices = getMilestoneSlices('M001');
  assert.deepStrictEqual(m1Slices.length, 2, 'M001 has 2 slices');
  assert.deepStrictEqual(m1Slices[0].id, 'S01', 'first slice is S01');
  assert.deepStrictEqual(m1Slices[0].status, 'complete', 'S01 status is complete');
  assert.deepStrictEqual(m1Slices[1].id, 'S02', 'second slice is S02');
  assert.deepStrictEqual(m1Slices[1].status, 'pending', 'S02 status is pending');

  const m2Slices = getMilestoneSlices('M002');
  assert.deepStrictEqual(m2Slices.length, 1, 'M002 has 1 slice');

  closeDatabase();
});

test('── markdown-renderer: getArtifact accessor ──', () => {
  openDatabase(':memory:');

  // Not found
  const missing = getArtifact('nonexistent/path');
  assert.deepStrictEqual(missing, null, 'getArtifact returns null for missing path');

  // Insert and retrieve
  insertArtifact({
    path: 'phases/01-test/01-ROADMAP.md',
    artifact_type: 'ROADMAP',
    milestone_id: 'M001',
    slice_id: null,
    task_id: null,
    full_content: '# Roadmap content',
  });

  const found = getArtifact('phases/01-test/01-ROADMAP.md');
  assert.ok(found !== null, 'getArtifact returns non-null for existing path');
  assert.deepStrictEqual(found!.artifact_type, 'ROADMAP', 'artifact type correct');
  assert.deepStrictEqual(found!.milestone_id, 'M001', 'milestone_id correct');
  assert.deepStrictEqual(found!.full_content, '# Roadmap content', 'content correct');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// Roadmap Checkbox Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderRoadmapCheckboxes round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    // Seed DB with milestone and slices
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core setup', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Rendering', status: 'pending' });

    // Write a roadmap file on disk with BOTH slices unchecked
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core setup', done: false },
      { id: 'S02', title: 'Rendering', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    // Render — should set S01 [x] and leave S02 [ ]
    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'renderRoadmapCheckboxes returns true');

    // Read rendered file and parse
    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    clearAllCaches();
    const parsed = parseRoadmap(rendered);

    assert.deepStrictEqual(parsed.slices.length, 2, 'roadmap has 2 slices after render');

    const s01 = parsed.slices.find(s => s.id === 'S01');
    const s02 = parsed.slices.find(s => s.id === 'S02');
    assert.ok(!!s01, 'S01 found in parsed roadmap');
    assert.ok(!!s02, 'S02 found in parsed roadmap');
    assert.ok(s01!.done, 'S01 is checked (done) after render');
    assert.ok(!s02!.done, 'S02 is unchecked (pending) after render');

    // Verify artifact stored in DB
    const artifact = getArtifact('phases/01-test/01-ROADMAP.md');
    assert.ok(artifact !== null, 'roadmap artifact stored in DB after render');
    assert.ok(artifact!.full_content.includes('[x] **S01:'), 'DB artifact has S01 checked');
    assert.ok(artifact!.full_content.includes('[ ] **S02:'), 'DB artifact has S02 unchecked');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderRoadmapCheckboxes bidirectional ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    // S01 is PENDING in DB, but checked on disk — should be unchecked
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core setup', status: 'pending' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Rendering', status: 'complete' });

    // Write roadmap with S01 checked and S02 unchecked (opposite of DB state)
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core setup', done: true },
      { id: 'S02', title: 'Rendering', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'bidirectional render returns true');

    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    clearAllCaches();
    const parsed = parseRoadmap(rendered);

    const s01 = parsed.slices.find(s => s.id === 'S01');
    const s02 = parsed.slices.find(s => s.id === 'S02');
    assert.ok(!s01!.done, 'S01 unchecked (DB says pending, was checked on disk)');
    assert.ok(s02!.done, 'S02 checked (DB says complete, was unchecked on disk)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Plan Checkbox Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderPlanCheckboxes round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });
    insertTask({ id: 'T03', sliceId: 'S01', milestoneId: 'M001', title: 'Third task', status: 'pending' });

    // Write plan with all tasks unchecked
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: false },
      { id: 'T02', title: 'Second task', done: false },
      { id: 'T03', title: 'Third task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const ok = await renderPlanCheckboxes(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'renderPlanCheckboxes returns true');

    const rendered = fs.readFileSync(planPath, 'utf-8');
    clearAllCaches();
    const parsed = parsePlan(rendered);

    assert.deepStrictEqual(parsed.tasks.length, 3, 'plan has 3 tasks after render');

    const t01 = parsed.tasks.find(t => t.id === 'T01');
    const t02 = parsed.tasks.find(t => t.id === 'T02');
    const t03 = parsed.tasks.find(t => t.id === 'T03');
    assert.ok(t01!.done, 'T01 checked (done in DB)');
    assert.ok(t02!.done, 'T02 checked (done in DB)');
    assert.ok(!t03!.done, 'T03 unchecked (pending in DB)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanCheckboxes re-renders DB tasks added after the plan artifact ──', async () => {
  // Regression for the lossy-projection root cause: renderPlanCheckboxes used to
  // patch the cached PLAN artifact in place, silently dropping tasks added to
  // the DB after the artifact was first written (the 4S/0T-vs-5S/13T drift).
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'pending' });

    // PLAN.md on disk reflects an earlier state with only T01.
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, makePlanContent('S01', [{ id: 'T01', title: 'First task', done: false }]));
    clearAllCaches();

    // Two more tasks are written to the DB after the artifact already exists.
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });
    insertTask({ id: 'T03', sliceId: 'S01', milestoneId: 'M001', title: 'Third task', status: 'pending' });

    const ok = await renderPlanCheckboxes(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'renderPlanCheckboxes returns true');

    const parsed = parsePlan(fs.readFileSync(planPath, 'utf-8'));
    clearAllCaches();
    assert.deepStrictEqual(
      parsed.tasks.map(t => t.id).sort(),
      ['T01', 'T02', 'T03'],
      'full re-render must include tasks added after the artifact was written',
    );
    assert.ok(parsed.tasks.find(t => t.id === 'T02')!.done, 'T02 reflects done status from DB');
    assert.ok(!parsed.tasks.find(t => t.id === 'T03')!.done, 'T03 reflects pending status from DB');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanCheckboxes bidirectional ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    // T01 pending in DB but checked on disk
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'pending' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: true },   // checked but DB says pending
      { id: 'T02', title: 'Second task', done: false },  // unchecked but DB says done
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const ok = await renderPlanCheckboxes(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'bidirectional plan render returns true');

    const rendered = fs.readFileSync(planPath, 'utf-8');
    clearAllCaches();
    const parsed = parsePlan(rendered);

    const t01 = parsed.tasks.find(t => t.id === 'T01');
    const t02 = parsed.tasks.find(t => t.id === 'T02');
    assert.ok(!t01!.done, 'T01 unchecked (DB says pending, was checked)');
    assert.ok(t02!.done, 'T02 checked (DB says done, was unchecked)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanFromDb creates parse-compatible slice plan + task plan files ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    // insertMilestone must come before scaffoldDirs so scaffoldDirs can read
    // the title from the DB and derive the correct slug ('milestone' → 01-milestone/).
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    scaffoldDirs(tmpDir, 'M001', ['S02']);
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      title: 'DB-backed planning',
      status: 'pending',
      demo: 'Rendered plans exist on disk.',
      planning: {
        goal: 'Render slice plans from DB state.',
        successCriteria: '- Slice plan stays parse-compatible\n- Task plan files are regenerated',
        proofLevel: 'integration',
        integrationClosure: 'Wires DB planning rows to markdown artifacts.',
        observabilityImpact: '- Run renderer contract tests\n- Inspect stale-render diagnostics on mismatch',
      },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Render slice plan',
      status: 'pending',
      planning: {
        description: 'Implement the DB-backed slice plan renderer.',
        estimate: '45m',
        files: ['src/resources/extensions/gsd/markdown-renderer.ts'],
        verify: 'node --test markdown-renderer.test.ts',
        inputs: ['src/resources/extensions/gsd/markdown-renderer.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/markdown-renderer.test.ts'],
        observabilityImpact: 'Renderer tests cover stale render failure paths.',
      },
    });
    insertTask({
      id: 'T02',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Render task plan',
      status: 'pending',
      planning: {
        description: 'Emit the task plan file with conservative frontmatter.',
        estimate: '30m',
        files: ['src/resources/extensions/gsd/files.ts'],
        verify: 'node --test auto-recovery.test.ts',
        inputs: ['src/resources/extensions/gsd/files.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/auto-recovery.test.ts'],
        observabilityImpact: 'Missing task-plan files fail recovery verification.',
      },
    });

    const rendered = await renderPlanFromDb(tmpDir, 'M001', 'S02');
    assert.ok(fs.existsSync(rendered.planPath), 'slice plan written to disk');
    // Flat-phase: tasks are checkboxes inside the plan file, no per-task files
    assert.strictEqual(rendered.taskPlanPaths.length, 0, 'no per-task plan files in flat-phase');

    const planContent = fs.readFileSync(rendered.planPath, 'utf-8');
    clearAllCaches();
    const parsedPlan = parsePlan(planContent);
    assert.strictEqual(parsedPlan.id, 'S02', 'rendered slice plan parses with correct slice id');
    assert.strictEqual(parsedPlan.goal, 'Render slice plans from DB state.', 'rendered slice plan preserves goal');
    assert.strictEqual(parsedPlan.demo, 'Rendered plans exist on disk.', 'rendered slice plan preserves demo');
    assert.strictEqual(parsedPlan.mustHaves.length, 2, 'rendered slice plan exposes must-haves');
    assert.strictEqual(parsedPlan.tasks.length, 2, 'rendered slice plan exposes all tasks');
    assert.strictEqual(parsedPlan.tasks[0].id, 'T01', 'first task parses correctly');
    assert.ok(parsedPlan.tasks[0].description.includes('DB-backed slice plan renderer'), 'task description preserved in slice plan');
    assert.strictEqual(parsedPlan.tasks[0].files?.[0], 'src/resources/extensions/gsd/markdown-renderer.ts', 'files list preserved in slice plan');
    assert.strictEqual(parsedPlan.tasks[0].verify, 'node --test markdown-renderer.test.ts', 'verify line preserved in slice plan');

    const planArtifact = getArtifact('phases/01-milestone/01-02-PLAN.md');
    assert.ok(planArtifact !== null, 'slice plan artifact stored in DB');
    assert.ok(planArtifact!.full_content.includes('<tasks>'), 'stored plan artifact contains <tasks> section');

    // Flat-phase: no per-task plan files — tasks are checkboxes inside the
    // Flat-phase: no per-task plan artifacts — tasks are checkboxes inside the
    // plan file. Skip the per-task artifact assertions that tested the old model.
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: slice plan preserves task descriptions without leaking nested headings ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Working app',
      status: 'pending',
      demo: 'The app works.',
      planning: {
        goal: 'Build a small app.',
        successCriteria: 'Not provided.',
        proofLevel: 'Not provided.',
        integrationClosure: 'N/A',
        observabilityImpact: 'None',
      },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Build app',
      status: 'pending',
      planning: {
        description: [
          'Create the static app files.',
          '',
          '## Steps',
          '',
          '- Create the HTML shell.',
          '- Wire browser storage.',
          '',
          '## Must-Haves',
          '',
          '- Adding an item updates the list.',
        ].join('\n'),
        estimate: '30m',
        files: ['index.html', 'app.js', 'style.css'],
        verify: 'open index.html',
        inputs: ['.gitignore'],
        expectedOutput: ['index.html', 'app.js', 'style.css'],
      },
    });

    const rendered = await renderPlanFromDb(tmpDir, 'M001', 'S01');
    const planContent = fs.readFileSync(rendered.planPath, 'utf-8');
    clearAllCaches();
    const parsedPlan = parsePlan(planContent);

    assert.doesNotMatch(planContent, /Not provided/i, 'placeholder values should not render');
    assert.doesNotMatch(planContent, /^## Steps$/m, 'task detail headings must not escape into the slice plan');
    assert.strictEqual((planContent.match(/^## Must-Haves$/gm) ?? []).length, 1, 'slice plan has only its own Must-Haves heading');
    assert.match(parsedPlan.tasks[0].description, /Create the static app files\./);
    assert.match(parsedPlan.tasks[0].description, /Create the HTML shell\./);
    assert.match(parsedPlan.tasks[0].description, /Wire browser storage\./);
    assert.match(parsedPlan.tasks[0].description, /Adding an item updates the list\./);

    // Flat-phase: no per-task plan files — tasks are inside the slice plan's
    // <tasks> block. Skip per-task plan assertions.
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanFromDb marks flagged slice gates ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    scaffoldDirs(tmpDir, 'M001', ['S01']);
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Risky slice',
      status: 'pending',
      demo: 'Reviewers can see flagged gates.',
      planning: {
        goal: 'Persist gate concern state.',
        successCriteria: '- Flagged gates stay visible',
      },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Render gate state',
      status: 'pending',
    });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q3', scope: 'slice' });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q4', scope: 'slice' });

    const findings = '- Shared gate findings.';
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      gateId: 'Q3',
      verdict: 'flag',
      rationale: 'Concern recorded.',
      findings,
    });
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      gateId: 'Q4',
      verdict: 'pass',
      rationale: 'No concern.',
      findings,
    });

    const rendered = await renderPlanFromDb(tmpDir, 'M001', 'S01');
    const threatSurface = extractSection(rendered.content, 'Threat Surface');
    const requirementImpact = extractSection(rendered.content, 'Requirement Impact');

    assert.ok(threatSurface?.includes('> **Warning:** Verdict: flag - concerns recorded below'));
    assert.ok(threatSurface?.includes(findings));
    assert.ok(!requirementImpact?.includes('Verdict: flag'), 'passing gate should not render a flag warning');
    assert.ok(requirementImpact?.includes(findings), 'passing gate still renders findings');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskPlanFromDb marks flagged task gates ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    scaffoldDirs(tmpDir, 'M001', ['S01']);
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task gate render',
      status: 'pending',
      planning: {
        description: 'Render task quality gates.',
      },
    });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q5', scope: 'task', taskId: 'T01' });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q6', scope: 'task', taskId: 'T01' });

    const findings = '- Same task findings.';
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      gateId: 'Q5',
      verdict: 'flag',
      rationale: 'Concern recorded.',
      findings,
    });
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      gateId: 'Q6',
      verdict: 'pass',
      rationale: 'No concern.',
      findings,
    });

    const rendered = await renderTaskPlanFromDb(tmpDir, 'M001', 'S01', 'T01');
    const failureModes = extractSection(rendered.content, 'Failure Modes');
    const loadProfile = extractSection(rendered.content, 'Load Profile');

    assert.ok(failureModes?.includes('> **Warning:** Verdict: flag - concerns recorded below'));
    assert.ok(failureModes?.includes(findings));
    assert.ok(!loadProfile?.includes('Verdict: flag'), 'passing task gate should not render a flag warning');
    assert.ok(loadProfile?.includes(findings), 'passing task gate still renders findings');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskPlanFromDb throws for missing task ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S02']);
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    let threw = false;
    try {
      await renderTaskPlanFromDb(tmpDir, 'M001', 'S02', 'T99');
    } catch (error) {
      threw = true;
      assert.match(String((error as Error).message), /task M001\/S02\/T99 not found/, 'renderTaskPlanFromDb should fail clearly when task row is missing');
    }
    assert.ok(threw, 'renderTaskPlanFromDb throws when the task row is missing');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// Task Summary Rendering
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderTaskSummary round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Test Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    const ok = await renderTaskSummary(tmpDir, 'M001', 'S01', 'T01');
    assert.ok(ok, 'renderTaskSummary returns true');

    // Verify file exists on disk
    const summaryPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', 'S01-T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'S01-T01-SUMMARY.md written to disk');

    // Parse and verify
    const rendered = fs.readFileSync(summaryPath, 'utf-8');
    clearAllCaches();
    const parsed = parseSummary(rendered);
    assert.deepStrictEqual(parsed.frontmatter.id, 'T01', 'parsed summary has correct id');
    assert.deepStrictEqual(parsed.frontmatter.parent, 'S01', 'parsed summary has correct parent');
    assert.deepStrictEqual(parsed.frontmatter.milestone, 'M001', 'parsed summary has correct milestone');
    assert.deepStrictEqual(parsed.frontmatter.duration, '45m', 'parsed summary has correct duration');
    assert.ok(parsed.title.includes('T01'), 'parsed summary title contains task ID');
    assert.ok(parsed.whatHappened.includes('Built the test feature'), 'whatHappened content preserved');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskSummary skips in-progress without a succeeded attempt ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Cancelled task with leaked summary',
      status: 'in_progress',
      fullSummaryMd: makeTaskSummaryContent('T01'),
    });

    const ok = await renderTaskSummary(tmpDir, 'M001', 'S01', 'T01');
    assert.equal(ok, false, 'cancelled/in-progress leaked summaries must not project');
    const summaryPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', 'S01-T01-SUMMARY.md',
    );
    assert.equal(fs.existsSync(summaryPath), false, 'SUMMARY.md must not be written');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskSummary skips empty ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task without summary',
      status: 'pending',
      fullSummaryMd: '', // empty summary
    });

    const ok = await renderTaskSummary(tmpDir, 'M001', 'S01', 'T01');
    assert.ok(!ok, 'renderTaskSummary returns false for empty summary');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: task summary artifact failure is observable ──', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => {
    closeDatabase();
    cleanupDir(tmpDir);
  });
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  scaffoldDirs(tmpDir, 'M001', ['S01']);
  insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
  insertTask({
    id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'done',
    fullSummaryMd: makeTaskSummaryContent('T01'),
  });
  _getAdapter()!.exec('DROP TABLE artifacts');

  await assert.rejects(
    () => renderTaskSummary(tmpDir, 'M001', 'S01', 'T01'),
    /task summary projection.*artifact persistence failed/i,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Slice Summary Rendering
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderSliceSummary round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'complete' });

    // Update slice with summary and UAT content
    // Since insertSlice uses INSERT OR IGNORE, we need to set the content via raw adapter
    const db = await import('../gsd-db.ts');
    const adapter = db._getAdapter()!;
    adapter.prepare(
      `UPDATE slices SET full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`,
    ).run({
      ':sm': '---\nid: S01\nparent: M001\nmilestone: M001\nduration: 2h\nverification_result: all-pass\ncompleted_at: 2025-01-01\nblocker_discovered: false\nprovides: []\nrequires: []\naffects: []\nkey_files:\n  - src/index.ts\nkey_decisions: []\npatterns_established: []\ndrill_down_paths: []\nobservability_surfaces: []\n---\n\n# S01: Test Slice Summary\n\n**Completed core functionality**\n\n## What Happened\n\nBuilt the slice.\n\n## Deviations\n\nNone.\n',
      ':um': '# S01 UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n\n## Checks\n\n- All tests pass\n',
    });

    const ok = await renderSliceSummary(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'renderSliceSummary returns true');

    // Verify SUMMARY file
    const summaryPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', '01-01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'S01-SUMMARY.md written to disk');

    const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
    assert.ok(summaryContent.includes('Test Slice Summary'), 'summary content correct');

    // Verify UAT file
    const uatPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', '01-01-UAT.md',
    );
    assert.ok(fs.existsSync(uatPath), 'S01-UAT.md written to disk');

    const uatContent = fs.readFileSync(uatPath, 'utf-8');
    assert.ok(uatContent.includes('artifact-driven'), 'UAT content correct');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// renderAllFromDb
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderAllFromDb produces all files ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    // Setup: 2 milestones, M001 has 2 slices with tasks, M002 has 1 slice
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);
    scaffoldDirs(tmpDir, 'M002', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertMilestone({ id: 'M002', title: 'test', status: 'active' });

    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });
    insertSlice({ id: 'S01', milestoneId: 'M002', title: 'Future', status: 'pending' });

    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'DB', status: 'done', fullSummaryMd: makeTaskSummaryContent('T01') });
    insertTask({ id: 'T01', sliceId: 'S02', milestoneId: 'M001', title: 'Renderer', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M002', title: 'Future task', status: 'pending' });

    // Write roadmap and plan files on disk
    const roadmap1 = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
      { id: 'S02', title: 'Render', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md'),
      roadmap1,
    );

    const roadmap2 = makeRoadmapContent([
      { id: 'S01', title: 'Future', done: false },
    ]);
    fs.mkdirSync(path.join(tmpDir, '.gsd', 'phases', '02-test'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'phases', '02-test', '02-ROADMAP.md'),
      roadmap2,
    );

    const plan1 = makePlanContent('S01', [
      { id: 'T01', title: 'DB', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md'),
      plan1,
    );

    const plan2 = makePlanContent('S02', [
      { id: 'T01', title: 'Renderer', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'phases', '01-test', '01-02-PLAN.md'),
      plan2,
    );

    const plan3 = makePlanContent('S01', [
      { id: 'T01', title: 'Future task', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'phases', '02-test', '02-01-PLAN.md'),
      plan3,
    );

    clearAllCaches();

    const result = await renderAllFromDb(tmpDir);

    assert.ok(result.rendered > 0, 'renderAllFromDb rendered some files');
    assert.deepStrictEqual(result.errors.length, 0, 'renderAllFromDb had no errors');

    // Verify M001 roadmap has S01 checked
    const m1Roadmap = fs.readFileSync(
      path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md'), 'utf-8',
    );
    clearAllCaches();
    const parsed1 = parseRoadmap(m1Roadmap);
    const s01 = parsed1.slices.find(s => s.id === 'S01');
    assert.ok(s01!.done, 'M001 S01 checked after renderAll');

    // Verify M001/S01 plan has T01 checked
    const m1s1Plan = fs.readFileSync(
      path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md'), 'utf-8',
    );
    clearAllCaches();
    const parsedPlan = parsePlan(m1s1Plan);
    assert.ok(parsedPlan.tasks[0].done, 'M001/S01 T01 checked after renderAll');

    // Verify task summary written
    const taskSummaryPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', 'S01-T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(taskSummaryPath), 'T01 summary written by renderAll');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DB-authoritative regeneration
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: missing artifact regenerates from DB without importing disk projection ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });

    // Write roadmap to disk but NOT in artifacts DB
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
    ]) + '\n\nDISK_ONLY_SENTINEL';
    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    // Verify no artifact in DB
    const before = getArtifact('phases/01-test/01-ROADMAP.md');
    assert.deepStrictEqual(before, null, 'artifact not in DB before render');

    // Render — should regenerate from DB rows, not import/patch disk content.
    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'render succeeds by regenerating from DB');

    // Verify artifact now exists in DB but does not contain disk-only content.
    const after = getArtifact('phases/01-test/01-ROADMAP.md');
    assert.ok(after !== null, 'artifact regenerated in DB');
    assert.ok(!after!.full_content.includes('DISK_ONLY_SENTINEL'), 'disk projection content was not imported');
    assert.ok(after!.full_content.includes('S01'), 'DB artifact reflects DB slice state');

    assert.ok(fs.existsSync(roadmapPath), 'roadmap projection regenerated on disk');
    const diskAfter = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(!diskAfter.includes('DISK_ONLY_SENTINEL'), 'disk projection was rewritten from DB');
    assert.ok(diskAfter.includes('S01'), 'disk projection reflects DB slice state');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: stale roadmap artifact regenerates from DB rows ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Planned Slice',
      risk: 'high',
      depends: ['S00'],
      demo: 'planned result',
      status: 'complete',
    });

    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    const staleContent = makeRoadmapContent([
      { id: 'S01', title: 'Stale Artifact Title', done: false },
    ]) + '\n\nSTALE_ARTIFACT_SENTINEL';
    fs.writeFileSync(roadmapPath, staleContent);
    insertArtifact({
      path: 'phases/01-test/01-ROADMAP.md',
      artifact_type: 'ROADMAP',
      milestone_id: 'M001',
      slice_id: null,
      task_id: null,
      full_content: staleContent,
    });
    clearAllCaches();

    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'render succeeds by regenerating stale roadmap artifact from DB');

    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(!rendered.includes('STALE_ARTIFACT_SENTINEL'), 'stale artifact-only content is not preserved');
    assert.ok(!rendered.includes('Stale Artifact Title'), 'stale artifact title is not preserved');

    clearAllCaches();
    const parsed = parseRoadmap(rendered);
    const s01 = parsed.slices.find(s => s.id === 'S01');
    assert.ok(s01, 'S01 parsed from regenerated roadmap');
    assert.ok(s01!.done, 'S01 is checked from DB completion status');
    assert.deepStrictEqual(s01!.title, 'Planned Slice', 'S01 title comes from DB');
    assert.deepStrictEqual(s01!.risk, 'high', 'S01 risk comes from DB');
    assert.deepStrictEqual(s01!.depends, ['S00'], 'S01 dependencies come from DB');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: roadmap render sanitizes title and normalizes invalid risk (#230) ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Title with `ticks` | pipes\nand newline',
      risk: 'this is invalid risk prose with | and `code`',
      depends: [],
      demo: 'Works',
      status: 'pending',
    });

    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'render succeeds');

    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    const sliceLine = rendered.split('\n').find(line => line.includes('**S01:'));
    assert.ok(sliceLine, 'slice line exists');
    assert.ok(!sliceLine!.includes('\n'), 'slice line is single-line');
    assert.ok(!sliceLine!.includes('|'), 'slice line title/risk does not include raw pipes');
    assert.ok(!sliceLine!.includes('`ticks`'), 'slice line title does not include raw backticks');
    assert.ok(sliceLine!.includes('`risk:medium`'), 'invalid risk is normalized to medium');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// stderr warnings (graceful degradation diagnostics)
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: stderr warning on missing content ──', async () => {
  openDatabase(':memory:');

  // No milestone/slices in DB, no files on disk — should return false and emit stderr
  insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
  // No slices inserted — should warn about no slices

  const ok = await renderRoadmapCheckboxes('/nonexistent/path', 'M001');
  assert.ok(!ok, 'returns false when no slices in DB');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Plan Checkbox Mismatch
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds plan checkbox mismatch ──', { skip: true }, () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // T01 is done, T02 is also done in DB
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    // Write plan with T01 checked but T02 unchecked
    // T01 matches DB (done + checked) but T02 is stale (done but unchecked)
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: true },
      { id: 'T02', title: 'Second task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Render T01 to sync it, but leave T02 out of sync
    // Actually, the plan was written with T01 already checked. 
    // The stale detection should find T02 as stale.
    const stale = detectStaleRenders(tmpDir);

    assert.ok(stale.length > 0, 'detectStaleRenders should find stale entries');
    const t02Stale = stale.find(s => s.reason.includes('T02'));
    assert.ok(!!t02Stale, 'should detect T02 as stale (done in DB, unchecked in plan)');
    assert.ok(t02Stale!.reason.includes('done in DB but unchecked'), 'reason should explain the mismatch');

    // T01 should NOT be stale — it's checked and done
    const t01Stale = stale.find(s => s.reason.includes('T01'));
    assert.deepStrictEqual(t01Stale, undefined, 'T01 should not be stale (done and checked)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Plan Checkbox
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders fixes plan and second detect returns empty ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    // Write plan with both tasks unchecked (both are stale since DB says done)
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: false },
      { id: 'T02', title: 'Second task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Verify stale before repair
    const staleBefore = detectStaleRenders(tmpDir);
    assert.ok(staleBefore.length > 0, 'should have stale entries before repair');

    // Repair
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, 'repairStaleRenders should repair at least 1 file');

    // After repair, detect again — should be empty
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    assert.deepStrictEqual(staleAfter.length, 0, 'detectStaleRenders should return empty after repair');

    // Verify the plan file was actually updated
    const repairedContent = fs.readFileSync(planPath, 'utf-8');
    assert.ok(repairedContent.includes('[x] **T01**'), 'T01 should be checked after repair');
    assert.ok(repairedContent.includes('[x] **T02**'), 'T02 should be checked after repair');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Roadmap Checkbox Mismatch
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds roadmap checkbox mismatch ──', { skip: true }, () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });

    // Write roadmap with both slices unchecked (S01 is stale — complete in DB but unchecked)
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
      { id: 'S02', title: 'Render', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const s01Stale = stale.find(s => s.reason.includes('S01'));
    assert.ok(!!s01Stale, 'should detect S01 as stale (complete in DB, unchecked in roadmap)');

    const s02Stale = stale.find(s => s.reason.includes('S02'));
    assert.deepStrictEqual(s02Stale, undefined, 'S02 should not be stale (pending and unchecked — matches)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: repairStaleRenders reads worktree roadmap projection ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const worktreeDir = path.join(tmpDir, '.gsd', 'worktrees', 'M001');
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    const projectMilestoneDir = path.join(tmpDir, '.gsd', 'phases', '01-test');
    const projectionMilestoneDir = path.join(worktreeDir, '.gsd', 'phases', '01-test');
    fs.mkdirSync(projectMilestoneDir, { recursive: true });
    fs.mkdirSync(projectionMilestoneDir, { recursive: true });

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });

    const staleRoadmap = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
    ]);
    const projectRoadmapPath = path.join(projectMilestoneDir, '01-ROADMAP.md');
    const projectionRoadmapPath = path.join(projectionMilestoneDir, '01-ROADMAP.md');
    fs.writeFileSync(projectRoadmapPath, staleRoadmap);
    fs.writeFileSync(projectionRoadmapPath, staleRoadmap);
    clearAllCaches();

    const staleBefore = detectStaleRenders(worktreeDir);
    assert.ok(
      staleBefore.some(s => pathsEqual(s.path, projectionRoadmapPath) && s.reason.includes('S01')),
      'worktree projection roadmap should be detected as stale',
    );
    assert.ok(
      staleBefore.every(s => !pathsEqual(s.path, projectRoadmapPath)),
      'project mirror roadmap should not be used for worktree stale detection',
    );

    const repaired = await repairStaleRenders(worktreeDir);
    assert.ok(repaired > 0, 'repairStaleRenders should repair the worktree projection');

    clearAllCaches();
    const staleAfter = detectStaleRenders(worktreeDir);
    assert.deepStrictEqual(staleAfter, [], 'worktree stale roadmap should be clear after repair');

    const projectContent = fs.readFileSync(projectRoadmapPath, 'utf-8');
    const projectionContent = fs.readFileSync(projectionRoadmapPath, 'utf-8');
    assert.ok(projectContent.includes('[ ] **S01:'), 'project mirror roadmap is left unchanged');
    assert.ok(projectionContent.includes('[x] **S01:'), 'worktree projection roadmap is repaired');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: repairStaleRenders handles descriptor roadmap projection dirs ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const worktreeDir = path.join(tmpDir, '.gsd', 'worktrees', 'M001');
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    const projectionMilestoneDir = path.join(worktreeDir, '.gsd', 'phases', '01-DESCRIPTOR');
    fs.mkdirSync(projectionMilestoneDir, { recursive: true });

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });

    const staleRoadmap = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
    ]);
    const descriptorRoadmapPath = path.join(projectionMilestoneDir, '01-ROADMAP.md');
    fs.writeFileSync(descriptorRoadmapPath, staleRoadmap);
    clearAllCaches();

    const staleBefore = detectStaleRenders(worktreeDir);
    assert.ok(
      staleBefore.some(s => pathsEqual(s.path, descriptorRoadmapPath) && s.reason.includes('S01')),
      'descriptor worktree projection roadmap should be detected as stale',
    );

    const repaired = await repairStaleRenders(worktreeDir);
    assert.ok(repaired > 0, 'repairStaleRenders should repair the descriptor projection');

    clearAllCaches();
    const staleAfter = detectStaleRenders(worktreeDir);
    assert.deepStrictEqual(staleAfter, [], 'descriptor stale roadmap should be clear after repair');

    const projectionContent = fs.readFileSync(descriptorRoadmapPath, 'utf-8');
    assert.ok(projectionContent.includes('[x] **S01:'), 'descriptor projection roadmap is repaired');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: repairStaleRenders handles legacy descriptor roadmap filenames ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    const milestoneDir = path.join(tmpDir, '.gsd', 'phases', '01-test');
    fs.mkdirSync(milestoneDir, { recursive: true });

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });

    const staleRoadmap = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
    ]);
    const legacyRoadmapPath = path.join(milestoneDir, '01-ROADMAP.md');
    fs.writeFileSync(legacyRoadmapPath, staleRoadmap);
    clearAllCaches();

    const staleBefore = detectStaleRenders(tmpDir);
    assert.ok(
      staleBefore.some(s => pathsEqual(s.path, legacyRoadmapPath) && s.reason.includes('S01')),
      'legacy descriptor roadmap filename should be detected as stale',
    );

    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, 'repairStaleRenders should repair the legacy descriptor roadmap');

    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    assert.deepStrictEqual(staleAfter, [], 'legacy descriptor roadmap should be clear after repair');

    const repairedContent = fs.readFileSync(legacyRoadmapPath, 'utf-8');
    assert.ok(repairedContent.includes('[x] **S01:'), 'legacy descriptor roadmap is repaired');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Missing Task Summary
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds missing task summary ──', { skip: true }, () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // Task is done with full_summary_md, but no SUMMARY.md on disk
    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    // Also write a plan so plan detection doesn't trigger (T01 is done but not checked)
    // We need a plan file so task plan detection works — but we specifically want to test
    // the missing summary case, so write plan with T01 checked
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find(s => s.reason.includes('SUMMARY.md missing'));
    assert.ok(!!summaryStale, 'should detect missing T01-SUMMARY.md');
    assert.ok(summaryStale!.reason.includes('T01'), 'reason should mention T01');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Missing Task Summary
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders writes missing task summary ──', { skip: true }, async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    // Write plan with T01 checked so plan detection doesn't trigger
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Repair
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, 'should repair missing summary');

    // Verify file written
    const summaryPath = path.join(
      tmpDir, '.gsd', 'phases', '01-test', 'S01-T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'S01-T01-SUMMARY.md should exist after repair');

    // Second detect should be empty
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    const summaryStale = staleAfter.find(s => s.reason.includes('SUMMARY.md missing') && s.reason.includes('T01'));
    assert.deepStrictEqual(summaryStale, undefined, 'missing summary should be fixed after repair');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Idempotency
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders idempotency — fully synced returns 0 ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'done' });

    // Write plan with T01 checked — matches DB
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // No stale entries when everything is in sync (no summary to check since no fullSummaryMd)
    const repaired = await repairStaleRenders(tmpDir);
    assert.deepStrictEqual(repaired, 0, 'repairStaleRenders should return 0 on fully synced project');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Missing Slice Summary + UAT
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds missing slice summary and UAT ──', { skip: true }, () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // Update slice to complete with content via raw adapter
    const adapter = _getAdapter()!;
    adapter.prepare(
      `UPDATE slices SET status = 'complete', full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`,
    ).run({
      ':sm': '---\nid: S01\nparent: M001\nmilestone: M001\n---\n\n# S01: Summary\n\nDone.\n',
      ':um': '# S01 UAT\n\nAll pass.\n',
    });

    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find(s => s.reason.includes('SUMMARY.md missing') && s.reason.includes('S01'));
    const uatStale = stale.find(s => s.reason.includes('UAT.md missing') && s.reason.includes('S01'));

    assert.ok(!!summaryStale, 'should detect missing S01-SUMMARY.md');
    assert.ok(!!uatStale, 'should detect missing S01-UAT.md');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// renderRoadmapFromDb — unplanned-milestone guard (#852 follow-up)
// ═══════════════════════════════════════════════════════════════════════════
//
// A milestone row created by gsd_milestone_generate_id / ensureMilestoneDbRow
// starts with title="" / vision="" and zero slices. Rendering that produced a
// 38-byte stub (`# M015: M015\n\n**Vision:** \n\n## Slices`) that passed
// existsSync but failed the plan-milestone "zero slices" content check —
// trapping auto-mode in a finalize-retry loop. The guard now refuses to render
// a ROADMAP for a milestone with zero slices AND empty vision, so verification
// sees a genuinely missing file (clear "write the ROADMAP" failure) instead of
// a misleading stub.

test('── markdown-renderer: renderRoadmapFromDb skips unplanned milestone (zero slices, empty vision) ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    // Reserved placeholder row — exactly what ensureMilestoneDbRow creates: no
    // title, no vision, no slices (the never-planned state).
    insertMilestone({ id: 'M015', title: '', status: 'queued' });
    scaffoldDirs(tmpDir, 'M015', []);

    const result = await renderRoadmapFromDb(tmpDir, 'M015');

    assert.deepEqual(result, { skipped: 'unplanned-milestone' });

    // No stub ROADMAP must land on disk — that's the whole point of the guard.
    const phaseDir = path.join(tmpDir, '.gsd', 'phases', '15-m015');
    const roadmapPath = path.join(phaseDir, '15-ROADMAP.md');
    assert.equal(
      fs.existsSync(roadmapPath),
      false,
      'renderRoadmapFromDb must NOT write a stub ROADMAP for an unplanned milestone',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderRoadmapFromDb removes a pre-existing stub ROADMAP for unplanned milestone ──', async () => {
  // Brownfield scenario: a previous run (before the unplanned-milestone guard
  // existed) already wrote a stub ROADMAP to disk. renderRoadmapFromDb must
  // delete it so plan-milestone verification sees a genuinely missing file
  // rather than failing on "zero slices" again (#852 follow-up).
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    insertMilestone({ id: 'M015', title: '', status: 'queued' });
    scaffoldDirs(tmpDir, 'M015', []);

    // Simulate a stub ROADMAP written by an older run.
    const phaseDir = path.join(tmpDir, '.gsd', 'phases', '15-m015');
    fs.mkdirSync(phaseDir, { recursive: true });
    const stubRoadmapPath = path.join(phaseDir, '15-ROADMAP.md');
    fs.writeFileSync(stubRoadmapPath, '# M015: M015\n\n**Vision:** \n\n## Slices\n');
    assert.equal(fs.existsSync(stubRoadmapPath), true, 'stub exists before guard runs');

    const result = await renderRoadmapFromDb(tmpDir, 'M015');

    assert.deepEqual(result, { skipped: 'unplanned-milestone' });
    assert.equal(
      fs.existsSync(stubRoadmapPath),
      false,
      'renderRoadmapFromDb must delete the pre-existing stub ROADMAP',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderRoadmapFromDb renders a planned milestone (≥1 slice) ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    insertMilestone({ id: 'M016', title: 'Planned', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M016', title: 'First slice', status: 'pending' });
    scaffoldDirs(tmpDir, 'M016', ['S01']);

    const result = await renderRoadmapFromDb(tmpDir, 'M016');

    assert.ok(!('skipped' in result), 'planned milestone must not be skipped');
    assert.ok('roadmapPath' in result && result.roadmapPath, 'returns a roadmapPath');
    assert.ok('content' in result && result.content.includes('## Slices'), 'content has a Slices section');
    assert.ok(
      'content' in result && result.content.includes('S01'),
      'content includes the planned slice',
    );
    assert.ok('content' in result && result.content.includes('**Vision:**\n'), 'empty vision has no trailing space');
    assert.ok('content' in result && result.content.includes('  > After this:\n'), 'empty demo has no trailing space');
    assert.ok('content' in result && !/[ \t]$/m.test(result.content), 'roadmap content has no trailing whitespace');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderRoadmapFromDb renders milestone with vision but zero slices ──', async () => {
  // A milestone with a non-empty vision but zero slices is NOT unplanned — it
  // may be mid-plan or intentionally slice-less. The guard must not skip it.
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    insertMilestone({ id: 'M017', title: 'Visionary', status: 'active' });
    // upsertMilestonePlanning sets the vision; insertMilestone leaves it "".
    // Simulate a planned-but-not-yet-sliced milestone via the planning upsert.
    const { upsertMilestonePlanning } = await import('../gsd-db.ts');
    upsertMilestonePlanning('M017', { vision: 'A slice-less milestone', title: 'Visionary', status: 'active', depends_on: [] });
    scaffoldDirs(tmpDir, 'M017', []);

    const result = await renderRoadmapFromDb(tmpDir, 'M017');

    assert.ok(!('skipped' in result), 'milestone with vision must not be skipped even with zero slices');
    assert.ok('content' in result && result.content.includes('A slice-less milestone'), 'vision is rendered');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// State-version stamp (T008)
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: roadmap render is byte-identical to the pre-stamp format plus one stamp line ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });

    const rendered = await renderRoadmapFromDb(tmpDir, 'M001');
    assert.ok(!('skipped' in rendered), 'planned milestone renders');

    // The pre-stamp byte stream for this fixture, per the FROZEN projection
    // format contract. If renderRoadmapMarkdown's output changes, this test
    // must go red — that is the byte-compatibility guard.
    const preStampBytes = [
      '# M001: Test',
      '',
      '**Vision:**',
      '',
      '## Slices',
      '',
      '- [x] **S01: Core** `risk:medium` `depends:[]`',
      '  > After this:',
      '',
      '- [ ] **S02: Render** `risk:medium` `depends:[]`',
      '  > After this:',
      '',
    ].join('\n');

    const { revision, authorityEpoch } = getCurrentProjectStateVersion();
    const stampLine = `<!-- gsd:state-version=${revision}:${authorityEpoch} -->\n`;

    assert.strictEqual(
      rendered.content,
      preStampBytes + stampLine,
      'returned content differs from the pre-stamp format ONLY by the stamp line',
    );
    assert.strictEqual(
      fs.readFileSync(rendered.roadmapPath, 'utf-8'),
      preStampBytes + stampLine,
      'on-disk projection differs from the pre-stamp format ONLY by the stamp line',
    );
    assert.strictEqual(
      stripProjectionStamp(rendered.content),
      preStampBytes,
      'stripping the stamp reproduces the pre-stamp bytes exactly',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: stamped re-render is byte-stable (no stamp accumulation) ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'pending' });

    const first = await renderPlanFromDb(tmpDir, 'M001', 'S01');
    const firstBytes = fs.readFileSync(first.planPath, 'utf-8');

    // Re-render from unchanged DB state. The plan artifact replay path must
    // not accumulate a second stamp line.
    const second = await renderPlanFromDb(tmpDir, 'M001', 'S01');
    const secondBytes = fs.readFileSync(second.planPath, 'utf-8');

    assert.strictEqual(secondBytes, firstBytes, 're-render of unchanged DB state is byte-identical');
    assert.strictEqual(
      (secondBytes.match(/gsd:state-version=/g) ?? []).length,
      1,
      'projection carries exactly one state-version stamp',
    );

    // The returned content matches the on-disk bytes, stamp included.
    assert.strictEqual(second.content, secondBytes, 'returned content equals on-disk bytes');

    // A freshly rendered projection has no content drift against DB intent.
    assert.deepStrictEqual(detectProjectionDrift(tmpDir), [], 'fresh render has no projection drift');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: ROADMAP render-import round-trip does not grow M### title prefix (#1592) ──', async () => {
  // Renderer: a DB title that already carries the id prefix must not double in the H1.
  const renderDir = makeTmpDir();
  openDatabase(path.join(renderDir, '.gsd', 'gsd.db'));
  clearAllCaches();
  try {
    insertMilestone({ id: 'M001', title: 'M001: M001: Clean Title', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'complete' });
    scaffoldDirs(renderDir, 'M001', ['S01']);

    const rendered = await renderRoadmapFromDb(renderDir, 'M001');
    assert.ok(!('skipped' in rendered), 'prefixed-title milestone still renders');
    assert.equal(
      rendered.content.split('\n')[0],
      '# M001: Clean Title',
      'render must strip existing M001: prefixes from the H1',
    );
  } finally {
    closeDatabase();
    cleanupDir(renderDir);
  }

  // Importer: row-creating imports must not prepend another M001: each cycle.
  const tmpDir = makeTmpDir();
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();
  try {
    insertMilestone({ id: 'M001', title: 'Clean Title', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'complete' });
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const rendered = await renderRoadmapFromDb(tmpDir, 'M001');
      assert.ok(!('skipped' in rendered), `cycle ${cycle}: planned milestone renders`);
      assert.equal(
        rendered.content.split('\n')[0],
        '# M001: Clean Title',
        `cycle ${cycle}: H1 must stay a single M001: prefix`,
      );

      const db = _getAdapter()!;
      transaction(() => {
        db.exec("DELETE FROM tasks");
        db.exec("DELETE FROM slices");
        db.exec("DELETE FROM milestones");
      });
      clearAllCaches();

      const counts = migrateHierarchyToDb(tmpDir);
      assert.equal(counts.milestones, 1, `cycle ${cycle}: import recreates the milestone`);
      assert.equal(
        getMilestone('M001')?.title,
        'Clean Title',
        `cycle ${cycle}: stored title must not grow an id prefix`,
      );
    }
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
