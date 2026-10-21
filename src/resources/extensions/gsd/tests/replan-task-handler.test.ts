import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  upsertTaskPlanning,
  getTask,
  getReplanHistory,
} from '../gsd-db.ts';
import { handleReplanTask as handleReplanTaskWithInvocation } from '../tools/replan-task.ts';
import { internalPlanningInvocation } from '../planning-invocation.ts';

function handleReplanTask(
  params: Parameters<typeof handleReplanTaskWithInvocation>[0],
  basePath: string,
) {
  return handleReplanTaskWithInvocation(params, basePath, internalPlanningInvocation());
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-replan-task-'));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedTask(status = 'pending'): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', demo: 'Demo.' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Original Task', status });
  upsertTaskPlanning('M001', 'S01', 'T01', {
    description: 'Original task description.',
    estimate: '30m',
    files: ['src/original.ts'],
    verify: 'node --test original.test.ts',
    inputs: ['src/original.ts'],
    expectedOutput: ['src/original.ts'],
  });
}

function validReplanTaskParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    title: 'Replanned Task',
    description: 'Updated task description with blocking rework scope.',
    estimate: '45m',
    files: ['src/replanned.ts'],
    verify: 'node --test replanned.test.ts',
    inputs: ['src/original.ts'],
    expectedOutput: ['src/replanned.ts'],
    requiredWorkflowTools: [] as string[],
    reworkBriefRef: 'RB-001',
  };
}

test('handleReplanTask rejects incompatible lifecycle work before persistence', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedTask('pending');
    const before = getTask('M001', 'S01', 'T01');
    const input = validReplanTaskParams();
    input.requiredWorkflowTools = ['gsd_requirement_update'];

    const result = await handleReplanTask(input, base);

    assert.ok('error' in result);
    assert.match(result.error, /gsd_requirement_update.*execute-task/i);
    assert.deepEqual(getTask('M001', 'S01', 'T01'), before);
  } finally {
    cleanup(base);
  }
});

test('handleReplanTask updates one pending task plan and records a task-scoped replan history entry', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedTask('pending');

    const result = await handleReplanTask(validReplanTaskParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S01', 'T01');
    assert.ok(task, 'task should still exist');
    assert.equal(task.title, 'Replanned Task');
    assert.equal(task.description, 'Updated task description with blocking rework scope.');
    assert.equal(task.verify, 'node --test replanned.test.ts');
    assert.deepEqual(task.files, ['src/replanned.ts']);

    const history = getReplanHistory('M001', 'S01');
    assert.ok(history.some((row) => row['task_id'] === 'T01' && String(row['summary']).includes('RB-001')));

    const planPath = join(base, '.gsd', 'phases', '01-test', '01-01-PLAN.md');
    assert.ok(existsSync(planPath), 'slice plan projection should be rendered');
    const planContent = readFileSync(planPath, 'utf-8');
    assert.match(planContent, /Replanned Task/);
    assert.match(planContent, /node --test replanned\.test\.ts/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanTask rejects completed tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedTask('complete');

    const result = await handleReplanTask(validReplanTaskParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /cannot replan completed task T01/i);
  } finally {
    cleanup(base);
  }
});
