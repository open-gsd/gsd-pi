import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { invalidateStateCache, getActiveMilestoneId } from '../state.ts';
import { clearPathCache } from '../paths.ts';
import { parkMilestone, unparkMilestone, discardMilestone, isParked, getParkedReason } from '../milestone-actions.ts';
import {
  closeDatabase,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { createWorktree } from "../worktree-manager.ts";
import { _resetLogs, drainLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-park-test-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function createMilestone(base: string, mid: string, opts?: { withRoadmap?: boolean; withSummary?: boolean; dependsOn?: string[] }): void {
  const mDir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(mDir, { recursive: true });

  if (opts?.dependsOn) {
    writeFileSync(join(mDir, `${mid}-CONTEXT.md`), [
      '---',
      `depends_on: [${opts.dependsOn.join(', ')}]`,
      '---',
      '',
      `# ${mid} Context`,
    ].join('\n'), 'utf-8');
  }

  if (opts?.withRoadmap) {
    writeFileSync(join(mDir, `${mid}-ROADMAP.md`), [
      `# ${mid}: Test Milestone`,
      '',
      '## Vision',
      'Test milestone for park/unpark testing.',
      '',
      '## Success Criteria',
      '- [ ] Tests pass',
      '',
      '## Slices',
      `- [${opts?.withSummary ? 'x' : ' '}] **S01: Setup** \`risk:low\` \`depends:[]\``,
      '  - After this: Basic setup complete.',
    ].join('\n'), 'utf-8');
  }

  if (opts?.withSummary) {
    writeFileSync(join(mDir, `${mid}-SUMMARY.md`), [
      '---',
      `id: ${mid}`,
      '---',
      '',
      `# ${mid} — Complete`,
    ].join('\n'), 'utf-8');
  }
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    // ignore
  }
  rmSync(base, { recursive: true, force: true });
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function initGitRepo(base: string): void {
  writeFileSync(join(base, "README.md"), "# test\n", "utf-8");
  writeFileSync(join(base, ".gsd", "STATE.md"), "# State\n", "utf-8");
  run("git init", base);
  run("git config user.email test@test.com", base);
  run("git config user.name Test", base);
  run("git add .", base);
  run('git commit -m "init"', base);
  run("git branch -M main", base);
}

function clearCaches(): void {
  clearPathCache();
  invalidateStateCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

  // ─── Test 1: parkMilestone creates PARKED.md ──────────────────────────

describe('park-milestone', () => {
test('parkMilestone creates PARKED.md', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      const success = parkMilestone(base, 'M001', 'Priority shift');
      assert.ok(success, 'parkMilestone returns true');
      assert.ok(isParked(base, 'M001'), 'isParked returns true after parking');

      const reason = getParkedReason(base, 'M001');
      assert.deepStrictEqual(reason, 'Priority shift', 'reason matches');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 2: parkMilestone is idempotent — fails if already parked ────
test('parkMilestone fails if already parked', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      parkMilestone(base, 'M001', 'First park');
      const secondPark = parkMilestone(base, 'M001', 'Second park');
      assert.ok(!secondPark, 'second parkMilestone returns false');
      assert.deepStrictEqual(getParkedReason(base, 'M001'), 'First park', 'reason unchanged from first park');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 3: unparkMilestone removes PARKED.md ────────────────────────
test('unparkMilestone removes PARKED.md', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      parkMilestone(base, 'M001', 'Test reason');
      assert.ok(isParked(base, 'M001'), 'milestone is parked');

      const success = unparkMilestone(base, 'M001');
      assert.ok(success, 'unparkMilestone returns true');
      assert.ok(!isParked(base, 'M001'), 'isParked returns false after unpark');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 4: unparkMilestone fails if not parked ──────────────────────
test('unparkMilestone fails if not parked', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      const result = unparkMilestone(base, 'M001');
      assert.ok(!result, 'unparkMilestone returns false when not parked');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 7: getActiveMilestoneId skips parked ────────────────────────
test('getActiveMilestoneId skips parked', async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      createMilestone(base, 'M002', { withRoadmap: true });
      clearCaches();

      assert.ok(openDatabase(join(base, '.gsd', 'gsd.db')), 'database opens');
      insertMilestone({ id: 'M001', title: 'Parked', status: 'active' });
      insertMilestone({ id: 'M002', title: 'Active', status: 'active' });

      parkMilestone(base, 'M001', 'Testing');

      const activeId = await getActiveMilestoneId(base);
      assert.deepStrictEqual(activeId, 'M002', 'getActiveMilestoneId returns M002');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 10: discardMilestone removes directory ──────────────────────
test('discardMilestone removes directory', async () => {
    const base = createFixtureBase();
    const previousStderr = setStderrLoggingEnabled(false);
    try {
      _resetLogs();
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      const mDir = join(base, '.gsd', 'milestones', 'M001');
      assert.ok(existsSync(mDir), 'milestone dir exists before discard');

      const success = discardMilestone(base, 'M001');
      assert.ok(success, 'discardMilestone returns true');
      assert.ok(!existsSync(mDir), 'milestone dir removed after discard');
      const logs = drainLogs();
      assert.ok(
        logs.some((entry) => entry.message.includes('discardMilestone DB cleanup skipped for M001: database unavailable')),
        'discardMilestone warns when DB cleanup is skipped',
      );
    } finally {
      setStderrLoggingEnabled(previousStderr);
      cleanup(base);
    }
});

  // ─── Test 11: discardMilestone updates queue order ────────────────────
test('discardMilestone updates queue order', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      createMilestone(base, 'M002', { withRoadmap: true });
      clearCaches();

      // Write a queue order that includes M001
      const queuePath = join(base, '.gsd', 'QUEUE-ORDER.json');
      writeFileSync(queuePath, JSON.stringify({ order: ['M001', 'M002'], updatedAt: new Date().toISOString() }), 'utf-8');

      discardMilestone(base, 'M001');

      // Queue order should no longer include M001
      const queueContent = JSON.parse(readFileSync(queuePath, 'utf-8'));
      assert.ok(!queueContent.order.includes('M001'), 'M001 removed from queue order');
      assert.ok(queueContent.order.includes('M002'), 'M002 still in queue order');
    } finally {
      cleanup(base);
    }
});

test('discardMilestone removes DB rows, worktree, and milestone branch', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      initGitRepo(base);
      clearCaches();

      assert.ok(openDatabase(join(base, '.gsd', 'gsd.db')), 'database opens');
      insertMilestone({ id: 'M001', title: 'Discard me', status: 'active' });
      insertSlice({ milestoneId: 'M001', id: 'S01', title: 'Only slice', status: 'pending' });
      insertTask({ milestoneId: 'M001', sliceId: 'S01', id: 'T01', title: 'Only task', status: 'pending' });

      const wt = createWorktree(base, 'M001', { branch: 'milestone/M001' });
      assert.ok(existsSync(wt.path), 'worktree exists before discard');
      assert.ok(run('git branch', base).includes('milestone/M001'), 'milestone branch exists before discard');
      assert.ok(getMilestone('M001'), 'milestone exists in DB before discard');
      assert.equal(getMilestoneSlices('M001').length, 1, 'slice exists in DB before discard');
      assert.equal(getSliceTasks('M001', 'S01').length, 1, 'task exists in DB before discard');

      const success = discardMilestone(base, 'M001');
      assert.ok(success, 'discardMilestone returns true');

      assert.equal(getMilestone('M001'), null, 'milestone row removed from DB');
      assert.equal(getMilestoneSlices('M001').length, 0, 'slice rows removed from DB');
      assert.equal(getSliceTasks('M001', 'S01').length, 0, 'task rows removed from DB');
      assert.ok(!existsSync(wt.path), 'worktree removed after discard');
      assert.ok(!run('git branch', base).includes('milestone/M001'), 'milestone branch removed after discard');
    } finally {
      cleanup(base);
    }
});

test('discardMilestone removes DB rows when milestone directory is already missing', () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, 'M001', { withRoadmap: true });
      clearCaches();

      assert.ok(openDatabase(join(base, '.gsd', 'gsd.db')), 'database opens');
      insertMilestone({ id: 'M001', title: 'Discard me', status: 'active' });
      insertSlice({ milestoneId: 'M001', id: 'S01', title: 'Only slice', status: 'pending' });
      insertTask({ milestoneId: 'M001', sliceId: 'S01', id: 'T01', title: 'Only task', status: 'pending' });

      const mDir = join(base, '.gsd', 'milestones', 'M001');
      rmSync(mDir, { recursive: true, force: true });
      assert.ok(!existsSync(mDir), 'milestone dir removed before discard');

      const success = discardMilestone(base, 'M001');
      assert.ok(success, 'discardMilestone returns true when DB cleanup succeeds');
      assert.equal(getMilestone('M001'), null, 'milestone row removed from DB');
      assert.equal(getMilestoneSlices('M001').length, 0, 'slice rows removed from DB');
      assert.equal(getSliceTasks('M001', 'S01').length, 0, 'task rows removed from DB');
    } finally {
      cleanup(base);
    }
});

});
