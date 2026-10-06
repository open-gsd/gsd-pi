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
  getTask,
  getSlice,
  getMilestone,
  getSliceTasks,
  insertVerificationEvidence,
  insertGateRow,
  getGateResults,
  saveReworkBrief,
  SCHEMA_VERSION,
} from '../gsd-db.ts';
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

  // Allowed closed-to-closed status stamp. Raw SQL: the fixture milestone is
  // unadopted, so the generic status writer refuses it.
  _getAdapter()!.prepare(
    "UPDATE tasks SET status = 'skipped', completed_at = :completed_at WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'",
  ).run({ ":completed_at": new Date().toISOString() });
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


