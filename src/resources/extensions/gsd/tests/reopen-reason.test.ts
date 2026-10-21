// GSD — reopen-reason injection tests (#1272)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from '../gsd-db.ts';
import { handleReopenTask } from '../tools/reopen-task.ts';
import { internalExecutionInvocation } from '../execution-invocation.ts';
import {
  reopenReasonArtifactPath,
  writeReopenReason,
  claimReopenReasonForInjection,
} from '../reopen-reason.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reopen-reason-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedCompleteTask(): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'in_progress' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: 'complete' });
}

test('writeReopenReason then claim: injects the reason, then is one-shot', () => {
  const base = makeTmpBase();
  try {
    const reason = 'T01 shifted the descendants count to 12. Fix: update the assertion to 12.';
    writeReopenReason(base, 'M001', 'S01', 'T01', reason);

    const path = reopenReasonArtifactPath(base, 'M001', 'S01', 'T01')!;
    assert.ok(existsSync(path), 'artifact should be written');

    const claimed = claimReopenReasonForInjection(base, 'M001', 'S01', 'T01');
    assert.ok(claimed, 'first claim should return an injection block');
    assert.match(claimed!.injectionBlock, /Reopened — Reason/);
    assert.match(claimed!.injectionBlock, /descendants count to 12/);
    assert.ok(!existsSync(path), 'artifact should be deleted after claim (one-shot)');

    const second = claimReopenReasonForInjection(base, 'M001', 'S01', 'T01');
    assert.equal(second, null, 'second claim should return null');
  } finally {
    cleanup(base);
  }
});

test('claimReopenReasonForInjection: returns null when nothing pending', () => {
  const base = makeTmpBase();
  try {
    assert.equal(claimReopenReasonForInjection(base, 'M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});

test('writeReopenReason: empty/whitespace reason is a no-op', () => {
  const base = makeTmpBase();
  try {
    writeReopenReason(base, 'M001', 'S01', 'T01', '   ');
    const path = reopenReasonArtifactPath(base, 'M001', 'S01', 'T01')!;
    assert.ok(!existsSync(path), 'no artifact should be written for an empty reason');
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: persists a claimable reopen reason when reason is provided', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    const result = await handleReopenTask({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      reason: 'Full suite caught NavNodeTest regression — update count assertion to 12.',
    }, base, internalExecutionInvocation('test/reopen-reason/provided'));
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const claimed = claimReopenReasonForInjection(base, 'M001', 'S01', 'T01');
    assert.ok(claimed, 'reopen reason should be claimable after handleReopenTask');
    assert.match(claimed!.injectionBlock, /NavNodeTest regression/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: no reason provided leaves nothing to claim', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    await handleReopenTask(
      { milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' },
      base,
      internalExecutionInvocation('test/reopen-reason/omitted'),
    );

    assert.equal(claimReopenReasonForInjection(base, 'M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});
