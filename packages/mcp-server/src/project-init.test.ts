import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectWorkflowState } from './workflow-tools.js';

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-project-init-'));
}

describe('initProjectWorkflowState', () => {
  test('creates .gsd and the workflow database in a fresh project', async () => {
    const dir = makeTempProject();
    try {
      const result = await initProjectWorkflowState(dir);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.created, true);
      assert.equal(existsSync(join(dir, '.gsd', 'gsd.db')), true);
      assert.equal(result.dbPath, join(dir, '.gsd', 'gsd.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is idempotent for an already-initialized project', async () => {
    const dir = makeTempProject();
    try {
      const first = await initProjectWorkflowState(dir);
      assert.equal(first.ok, true, first.reason);
      const second = await initProjectWorkflowState(dir);
      assert.equal(second.ok, true, second.reason);
      assert.equal(second.created, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates only the .gsd database, not a git repo', async () => {
    const dir = makeTempProject();
    try {
      const result = await initProjectWorkflowState(dir);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.gitRepo, false);
      assert.equal(existsSync(join(dir, '.git')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails cleanly when the project directory does not exist', async () => {
    const missing = join(tmpdir(), 'gsd-project-init-missing-' + process.pid);
    const result = await initProjectWorkflowState(missing);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'project_dir_missing');
    assert.equal(existsSync(missing), false);
  });

  test('reports an existing .git repo as gitRepo: true', async () => {
    const dir = makeTempProject();
    try {
      mkdirSync(join(dir, '.git'), { recursive: true });
      const result = await initProjectWorkflowState(dir);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.gitRepo, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
