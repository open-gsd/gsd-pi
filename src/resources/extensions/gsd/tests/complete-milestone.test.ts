// Project/App: gsd-pi
// File Purpose: Handler tests for complete-milestone (gsd_complete_milestone).
//
// Covers the milestone close-out "turn" end-to-end: required-field validation,
// the explicit verificationPassed gate, the milestone-validation verdict gate
// (defense-in-depth), incomplete-slice and incomplete-task guards, idempotent
// re-completion (alreadyComplete), and the #4598 "do not overwrite an existing
// SUMMARY.md" guard. complete-milestone previously had NO dedicated handler
// test — this file is that coverage.

import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  _getAdapter,
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertAssessment,
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

/** Count complete-milestone entries in the JSONL event log under basePath. */
function countCompleteMilestoneEvents(basePath: string): number {
  const logPath = path.join(basePath, '.gsd', 'event-log.jsonl');
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { cmd?: string };
      } catch {
        return {};
      }
    })
    .filter((ev) => ev.cmd === 'complete-milestone').length;
}

/** Temp project with the M001 milestone directory present for projections. */
function createTempProject(): { basePath: string; milestoneDir: string } {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-milestone-handler-'));
  const milestoneDir = path.join(basePath, '.gsd', 'milestones', 'M001');
  fs.mkdirSync(path.join(milestoneDir, 'slices', 'S01', 'tasks'), { recursive: true });
  return { basePath, milestoneDir };
}

/**
 * Seed a milestone whose slices+tasks are all complete and (optionally) record
 * a milestone-validation assessment with the given verdict. This is the state
 * the loop is in when it reaches completing-milestone.
 */
