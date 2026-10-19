// Positive post-cutover projection-fidelity checks (T008), re-homed from the
// retiring semantic-shadow no-cutover gate (T009 split-retires it).
//
// Post-cutover the DB is the sole authority; markdown files are read-only
// projections stamped with the DB project revision/authority epoch they were
// rendered from (the jj working-copy pattern). These tests prove:
//   (a) every projection written by markdown-renderer carries the additive
//       <!-- gsd:state-version=R:E --> stamp matching the DB's current
//       project revision/authority epoch;
//   (b) freshly rendered projections have zero content drift against the DB
//       render intent;
//   (c) a hand-edited projection (content mismatch, stamp intact) is detected
//       as stale via detectProjectionDrift;
//   (d) a stamp-only difference is NOT treated as content drift.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  _getAdapter,
} from '../gsd-db.ts';
import {
  renderAllFromDb,
  detectProjectionDrift,
  getCurrentProjectStateVersion,
  readProjectionStateVersion,
  comparableProjectionContent,
} from '../markdown-renderer.ts';
import { clearParseCache } from '../files.ts';
import { clearPathCache, _clearGsdRootCache } from '../paths.ts';
import { invalidateStateCache } from '../state.ts';

// Safety net: close the DB after every test so a failure doesn't leak the
// connection and block the next test's openDatabase call.
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-projection-fidelity-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

function pathsEqual(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
}

function clearAllCaches(): void {
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();
}

/**
 * Create the on-disk flat-phase directory structure for a milestone so the
 * path resolvers work. Mirrors the helper in markdown-renderer.test.ts.
 */
function scaffoldDirs(tmpDir: string, mid: string): void {
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const slug = 'test';
  const msDir = path.join(tmpDir, '.gsd', 'phases', `${String(phaseNum).padStart(2, '0')}-${slug}`);
  fs.mkdirSync(msDir, { recursive: true });
}

function makeTaskSummaryContent(taskId: string): string {
  return [
    '---',
    `id: ${taskId}`,
    'parent: S01',
    'milestone: M001',
    'duration: 45m',
    'verification_result: all-pass',
    `completed_at: ${new Date().toISOString()}`,
    'blocker_discovered: false',
    'provides: []',
    'requires: []',
    'affects: []',
    'key_files:',
    '  - src/test.ts',
    'key_decisions: []',
    'patterns_established: []',
    'drill_down_paths: []',
    'observability_surfaces: []',
    '---',
    '',
    `# ${taskId}: Test Task Summary`,
    '',
    '**Implemented test functionality**',
    '',
    '## What Happened',
    '',
    'Built the test feature.',
    '',
  ].join('\n');
}

function seedFixtureProject(tmpDir: string): void {
  scaffoldDirs(tmpDir, 'M001');
  insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });
  insertTask({
    id: 'T01', sliceId: 'S01', milestoneId: 'M001',
    title: 'DB', status: 'done', fullSummaryMd: makeTaskSummaryContent('T01'),
  });
  insertTask({ id: 'T01', sliceId: 'S02', milestoneId: 'M001', title: 'Renderer', status: 'pending' });
}

/** revision/authority_epoch straight from the authority row the receipt advances. */
function authorityRowVersion(): { revision: number; authorityEpoch: number } {
  const row = _getAdapter()!.prepare(
    'SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1',
  ).get() as { revision: number; authority_epoch: number };
  return { revision: Number(row.revision), authorityEpoch: Number(row.authority_epoch) };
}

const ROADMAP_PATH = path.join('.gsd', 'phases', '01-test', '01-ROADMAP.md');
const PLAN_S01_PATH = path.join('.gsd', 'phases', '01-test', '01-01-PLAN.md');
const PLAN_S02_PATH = path.join('.gsd', 'phases', '01-test', '01-02-PLAN.md');
const TASK_SUMMARY_PATH = path.join('.gsd', 'phases', '01-test', 'S01-T01-SUMMARY.md');

// ─── Tests ─────────────────────────────────────────────────────────────────

