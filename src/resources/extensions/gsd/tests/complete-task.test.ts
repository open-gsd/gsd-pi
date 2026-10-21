import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  transaction,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getTask,
  getSlice,
  getSliceTasks,
  insertVerificationEvidence,
  insertGateRow,
  getGateResults,
  saveReworkBrief,
  updateMilestoneStatus,
  updateSliceStatus,
  SCHEMA_VERSION,
} from '../gsd-db.ts';
import { handleCompleteTask } from '../tools/complete-task.ts';
import { resolveTaskFile } from '../paths.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-complete-task-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch {
    // best effort
  }
}

function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Create a temp project directory with .gsd structure for handler tests.
 */
function createTempProject(): { basePath: string; planPath: string } {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-handler-'));
  const tasksDir = path.join(basePath, '.gsd', 'phases', '01-test');
  fs.mkdirSync(tasksDir, { recursive: true });

  const planPath = path.join(basePath, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
  fs.writeFileSync(planPath, `# S01: Test Slice

## Tasks

- [ ] **T01: Test task** \`est:30m\`
  - Do: Implement the thing
  - Verify: Run tests

- [ ] **T02: Second task** \`est:1h\`
  - Do: Implement more
  - Verify: Run more tests
`);

  return { basePath, planPath };
}

function writeProjectPreferences(basePath: string, yaml: string): void {
  fs.writeFileSync(path.join(basePath, '.gsd', 'PREFERENCES.md'), `---\n${yaml}---\n`);
}

async function withWorkingDirectory<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await action();
  } finally {
    process.chdir(previousCwd);
  }
}

function makeValidParams() {
  return {
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    oneLiner: 'Added test functionality',
    narrative: 'Implemented the test feature with full coverage.',
    verification: 'Ran npm run test:unit — all tests pass.',
    deviations: 'None.',
    knownIssues: 'None.',
    keyFiles: ['src/test.ts', 'src/test.test.ts'],
    keyDecisions: ['D001'],
    blockerDiscovered: false,
    verificationEvidence: [
      {
        command: 'npm run test:unit',
        exitCode: 0,
        verdict: '✅ pass',
        durationMs: 5000,
      },
    ],
  };
}

