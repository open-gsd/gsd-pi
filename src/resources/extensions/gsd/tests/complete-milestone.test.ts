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
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertAssessment,
  updateSliceStatus,
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
  // Mark the slice complete (insertSlice defaults to pending).
  updateSliceStatus('M001', 'S01', opts.sliceStatus ?? 'complete', new Date().toISOString());

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
// complete-milestone: handler happy path
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: handler happy path ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();

  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  const result = await handleCompleteMilestone(makeValidParams(), basePath);

  assertTrue(!('error' in result), 'handler should succeed on a fully-complete, validated milestone');
  if (!('error' in result)) {
    assertEq(result.milestoneId, 'M001', 'result milestoneId');
    assertTrue(result.summaryPath.endsWith('M001-SUMMARY.md'), 'summaryPath should end with M001-SUMMARY.md');
    assertTrue(result.alreadyComplete !== true, 'first completion should not be flagged alreadyComplete');

    // (a) DB status flipped to complete with completed_at set.
    const m = getMilestone('M001');
    assertTrue(m !== null, 'milestone should exist after completion');
    assertEq(m!.status, 'complete', 'milestone status should be complete in DB');
    assertTrue(m!.completed_at !== null && m!.completed_at !== '', 'completed_at should be set');

    // (b) SUMMARY.md rendered with frontmatter + sections.
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should exist on disk');
    const summary = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summary, /^---\n/, 'summary should start with YAML frontmatter');
    assertMatch(summary, /id: M001/, 'summary frontmatter should contain id: M001');
    assertMatch(summary, /status: complete/, 'summary frontmatter should mark status complete');
    assertMatch(summary, /# M001: Test Milestone/, 'summary should have H1 with stripped title');
    assertMatch(summary, /## Success Criteria Results/, 'summary should have Success Criteria section');
    assertMatch(summary, /All success criteria met\./, 'summary should inline successCriteriaResults');
    assertMatch(summary, /## Definition of Done Results/, 'summary should have DoD section');

    // (c) A complete-milestone event was appended exactly once.
    assertEq(countCompleteMilestoneEvents(basePath), 1, 'exactly one complete-milestone event should be recorded');
  }

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

console.log('\n=== complete-milestone: deferred slices do not block closeout ===');
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

  assertTrue(!('error' in result), 'deferred slice should not block milestone completion');
  assertEq(getMilestone('M001')!.status, 'complete', 'milestone should complete with deferred inactive slice');

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

console.log('\n=== complete-milestone: idempotent re-completion ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath } = createTempProject();
  seedCompletedMilestone({ basePath, validationVerdict: 'pass' });

  const r1 = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue(!('error' in r1), 'first completion should succeed');

  const r2 = await handleCompleteMilestone(makeValidParams(), basePath);
  assertTrue(!('error' in r2), 'second completion should be a non-error no-op');
  if (!('error' in r2)) {
    assertEq(r2.alreadyComplete, true, 'second completion should be flagged alreadyComplete');
  }

  // No duplicate completion event was appended on the retry.
  assertEq(countCompleteMilestoneEvents(basePath), 1, 'retry must not append a duplicate complete-milestone event');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-milestone: existing SUMMARY.md is not overwritten (#4598)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-milestone: existing SUMMARY.md preserved (#4598) ===');
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
  assertTrue(!('error' in result), 'completion should still succeed when SUMMARY.md already exists');
  if (!('error' in result)) {
    assertEq(
      fs.readFileSync(summaryPath, 'utf-8'),
      sentinel,
      'existing SUMMARY.md must be preserved, not overwritten by the mechanical renderer',
    );
    // DB completion still happened.
    assertEq(getMilestone('M001')!.status, 'complete', 'milestone should still be marked complete in DB');
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
  assertTrue(!('error' in result), 'completion should still succeed when flat-phase compatibility SUMMARY.md exists');
  if (!('error' in result)) {
    assertEq(
      result.summaryPath,
      fs.realpathSync(summaryPath),
      'completion should report the preserved existing SUMMARY path',
    );
    assertEq(
      fs.readFileSync(summaryPath, 'utf-8'),
      sentinel,
      'flat-phase compatibility SUMMARY.md must be preserved, not hidden by a canonical rewrite',
    );
    assertTrue(
      !fs.existsSync(canonicalSummaryPath),
      'completion must not create a canonical sibling over an existing compatibility summary',
    );
    assertEq(getMilestone('M001')!.status, 'complete', 'milestone should still be marked complete in DB');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════

report();
