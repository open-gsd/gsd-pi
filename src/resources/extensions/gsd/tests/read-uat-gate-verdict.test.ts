/**
 * Behaviour test for the milestone-closeout UAT gate — `readUatGateVerdict`.
 *
 * The gate reads a slice's UAT sign-off from the `run-uat` row in the
 * `assessments` table, by (milestoneId, sliceId) identity. `gsd_uat_result_save`
 * writes that row. The rendered ASSESSMENT.md and UAT.md files are projections:
 * a verdict line in a file is not a sign-off, and a missing file does not hide
 * a recorded verdict (ADR-046).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertAssessment,
} from '../gsd-db.ts';
import { readUatGateVerdict } from '../auto-dispatch.ts';

const MID = 'M001';
const SLICE = 'S01';

/** An ASSESSMENT body that declares a runtime-executable UAT type and a PASS verdict. */
const RUNTIME_PASS_BODY = [
  '---',
  'verdict: pass',
  '---',
  '',
  '# S01 UAT Assessment',
  '',
  '## UAT Type',
  '- UAT mode: runtime-executable',
  '',
  '## Result',
  'All checks passed.',
].join('\n');

describe('readUatGateVerdict — the run-uat row is the only sign-off', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uat-gate-'));
    fs.mkdirSync(path.join(basePath, '.gsd'), { recursive: true });
    openDatabase(path.join(basePath, '.gsd', 'gsd.db'));
    insertMilestone({ id: MID });
    insertSlice({ id: SLICE, milestoneId: MID });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  /** Write a rendered slice file at the path the projection uses. */
  function writeSliceFile(suffix: 'ASSESSMENT' | 'UAT', content: string): void {
    const dir = path.join(basePath, '.gsd', 'milestones', MID, 'slices', SLICE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SLICE}-${suffix}.md`), content);
  }

  function insertRunUat(status: string, rowPath = `.gsd/phases/01-some-feature/01-01-ASSESSMENT.md`): void {
    insertAssessment({
      path: rowPath,
      milestoneId: MID,
      sliceId: SLICE,
      status,
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY.replace('verdict: pass', `verdict: ${status}`),
    });
  }

  test('a run-uat row signs off with no ASSESSMENT file on disk', () => {
    insertRunUat('pass');

    const result = readUatGateVerdict(MID, SLICE);

    assert.ok(result, 'the run-uat row must resolve a verdict with no projection on disk');
    assert.equal(result.verdict, 'pass');
    assert.equal(result.uatType, 'runtime-executable', 'the UAT type comes from the row body');
  });

  test('a PASS verdict written into ASSESSMENT.md does not sign off UAT', () => {
    writeSliceFile('ASSESSMENT', RUNTIME_PASS_BODY);

    assert.equal(
      readUatGateVerdict(MID, SLICE),
      null,
      'a verdict in a file with no run-uat row must not be a sign-off',
    );
  });

  test('a PASS verdict written into UAT.md does not sign off UAT', () => {
    writeSliceFile('UAT', ['# S01 UAT', '', 'verdict: PASS', ''].join('\n'));

    assert.equal(readUatGateVerdict(MID, SLICE), null);
  });

  test('a PASS verdict in ASSESSMENT.md does not replace a recorded FAIL row', () => {
    insertRunUat('fail');
    writeSliceFile('ASSESSMENT', RUNTIME_PASS_BODY);

    const result = readUatGateVerdict(MID, SLICE);

    assert.ok(result);
    assert.equal(result.verdict, 'fail', 'the recorded row wins over the edited file');
  });

  test('a roadmap-scoped assessment does not satisfy the UAT gate', () => {
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'roadmap',
      fullContent: RUNTIME_PASS_BODY,
    });

    assert.equal(readUatGateVerdict(MID, SLICE), null);
  });

  test('a backfilled assessment does not satisfy the UAT gate (#1258)', () => {
    // Older versions fabricated a PASS assessment, scope 'backfill', for slices
    // whose UAT never ran. "Never checked" must not read as "passed".
    writeSliceFile('ASSESSMENT', RUNTIME_PASS_BODY);
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'backfill',
      fullContent: RUNTIME_PASS_BODY,
    });

    assert.equal(readUatGateVerdict(MID, SLICE), null);
  });

  test('a run-uat row resolves beside a backfilled row (#1258)', () => {
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'backfill',
      fullContent: RUNTIME_PASS_BODY,
    });
    insertRunUat('pass');

    assert.equal(readUatGateVerdict(MID, SLICE)?.verdict, 'pass');
  });

  test('returns null when no run-uat row exists', () => {
    assert.equal(readUatGateVerdict(MID, SLICE), null);
  });
});