function makeEscalationOptions() {
  return [
    { id: 'continue', label: 'Continue', tradeoffs: 'Keeps execution moving with the default path.' },
    { id: 'pause', label: 'Pause', tradeoffs: 'Stops execution until the blocker is reviewed.' },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Fresh DB is migrated to the current schema version
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: fresh DB migrates to current schema version ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const adapter = _getAdapter()!;

  // Verify schema version matches the current source-of-truth constant.
  // Asserting against SCHEMA_VERSION (not a hardcoded number) keeps this
  // green across migration bumps while still catching a
  // "fresh-DB-was-not-migrated" regression.
  const versionRow = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assertEq(versionRow?.['v'], SCHEMA_VERSION, 'fresh DB should be migrated to current SCHEMA_VERSION');

  // Verify all 4 new tables exist
  const tables = adapter.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all();
  const tableNames = tables.map(t => t['name'] as string);
  assertTrue(tableNames.includes('milestones'), 'milestones table should exist');
  assertTrue(tableNames.includes('slices'), 'slices table should exist');
  assertTrue(tableNames.includes('tasks'), 'tasks table should exist');
  assertTrue(tableNames.includes('verification_evidence'), 'verification_evidence table should exist');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Accessor CRUD
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: accessor CRUD ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Insert milestone
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  const adapter = _getAdapter()!;
  const mRow = adapter.prepare("SELECT * FROM milestones WHERE id = 'M001'").get();
  assertEq(mRow?.['id'], 'M001', 'milestone id should be M001');
  assertEq(mRow?.['title'], 'Test Milestone', 'milestone title should match');

  // Insert slice
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high' });
  const sRow = adapter.prepare("SELECT * FROM slices WHERE id = 'S01' AND milestone_id = 'M001'").get();
  assertEq(sRow?.['id'], 'S01', 'slice id should be S01');
  assertEq(sRow?.['risk'], 'high', 'slice risk should be high');

  // Insert task with all fields
  insertTask({
    id: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    title: 'Test Task',
    status: 'complete',
    oneLiner: 'Did the thing',
    narrative: 'Full story here.',
    verificationResult: 'passed',
    duration: '30m',
    blockerDiscovered: false,
    deviations: 'None',
    knownIssues: 'None',
    keyFiles: ['file1.ts', 'file2.ts'],
    keyDecisions: ['D001'],
    fullSummaryMd: '# Summary',
  });

  // getTask verifies all fields
  const task = getTask('M001', 'S01', 'T01');
  assertTrue(task !== null, 'task should not be null');
  assertEq(task!.id, 'T01', 'task id');
  assertEq(task!.slice_id, 'S01', 'task slice_id');
  assertEq(task!.milestone_id, 'M001', 'task milestone_id');
  assertEq(task!.title, 'Test Task', 'task title');
  assertEq(task!.status, 'complete', 'task status');
  assertEq(task!.one_liner, 'Did the thing', 'task one_liner');
  assertEq(task!.narrative, 'Full story here.', 'task narrative');
  assertEq(task!.verification_result, 'passed', 'task verification_result');
  assertEq(task!.blocker_discovered, false, 'task blocker_discovered');
  assertEq(task!.key_files, ['file1.ts', 'file2.ts'], 'task key_files JSON round-trip');
  assertEq(task!.key_decisions, ['D001'], 'task key_decisions JSON round-trip');
  assertEq(task!.full_summary_md, '# Summary', 'task full_summary_md');

  // getTask returns null for non-existent
  const noTask = getTask('M001', 'S01', 'T99');
  assertEq(noTask, null, 'non-existent task should return null');

  // Insert verification evidence
  insertVerificationEvidence({
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    command: 'npm test',
    exitCode: 0,
    verdict: '✅ pass',
    durationMs: 3000,
  });
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 1, 'should have 1 verification evidence row');
  assertEq(evRows[0]['command'], 'npm test', 'evidence command');
  assertEq(evRows[0]['exit_code'], 0, 'evidence exit_code');
  assertEq(evRows[0]['verdict'], '✅ pass', 'evidence verdict');
  assertEq(evRows[0]['duration_ms'], 3000, 'evidence duration_ms');

  // getSliceTasks returns array
  const sliceTasks = getSliceTasks('M001', 'S01');
  assertEq(sliceTasks.length, 1, 'getSliceTasks should return 1 task');
  assertEq(sliceTasks[0].id, 'T01', 'getSliceTasks first task id');

  // updateTaskStatus preserves allowed closed-to-closed transitions.
  updateTaskStatus('M001', 'S01', 'T01', 'skipped', new Date().toISOString());
  const updatedTask = getTask('M001', 'S01', 'T01');
  assertEq(updatedTask!.status, 'skipped', 'task status should be updated to skipped');
  assertTrue(updatedTask!.completed_at !== null, 'completed_at should be set after status update');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Accessor stale-state error
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: accessor stale-state error ===');
{
  // No DB open — accessors should throw GSD_STALE_STATE
  closeDatabase();
  let threw = false;
  try {
    insertMilestone({ id: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'should throw GSD_STALE_STATE when no DB open');
  }
  assertTrue(threw, 'insertMilestone should throw when no DB open');

  threw = false;
  try {
    insertSlice({ id: 'S01', milestoneId: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertSlice should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertSlice should throw when no DB open');

  threw = false;
  try {
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertTask should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertTask should throw when no DB open');

  threw = false;
  try {
    insertVerificationEvidence({
      taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
      command: 'test', exitCode: 0, verdict: 'pass', durationMs: 0,
    });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertVerificationEvidence should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertVerificationEvidence should throw when no DB open');
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler happy path
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler happy path ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  // Seed milestone + slice + both tasks so projection renders T01 ([x]) and T02 ([ ])
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high', depends: ['S00'], demo: 'basic functionality works', sequence: 1 });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'pending', title: 'Second task' });

  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);

  assertTrue(!('error' in result), 'handler should succeed without error');
  if (!('error' in result)) {
    assertEq(result.taskId, 'T01', 'result taskId');
    assertEq(result.sliceId, 'S01', 'result sliceId');
    assertEq(result.milestoneId, 'M001', 'result milestoneId');
    assertTrue(result.summaryPath.endsWith('T01-SUMMARY.md'), 'summaryPath should end with T01-SUMMARY.md');

    // (a) Verify task row in DB with status 'complete'
    const task = getTask('M001', 'S01', 'T01');
    assertTrue(task !== null, 'task should exist in DB after handler');
    assertEq(task!.status, 'complete', 'task status should be complete');
    assertEq(task!.one_liner, 'Added test functionality', 'task one_liner in DB');
    assertEq(task!.key_files, ['src/test.ts', 'src/test.test.ts'], 'task key_files in DB');

    // (b) Verify verification_evidence rows in DB
    const adapter = _getAdapter()!;
    const evRows = adapter.prepare(
      "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND milestone_id = 'M001'"
    ).all();
    assertEq(evRows.length, 1, 'should have 1 verification evidence row after handler');
    assertEq(evRows[0]['command'], 'npm run test:unit', 'evidence command from handler');

    // (c) Verify T01-SUMMARY.md file on disk with correct YAML frontmatter
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should exist on disk');
    const summaryContent = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summaryContent, /^---\n/, 'summary should start with YAML frontmatter');
    assertMatch(summaryContent, /id: T01/, 'summary should contain id: T01');
    assertMatch(summaryContent, /parent: S01/, 'summary should contain parent: S01');
    assertMatch(summaryContent, /milestone: M001/, 'summary should contain milestone: M001');
    assertMatch(summaryContent, /blocker_discovered: false/, 'summary should contain blocker_discovered');
    assertMatch(summaryContent, /# T01:/, 'summary should have H1 with task ID');
    assertMatch(summaryContent, /\*\*Added test functionality\*\*/, 'summary should have one-liner in bold');
    assertMatch(summaryContent, /## What Happened/, 'summary should have What Happened section');
    assertMatch(summaryContent, /## Verification Evidence/, 'summary should have Verification Evidence section');
    assertMatch(summaryContent, /npm run test:unit/, 'summary evidence should contain command');
    assertMatch(summaryContent, /<!-- gsd:state-version=\d+:\d+ -->/, 'summary should carry the canonical projection stamp');
    const summaryArtifact = adapter.prepare(
      "SELECT full_content FROM artifacts WHERE artifact_type = 'SUMMARY' AND task_id = 'T01'"
    ).get();
    assertEq(summaryArtifact?.['full_content'], summaryContent, 'summary artifact should match stamped disk bytes');

    // (d) Verify plan checkbox changed to [x]
    const planContent = fs.readFileSync(planPath, 'utf-8');
    assertMatch(planContent, /\[x\]\s+\*\*T01\*\*/, 'T01 should be checked in plan');
    // T02 should still be unchecked
    assertMatch(planContent, /\[ \]\s+\*\*T02\*\*/, 'T02 should still be unchecked in plan');

    // (e) Verify full_summary_md stored in DB for D004 recovery
    const taskAfter = getTask('M001', 'S01', 'T01');
    assertTrue(taskAfter!.full_summary_md.length > 0, 'full_summary_md should be non-empty in DB');
    assertMatch(taskAfter!.full_summary_md, /id: T01/, 'full_summary_md should contain frontmatter');

    const sliceAfter = getSlice('M001', 'S01');
    assertTrue(sliceAfter !== null, 'slice should still exist after complete-task');
    assertEq(sliceAfter!.title, 'Test Slice', 'complete-task should preserve existing slice title');
    assertEq(sliceAfter!.risk, 'high', 'complete-task should preserve existing slice risk');
    assertEq(sliceAfter!.depends, ['S00'], 'complete-task should preserve existing slice dependencies');
    assertEq(sliceAfter!.demo, 'basic functionality works', 'complete-task should preserve existing slice demo');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Roadmap task output is not clobbered by stale DB render
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: roadmap expected output is not re-rendered from stale DB ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();
  const phaseDir = path.dirname(planPath);
  const roadmapPath = path.join(phaseDir, '01-ROADMAP.md');
  const roadmapContent = `# M001: Test Milestone

## Success Criteria
- Keep remediation criteria from the verified task output.

## Boundary Map
- S01 -> terminal: criteria remain documented.
`;
  fs.writeFileSync(roadmapPath, roadmapContent);

  insertMilestone({ id: 'M001', title: 'Test Milestone', planning: { vision: 'Stale DB vision' } });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high', depends: [], demo: 'basic functionality works', sequence: 1 });
  insertTask({
    id: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    status: 'pending',
    title: 'Repair roadmap criteria',
    planning: {
      expectedOutput: ['.gsd/phases/01-test/01-ROADMAP.md — remediation criteria'],
    },
  });

  const result = await handleCompleteTask({
    ...makeValidParams(),
    keyFiles: [],
    keyDecisions: [],
  }, basePath);

  assertTrue(!('error' in result), 'handler should succeed without error');
  assertEq(
    fs.readFileSync(roadmapPath, 'utf-8'),
    roadmapContent,
    'complete-task should not overwrite a roadmap listed as task expected output',
  );

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Flat-phase duplicate task IDs are slice-qualified
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: flat-phase duplicate task IDs are slice-qualified ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-flat-task-summary-'));
  const phaseDir = path.join(basePath, '.gsd', 'phases', '01-test');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), `# S01: First Slice

## Tasks

- [ ] **T03: Shared task id** \`est:30m\`
  - Do: Complete first slice task
  - Verify: Run first check
`);
  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), `# S02: Second Slice

## Tasks

- [ ] **T03: Shared task id** \`est:30m\`
  - Do: Complete second slice task
  - Verify: Run second check
`);

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', sequence: 1 });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', sequence: 2 });

  const first = await handleCompleteTask({
    ...makeValidParams(),
    taskId: 'T03',
    sliceId: 'S01',
    oneLiner: 'Completed first slice T03',
  }, basePath);
  const second = await handleCompleteTask({
    ...makeValidParams(),
    taskId: 'T03',
    sliceId: 'S02',
    oneLiner: 'Completed second slice T03',
  }, basePath);

  assertTrue(!('error' in first), 'first duplicate task ID completion should succeed');
  assertTrue(!('error' in second), 'second duplicate task ID completion should succeed');
  if (!('error' in first) && !('error' in second)) {
    const firstSummary = path.join(phaseDir, 'S01-T03-SUMMARY.md');
    const secondSummary = path.join(phaseDir, 'S02-T03-SUMMARY.md');
    const legacySummary = path.join(phaseDir, 'T03-SUMMARY.md');

    assertEq(first.summaryPath, firstSummary, 'S01/T03 should write a slice-qualified summary path');
    assertEq(second.summaryPath, secondSummary, 'S02/T03 should write a slice-qualified summary path');
    assertTrue(fs.existsSync(firstSummary), 'S01/T03 summary should exist');
    assertTrue(fs.existsSync(secondSummary), 'S02/T03 summary should exist');
    assertTrue(!fs.existsSync(legacySummary), 'flat-phase completion should not create legacy T03-SUMMARY.md');

    const firstContent = fs.readFileSync(firstSummary, 'utf-8');
    const secondContent = fs.readFileSync(secondSummary, 'utf-8');
    assertMatch(firstContent, /parent: S01/, 'S01/T03 summary should keep parent S01');
    assertMatch(secondContent, /parent: S02/, 'S02/T03 summary should keep parent S02');
    assertEq(resolveTaskFile(basePath, 'M001', 'S02', 'T03', 'SUMMARY'), secondSummary, 'resolver should prefer S02-specific summary');

    const legacyFallback = path.join(phaseDir, 'T99-SUMMARY.md');
    fs.writeFileSync(legacyFallback, '# Legacy task summary\n');
    assertEq(resolveTaskFile(basePath, 'M001', 'S09', 'T99', 'SUMMARY'), legacyFallback, 'resolver should fall back to old flat summary names');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Projection failure preserves DB completion
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: projection failure preserves DB completion ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  fs.unlinkSync(planPath);
  fs.mkdirSync(planPath, { recursive: true });

  const result = await handleCompleteTask(makeValidParams(), basePath);

  assertTrue('error' in result, 'projection failure should return an error');
  if ('error' in result) {
    assertMatch(result.error, /projection write failed/, 'error should mention projection write failure');
  }

  const task = getTask('M001', 'S01', 'T01');
  assertTrue(task !== null, 'task row should remain for projection repair');
  assertEq(task!.status, 'complete', 'task completion should remain committed');
  assertTrue(task!.completed_at !== null, 'committed task should keep completed_at');

  const adapter = _getAdapter()!;
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 1, 'verification evidence should remain committed for projection repair');

  const summaryPath = path.join(path.dirname(planPath), 'S01-T01-SUMMARY.md');
  assertTrue(fs.existsSync(summaryPath), 'successfully written SUMMARY.md should remain available for repair');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler does not re-render completed sibling summaries
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler leaves completed sibling summaries untouched ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high', depends: [], demo: 'basic functionality works', sequence: 1 });
  insertTask({ id: 'T00', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Already complete task', oneLiner: 'Previously completed' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'pending', title: 'Second task' });

  const siblingSummaryPath = path.join(path.dirname(planPath), 'T00-SUMMARY.md');
  const siblingSummaryContent = 'existing sibling summary marker\n';
  fs.writeFileSync(siblingSummaryPath, siblingSummaryContent);

  const result = await handleCompleteTask(makeValidParams(), basePath);

  assertTrue(!('error' in result), 'handler should succeed without error');
  assertEq(
    fs.readFileSync(siblingSummaryPath, 'utf-8'),
    siblingSummaryContent,
    'complete-task should not re-render summaries for already-completed sibling tasks',
  );

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: hard-blocker escalation with mid-execution escalation disabled
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: disabled hard-blocker escalation rejects before completion ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  writeProjectPreferences(basePath, 'phases:\n  mid_execution_escalation: false\n');

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = {
    ...makeValidParams(),
    blockerDiscovered: true,
    escalation: {
      question: 'Should execution pause for the hard blocker?',
      options: makeEscalationOptions(),
      recommendation: 'pause',
      recommendationRationale: 'The blocker should not be silently advanced.',
      continueWithDefault: false,
    },
  };

  const result = await withWorkingDirectory(basePath, () => handleCompleteTask(params, basePath));

  assertTrue('error' in result, 'hard-blocker escalation should fail when escalation handling is disabled');
  if ('error' in result) {
    assertMatch(result.error, /hard-blocker escalation/, 'error should mention hard-blocker escalation');
    assertMatch(result.error, /mid_execution_escalation is disabled/, 'error should mention disabled preference');
  }

  const task = getTask('M001', 'S01', 'T01');
  assertEq(task, null, 'disabled hard-blocker escalation should not create or complete the task');

  const adapter = _getAdapter()!;
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 0, 'disabled hard-blocker escalation should not persist verification evidence');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: hard-blocker escalation projection write failure
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: escalation write failure preserves completion ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();
  writeProjectPreferences(basePath, 'phases:\n  mid_execution_escalation: true\n');
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  // A directory at the artifact path makes the final atomic rename fail while
  // leaving the earlier SUMMARY and PLAN writes available.
  fs.mkdirSync(path.join(path.dirname(planPath), 'T01-ESCALATION.json'));
  const result = await withWorkingDirectory(basePath, () => handleCompleteTask({
    ...makeValidParams(),
    blockerDiscovered: true,
    escalation: {
      question: 'Should execution pause for the hard blocker?',
      options: makeEscalationOptions(),
      recommendation: 'pause',
      recommendationRationale: 'The blocker should not be silently advanced.',
      continueWithDefault: false,
    },
  }, basePath));

  assertTrue('error' in result, 'hard-blocker escalation write failure should return an error');
  if ('error' in result) {
    assertMatch(result.error, /escalation write failed/, 'error should identify the escalation projection');
    assertMatch(result.error, /completion remains committed/, 'error should report durable completion');
  }
  const task = getTask('M001', 'S01', 'T01');
  assertEq(task?.status, 'complete', 'task completion should remain committed');
  assertEq(task?.escalation_pending, 1, 'hard-blocker recovery intent should remain pending');
  assertEq(task?.escalation_awaiting_review, 0, 'hard blocker should not be marked awaiting review');
  assertMatch(task?.escalation_artifact_path ?? '', /T01-ESCALATION\.json$/, 'recovery intent should retain the artifact path');
  const evidence = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).get();
  assertEq(evidence?.['count'], 1, 'verification evidence should remain committed');
  const eventLogPath = path.join(basePath, '.gsd', 'event-log.jsonl');
  const eventLog = fs.existsSync(eventLogPath) ? fs.readFileSync(eventLogPath, 'utf8') : '';
  assertTrue(eventLog.length > 0, 'post-mutation event log should still be written');
  assertMatch(eventLog, /"cmd":"complete-task"/, 'event log should record completion');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: escalation errors preserve applied rework resolutions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: disabled escalation preserves pending rework ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  writeProjectPreferences(basePath, 'phases:\n  mid_execution_escalation: false\n');

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });
  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  // Disabled hard-blocker escalation is rejected before completion, so no
  // task or rework lifecycle mutation can be applied.
  const result = await withWorkingDirectory(basePath, () => handleCompleteTask({
    ...makeValidParams(),
    blockerDiscovered: true,
    reworkResolution: [{
      findingId: 'F1',
      status: 'resolved',
      evidence: 'Fixed compile error and reran pnpm run typecheck:extensions.',
    }],
    escalation: {
      question: 'Should execution pause for the hard blocker?',
      options: makeEscalationOptions(),
      recommendation: 'pause',
      recommendationRationale: 'The blocker should not be silently advanced.',
      continueWithDefault: false,
    },
  }, basePath));

  assertTrue('error' in result, 'completion should report disabled hard-blocker escalation');
  assertEq(getTask('M001', 'S01', 'T01')?.status, 'pending', 'task should remain pending');

  const finding = _getAdapter()!.prepare(
    "SELECT status, evidence, decision_ref FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'"
  ).get() as { status: string; evidence: string; decision_ref: string };
  assertEq(finding.status, 'pending', 'rework finding should remain pending');
  assertEq(finding.evidence, '', 'rework finding evidence should not be applied');

  // A retry without the required rework resolution remains blocked.
  const retry = await withWorkingDirectory(basePath, () => handleCompleteTask(makeValidParams(), basePath));
  assertTrue('error' in retry, 'retry should remain blocked by unresolved rework');
  if ('error' in retry) {
    assertMatch(retry.error, /unresolved blocking rework/i, 'retry should report unresolved rework');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: escalation validation remains pre-commit
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: invalid escalation remains pre-commit ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  writeProjectPreferences(basePath, 'phases:\n  mid_execution_escalation: true\n');
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const result = await withWorkingDirectory(basePath, () => handleCompleteTask({
    ...makeValidParams(),
    escalation: {
      question: 'Invalid duplicate options?',
      options: [
        { id: 'same', label: 'First', tradeoffs: 'First path.' },
        { id: 'same', label: 'Second', tradeoffs: 'Second path.' },
      ],
      recommendation: 'same',
      recommendationRationale: 'This payload must be rejected.',
      continueWithDefault: false,
    },
  }, basePath));

  assertTrue('error' in result, 'invalid escalation should be rejected');
  if ('error' in result) {
    assertMatch(result.error, /payload invalid/, 'error should identify pre-commit validation');
  }
  assertEq(getTask('M001', 'S01', 'T01'), null, 'invalid escalation should not create or complete the task');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: soft escalation with mid-execution escalation disabled
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: disabled soft escalation still completes ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  writeProjectPreferences(basePath, 'phases:\n  mid_execution_escalation: false\n');

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = {
    ...makeValidParams(),
    escalation: {
      question: 'Should execution continue with the default?',
      options: makeEscalationOptions(),
      recommendation: 'continue',
      recommendationRationale: 'The default path is safe enough to continue.',
      continueWithDefault: true,
    },
  };

  const result = await withWorkingDirectory(basePath, () => handleCompleteTask(params, basePath));

  assertTrue(!('error' in result), 'soft escalation should still complete when escalation handling is disabled');
  if (!('error' in result)) {
    assertTrue(!result.escalation, 'disabled preference should not return escalation metadata');
  }

  const task = getTask('M001', 'S01', 'T01');
  assertTrue(task !== null, 'task row should exist');
  assertEq(task!.status, 'complete', 'soft escalation should leave task complete');

  const adapter = _getAdapter()!;
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 1, 'verification evidence should remain for soft escalation completion');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler validation errors
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler validation errors ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const params = makeValidParams();

  // Empty taskId
  const r1 = await handleCompleteTask({ ...params, taskId: '' }, '/tmp/fake');
  assertTrue('error' in r1, 'should return error for empty taskId');
  if ('error' in r1) {
    assertMatch(r1.error, /taskId/, 'error should mention taskId');
  }

  // Empty milestoneId
  const r2 = await handleCompleteTask({ ...params, milestoneId: '' }, '/tmp/fake');
  assertTrue('error' in r2, 'should return error for empty milestoneId');
  if ('error' in r2) {
    assertMatch(r2.error, /milestoneId/, 'error should mention milestoneId');
  }

  // Empty sliceId
  const r3 = await handleCompleteTask({ ...params, sliceId: '' }, '/tmp/fake');
  assertTrue('error' in r3, 'should return error for empty sliceId');
  if ('error' in r3) {
    assertMatch(r3.error, /sliceId/, 'error should mention sliceId');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler idempotency
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler idempotency ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  // Seed milestone + slice so state machine guards pass
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = makeValidParams();

  // First call should succeed
  const r1 = await handleCompleteTask(params, basePath);
  assertTrue(!('error' in r1), 'first call should succeed');
  if ('error' in r1) {
    throw new Error(r1.error);
  }

  // Verify complete-task did not duplicate T01. S01-PLAN.md is a projection,
  // so the remaining plan task is not imported implicitly.
  const tasks = getSliceTasks('M001', 'S01');
  assertEq(tasks.length, 1, 'should only have the completed DB task after first call');
  assertEq(tasks.filter(t => t.id === 'T01').length, 1, 'should have exactly one T01 row after first call');

  // If the DB row is complete but the projection was lost, the duplicate call
  // should repair the missing summary from full_summary_md instead of forcing a
  // reopen/re-complete loop.
  fs.unlinkSync(r1.summaryPath);
  assertTrue(!fs.existsSync(r1.summaryPath), 'fixture should remove the task summary before repair');
  const r2 = await handleCompleteTask(params, basePath);
  assertTrue(!('error' in r2), 'second call should repair missing summary for DB-complete task');
  if ('error' in r2) {
    throw new Error(r2.error);
  }
  assertTrue(fs.existsSync(r2.summaryPath), 'missing summary should be restored on disk');
  assertEq(r2.duplicate, true, 'repair should be reported as a duplicate/no-op state mutation');

  // Third call with the summary present — state machine guard rejects (task is already complete)
  const r3 = await handleCompleteTask(params, basePath);
  assertTrue('error' in r3, 'third call should return error (task already complete)');
  if ('error' in r3) {
    assertMatch(r3.error, /already complete/, 'error should mention already complete');
  }

  // Still no duplicate rows from the repair or rejected third call.
  const tasksAfter = getSliceTasks('M001', 'S01');
  assertEq(tasksAfter.length, 1, 'should still only have T01 after duplicate repair and rejected third call');
  assertEq(tasksAfter.filter(t => t.id === 'T01').length, 1, 'should still have exactly one T01 row');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler with missing plan file (graceful)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler with missing plan file ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Create a temp dir WITHOUT a plan file
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-plan-'));
  const tasksDir = path.join(basePath, '.gsd', 'phases', '01-test');
  fs.mkdirSync(tasksDir, { recursive: true });

  // Seed milestone + slice so state machine guards pass
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);

  // Should succeed and regenerate the missing plan projection from DB.
  assertTrue(!('error' in result), 'handler should succeed without plan file');
  if (!('error' in result)) {
    assertTrue(fs.existsSync(result.summaryPath), 'summary should be written even without plan file');
    const planPath = path.join(basePath, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    assertTrue(fs.existsSync(planPath), 'missing plan projection should be regenerated from DB');
    assertTrue(fs.readFileSync(planPath, 'utf-8').includes('[x] **T01**'), 'regenerated plan should reflect DB task completion');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: minimal params — no optional fields (#2771 regression)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: minimal params (no keyFiles, keyDecisions, verificationEvidence, blockerDiscovered) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  // Minimal params — only required fields, all optional enrichment fields omitted
  const minimalParams = {
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    oneLiner: 'Basic task',
    narrative: 'Did the work.',
    verification: 'Looks good.',
    // keyFiles, keyDecisions, verificationEvidence, blockerDiscovered intentionally omitted
  };

  const result = await handleCompleteTask(minimalParams as any, basePath);

  assertTrue(!('error' in result), 'handler should not crash with minimal params (no optional fields)');
  if (!('error' in result)) {
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should be written with minimal params');
    const summaryContent = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summaryContent, /blocker_discovered:\s*false/, 'blocker_discovered should default to false');
    assertMatch(summaryContent, /key_files:\n  - \(none\)/, 'empty key_files should use (none) sentinel for parseSummary compatibility');
    assertMatch(summaryContent, /key_decisions:\n  - \(none\)/, 'empty key_decisions should use (none) sentinel for parseSummary compatibility');
    assertTrue(summaryContent.includes('  - (none)'), 'empty frontmatter lists use (none) sentinel to preserve parseSummary key_files.length > 0 invariant');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: remaining required-field validation (oneLiner/narrative/verification)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: remaining required-field validation ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const params = makeValidParams();

  const rOne = await handleCompleteTask({ ...params, oneLiner: '' }, '/tmp/fake');
  assertTrue('error' in rOne, 'empty oneLiner should error');
  if ('error' in rOne) assertMatch(rOne.error, /oneLiner/, 'error should mention oneLiner');

  const rNarr = await handleCompleteTask({ ...params, narrative: '   ' }, '/tmp/fake');
  assertTrue('error' in rNarr, 'whitespace-only narrative should error');
  if ('error' in rNarr) assertMatch(rNarr.error, /narrative/, 'error should mention narrative');

  const rVer = await handleCompleteTask({ ...params, verification: '' }, '/tmp/fake');
  assertTrue('error' in rVer, 'empty verification should error');
  if ('error' in rVer) assertMatch(rVer.error, /verification/, 'error should mention verification');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: cannot complete a task in a CLOSED milestone
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: rejects completion in a closed milestone ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  // Close the milestone after seeding.
  updateMilestoneStatus('M001', 'complete', new Date().toISOString());

  const result = await handleCompleteTask(makeValidParams(), basePath);
  assertTrue('error' in result, 'should reject task completion in a closed milestone');
  if ('error' in result) assertMatch(result.error, /closed milestone/i, 'error should mention closed milestone');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: cannot complete a task in a CLOSED slice
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: rejects completion in a closed slice ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  updateSliceStatus('M001', 'S01', 'complete', new Date().toISOString());

  const result = await handleCompleteTask(makeValidParams(), basePath);
  assertTrue('error' in result, 'should reject task completion in a closed slice');
  if ('error' in result) assertMatch(result.error, /closed slice/i, 'error should mention closed slice');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: closes execute-task gates Q5/Q6/Q7 (pass when populated, omitted when empty)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: closes Q5/Q6/Q7 gates (pass vs omitted) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  // Seed the three task-scoped gates as pending for T01.
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q5', scope: 'task', taskId: 'T01' });
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q6', scope: 'task', taskId: 'T01' });
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q7', scope: 'task', taskId: 'T01' });

  // Populate Q5 (failureModes) and Q7 (negativeTests); leave Q6 (loadProfile) empty.
  const params = {
    ...makeValidParams(),
    failureModes: 'Network partition mid-write leaves a half-flushed record.',
    negativeTests: 'Reject malformed payloads; verify rollback on constraint violation.',
    // loadProfile intentionally omitted → Q6 should be recorded omitted
  };

  const result = await handleCompleteTask(params as any, basePath);
  assertTrue(!('error' in result), 'gate-closing completion should succeed');

  const gates = getGateResults('M001', 'S01', 'task');
  const byId = new Map(gates.map((g) => [g.gate_id, g]));
  assertEq(byId.size, 3, 'all three task gates should be present');
  assertEq(byId.get('Q5')?.status, 'complete', 'Q5 should be closed');
  assertEq(byId.get('Q5')?.verdict, 'pass', 'Q5 populated → pass');
  assertEq(byId.get('Q7')?.verdict, 'pass', 'Q7 populated → pass');
  assertEq(byId.get('Q6')?.verdict, 'omitted', 'Q6 empty → omitted');

  // No task-scoped gates remain pending for the loop to stall on.
  const stillPending = getGateResults('M001', 'S01', 'task').filter((g) => g.status === 'pending');
  assertEq(stillPending.length, 0, 'no task gates should remain pending after completion');

  cleanupDir(basePath);
  cleanup(dbPath);
}


// ═══════════════════════════════════════════════════════════════════════════
// complete-task: unresolved blocking rework findings reject completion
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: rejects unresolved blocking rework findings ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });

  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  const result = await handleCompleteTask(makeValidParams(), basePath);
  assertTrue('error' in result, 'completion should reject unresolved blocking rework findings');
  if ('error' in result) {
    assertMatch(result.error, /unresolved blocking rework finding/i, 'error should explain unresolved rework');
    assertMatch(result.error, /F1/, 'error should name the unresolved finding id');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}


console.log('\n=== complete-task: accepts resolved blocking rework evidence ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });
  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  const result = await handleCompleteTask({
    ...makeValidParams(),
    reworkResolution: [{
      findingId: 'F1',
      status: 'resolved',
      evidence: 'Fixed compile error and reran pnpm run typecheck:extensions.',
    }],
  }, basePath);

  assertTrue(!('error' in result), 'completion should accept resolved blocking rework evidence');
  assertEq(getTask('M001', 'S01', 'T01')?.status, 'complete', 'task should complete after resolving rework');
  const finding = _getAdapter()!.prepare("SELECT status, evidence FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'").get() as { status: string; evidence: string };
  assertEq(finding.status, 'resolved', 'finding status should be updated');
  assertMatch(finding.evidence, /Fixed compile error/, 'resolution evidence should be persisted');

  cleanupDir(basePath);
  cleanup(dbPath);
}

console.log('\n=== complete-task: accepts deferred blocking rework with decision reference ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });
  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  const result = await handleCompleteTask({
    ...makeValidParams(),
    reworkResolution: [{
      findingId: 'F1',
      status: 'deferred-with-override',
      evidence: 'Maintainer accepted temporary deferral.',
      decisionRef: 'DEC-2026-07-07-rework-deferral',
    }],
  }, basePath);

  assertTrue(!('error' in result), 'completion should accept deferred blocking rework with decision reference');
  const finding = _getAdapter()!.prepare("SELECT status, decision_ref FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'").get() as { status: string; decision_ref: string };
  assertEq(finding.status, 'deferred-with-override', 'finding status should record the override');
  assertEq(finding.decision_ref, 'DEC-2026-07-07-rework-deferral', 'decision reference should be persisted');

  cleanupDir(basePath);
  cleanup(dbPath);
}

console.log('\n=== complete-task: invalid duplicate rework resolution cannot overwrite a valid one ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });
  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  // The guard admits F1 because a satisfying entry exists, but a later
  // non-satisfying duplicate for the same finding must NOT overwrite the valid
  // resolution and leave F1 resolved with no evidence.
  const result = await handleCompleteTask({
    ...makeValidParams(),
    reworkResolution: [
      { findingId: 'F1', status: 'resolved', evidence: 'Fixed compile error and reran pnpm run typecheck:extensions.' },
      { findingId: 'F1', status: 'resolved', evidence: '' },
    ],
  }, basePath);

  assertTrue(!('error' in result), 'completion should succeed on the valid resolution');
  const finding = _getAdapter()!.prepare(
    "SELECT status, evidence FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'"
  ).get() as { status: string; evidence: string };
  assertEq(finding.status, 'resolved', 'finding should remain resolved');
  assertMatch(finding.evidence, /Fixed compile error/, 'valid evidence must survive the invalid duplicate');

  cleanupDir(basePath);
  cleanup(dbPath);
}

console.log('\n=== complete-task: invalid deferred duplicate cannot strip decisionRef ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Test task', status: 'pending' });
  saveReworkBrief({
    briefId: 'RB-001',
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    findings: [{
      findingId: 'F1',
      severity: 'blocking',
      description: 'Compile regression',
      requiredFix: 'Fix compile error',
      verificationCommands: ['pnpm run typecheck:extensions'],
    }],
  });

  // A deferred-with-override duplicate that omits decisionRef is non-satisfying
  // and must not overwrite the valid deferral.
  const result = await handleCompleteTask({
    ...makeValidParams(),
    reworkResolution: [
      { findingId: 'F1', status: 'deferred-with-override', evidence: 'Maintainer accepted temporary deferral.', decisionRef: 'DEC-2026-07-07-rework-deferral' },
      { findingId: 'F1', status: 'deferred-with-override', evidence: 'Maintainer accepted temporary deferral.' },
    ],
  }, basePath);

  assertTrue(!('error' in result), 'completion should succeed on the valid deferral');
  const finding = _getAdapter()!.prepare(
    "SELECT status, decision_ref FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'"
  ).get() as { status: string; decision_ref: string };
  assertEq(finding.status, 'deferred-with-override', 'finding should remain deferred-with-override');
  assertEq(finding.decision_ref, 'DEC-2026-07-07-rework-deferral', 'valid decisionRef must survive the invalid duplicate');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: legacy completion preserves the planned task title (#2216)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: legacy completion preserves the planned task title (#2216) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Record the corrected acceptance criterion', status: 'pending' });

  const blockerLiner = 'Stopped T01 at its human-in-the-loop precondition';
  const result = await withWorkingDirectory(basePath, () => handleCompleteTask({
    ...makeValidParams(),
    oneLiner: blockerLiner,
    blockerDiscovered: true,
  }, basePath));

  assertTrue(!('error' in result), 'blocker completion should succeed on the legacy path');
  const task = getTask('M001', 'S01', 'T01');
  assertEq(task?.status, 'complete', 'blocker completion should commit');
  assertEq(task?.title, 'Record the corrected acceptance criterion', 'planned title must not be overwritten by the blocker one-liner (#2216)');
  assertEq(task?.one_liner, blockerLiner, 'one_liner should hold the blocker prose');
  assertEq(task?.blocker_discovered, true, 'blocker_discovered should be recorded');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: legacy completion of an unplanned task keeps the one-liner as title
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: legacy completion of an unplanned task keeps the one-liner as title ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath } = createTempProject();
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const result = await withWorkingDirectory(basePath, () => handleCompleteTask(makeValidParams(), basePath));

  assertTrue(!('error' in result), 'completion of an unplanned task should still succeed');
  const task = getTask('M001', 'S01', 'T01');
  assertEq(task?.status, 'complete', 'unplanned task completion should insert a new row');
  assertEq(task?.title, 'Added test functionality', 'a genuinely new row should take the one-liner as its title');
  assertEq(task?.one_liner, 'Added test functionality', 'one_liner should match the one-liner');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════

report();
