// Project/App: gsd-pi
// File Purpose: Park, unpark and discard are Domain Operations for every milestone; files are renders.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { invalidateStateCache, getActiveMilestoneId } from '../state.ts';
import { clearPathCache } from '../paths.ts';
import { parkMilestone, unparkMilestone, discardMilestone, isParked, getParkedReason } from '../milestone-actions.ts';
import { _setAutoActiveForTest } from '../auto.ts';
import { adoptOrTransitionLifecycle } from '../db/writers/lifecycle-commands.ts';
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  getSlice,
  getTask,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { createWorktree } from "../worktree-manager.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";

function createMilestoneDir(base: string, mid: string): string {
  const mDir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, `${mid}-ROADMAP.md`), `# ${mid}: Test Milestone\n`, 'utf-8');
  return mDir;
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function initGitRepo(base: string): void {
  writeFileSync(join(base, "README.md"), "# test\n", "utf-8");
  writeFileSync(join(base, ".gitignore"), ".gsd/gsd.db*\n", "utf-8");
  run("git init", base);
  run("git config user.email test@test.com", base);
  run("git config user.name Test", base);
  run("git add .", base);
  run('git commit -m "init"', base);
  run("git branch -M main", base);
}

function scalar(sql: string, params: Record<string, unknown> = {}): unknown {
  return Object.values(_getAdapter()!.prepare(sql).get(params) ?? {})[0];
}

function revision(): number {
  return Number(scalar("SELECT revision FROM project_authority WHERE singleton = 1"));
}

function operations(type: string): number {
  return Number(scalar("SELECT COUNT(*) FROM workflow_operations WHERE operation_type = :type", { ":type": type }));
}

function lifecycleStatus(where: string): unknown {
  return scalar(`SELECT lifecycle_status FROM workflow_item_lifecycles WHERE ${where}`);
}

