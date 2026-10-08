// GSD — reopen-slice handler tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getSlice,
  getSliceRunUatAssessment,
  getSliceTasks,
  getTaskVerificationEvidence,
  insertAssessment,
  insertVerificationEvidence,
  upsertQualityGate,
  _getAdapter,
} from '../gsd-db.ts';
import { readExecRun, recordExecRun } from '../db/writers/exec-runs.ts';
import { incrementUatRetryAttempts, getUatRetryAttempts } from '../db/writers/runtime-control.ts';
import { relSliceFile, targetSliceFile } from '../paths.ts';
import { internalExecutionInvocation } from '../execution-invocation.ts';
import { readUnitBudget, spendUnitBudget } from '../db/unit-dispatch-budgets.ts';
import { claimTestDispatch } from './helpers/unit-dispatch.ts';
import { seedLifecycles, type Lifecycle } from './helpers/authority-cutover.ts';
import {
  handleReopenSlice as handleReopenSliceWithInvocation,
  type ReopenSliceParams,
} from '../tools/reopen-slice.ts';
import { handleCompleteSlice } from '../tools/complete-slice.ts';
import { flushWorkflowProjections } from '../projection-flush.ts';
import { detectArtifactDbDrift } from '../state-reconciliation/drift/artifact-db.ts';
import { clearPathCache } from '../paths.ts';
import type { CompleteSliceParams, GSDState } from '../types.ts';
import { seedSliceCompletionAuthority } from './slice-completion-fixture.ts';

let invocationSequence = 0;

function handleReopenSlice(params: ReopenSliceParams, basePath: string) {
  invocationSequence += 1;
  return handleReopenSliceWithInvocation(
    params,
    basePath,
    internalExecutionInvocation(`test/reopen-slice/${invocationSequence}`),
  );
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reopen-slice-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedCompleteSlice(): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'complete' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: 'complete' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Task Two', status: 'complete' });
}

/**
 * Adopt the fixture rows so the reopen's shadow repair finds no drift: each
 * canonical row mirrors the row's legacy status.
 */
function adoptFixture(key: string): void {
  const rows: Lifecycle[] = [
    ..._getAdapter()!.prepare("SELECT id, status FROM milestones WHERE id = 'M001'").all()
      .map((row: Record<string, unknown>) => ({
        itemKind: 'milestone' as const,
        milestoneId: String(row.id),
        lifecycleStatus: legacyToCanonical(String(row.status)),
      })),
    ..._getAdapter()!.prepare("SELECT id, status FROM slices WHERE milestone_id = 'M001' ORDER BY id").all()
      .map((row: Record<string, unknown>) => ({
        itemKind: 'slice' as const,
        milestoneId: 'M001',
        sliceId: String(row.id),
        lifecycleStatus: legacyToCanonical(String(row.status)),
      })),
    ..._getAdapter()!.prepare("SELECT slice_id, id, status FROM tasks WHERE milestone_id = 'M001' ORDER BY slice_id, id").all()
      .map((row: Record<string, unknown>) => ({
        itemKind: 'task' as const,
        milestoneId: 'M001',
        sliceId: String(row.slice_id),
        taskId: String(row.id),
        lifecycleStatus: legacyToCanonical(String(row.status)),
      })),
  ];
  seedLifecycles(`reopen-slice/${key}`, rows);
}

function legacyToCanonical(status: string): Lifecycle['lifecycleStatus'] {
  switch (status) {
    case 'pending': return 'pending';
    case 'active':
    case 'in_progress': return 'in_progress';
    case 'planned':
    case 'ready':
    case 'queued': return 'ready';
    case 'complete':
    case 'completed':
    case 'done':
    case 'closed': return 'completed';
    case 'skipped':
    case 'cancelled': return 'cancelled';
    case 'deferred':
    case 'parked': return 'paused';
    default: return 'ready';
  }
}

// ─── Success path ────────────────────────────────────────────────────────

