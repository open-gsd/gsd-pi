import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getSlice, getTask, getSliceTasks, getGateResults } from '../gsd-db.ts';
import { handlePlanTask as handlePlanTaskWithInvocation, type PlanTaskParams } from '../tools/plan-task.ts';
import { parseProjectionPlan as parsePlan } from '../schemas/parsers.ts';
import { resolveVerificationRepositoryTargets } from '../verification-source-integrity.ts';

let invocationSequence = 0;

function handlePlanTask(params: PlanTaskParams, basePath: string) {
  invocationSequence += 1;
  return handlePlanTaskWithInvocation(params, basePath, {
    idempotencyKey: `plan-task-test:${invocationSequence}`,
    sourceTransport: 'internal',
    actorType: 'agent',
  });
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-task-'));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedParent(): void {
  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
}

function writeParentWorkspacePreferences(base: string): void {
  mkdirSync(join(base, 'frontend', 'src'), { recursive: true });
  mkdirSync(join(base, 'backend', 'src'), { recursive: true });
  writeFileSync(
    join(base, '.gsd', 'PREFERENCES.md'),
    [
      '---',
      'workspace:',
      '  mode: parent',
      '  repositories:',
      '    frontend:',
      '      path: frontend',
      '    backend:',
      '      path: backend',
      '---',
    ].join('\n'),
    'utf-8',
  );
}

function validParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S02',
    taskId: 'T02',
    title: 'Write task handler',
    description: 'Implement the DB-backed task planning handler.',
    estimate: '30m',
    files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
    inputs: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    expectedOutput: ['src/resources/extensions/gsd/tests/plan-task.test.ts'],
    observabilityImpact: 'Tests exercise validation, render failure, and cache refresh behavior.',
  };
}

test('handlePlanTask writes planning state and renders the flat-phase slice plan', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S02', 'T02');
    assert.ok(task);
    assert.equal(task?.title, 'Write task handler');
    assert.equal(task?.description, 'Implement the DB-backed task planning handler.');
    assert.equal(task?.estimate, '30m');

    const slicePlanPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.equal(result.taskPlanPath, slicePlanPath);
    assert.ok(existsSync(slicePlanPath), 'slice plan should be rendered to disk');
    assert.equal(existsSync(join(base, '.gsd', 'phases', '01-test', 'T02-PLAN.md')), false);
    const slicePlan = parsePlan(readFileSync(slicePlanPath, 'utf-8'));
    assert.equal(slicePlan.tasks[0]?.id, 'T02');
    assert.equal(slicePlan.tasks[0]?.files?.[0], 'src/resources/extensions/gsd/tools/plan-task.ts');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask strips GSD planning artifacts from inputs/files instead of persisting them', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const params = validParams();
    const result = await handlePlanTask({
      ...params,
      inputs: ['.gsd/phases/01-test/01-01-ASSESSMENT.md', ...params.inputs],
      files: [...params.files, '.gsd/phases/01-test/01-01-SUMMARY.md'],
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S02', 'T02');
    assert.deepEqual(task?.inputs, params.inputs);
    assert.deepEqual(task?.files, params.files);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask seeds execute-task gate rows for incremental planning', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const gateIds = getGateResults('M001', 'S02', 'task')
      .filter((gate) => gate.task_id === 'T02')
      .map((gate) => gate.gate_id)
      .sort();
    assert.deepEqual(gateIds, ['Q5', 'Q6', 'Q7']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects invalid payloads', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({ ...validParams(), files: [''] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files must contain only non-empty strings/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask requires explicit reopen before planning a legacy deferred task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    insertTask({
      id: 'T02',
      milestoneId: 'M001',
      sliceId: 'S02',
      title: 'Deferred task',
      status: 'deferred',
    });

    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /cancelled task T02.*reopen/i);
    assert.equal(getTask('M001', 'S02', 'T02')?.title, 'Deferred task');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask explains string IO fields must be arrays', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      expectedOutput: 'src/output.ts' as unknown as string[],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: expectedOutput must be an array of strings, not string/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects prose expectedOutput entries', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      expectedOutput: ['Browser UI supports due-date add/edit flows and mixed-list urgency rendering.'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: expectedOutput must contain only file paths/);
    assert.doesNotMatch(result.error, /outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid output contract must not persist the task');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects absolute task IO paths outside the active worktree', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const outside = join(tmpdir(), 'outside-checkout', 'index.html');
    const result = await handlePlanTask({
      ...validParams(),
      inputs: [outside],
      expectedOutput: [outside],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /validation failed: inputs contains path outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid planning IO must not persist the task');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects parent-checkout task IO paths from an active worktree', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'gsd-plan-task-project-'));
  const worktree = join(projectRoot, '.gsd', 'worktrees', 'M001');
  mkdirSync(join(projectRoot, '.gsd'), { recursive: true });
  mkdirSync(join(worktree, '.gsd', 'phases', '01-test'), { recursive: true });
  openDatabase(join(projectRoot, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const parentCheckoutPath = join(projectRoot, 'src', 'index.ts');
    const result = await handlePlanTask({
      ...validParams(),
      files: [parentCheckoutPath],
      inputs: [parentCheckoutPath],
      expectedOutput: [parentCheckoutPath],
    }, worktree);

    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files contains path outside allowed repository roots/);
    assert.match(result.error, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'parent-checkout paths must not persist worktree task planning');
  } finally {
    cleanup(projectRoot);
  }
});