function seedCompletedMilestone(opts: {
  basePath: string;
  milestoneStatus?: string;
  validationVerdict?: string | null;
  taskStatus?: string; // override to simulate a lingering incomplete task
  sliceStatus?: string; // override to simulate an incomplete slice
}): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: opts.milestoneStatus ?? 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One' });
  insertTask({
    id: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    status: opts.taskStatus ?? 'complete',
    title: 'Task One',
  });
  // Mark the slice complete (insertSlice defaults to pending). Raw SQL: the
  // fixture milestone is unadopted, so the generic status writer refuses it.
  _getAdapter()!.prepare(
    "UPDATE slices SET status = :status, completed_at = :completed_at WHERE milestone_id = 'M001' AND id = 'S01'",
  ).run({ ":status": opts.sliceStatus ?? 'complete', ":completed_at": new Date().toISOString() });

  if (opts.validationVerdict !== null && opts.validationVerdict !== undefined) {
    insertAssessment({
      path: path.join(opts.basePath, '.gsd', 'milestones', 'M001', 'M001-VALIDATION.md'),
      milestoneId: 'M001',
      sliceId: null,
      taskId: null,
      status: opts.validationVerdict,
      scope: 'milestone-validation',
      fullContent: `verdict: ${opts.validationVerdict}\n`,
    });
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: unadopted closeout refusal
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: handler refuses an unadopted closeout ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  const result = await handleCompleteMilestone(makeValidParams(), basePath);

  // The generic status writer refuses rows without a canonical lifecycle row,
  // so even a fully-validated unadopted closeout is refused: adopt the project
  // with /gsd db adopt, then complete.
  assertTrue('error' in result, 'an unadopted closeout must be refused');
  if ('error' in result) {
    assertMatch(result.error, /Milestone M001 has no canonical lifecycle row/, 'error should name the row');
    assertMatch(result.error, /\/gsd db adopt/, 'error should point at adoption');
  }

  // Nothing was written: the milestone stays active, no SUMMARY, no event.
  assertEq(getMilestone('M001')!.status, 'active', 'refused closeout must not flip the status');
  assertEq(countCompleteMilestoneEvents(basePath), 0, 'refused closeout must not append an event');
  const summaryPath = path.join(basePath, '.gsd', 'milestones', 'M001', 'M001-SUMMARY.md');
  assertTrue(!fs.existsSync(summaryPath), 'refused closeout must not render a SUMMARY');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: required-field validation
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: required-field validation ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const params = makeValidParams();

  const r1 = await handleCompleteMilestone({ ...params, milestoneId: '' }, '/tmp/fake');
  assertTrue('error' in r1, 'empty milestoneId should error');
  if ('error' in r1) assertMatch(r1.error, /milestoneId/, 'error should mention milestoneId');

  const r2 = await handleCompleteMilestone({ ...params, title: '' }, '/tmp/fake');
  assertTrue('error' in r2, 'empty title should error');
  if ('error' in r2) assertMatch(r2.error, /title/, 'error should mention title');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: verificationPassed must be explicitly true
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: verificationPassed gate ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  const rFalse = await handleCompleteMilestone(
    { ...makeValidParams(), verificationPassed: false },
    basePath,
  );
  assertTrue('error' in rFalse, 'verificationPassed=false should block completion');
  if ('error' in rFalse) assertMatch(rFalse.error, /verification did not pass/i, 'error should explain verification gate');

  // Milestone must remain not-complete after the rejected call.
  assertEq(getMilestone('M001')!.status, 'active', 'milestone should stay active when verification did not pass');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: milestone not found
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: milestone not found ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  // No milestone seeded.

  const result = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in result, 'unknown milestone should error');
  if ('error' in result) assertMatch(result.error, /milestone not found/i, 'error should say milestone not found');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: validation verdict gate (defense-in-depth)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: validation verdict must be pass ===');
{
  // (a) No validation assessment at all → blocked.
  {
    const dbPath = tempDbPath();
    openDatabase(dbPath);
    const { basePath } = createTempProject();
    seedCompletedMilestone({ basePath, validationVerdict: null });

    const result = await handleCompleteMilestone(makeValidParams(), basePath);
    assertTrue('error' in result, 'absent validation should block completion');
    if ('error' in result) {
      assertMatch(result.error, /Refusing to complete/i, 'error should refuse completion');
      assertMatch(result.error, /absent/i, 'error should report verdict as absent');
    }
    assertEq(getMilestone('M001')!.status, 'active', 'milestone should remain active when validation is absent');

    cleanupDir(basePath);
    cleanup(dbPath);
  }

  // (b) Failing validation verdict → blocked.
  {
    const dbPath = tempDbPath();
    openDatabase(dbPath);
    const { basePath } = createTempProject();
    seedCompletedMilestone({ basePath, validationVerdict: 'fail' });

    const result = await handleCompleteMilestone(makeValidParams(), basePath);
    assertTrue('error' in result, 'fail verdict should block completion');
    if ('error' in result) assertMatch(result.error, /verdict is "fail"/i, 'error should report the fail verdict');

    cleanupDir(basePath);
    cleanup(dbPath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: incomplete slices block closeout
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: incomplete slices block closeout ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  // Validation passes, but the slice is still pending.
  seedCompletedMilestone({ basePath, validationVerdict: 'pass', sliceStatus: 'pending' });

  const result = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in result, 'pending slice should block milestone completion');
  if ('error' in result) {
    assertMatch(result.error, /incomplete slices/i, 'error should mention incomplete slices');
    assertMatch(result.error, /S01/, 'error should name the incomplete slice');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: deferred slices are inactive for closeout
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: deferred slices do not change the unadopted refusal ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Deferred Slice', status: 'deferred' });
  insertTask({
    id: 'T02',
    sliceId: 'S02',
    milestoneId: 'M001',
    status: 'pending',
    title: 'Deferred Slice Task',
  });

  const result = await handleCompleteMilestone(makeValidParams(), basePath);

  // Deferred slices still pass the closeout guards, but the unadopted write
  // itself is refused.
  assertTrue('error' in result, 'an unadopted closeout must be refused even with deferred slices');
  if ('error' in result) assertMatch(result.error, /no canonical lifecycle row/, 'error should be the adoption refusal');
  assertEq(getMilestone('M001')!.status, 'active', 'milestone should stay active');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: deep task check (slice closed, task not)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: deep task check blocks closeout ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  // Slice marked complete but one task lingers pending — the deep check must catch it.
  seedCompletedMilestone({ basePath, validationVerdict: 'pass', sliceStatus: 'complete', taskStatus: 'pending' });

  const result = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in result, 'lingering pending task should block milestone completion');
  if ('error' in result) {
    assertMatch(result.error, /incomplete tasks/i, 'error should mention incomplete tasks');
    assertMatch(result.error, /T01/, 'error should name the incomplete task');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: idempotent re-completion (alreadyComplete)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: refused completion is retryable ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  const r1 = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in r1, 'first completion of an unadopted milestone is refused');

  const r2 = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in r2, 'the retry is refused identically');
  if ('error' in r2) assertMatch(r2.error, /no canonical lifecycle row/, 'the refusal is stable');

  // No completion event was appended by either attempt.
  assertEq(countCompleteMilestoneEvents(basePath), 0, 'refusals must not append completion events');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: refusal leaves an existing SUMMARY.md untouched (#4598)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: refusal leaves an existing SUMMARY.md untouched (#4598) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath, milestoneDir } = createTempProject();
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  // Pre-write a richer SUMMARY.md as if a prior completion run produced it.
  const summaryPath = path.join(milestoneDir, 'M001-SUMMARY.md');
  const sentinel = '# M001: Pre-existing richer summary\n\nDO NOT OVERWRITE ME\n';
  fs.writeFileSync(summaryPath, sentinel, 'utf-8');

  const result = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in result, 'an unadopted closeout must be refused');
  if ('error' in result) {
    assertEq(
      fs.readFileSync(summaryPath, 'utf-8'),
      sentinel,
      'refusal must not touch the existing SUMMARY.md',
    );
    assertEq(getMilestone('M001')!.status, 'active', 'milestone must stay active');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: flat-phase compatibility SUMMARY.md is not hidden
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: flat-phase legacy-named SUMMARY.md preserved (#4598) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-flat-complete-milestone-'));
  const phaseDir = path.join(basePath, '.gsd', 'phases', '01-test-milestone');
  fs.mkdirSync(path.join(phaseDir, 'slices', 'S01', 'tasks'), { recursive: true });
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  // Flat-phase projects may still contain legacy-named compatibility files.
  // The no-overwrite guard must preserve those richer summaries instead of
  // generating a canonical sibling that later readers would prefer.
  const summaryPath = path.join(phaseDir, 'M001-SUMMARY.md');
  const canonicalSummaryPath = path.join(phaseDir, '01-SUMMARY.md');
  const sentinel = '# M001: Pre-existing flat-phase richer summary\n\nDO NOT OVERWRITE ME\n';
  fs.writeFileSync(summaryPath, sentinel, 'utf-8');

  const result = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue('error' in result, 'an unadopted closeout must be refused even with a compatibility SUMMARY');
  if ('error' in result) {
    assertEq(
      fs.readFileSync(summaryPath, 'utf-8'),
      sentinel,
      'refusal must preserve the flat-phase compatibility SUMMARY.md',
    );
    assertTrue(
      !fs.existsSync(canonicalSummaryPath),
      'refusal must not create a canonical sibling summary',
    );
    assertEq(getMilestone('M001')!.status, 'active', 'milestone must stay active');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════

report();