test('handleReopenSlice: releases the exhausted mark of the slice units, and of no other slice', async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  seedCompleteSlice();
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Other Slice', status: 'pending' });
  adoptFixture('exhausted');
  const exhausted = (unitId: string) => ({ unitType: 'complete-slice', unitId, kind: 'exhausted' }) as const;
  for (const sliceId of ['S01', 'S02']) {
    claimTestDispatch(base, {
      milestoneId: 'M001',
      sliceId,
      unitType: 'complete-slice',
      unitId: `M001/${sliceId}`,
    });
    spendUnitBudget(new Map(), exhausted(`M001/${sliceId}`));
  }

  const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
  assert.equal(readUnitBudget(new Map(), exhausted('M001/S01')), 0, 'the reopened slice can be dispatched again');
  assert.equal(readUnitBudget(new Map(), exhausted('M001/S02')), 1, 'a slice that was not reopened stays exhausted');
});

test('handleReopenSlice: resets a complete slice to in_progress and all tasks to pending', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteSlice();
    adoptFixture('reset');

    const result = await handleReopenSlice({
      milestoneId: 'M001',
      sliceId: 'S01',
      reason: 'need to redo after requirements change',
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.equal(result.sliceId, 'S01');
    assert.equal(result.tasksReset, 2, 'should report 2 tasks reset');

    const slice = getSlice('M001', 'S01');
    assert.ok(slice, 'slice should still exist');
    assert.equal(slice!.status, 'in_progress', 'slice status should be in_progress');

    const tasks = getSliceTasks('M001', 'S01');
    assert.equal(tasks.length, 2, 'both tasks should still exist');
    assert.ok(tasks.every(t => t.status === 'pending'), 'all tasks should be pending');
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: the old UAT verdict and the old claimed evidence do not count after reopen', async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  seedCompleteSlice();
  adoptFixture('uat');
  insertVerificationEvidence({
    taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
    command: 'npm test', exitCode: 0, verdict: 'pass', durationMs: 5,
  });
  // What gsd_uat_result_save stores for a PASS, and the file it renders.
  insertAssessment({
    path: relSliceFile(base, 'M001', 'S01', 'ASSESSMENT'),
    milestoneId: 'M001', sliceId: 'S01', status: 'pass', scope: 'run-uat', fullContent: 'verdict: PASS',
  });
  upsertQualityGate({
    milestoneId: 'M001', sliceId: 'S01', gateId: 'UAT', scope: 'slice', taskId: '',
    status: 'complete', verdict: 'pass', rationale: 'UAT PASS', findings: '', evaluatedAt: new Date().toISOString(),
  });
  const assessmentFile = targetSliceFile(base, 'M001', 'S01', 'ASSESSMENT');
  mkdirSync(dirname(assessmentFile), { recursive: true });
  writeFileSync(assessmentFile, 'verdict: PASS\n');
  incrementUatRetryAttempts('M001', 'S01');
  // A UAT run the host recorded for an attempt that was never saved.
  recordExecRun({
    kind: 'uat_exec', milestoneId: 'M001', sliceId: 'S01', checkId: 'UAT-01',
    id: 'run-before-reopen', runtime: 'bash', command: 'node check.js', cwd: base,
    exit_code: 0, signal: null, timedOut: false, aborted: false,
    started_at: new Date().toISOString(), duration_ms: 1, output_hash: 'sha256:test',
  });
  assert.equal(getSliceRunUatAssessment('M001', 'S01')?.status, 'pass');
  assert.equal(getTaskVerificationEvidence('M001', 'S01', 'T01').length, 1);

  const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
  assert.equal(getSliceRunUatAssessment('M001', 'S01'), null, 'the UAT verdict must be gone');
  assert.deepEqual(getTaskVerificationEvidence('M001', 'S01', 'T01'), [], 'the claimed evidence must be gone');
  assert.equal(
    _getAdapter()!.prepare("SELECT COUNT(*) AS n FROM quality_gates WHERE gate_id = 'UAT'").get()?.['n'],
    0,
    'the UAT gate must have no verdict',
  );
  assert.equal(getUatRetryAttempts('M001', 'S01'), 0, 'the redo gets a new run-uat budget');
  assert.equal(readExecRun('run-before-reopen')?.attempt_ref, null, 'the old UAT run belongs to no attempt');
  assert.equal(existsSync(assessmentFile), false, 'the ASSESSMENT projection must be removed');
  // The removed content is still in the database, in the reopen event.
  const reopened = JSON.parse(String(_getAdapter()!.prepare(
    "SELECT payload_json FROM workflow_domain_events WHERE event_type = 'slice.reopened'",
  ).get()?.['payload_json']));
  assert.equal(reopened.invalidatedEvidence.assessments[0].full_content, 'verdict: PASS');
  assert.equal(reopened.invalidatedEvidence.verification_evidence[0].command, 'npm test');
  assert.equal(reopened.invalidatedEvidence.quality_gates[0].rationale, 'UAT PASS');
});

test('handleReopenSlice: works with a single task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });
    adoptFixture('single');

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

    assert.ok(!('error' in result));
    assert.equal(result.tasksReset, 1);
  } finally {
    cleanup(base);
  }
});

