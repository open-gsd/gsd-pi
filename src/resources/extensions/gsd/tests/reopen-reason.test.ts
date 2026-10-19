// GSD — reopen-reason injection tests (#1272)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _getAdapter,
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from '../gsd-db.ts';
import { handleReopenTask } from '../tools/reopen-task.ts';
import { internalExecutionInvocation } from '../execution-invocation.ts';
import { readPendingReopenReason } from '../reopen-reason.ts';
import { claimTaskAttempt } from '../task-execution-domain-operation.ts';
import { reopenTask } from '../task-lifecycle-domain-operation.ts';

const TASK = { milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' };

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reopen-reason-'));
  mkdirSync(tasksDir(base), { recursive: true });
  return base;
}

function tasksDir(base: string): string {
  return join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
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

function claimNextAttempt(): void {
  const db = _getAdapter()!;
  db.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'dispatch-trace-1', 'dispatch-turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const dispatch = db.prepare('SELECT id FROM unit_dispatches').get() as { id: number };
  claimTaskAttempt({
    invocation: internalExecutionInvocation('test/reopen-reason/claim'),
    task: TASK,
    workerId: 'worker-1',
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.id),
  });
}

test('handleReopenTask: the reason is pending from the DB until a new Attempt is claimed', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    const result = await handleReopenTask({
      ...TASK,
      reason: 'Full suite caught NavNodeTest regression — update count assertion to 12.',
    }, base, internalExecutionInvocation('test/reopen-reason/provided'));
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    assert.deepEqual(
      readdirSync(tasksDir(base)).filter((name) => name.endsWith('-REOPEN.json')),
      [],
      'the reason is not a file',
    );
    const pending = readPendingReopenReason('M001', 'S01', 'T01');
    assert.ok(pending, 'reopen reason should be pending after handleReopenTask');
    assert.match(pending.injectionBlock, /Reopened — Reason/);
    assert.match(pending.injectionBlock, /NavNodeTest regression/);
    // Reading does not consume it: a preview build must not eat the diagnosis.
    assert.deepEqual(readPendingReopenReason('M001', 'S01', 'T01'), pending);

    claimNextAttempt();
    assert.equal(readPendingReopenReason('M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: no reason provided leaves nothing pending', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    await handleReopenTask(
      { ...TASK },
      base,
      internalExecutionInvocation('test/reopen-reason/omitted'),
    );

    assert.equal(readPendingReopenReason('M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});

test('a reopen that is not a gate diagnosis (undo, hook retry) is not injected', () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();
    reopenTask({
      invocation: internalExecutionInvocation('test/reopen-reason/undo'),
      task: TASK,
      reason: 'Task reopened by an explicit undo command',
    });
    assert.equal(readPendingReopenReason('M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});

test('a T##-REOPEN.json file on disk is not a reopen reason', () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();
    writeFileSync(join(tasksDir(base), 'T01-REOPEN.json'), JSON.stringify({
      version: 1,
      ...TASK,
      reason: 'injected from disk',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    assert.equal(readPendingReopenReason('M001', 'S01', 'T01'), null);
  } finally {
    cleanup(base);
  }
});
