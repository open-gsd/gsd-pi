// Project/App: gsd-pi
// File Purpose: Handler tests for complete-milestone (gsd_complete_milestone).
//
// Completion goes through one canonical Domain Operation: it requires the
// caller's invocation identity, and it refuses a hierarchy row without a
// canonical lifecycle row instead of writing a legacy status.

import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  _getAdapter,
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestone,
} from '../gsd-db.ts';
import {
  handleCompleteMilestone,
  type CompleteMilestoneParams,
} from '../tools/complete-milestone.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-complete-milestone-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
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

/** Temp project with the M001 milestone directory present for projections. */
function createTempProject(): { basePath: string; milestoneDir: string } {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-milestone-handler-'));
  const milestoneDir = path.join(basePath, '.gsd', 'milestones', 'M001');
  fs.mkdirSync(path.join(milestoneDir, 'slices', 'S01', 'tasks'), { recursive: true });
  // The closeout captures the tested source revision from the repository.
  fs.writeFileSync(path.join(basePath, '.gitignore'), '.gsd/\n');
  fs.writeFileSync(path.join(basePath, 'source.ts'), 'export const source = 1;\n');
  execFileSync('git', ['init'], { cwd: basePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: basePath });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: basePath });
  execFileSync('git', ['add', '.gitignore', 'source.ts'], { cwd: basePath });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: basePath, stdio: 'ignore' });
  return { basePath, milestoneDir };
}

/**
 * Seed the state the loop is in when it reaches completing-milestone: every
 * slice and task closed. Raw SQL for the slice status: the fixture milestone
 * is unadopted, so the generic status writer refuses it.
 */
function seedCompletedMilestone(basePath: string): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One' });
  insertTask({
    id: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    status: 'complete',
    title: 'Task One',
  });
  _getAdapter()!.prepare(
    "UPDATE slices SET status = 'complete', completed_at = :completed_at WHERE milestone_id = 'M001' AND id = 'S01'",
  ).run({ ":completed_at": new Date().toISOString() });
}

function makeValidParams(): CompleteMilestoneParams {
  return {
    milestoneId: 'M001',
    title: 'M001: Test Milestone',
    oneLiner: 'Delivered the test milestone end to end.',
    narrative: 'All slices landed, validation passed, and the suite is green.',
    verificationPassed: true,
    successCriteriaResults: 'All success criteria met.',
    definitionOfDoneResults: 'DoD satisfied.',
    requirementOutcomes: 'R001 validated.',
    keyDecisions: ['D001'],
    keyFiles: ['src/foo.ts'],
    lessonsLearned: ['Keep the loop idempotent.'],
    followUps: 'None.',
    deviations: 'None.',
  };
}

const invocation = {
  idempotencyKey: 'test/complete-milestone/handler',
  sourceTransport: 'internal' as const,
  actorType: 'agent' as const,
};

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: required-field validation
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: required-field validation ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const params = makeValidParams();

  const r1 = await handleCompleteMilestone({ ...params, milestoneId: '' }, '/tmp/fake', invocation);
  assertTrue('error' in r1, 'empty milestoneId should error');
  if ('error' in r1) assertMatch(r1.error, /milestoneId/, 'error should mention milestoneId');

  const r2 = await handleCompleteMilestone({ ...params, title: '' }, '/tmp/fake', invocation);
  assertTrue('error' in r2, 'empty title should error');
  if ('error' in r2) assertMatch(r2.error, /title/, 'error should mention title');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: completion requires canonical invocation identity
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: invocation identity is required ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone(basePath);

  const result = await handleCompleteMilestone(makeValidParams(), basePath);

  assertTrue('error' in result, 'completion without invocation identity must be refused');
  if ('error' in result) {
    assertMatch(result.error, /canonical invocation identity/, 'error should name the missing identity');
  }

  // Nothing was written: the milestone stays active, no SUMMARY.
  assertEq(getMilestone('M001')!.status, 'active', 'refused closeout must not flip the status');
  const summaryPath = path.join(basePath, '.gsd', 'milestones', 'M001', 'M001-SUMMARY.md');
  assertTrue(!fs.existsSync(summaryPath), 'refused closeout must not render a SUMMARY');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: a row without a lifecycle row is refused loudly
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: unadopted closeout is refused loudly ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone(basePath);

  const result = await handleCompleteMilestone(makeValidParams(), basePath, invocation);

  assertTrue('error' in result, 'an unadopted closeout must be refused');
  if ('error' in result) {
    assertMatch(result.error, /Milestone M001/, 'error should name the row');
    // The canonical Domain Operation refuses on its first unsatisfied guard:
    // without a lifecycle row there is no current validation receipt, so the
    // readiness gate (or, with one, the lifecycle authority check) stops it.
    assertMatch(
      result.error,
      /canonical validation is not current|missing canonical lifecycle authority/,
      'error should name the canonical closeout guard',
    );
  }

  // Nothing was written: the milestone stays active, no SUMMARY.
  assertEq(getMilestone('M001')!.status, 'active', 'refused closeout must not flip the status');
  const summaryPath = path.join(basePath, '.gsd', 'milestones', 'M001', 'M001-SUMMARY.md');
  assertTrue(!fs.existsSync(summaryPath), 'refused closeout must not render a SUMMARY');

  // The retry is refused identically.
  const retry = await handleCompleteMilestone(makeValidParams(), basePath, invocation);
  assertTrue('error' in retry, 'the retry is refused identically');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════

report();