// ─── Failure paths ───────────────────────────────────────────────────────

test('handleReopenSlice: rejects empty sliceId', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: '' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /sliceId/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects non-existent milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenSlice({ milestoneId: 'M999', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /milestone not found/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects slice in a closed milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Done', status: 'complete' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });
    adoptFixture('closed-milestone');

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /closed milestone/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: refuses the unadopted #1205 desync loudly instead of escaping', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    // Desync signature: slice left "pending" by a UAT→planning fallback while
    // its tasks stayed "complete" from the first execution pass. Without
    // canonical lifecycle rows the shadow repair refuses — adopt the project,
    // then reopen.
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

    assert.ok('error' in result, 'an unadopted desync must be refused loudly');
    if ('error' in result) {
      assert.match(result.error, /unresolved canonical lifecycle shadows/);
      assert.match(result.error, /M001\/S01/);
    }
    const slice = getSlice('M001', 'S01');
    assert.equal(slice!.status, 'pending', 'the desynced slice must stay untouched');
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects an in-flight slice with mixed task progress and preserves it — #1205', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    // Normal in-flight slice, NOT the #1205 desync: one task finished while
    // another is still in progress. The desync guard must not treat a single
    // completed task as reopenable, or a full reset would wipe live progress.
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'in_progress' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'in_progress' });
    adoptFixture('in-flight');

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

    assert.ok('error' in result, 'in-flight slice with unfinished tasks must be rejected');
    assert.match(result.error, /not complete/);

    // Progress must be untouched — nothing reset to pending.
    const byId = Object.fromEntries(getSliceTasks('M001', 'S01').map(t => [t.id, t.status]));
    assert.equal(byId['T01'], 'complete', 'completed task must stay complete');
    assert.equal(byId['T02'], 'in_progress', 'in-progress task must stay in_progress');
    assert.equal(getSlice('M001', 'S01')!.status, 'in_progress', 'slice status must be untouched');
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects reopening a slice that is not complete', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'in_progress' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /not complete/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects non-existent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S99' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /slice not found/);
  } finally {
    cleanup(base);
  }
});

// ─── Completion artifacts after reopen ───────────────────────────────────

function summaryDrift(basePath: string): string[] {
  clearPathCache();
  const state = { activeMilestone: { id: 'M001', title: 'Test Milestone' } } as GSDState;
  return detectArtifactDbDrift(state, { basePath, state })
    .flatMap((drift) => drift.kind === 'artifact-db-status-divergence' ? [drift.reason] : []);
}

function sliceSummaryRows(): string[] {
  return _getAdapter()!.prepare(`
    SELECT path FROM artifacts
    WHERE artifact_type = 'SUMMARY' AND milestone_id = 'M001' AND slice_id = 'S01'
    ORDER BY path
  `).all().map((row: Record<string, unknown>) => String(row.path));
}