test('projection-fidelity: every rendered projection carries the DB state-version stamp', async () => {
  const tmpDir = makeTmpDir();
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  try {
    seedFixtureProject(tmpDir);

    const result = await renderAllFromDb(tmpDir);
    assert.deepStrictEqual(result.errors, [], 'renderAllFromDb had no errors');
    assert.ok(result.rendered > 0, 'renderAllFromDb rendered projections');

    // The stamp values come from the same project revision/authority epoch the
    // cutover receipt advances; the exported reader must agree with the raw row.
    const fromRow = authorityRowVersion();
    const fromHelper = getCurrentProjectStateVersion();
    assert.deepStrictEqual(fromHelper, fromRow, 'helper reads the project_authority row');

    const stampLine = `<!-- gsd:state-version=${fromRow.revision}:${fromRow.authorityEpoch} -->\n`;
    const projections = [ROADMAP_PATH, PLAN_S01_PATH, PLAN_S02_PATH, TASK_SUMMARY_PATH];

    for (const rel of projections) {
      const abs = path.join(tmpDir, rel);
      assert.ok(fs.existsSync(abs), `${rel} was rendered`);
      const content = fs.readFileSync(abs, 'utf-8');

      assert.ok(
        content.endsWith(stampLine),
        `${rel} ends with the stamp for the current DB state version`,
      );
      assert.strictEqual(
        (content.match(/gsd:state-version=\d+:\d+/g) ?? []).length,
        1,
        `${rel} carries exactly one state-version stamp`,
      );
      assert.deepStrictEqual(
        readProjectionStateVersion(content),
        fromRow,
        `${rel} stamp matches the DB project revision/authority epoch`,
      );
    }

    // Freshly rendered (stamped) projections match DB state: no content drift.
    assert.deepStrictEqual(
      detectProjectionDrift(tmpDir),
      [],
      'freshly rendered projections have zero content drift',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('projection-fidelity: hand-edited projection content is detected as stale', async () => {
  const tmpDir = makeTmpDir();
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  try {
    seedFixtureProject(tmpDir);
    const result = await renderAllFromDb(tmpDir);
    assert.deepStrictEqual(result.errors, [], 'renderAllFromDb had no errors');

    // Hand-edit the S02 plan: flip T01's checkbox but leave the stamp intact.
    const planAbs = path.join(tmpDir, PLAN_S02_PATH);
    const stamped = fs.readFileSync(planAbs, 'utf-8');
    assert.ok(stamped.includes('- [ ] **T01**'), 'fixture plan has T01 unchecked');
    fs.writeFileSync(planAbs, stamped.replace('- [ ] **T01**', '- [x] **T01**'));

    const drift = detectProjectionDrift(tmpDir);
    const planDrift = drift.find((entry) => pathsEqual(entry.path, planAbs));
    assert.ok(planDrift, 'hand-edited plan is detected as stale');
    assert.ok(
      planDrift!.reason.includes('in plan'),
      `drift reason keeps the repair-dispatch "in plan" marker; got: ${planDrift!.reason}`,
    );

    // The untouched roadmap must not be flagged.
    assert.ok(
      !drift.some((entry) => pathsEqual(entry.path, path.join(tmpDir, ROADMAP_PATH))),
      'untouched roadmap is not flagged',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('projection-fidelity: stamp-only difference is not treated as content drift', async () => {
  const tmpDir = makeTmpDir();
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  try {
    seedFixtureProject(tmpDir);
    const result = await renderAllFromDb(tmpDir);
    assert.deepStrictEqual(result.errors, [], 'renderAllFromDb had no errors');

    // Rewrite the S02 plan with a different stamp value and identical content —
    // e.g. a projection rendered under another revision/epoch.
    const planAbs = path.join(tmpDir, PLAN_S02_PATH);
    const stamped = fs.readFileSync(planAbs, 'utf-8');
    const restamped = stamped.replace(
      /gsd:state-version=\d+:\d+/,
      'gsd:state-version=999:999',
    );
    assert.notStrictEqual(restamped, stamped, 'stamp rewrite changed the file');
    fs.writeFileSync(planAbs, restamped);

    assert.deepStrictEqual(
      detectProjectionDrift(tmpDir),
      [],
      'stamp-only difference is not content drift',
    );
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ─── Trailing-newline stamp separator (issue #2427) ────────────────────────
//
// stampProjectionContent inserts a "\n" separator before the stamp when the
// render intent does not end with a newline. stripProjectionStamp removes only
// the stamp line, so for newline-less DB content the stamped file strips to
// DB content + "\n" — a guaranteed 1-byte phantom drift. detectProjectionDrift
// must normalize trailing newlines on both sides before comparing.

function seedTaskWithSummary(taskId: string, summaryMd: string): void {
  insertTask({
    id: taskId, sliceId: 'S01', milestoneId: 'M001',
    title: `Task ${taskId}`, status: 'done', fullSummaryMd: summaryMd,
  });
}

function taskSummaryAbs(tmpDir: string, taskId: string): string {
  return path.join(tmpDir, '.gsd', 'phases', '01-test', `S01-${taskId}-SUMMARY.md`);
}

test('projection-fidelity: DB intent without a trailing newline does not drift after stamping', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => cleanupDir(tmpDir));
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  seedFixtureProject(tmpDir);
  // T02's summary deliberately lacks the trailing newline; T03's carries an
  // extra one. Both normalize to the same content as their projections.
  seedTaskWithSummary('T02', [
    '# T02: No Trailing Newline',
    '',
    'Last line without a newline.',
  ].join('\n'));
  seedTaskWithSummary('T03', [
    '# T03: Extra Trailing Newlines',
    '',
    'Ends with two newlines.',
    '',
    '',
  ].join('\n'));

  const result = await renderAllFromDb(tmpDir);
  assert.deepStrictEqual(result.errors, [], 'renderAllFromDb had no errors');

  // The projections went through the real stamping path.
  for (const taskId of ['T01', 'T02', 'T03']) {
    const abs = taskSummaryAbs(tmpDir, taskId);
    assert.ok(fs.existsSync(abs), `S01-${taskId}-SUMMARY.md was rendered`);
    assert.match(
      fs.readFileSync(abs, 'utf-8'),
      /<!-- gsd:state-version=\d+:\d+ -->\n$/,
      `S01-${taskId}-SUMMARY.md carries the state-version stamp`,
    );
  }

  assert.deepStrictEqual(
    detectProjectionDrift(tmpDir),
    [],
    'newline-less DB intent does not produce phantom drift; newline-terminated and extra-newline intents stay drift-free',
  );
});

test('projection-fidelity: genuine content drift beyond trailing newlines is still detected', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => cleanupDir(tmpDir));
  openDatabase(path.join(tmpDir, '.gsd', 'gsd.db'));
  clearAllCaches();

  seedFixtureProject(tmpDir);
  const result = await renderAllFromDb(tmpDir);
  assert.deepStrictEqual(result.errors, [], 'renderAllFromDb had no errors');

  // Change the DB render intent by more than a trailing newline. Mutate the
  // stored value itself (no regeneration) so the drift can only come from the
  // intended sentence change.
  const current = (_getAdapter()!.prepare(
    "SELECT full_summary_md FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'",
  ).get() as { full_summary_md: string }).full_summary_md;
  const mutated = current.replace('Built the test feature.', 'Built the test feature differently.');
  assert.notEqual(mutated, current, 'fixture mutation actually changed the stored intent');
  _getAdapter()!.prepare(
    "UPDATE tasks SET full_summary_md = ? WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'",
  ).run(mutated + '\n');

  const drift = detectProjectionDrift(tmpDir);
  const summaryAbs = taskSummaryAbs(tmpDir, 'T01');
  assert.ok(
    drift.some((entry) => pathsEqual(entry.path, summaryAbs)),
    'interior content change is still detected as stale',
  );
});

test('projection-fidelity: comparableProjectionContent treats all trailing newline forms as inert (#2427)', () => {
  // A trailing bare CR on the DB side must not resurrect the phantom: the
  // stamped file ends "...\r\n<!-- stamp -->\n", whose normalization consumes
  // the CRLF pair, so the bare-CR DB intent must normalize the same way.
  assert.equal(comparableProjectionContent('abc'), comparableProjectionContent('abc\n'));
  assert.equal(comparableProjectionContent('abc'), comparableProjectionContent('abc\r\n'));
  assert.equal(comparableProjectionContent('abc'), comparableProjectionContent('abc\r'));
  assert.equal(comparableProjectionContent('abc'), comparableProjectionContent('abc\n\n\n'));
  assert.equal(comparableProjectionContent('abc'), comparableProjectionContent('abc\r\n\r\n'));
  // Interior differences and trailing non-newline whitespace stay byte-exact.
  assert.notEqual(comparableProjectionContent('abc'), comparableProjectionContent('abd'));
  assert.notEqual(comparableProjectionContent('abc'), comparableProjectionContent('abc\nx\n'));
  assert.notEqual(comparableProjectionContent('abc '), comparableProjectionContent('abc'));
});
