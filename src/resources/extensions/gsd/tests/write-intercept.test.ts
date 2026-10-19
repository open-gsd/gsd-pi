// GSD Extension — write-intercept unit tests
// Tests isBlockedStateFile() and BLOCKED_WRITE_ERROR constant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedStateFile, blockedBashWriteReason, blockedWriteReason, BLOCKED_WRITE_ERROR } from '../write-intercept.ts';

// ─── isBlockedStateFile: blocked paths ───────────────────────────────────

test('write-intercept: blocks unix .gsd/STATE.md path', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks relative path with dir prefix before .gsd/STATE.md', () => {
  assert.strictEqual(isBlockedStateFile('project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks bare relative .gsd/STATE.md (no leading separator)', () => {
  // (^|[/\\]) matches paths that start with .gsd/ — covers the case where write
  // tools receive a bare relative path before the file exists (realpathSync fails).
  assert.strictEqual(isBlockedStateFile('.gsd/STATE.md'), true);
});

test('write-intercept: blocks nested project .gsd/STATE.md path', () => {
  assert.strictEqual(isBlockedStateFile('/Users/dev/my-project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks .gsd/projects/<name>/STATE.md (symlinked projects path)', () => {
  assert.strictEqual(isBlockedStateFile('/home/user/.gsd/projects/my-project/STATE.md'), true);
});

// ─── isBlockedStateFile: allowed paths ───────────────────────────────────

test('write-intercept: allows .gsd/ROADMAP.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/ROADMAP.md'), false);
});

test('write-intercept: allows .gsd/PLAN.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/PLAN.md'), false);
});

test('write-intercept: allows .gsd/REQUIREMENTS.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/REQUIREMENTS.md'), false);
});

test('write-intercept: allows .gsd/SUMMARY.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/SUMMARY.md'), false);
});

test('write-intercept: allows .gsd/PROJECT.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/PROJECT.md'), false);
});

test('write-intercept: allows regular source files', () => {
  assert.strictEqual(isBlockedStateFile('/project/src/index.ts'), false);
});

test('write-intercept: allows slice plan files', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/milestones/M001/slices/S01/S01-PLAN.md'), false);
});

test('write-intercept: does not block files named STATE.md outside .gsd/', () => {
  assert.strictEqual(isBlockedStateFile('/project/docs/STATE.md'), false);
});

// ─── BLOCKED_WRITE_ERROR: content ────────────────────────────────────────

test('write-intercept: BLOCKED_WRITE_ERROR is a non-empty string', () => {
  assert.strictEqual(typeof BLOCKED_WRITE_ERROR, 'string');
  assert.ok(BLOCKED_WRITE_ERROR.length > 0);
});

test('write-intercept: BLOCKED_WRITE_ERROR mentions engine tool calls', () => {
  assert.ok(BLOCKED_WRITE_ERROR.includes('gsd_task_complete'), 'should mention gsd_task_complete');
  assert.ok(BLOCKED_WRITE_ERROR.includes('engine tool calls'), 'should mention engine tool calls');
});

// ─── CONTINUE.md: a render of the Work Checkpoint row ────────────────────

const CONTINUE_RENDER_PATHS = [
  '/project/.gsd/milestones/M001/slices/S01/S01-CONTINUE.md',
  '/project/.gsd/milestones/M001/slices/S01/continue.md',
  '/project/.gsd/milestones/M001/M001-CONTINUE.md',
  '/project/.gsd/phases/01-foo/01-01-CONTINUE.md',
];

test('write-intercept: a write to a CONTINUE file is refused and the refusal names gsd_checkpoint_save', () => {
  for (const path of CONTINUE_RENDER_PATHS) {
    const reason = blockedWriteReason(path);
    assert.match(reason ?? '', /Use gsd_checkpoint_save instead\./, path);
    assert.ok(reason!.includes(path), `the refusal names ${path}`);
  }
});

test('write-intercept: a bash write to a CONTINUE file is refused and the refusal names gsd_checkpoint_save', () => {
  for (const path of CONTINUE_RENDER_PATHS) {
    assert.match(blockedBashWriteReason(`echo "next: do X" > ${path}`) ?? '', /Use gsd_checkpoint_save instead\./, path);
  }
  assert.match(
    blockedBashWriteReason('cat notes.md | tee .gsd/milestones/M001/slices/S01/continue.md') ?? '',
    /Use gsd_checkpoint_save instead\./,
  );
});

test('write-intercept: a CONTINUE.md outside .gsd/milestones and .gsd/phases stays writable', () => {
  for (const path of ['/project/docs/CONTINUE.md', '/project/.gsd/HANDOFF.md', '/project/.gsd/CONTINUE.md', '/project/.gsd/reports/S01-CONTINUE.md']) {
    assert.strictEqual(blockedWriteReason(path), null, path);
    assert.strictEqual(blockedBashWriteReason(`echo x > ${path}`), null, path);
  }
  // Reading the render is not a write.
  assert.strictEqual(blockedBashWriteReason('cat .gsd/milestones/M001/slices/S01/S01-CONTINUE.md'), null);
});