test('handleReopenSlice: a slice reopened inside a milestone worktree is not artifact/DB drift', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-reopen-slice-worktree-')));
  t.after(() => cleanup(root));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  writeFileSync(join(root, '.gitignore'), '.gsd/\n.gsd-worktrees/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'fixture');
  git('worktree', 'add', '-q', '.gsd-worktrees/M001', '-b', 'milestone/M001');
  const worktree = join(root, '.gsd-worktrees', 'M001');
  const rootPhaseDir = join(root, '.gsd', 'phases', '01-test');
  mkdirSync(rootPhaseDir, { recursive: true });
  mkdirSync(join(worktree, '.gsd', 'phases', '01-test'), { recursive: true });

  openDatabase(join(root, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', sequence: 1 });
  insertTask({
    id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: 'complete',
    fullSummaryMd: '---\nid: T01\n---\n# T01 summary\n',
  });
  seedSliceCompletionAuthority({ milestoneId: 'M001', sliceId: 'S01', completedTaskIds: ['T01'] });
  const completion: CompleteSliceParams = {
    sliceId: 'S01', milestoneId: 'M001', sliceTitle: 'Test Slice',
    oneLiner: 'Completed the slice', narrative: 'Built it.', verification: 'All checks pass.',
    deviations: 'None.', knownLimitations: 'None.', followUps: 'None.',
    keyFiles: [], keyDecisions: [], patternsEstablished: [], observabilitySurfaces: [], provides: [],
    requirementsSurfaced: [], drillDownPaths: [], affects: [], requirementsAdvanced: [],
    requirementsValidated: [], requirementsInvalidated: [], filesModified: [], requires: [],
    uatContent: '## Smoke Test\n\nRun the suite.\n',
  };
  const completed = await handleCompleteSlice(
    completion, worktree, internalExecutionInvocation('test/reopen-slice/worktree/complete'),
  );
  assert.ok(!('error' in completed), `unexpected error: ${'error' in completed ? completed.error : ''}`);
  // Any later workflow tool call drains the Projection Work of the completion:
  // it stores the SUMMARY rows and renders the project-root copies.
  await flushWorkflowProjections(worktree, { milestoneId: 'M001' });
  assert.deepEqual(sliceSummaryRows(), ['phases/01-test/01-01-SUMMARY.md', 'phases/01-test/S01-T01-SUMMARY.md']);
  assert.equal(existsSync(join(rootPhaseDir, '01-01-SUMMARY.md')), true, 'completion renders the project-root SUMMARY');
  assert.equal(existsSync(completed.summaryPath), true, 'completion renders the worktree SUMMARY');

  // The agent reopens the slice from a unit that runs in the milestone worktree.
  const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01', reason: 'redo the slice' }, worktree);
  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
  assert.equal(getSlice('M001', 'S01')?.status, 'in_progress');

  // The next /gsd auto runs the pre-dispatch drift guard at the project root.
  assert.deepEqual(summaryDrift(root), [], 'the reopened slice must be dispatchable from the project root');
  assert.deepEqual(summaryDrift(worktree), [], 'the reopened slice must be dispatchable from the milestone worktree');
  assert.deepEqual(sliceSummaryRows(), [], 'no SUMMARY row of the voided completion remains');
  const reopenPayload = JSON.parse(String(_getAdapter()!.prepare(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'slice.reopened'
  `).get()?.payload_json)) as { invalidatedEvidence: { artifacts: Array<{ path: string }> } };
  assert.deepEqual(
    reopenPayload.invalidatedEvidence.artifacts.map((artifact) => artifact.path).sort(),
    ['phases/01-test/01-01-SUMMARY.md', 'phases/01-test/S01-T01-SUMMARY.md'],
    'the reopen event keeps the removed SUMMARY rows',
  );
});
