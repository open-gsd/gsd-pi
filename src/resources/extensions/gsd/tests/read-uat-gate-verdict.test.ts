/**
 * Behavioural regression test for the milestone-closeout UAT gate —
 * `readUatGateVerdict`.
 *
 * The gate (ADR-017: DB-authoritative UAT sign-off) reads a slice's UAT
 * verdict from its ASSESSMENT artifact via the *canonical* expected path
 * (`resolveSliceFile` + a path-keyed `getAssessment`). When a milestone
 * artifact-layout migration orphans the ASSESSMENT markdown from that canonical
 * path (e.g. `phases/…` → `milestones/…`), the gate used to return `null` and
 * block milestone closure with "missing UAT PASS verdict" — even though the
 * verdict was correctly recorded in the `assessments` table by
 * `gsd_uat_result_save`.
 *
 * The DB fallback added to `readUatGateVerdict` consults the authoritative
 * `assessments` table by (milestoneId, sliceId, scope='run-uat') identity,
 * independent of path. These tests pin that behaviour.
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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uat-gate-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  closeDatabase();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

const MID = 'M001';
const SLICE = 'S01';

/** Canonical on-disk ASSESSMENT path produced by `resolveSliceFile`. */
function canonicalAssessmentPath(basePath: string): string {
  return path.join(basePath, '.gsd', 'milestones', MID, 'slices', SLICE, `${SLICE}-ASSESSMENT.md`);
}

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

describe('readUatGateVerdict — DB fallback for orphaned ASSESSMENT', () => {
  let dbPath: string;
  let basePath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uat-gate-proj-'));
    insertMilestone({ id: MID });
    insertSlice({ id: SLICE, milestoneId: MID });
  });

  afterEach(() => {
    cleanupDb(dbPath);
    try { fs.rmSync(basePath, { recursive: true, force: true }); } catch { /* */ }
  });

  test('returns pass when the ASSESSMENT is keyed by a legacy/orphaned path (the bug)', async () => {
    // Reproduces milestone 15: `gsd_uat_result_save` wrote S01's assessment row
    // under a now-migrated path; the canonical file never existed on disk and
    // the `assessments.path` is not what `resolveSliceFile` computes.
    insertAssessment({
      // Deliberately non-canonical — a legacy `phases/…` path.
      path: `.gsd/phases/01-some-feature/01-01-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.ok(result, 'expected the DB fallback to resolve a verdict, got null');
    assert.equal(result!.verdict, 'pass');
  });

  test('the DB fallback derives uatType from the assessment body when no file exists', async () => {
    insertAssessment({
      path: `.gsd/phases/01-some-feature/01-01-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.ok(result);
    assert.equal(result!.verdict, 'pass');
    assert.equal(result!.uatType, 'runtime-executable');
  });

  test('canonical ASSESSMENT file on disk still resolves (regression guard)', async () => {
    // When the file is present at the canonical path, the existing path-keyed
    // lookup must resolve it without needing the fallback.
    const file = canonicalAssessmentPath(basePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, RUNTIME_PASS_BODY);
    // Also seed the path-keyed assessments row, mirroring a normal save.
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.ok(result);
    assert.equal(result!.verdict, 'pass');
    assert.equal(result!.uatType, 'runtime-executable');
  });

  test('a roadmap-scoped assessment does NOT satisfy the UAT gate', async () => {
    // `reassess-roadmap` writes roadmap-scoped assessments to the same
    // S##-ASSESSMENT path; those must never be treated as a UAT verdict. The
    // legacy-path fallback queries scope='run-uat', so a roadmap-only row is
    // invisible and the gate returns null.
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'roadmap',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.equal(result, null, 'roadmap-scoped assessments must not satisfy the UAT gate');
  });

  test('a backfilled assessment does NOT satisfy the UAT gate (#1258)', async () => {
    // The milestone-validation backfill fabricates a `verdict: PASS` ASSESSMENT
    // for completed slices that never produced a real UAT result (e.g.
    // artifact-driven UAT that was never dispatched). Filed under scope
    // 'backfill', that placeholder must never be read as a genuine UAT sign-off —
    // otherwise "never checked" is silently treated as "passed". Even with the
    // fabricated file present on disk, the gate must fall through to the
    // authoritative run-uat row (absent here) and return null.
    const file = canonicalAssessmentPath(basePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, RUNTIME_PASS_BODY);
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'backfill',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.equal(result, null, 'backfilled assessments must not satisfy the UAT gate');
  });

  test('a genuine run-uat row still resolves even when a backfilled file exists (#1258)', async () => {
    // If a real UAT was later recorded, its authoritative run-uat row must win
    // over the fabricated placeholder rather than being masked by it.
    const file = canonicalAssessmentPath(basePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, RUNTIME_PASS_BODY);
    insertAssessment({
      path: `.gsd/milestones/${MID}/slices/${SLICE}/${SLICE}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'backfill',
      fullContent: RUNTIME_PASS_BODY,
    });
    insertAssessment({
      path: `.gsd/phases/01-some-feature/01-01-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'pass',
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY,
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.ok(result, 'a genuine run-uat sign-off must resolve');
    assert.equal(result!.verdict, 'pass');
  });

  test('returns null when no assessment and no file exist (fallback does not hallucinate)', async () => {
    const result = await readUatGateVerdict(basePath, MID, SLICE);
    assert.equal(result, null);
  });

  test('surfaces a recorded non-pass verdict via the DB fallback', async () => {
    // A failing verdict stored under a legacy path must surface (not be masked
    // as "missing") so the gate's non-PASS branch can act on it.
    insertAssessment({
      path: `.gsd/phases/01-some-feature/01-01-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SLICE,
      status: 'fail',
      scope: 'run-uat',
      fullContent: RUNTIME_PASS_BODY.replace('verdict: pass', 'verdict: fail'),
    });

    const result = await readUatGateVerdict(basePath, MID, SLICE);

    assert.ok(result);
    assert.equal(result!.verdict, 'fail');
  });
});