test('handlePlanTask rejects missing parent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask surfaces render failures without changing parse-visible slice plan state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    insertTask({ id: 'T02', sliceId: 'S02', milestoneId: 'M001', title: 'Cached task', status: 'pending' });
    const slicePlanPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    writeFileSync(slicePlanPath, '# S02: Cached slice\n\n<tasks>\n- [ ] **T02**: Cached task\n</tasks>\n', 'utf-8');
    rmSync(slicePlanPath, { force: true });
    mkdirSync(slicePlanPath, { recursive: true });

    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask commits sketch refinement even when the flat-phase projection fails', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    // The flat-phase slice render targets phases/01-test/01-02-PLAN.md.
    // Pre-creating that path as a directory forces EISDIR. Planning authority
    // still commits atomically; projection repair can retry independently.
    mkdirSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md'), { recursive: true });

    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 0, 'planning authority must not be compensated after projection failure');
    assert.ok(getTask('M001', 'S02', 'T02'), 'the task itself is still persisted so the slice can re-sync on retry');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask reruns idempotently and refreshes parse-visible state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const slicePlanPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    writeFileSync(slicePlanPath, '# S02: Cached slice\n\n<tasks>\n- [ ] **T02**: Cached task\n</tasks>\n', 'utf-8');

    const first = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanTask({
      ...validParams(),
      description: 'Updated task handler description.',
      estimate: '1h',
    }, base);
    assert.ok(!('error' in second));

    const task = getTask('M001', 'S02', 'T02');
    assert.equal(task?.description, 'Updated task handler description.');
    assert.equal(task?.estimate, '1h');

    const parsed = parsePlan(readFileSync(slicePlanPath, 'utf-8'));
    assert.equal(parsed.tasks[0]?.id, 'T02');
    assert.match(readFileSync(slicePlanPath, 'utf-8'), /Updated task handler description\./);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask persists targetRepositories for parent-workspace tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: ['project'],
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const tasks = getSliceTasks('M001', 'S02');
    const planned = tasks.find((t) => t.id === 'T02');
    assert.ok(planned, 'planned task should exist');
    assert.deepEqual(planned?.target_repositories, ['project']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask keeps implicit parent-workspace tasks scoped to the root for verification', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    writeParentWorkspacePreferences(base);
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S02', 'T02');
    const slice = getSlice('M001', 'S02');
    // #1630 derives the concrete target from the task's root-only planned paths,
    // so the row is explicit rather than empty; #1656's requirement is that
    // verification never fans out to the child repositories, asserted below.
    assert.deepEqual(task?.target_repositories, ['project']);

    const resolved = resolveVerificationRepositoryTargets(base, {
      workspace: {
        mode: 'parent',
        repositories: {
          frontend: { path: 'frontend' },
          backend: { path: 'backend' },
        },
      },
    }, task, slice);
    assert.deepEqual(resolved.repositories.map((repository) => repository.id), ['project']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects non-array targetRepositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: 'frontend' as unknown as string[],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: targetRepositories/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects empty targetRepositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: [],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: targetRepositories must include at least one repository id when provided/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid target repositories must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects unknown target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: ['frontend'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: unknown targetRepositories:/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'unknown target repositories must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask enforces path scope to declared target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    mkdirSync(join(base, 'frontend', 'src'), { recursive: true });
    mkdirSync(join(base, 'backend', 'src'), { recursive: true });
    writeFileSync(
      join(base, '.gsd', 'PREFERENCES.md'),
      [
        '---',
        'workspace:',
        '  mode: parent',
        '  repositories:',
        '    frontend:',
        '      path: frontend',
        '    backend:',
        '      path: backend',
        '---',
      ].join('\n'),
      'utf-8',
    );

    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: ['frontend'],
      files: [join(base, 'backend', 'src', 'server.ts')],
      inputs: ['app.js'],
      expectedOutput: ['app.js'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files contains path outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid scoped paths must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask inherits parent slice target repositories for path scope', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      planning: { targetRepositories: ['frontend'] },
    });
    writeParentWorkspacePreferences(base);

    const result = await handlePlanTask({
      ...validParams(),
      files: [join(base, 'backend', 'src', 'server.ts')],
      inputs: ['app.js'],
      expectedOutput: ['app.js'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files contains path outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'slice-scoped invalid paths must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask preserves stored task target repositories when omitted replan needs them for path scope', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    writeParentWorkspacePreferences(base);
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      planning: { targetRepositories: ['frontend'] },
    });
    insertTask({
      id: 'T02',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Parent root work',
      status: 'pending',
      planning: { targetRepositories: ['project'] },
    });

    const rootFile = join(base, 'root-config.json');
    const result = await handlePlanTask({
      ...validParams(),
      files: [rootFile],
      inputs: [rootFile],
      expectedOutput: [rootFile],
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.deepEqual(getTask('M001', 'S02', 'T02')?.target_repositories, ['project']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask follows the current slice target default when omitted replan paths validate there', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    writeParentWorkspacePreferences(base);
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      planning: { targetRepositories: ['frontend'] },
    });
    insertTask({
      id: 'T02',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Child repo work',
      status: 'pending',
      planning: { targetRepositories: ['frontend'] },
    });
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      planning: { targetRepositories: ['backend'] },
    });

    const backendFile = join(base, 'backend', 'src', 'server.ts');
    const result = await handlePlanTask({
      ...validParams(),
      files: [backendFile],
      inputs: [backendFile],
      expectedOutput: [backendFile],
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.deepEqual(getTask('M001', 'S02', 'T02')?.target_repositories, ['backend']);
  } finally {
    cleanup(base);
  }
});