function adoptMilestone(milestoneId: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt-milestone",
    idempotencyKey: `test/fixture/adopt/${milestoneId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId, lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId, sliceId: "S01", lifecycleStatus: "ready" });
    return {
      events: [{ eventType: "test.fixture.adopted", entityType: "milestone", entityId: milestoneId, payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: `test/adopted/${milestoneId.toLowerCase()}`, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

describe('park-milestone', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gsd-park-test-'));
    mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
    assert.ok(openDatabase(join(base, '.gsd', 'gsd.db')), 'database opens');
    clearPathCache();
    invalidateStateCache();
  });

  afterEach(() => {
    _setAutoActiveForTest(false);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  test('parks a DB-only milestone with no directory in one Domain Operation', async () => {
    insertMilestone({ id: 'M001', title: 'DB only', status: 'queued' });
    const before = revision();

    assert.equal(await parkMilestone(base, 'M001', 'Priority shift'), true);

    assert.equal(getMilestone('M001')!.status, 'parked');
    assert.equal(lifecycleStatus("item_kind = 'milestone' AND milestone_id = 'M001'"), 'paused');
    assert.equal(operations('milestone.park'), 1);
    assert.equal(revision(), before + 1);
    assert.equal(isParked('M001'), true);
    assert.equal(getParkedReason('M001'), 'Priority shift');
    assert.equal(existsSync(join(base, '.gsd', 'milestones', 'M001')), false, 'no directory is created');
  });

  test('renders PARKED.md from the park record and a second park changes nothing', async () => {
    createMilestoneDir(base, 'M001');
    insertMilestone({ id: 'M001', title: 'On disk', status: 'active' });

    await parkMilestone(base, 'M001', 'First "park"');
    const marker = readFileSync(join(base, '.gsd', 'milestones', 'M001', 'M001-PARKED.md'), 'utf-8');
    assert.match(marker, /reason: "First \\"park\\""/);
    const after = revision();

    assert.equal(await parkMilestone(base, 'M001', 'Second park'), false);
    assert.equal(revision(), after);
    assert.equal(getParkedReason('M001'), 'First "park"');
  });

  test('a PARKED.md marker on disk is not park state', async () => {
    const mDir = createMilestoneDir(base, 'M001');
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    writeFileSync(join(mDir, 'M001-PARKED.md'), '---\nreason: "hand written"\n---\n', 'utf-8');

    assert.equal(isParked('M001'), false);
    assert.equal(await unparkMilestone(base, 'M001'), false);
    assert.equal(await parkMilestone(base, 'M001', 'real park'), true);
    assert.equal(getParkedReason('M001'), 'real park');
  });

  test('unpark restores the milestone and removes the marker after the commit', async () => {
    createMilestoneDir(base, 'M001');
    insertMilestone({ id: 'M001', title: 'On disk', status: 'active' });
    await parkMilestone(base, 'M001', 'Test reason');
    assert.ok(existsSync(join(base, '.gsd', 'milestones', 'M001', 'M001-PARKED.md')));

    assert.equal(await unparkMilestone(base, 'M001'), true);

    assert.equal(getMilestone('M001')!.status, 'active');
    assert.equal(lifecycleStatus("item_kind = 'milestone' AND milestone_id = 'M001'"), 'in_progress');
    assert.equal(operations('milestone.unpark'), 1);
    assert.equal(existsSync(join(base, '.gsd', 'milestones', 'M001', 'M001-PARKED.md')), false);
    assert.equal(getParkedReason('M001'), null);
    assert.equal(await unparkMilestone(base, 'M001'), false, 'unpark of an unparked milestone is refused');
  });

  test('getActiveMilestoneId skips a parked milestone', async () => {
    insertMilestone({ id: 'M001', title: 'Parked', status: 'active' });
    insertMilestone({ id: 'M002', title: 'Active', status: 'active' });

    await parkMilestone(base, 'M001', 'Testing');

    assert.equal(await getActiveMilestoneId(base), 'M002');
  });

  test('the auto loop abandon override parks the milestone while auto-mode is active', async () => {
    insertMilestone({ id: 'M001', title: 'Abandoned', status: 'active' });
    _setAutoActiveForTest(true);

    await assert.rejects(() => parkMilestone(base, 'M001', 'abandon this milestone'), /auto-mode is active/);
    assert.equal(await parkMilestone(base, 'M001', 'abandon this milestone', { fromAutoLoop: true }), true);

    assert.equal(getMilestone('M001')!.status, 'parked');
    assert.equal(getParkedReason('M001'), 'abandon this milestone');
  });

  test('discard tombstones an adopted milestone and removes files after the commit', async () => {
    const mDir = createMilestoneDir(base, 'M001');
    createMilestoneDir(base, 'M002');
    initGitRepo(base);
    insertMilestone({ id: 'M001', title: 'Discard me', status: 'active' });
    insertMilestone({ id: 'M002', title: 'Keep me', status: 'queued' });
    insertSlice({ milestoneId: 'M001', id: 'S01', title: 'Open slice', status: 'pending' });
    insertSlice({ milestoneId: 'M001', id: 'S02', title: 'Done slice', status: 'complete' });
    insertTask({ milestoneId: 'M001', sliceId: 'S01', id: 'T01', title: 'Open task', status: 'pending' });
    insertArtifact({
      path: 'milestones/M001/M001-CONTEXT.md',
      artifact_type: 'CONTEXT',
      milestone_id: 'M001',
      slice_id: null,
      task_id: null,
      full_content: '# M001 context\n',
    });
    adoptMilestone('M001');
    writeFileSync(join(base, '.gsd', 'QUEUE-ORDER.json'), JSON.stringify({ order: ['M001', 'M002'] }), 'utf-8');
    const wt = createWorktree(base, 'M001', { branch: 'milestone/M001' });
    const before = revision();

    assert.equal(await discardMilestone(base, 'M001'), true);

    assert.equal(operations('milestone.discard'), 1);
    assert.equal(revision(), before + 1);
    assert.equal(getMilestone('M001')!.status, 'skipped', 'row kept as a tombstone');
    assert.equal(getSlice('M001', 'S01')!.status, 'skipped');
    assert.equal(getSlice('M001', 'S02')!.status, 'complete', 'closed work stays closed');
    assert.equal(getTask('M001', 'S01', 'T01')!.status, 'skipped');
    assert.equal(lifecycleStatus("item_kind = 'milestone' AND milestone_id = 'M001'"), 'cancelled');
    assert.equal(lifecycleStatus("item_kind = 'task' AND milestone_id = 'M001'"), 'cancelled');
    assert.equal(scalar("SELECT waiver_status FROM workflow_waivers WHERE scope = 'milestone:M001'"), 'active');
    assert.equal(existsSync(mDir), false);
    assert.equal(existsSync(wt.path), false);
    assert.ok(!run('git branch', base).includes('milestone/M001'));
    assert.deepEqual(JSON.parse(readFileSync(join(base, '.gsd', 'QUEUE-ORDER.json'), 'utf-8')).order, ['M002']);

    await renderAllFromDb(base);
    assert.equal(existsSync(mDir), false, 'a full render does not bring the discarded tree back');
  });

  test('a failed discard keeps the milestone files', async () => {
    const mDir = createMilestoneDir(base, 'M001');
    insertMilestone({ id: 'M001', title: 'Discard me', status: 'active' });
    _getAdapter()!.exec(
      "CREATE TRIGGER fail_milestone_update BEFORE UPDATE ON milestones BEGIN SELECT RAISE(ABORT, 'simulated discard failure'); END;",
    );

    await assert.rejects(() => discardMilestone(base, 'M001'), /simulated discard failure/);

    assert.equal(getMilestone('M001')!.status, 'active');
    assert.equal(existsSync(mDir), true, 'files are removed only after the commit');
  });

  test('discard refuses a completed milestone and an unknown one', async () => {
    insertMilestone({ id: 'M001', title: 'Done', status: 'complete' });

    await assert.rejects(() => discardMilestone(base, 'M001'), /already closed/);
    assert.equal(await discardMilestone(base, 'M404'), false);
    assert.equal(operations('milestone.discard'), 0);
  });
});
