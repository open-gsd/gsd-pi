// Project/App: gsd-pi
// File Purpose: ADR-047 liveness backstop regression harness (#1655) —
// deterministic trip/persistence/resume coverage against a temp DB, no LLM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  insertAssessment,
  insertArtifact,
  insertGateRow,
  saveGateResult,
  updateTaskStatus,
} from '../gsd-db.ts';
import {
  LIVENESS_TRIP_THRESHOLD,
  COMPLETED_NO_ADVANCE_GUARD_ID,
  acknowledgeWedge,
  clearAbandonedCloseoutSignatures,
  formatWedgeRefusalNotice,
  formatWedgeTripNotice,
  garbageCollectResolvedWedges,
  getOpenWedge,
  hashBackstopInput,
  recheckCompletedNoAdvanceWedge,
  recordNonAdvancingOutcome,
  recordNonAdvancingRecurrence,
  serializeNonAdvancingEvidence,
  snapshotUnitTargetRows,
  wedgeResumeCommand,
} from '../auto-liveness-backstop.ts';
import {
  loopGuardIdsWithInstructions,
  loopGuardRecoveryInstruction,
  resolveLoopSanctionedExit,
} from '../auto/loop-sanctioned-exits.ts';
import { markBlockedStopReason } from '../stop-notice.ts';
import { formatStopNoticePrefix } from '../stop-notice.ts';

const SCOPE = '/tmp/liveness-backstop-project';

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-liveness-backstop-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* Best-effort cleanup only. */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* Best-effort cleanup only. */ }
}

function sig(guardId: string, payload: string, unitId = 'M001/S01/T01') {
  return {
    scopeId: SCOPE,
    guardId,
    unitType: 'execute-task',
    unitId,
    inputPayload: payload,
  };
}

function readOpenWedge() {
  const result = getOpenWedge(SCOPE);
  assert.equal(result.ok, true, 'open-wedge read should succeed');
  return result.ok ? result.wedge : null;
}

function readTargetSnapshot(unitType: string, unitId: string): string | null {
  const result = snapshotUnitTargetRows(unitType, unitId);
  assert.equal(result.ok, true, 'target-row snapshot should succeed');
  return result.ok ? result.hash : null;
}

test('ADR-047: typed blocker evidence serializes stably without dropping hashes', () => {
  const first = serializeNonAdvancingEvidence({
    message: 'projection drift',
    drift: { actualSha: 'after', expectedSha: 'before' },
  });
  const reordered = serializeNonAdvancingEvidence({
    drift: { expectedSha: 'before', actualSha: 'after' },
    message: 'projection drift',
  });

  assert.equal(first, reordered);
  assert.match(first, /actualSha/);
  assert.match(first, /expectedSha/);
  assert.notEqual(
    hashBackstopInput(first),
    hashBackstopInput(serializeNonAdvancingEvidence({
      message: 'projection drift',
      drift: { actualSha: 'changed-again', expectedSha: 'before' },
    })),
  );
});

test('ADR-047: trips at 2 occurrences with identical input hash', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  const first = recordNonAdvancingOutcome(sig('drift-guard', 'verdict: fail — drift record X'));
  assert.equal(first.tripped, false);
  assert.equal(first.count, 1);
  assert.equal(readOpenWedge(), null, 'no wedge before the threshold');

  const second = recordNonAdvancingOutcome(sig('drift-guard', 'verdict: fail — drift record X'));
  assert.equal(second.tripped, true);
  assert.equal(second.count, LIVENESS_TRIP_THRESHOLD);
  if (!second.tripped) return;
  assert.equal(second.wedge.guardId, 'drift-guard');
  assert.equal(second.wedge.unitType, 'execute-task');
  assert.equal(second.wedge.unitId, 'M001/S01/T01');
  assert.equal(second.wedge.occurrenceCount, 2);
  assert.equal(second.wedge.acknowledgedAt, null);

  const open = readOpenWedge();
  assert.ok(open, 'wedge record persisted');
  assert.equal(open!.wedgeId, second.wedge.wedgeId);
});

test('ADR-047: NO trip when the input hash changes — counter resets to 1', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  assert.equal(recordNonAdvancingOutcome(sig('drift-guard', 'payload A')).tripped, false);
  const changed = recordNonAdvancingOutcome(sig('drift-guard', 'payload B'));
  assert.equal(changed.tripped, false, 'changed inputs mean state advanced — no trip');
  assert.equal(changed.count, 1, 'hash change resets the counter');
  assert.equal(readOpenWedge(), null);

  // The new hash then trips on ITS second identical occurrence.
  const retrip = recordNonAdvancingOutcome(sig('drift-guard', 'payload B'));
  assert.equal(retrip.tripped, true);
});

test('ADR-047: A-B-A-B oscillation trips — interleaving-blind counters', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  // A and B are distinct signatures (different targets) alternating —
  // the consecutive-only Rule 1 provably never fired on this shape (#1623).
  const a = () => recordNonAdvancingOutcome(sig('slice-gate', 'gate payload A', 'M001/S01'));
  const b = () => recordNonAdvancingOutcome(sig('task-guard', 'guard payload B', 'M001/S01/T01'));

  assert.equal(a().tripped, false);
  assert.equal(b().tripped, false);
  const secondA = a();
  assert.equal(secondA.tripped, true, 'interleaved B must not reset A\'s counter');
  assert.equal(secondA.count, 2);
});

test('ADR-047: counter survives a process restart (new instance over the same DB)', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  assert.equal(recordNonAdvancingOutcome(sig('resume-guard', 'stale pause pin P')).tripped, false);

  // Simulated restart: close and reopen the DB — the old in-process ring
  // reset to zero here (#1622, #1626 looped for hours); the ledger must not.
  closeDatabase();
  openDatabase(dbPath);

  const afterRestart = recordNonAdvancingOutcome(sig('resume-guard', 'stale pause pin P'));
  assert.equal(afterRestart.tripped, true, 'restart must not reset the per-signature counter');
  assert.equal(afterRestart.count, 2);
});

test('ADR-047: acknowledged resume probes once and reopens the same wedge if unchanged', async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  const tripped = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  // Unacknowledged wedge blocks re-entry.
  const open = readOpenWedge();
  assert.ok(open, 'entry gates read this record to refuse re-entry');
  assert.match(formatWedgeRefusalNotice(open!), /--resume-wedge/);

  // A restart alone changes nothing: a third identical outcome re-reports the
  // SAME wedge id instead of minting duplicates.
  const third = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(third.tripped, true);
  if (!third.tripped) return;
  assert.equal(third.wedge.wedgeId, tripped.wedge.wedgeId);

  // Unknown id is rejected.
  assert.equal((await acknowledgeWedge(SCOPE, 'W-nonsense', () => ({ blocking: false }))).ok, false);

  // Explicit acknowledgment opens one re-entry probe without erasing the
  // signature that proves whether the originating blocker actually changed.
  const ack = await acknowledgeWedge(SCOPE, tripped.wedge.wedgeId, () => ({ blocking: false }));
  assert.equal(ack.ok, true);
  assert.equal(readOpenWedge(), null, 'acknowledged wedge no longer blocks re-entry');

  const unchanged = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(unchanged.tripped, true, 'unchanged blocker must retrip on the probe');
  if (!unchanged.tripped) return;
  assert.equal(unchanged.wedge.wedgeId, tripped.wedge.wedgeId, 'the original wedge is reopened');
  assert.equal(unchanged.count, 4, 'acknowledgment must not reset the liveness counter');
  assert.equal(readOpenWedge()?.wedgeId, tripped.wedge.wedgeId);
});

test('ADR-047: acknowledgment preserves a wedge while its originating guard still blocks', async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  const tripped = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  let rechecked: Pick<typeof tripped.wedge, 'guardId' | 'unitType' | 'unitId' | 'inputHash'> | null = null;
  const ack = await acknowledgeWedge(SCOPE, tripped.wedge.wedgeId, (wedge) => {
    rechecked = {
      guardId: wedge.guardId,
      unitType: wedge.unitType,
      unitId: wedge.unitId,
      inputHash: wedge.inputHash,
    };
    return { blocking: true, reason: 'verification command still exits 1' };
  });

  assert.deepEqual(rechecked, {
    guardId: 'verify-gate',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputHash: tripped.wedge.inputHash,
  });
  assert.deepEqual(ack, {
    ok: false,
    reason: 'originating guard verify-gate still blocks: verification command still exits 1',
  });
  assert.equal(readOpenWedge()?.wedgeId, tripped.wedge.wedgeId);
  assert.equal(
    recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1')).tripped,
    true,
    'a refused acknowledgment must preserve the tripped signature counter',
  );
});

test('ADR-047: wedge trip notice names the guard, the wedge id, and the resume command', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  recordNonAdvancingOutcome(sig('tool-scope-guard', 'blocked tool payload'));
  const tripped = recordNonAdvancingOutcome(sig('tool-scope-guard', 'blocked tool payload'));
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  const notice = formatWedgeTripNotice(tripped.wedge);
  assert.match(notice, /tool-scope-guard/);
  assert.match(notice, new RegExp(tripped.wedge.wedgeId));
  assert.match(notice, /--resume-wedge/);
  assert.equal(wedgeResumeCommand(tripped.wedge), `/gsd auto --resume-wedge ${tripped.wedge.wedgeId}`);

  // Routed through the canonical blocked stop notice, the terminal line keeps
  // the "Auto-mode blocked" prefix the headless host (exit 10) and the
  // acceptance-bed WEDGED classifier both key on.
  const terminal = formatStopNoticePrefix(markBlockedStopReason(notice));
  assert.match(terminal, /^Auto-mode blocked — /);
});

test('ADR-047: completed-no-advance — target-row hash is stable until a target row moves', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'task', status: 'pending' });

  const atDispatch = readTargetSnapshot('execute-task', 'M001/S01/T01');
  assert.ok(atDispatch, 'snapshot available when DB rows exist');
  const unchanged = readTargetSnapshot('execute-task', 'M001/S01/T01');
  assert.equal(unchanged, atDispatch, 'zero-work completion leaves the hash identical');

  // Two identical completed-no-advance outcomes trip like any other signature.
  const record = () => recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: atDispatch!,
  });
  assert.equal(record().tripped, false);
  assert.equal(record().tripped, true);

  updateTaskStatus('M001', 'S01', 'T01', 'complete');
  const afterAdvance = readTargetSnapshot('execute-task', 'M001/S01/T01');
  assert.notEqual(afterAdvance, atDispatch, 'a moved target row changes the hash');
});

test('ADR-047: run-uat target advances when a retried assessment changes verdict', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'complete', depends: [] });

  insertAssessment({
    path: '.gsd/phases/01-fixture/01-01-ASSESSMENT.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'fail',
    scope: 'run-uat',
    fullContent: 'attempt 1 failed',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const failed = readTargetSnapshot('run-uat', 'M001/S01');

  insertAssessment({
    path: '.gsd/phases/01-fixture/01-01-ASSESSMENT.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'pass',
    scope: 'run-uat',
    fullContent: 'attempt 2 passed',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const passed = readTargetSnapshot('run-uat', 'M001/S01');
  assert.notEqual(passed, failed, 'FAIL → PASS must advance the run-uat target');

  insertAssessment({
    path: '.gsd/phases/01-fixture/01-01-ASSESSMENT.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'pass',
    scope: 'run-uat',
    fullContent: 'attempt 3 also passed',
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  assert.equal(
    readTargetSnapshot('run-uat', 'M001/S01'),
    passed,
    'new attempt metadata without a verdict change is not target advancement',
  );
});

test('ADR-047: gate-evaluate target advances when a scoped gate verdict is persisted (#2310)', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q3', scope: 'slice' });
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q4', scope: 'slice' });

  const before = readTargetSnapshot('gate-evaluate', 'M001/S01/gates+Q3,Q4');
  assert.ok(before, 'gate-evaluate snapshot available when gate rows exist');

  saveGateResult({
    milestoneId: 'M001',
    sliceId: 'S01',
    gateId: 'Q3',
    verdict: 'pass',
    rationale: 'no auth surface',
    findings: '',
  });
  const afterQ3 = readTargetSnapshot('gate-evaluate', 'M001/S01/gates+Q3,Q4');
  assert.notEqual(afterQ3, before, 'persisting one scoped gate verdict must advance the hash');

  saveGateResult({
    milestoneId: 'M001',
    sliceId: 'S01',
    gateId: 'Q4',
    verdict: 'pass',
    rationale: 'requirements covered',
    findings: '',
  });
  const afterQ4 = readTargetSnapshot('gate-evaluate', 'M001/S01/gates+Q3,Q4');
  assert.notEqual(afterQ4, afterQ3, 'persisting the remaining gate verdict must advance again');
});

test('ADR-047: stable guard identity isolates identical payloads from different guards', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  const first = recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: 'source-integrity-guard',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: 'identical guard reading',
  });
  assert.equal(first.tripped, false);
  const second = recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: 'tool-contract-guard',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: 'identical guard reading',
  });
  assert.equal(second.tripped, false, 'different stable guards must own separate counters');
  assert.equal(second.count, 1);
});

test('ADR-047: changing a guard input clears its superseded hash rows', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  assert.equal(recordNonAdvancingOutcome(sig('drift-guard', 'payload A')).tripped, false);
  assert.equal(recordNonAdvancingOutcome(sig('drift-guard', 'payload B')).tripped, false);
  const returnedToA = recordNonAdvancingOutcome(sig('drift-guard', 'payload A'));

  assert.equal(returnedToA.tripped, false, 'A→B→A must not increment the stale A row');
  assert.equal(returnedToA.count, 1);
});

test('ADR-047: unavailable storage is an explicit failure and never a not-tripped success', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  closeDatabase();

  const recorded = recordNonAdvancingOutcome(sig('drift-guard', 'payload'));
  assert.ok('error' in recorded, 'ledger write failure must be explicit');

  const wedge = getOpenWedge(SCOPE);
  assert.equal(wedge.ok, false, 'open-wedge read failure must be explicit');

  const snapshot = snapshotUnitTargetRows('execute-task', 'M001/S01/T01');
  assert.equal(snapshot.ok, false, 'snapshot failure must be explicit');
});

test('ADR-047: default sanctioned exit preserves the complete payload', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  const payload = `${'x'.repeat(1200)} state-mutating exit: /gsd doctor --fix`;

  recordNonAdvancingOutcome(sig('long-payload-guard', payload));
  const tripped = recordNonAdvancingOutcome(sig('long-payload-guard', payload));

  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;
  assert.equal(tripped.wedge.sanctionedExit, payload);
});

test('#1672: every loop guard instruction names a real recovery command', () => {
  // Gap 4 (#1672): loop-level wedges used to persist "Resolve the reported
  // condition" — a restart could only reprint that. Each guard id now carries
  // its owner's published command, so a wedge names a reachable exit.
  const commandPattern = /`(\/gsd [a-z][a-z -]*|gsd headless auto|gsd_task_recovery_resume)`|gsd_task_recovery_resume/;
  for (const guardId of loopGuardIdsWithInstructions()) {
    const instruction = loopGuardRecoveryInstruction(guardId);
    assert.match(instruction, commandPattern, `${guardId} must name a real command`);
    assert.doesNotMatch(instruction, /Resolve the reported condition/);
  }
  // Unknown guard ids still get an actionable triage pair, never generic text.
  assert.match(loopGuardRecoveryInstruction('guard-that-does-not-exist'), commandPattern);
});

test('#1672: every runGuards break reason retains its recovery command', () => {
  const expectedCommands: Array<[string, RegExp]> = [
    ['user-backtrack', /`\/gsd auto`/],
    ['user-stop', /`\/gsd auto`/],
    ['stop-guard-error', /`\/gsd forensics`/],
    ['budget-halt', /`\/gsd auto`/],
    ['budget-pause', /`\/gsd auto`/],
    ['context-window', /`\/gsd auto`/],
  ];
  const mappedGuardIds = new Set(loopGuardIdsWithInstructions());

  for (const [guardId, expectedCommand] of expectedCommands) {
    assert.equal(mappedGuardIds.has(guardId), true, `${guardId} must have an explicit mapping`);
    assert.match(loopGuardRecoveryInstruction(guardId), expectedCommand, guardId);
  }
});

test('#1672: the composed loop sanctioned exit carries the guard payload', () => {
  const exit = resolveLoopSanctionedExit({
    guardId: 'finalize-retry',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    failurePayload: 'roadmap has zero slices',
  });
  assert.match(exit, /finalize-retry blocked execute-task M001\/S01\/T01/);
  assert.match(exit, /`\/gsd rebuild markdown`/, 'the finalize-retry owner names the projection repair');
  assert.match(exit, /Failure: roadmap has zero slices/);

  // A payload that only restates the guard id adds nothing and is omitted.
  const bare = resolveLoopSanctionedExit({
    guardId: 'memory-pressure',
    unitType: 'orchestration',
    unitId: 'workflow',
    failurePayload: 'memory-pressure',
  });
  assert.doesNotMatch(bare, /Failure:/);
  assert.match(bare, /`\/gsd auto`/);
});

test('#1672: a loop guard signature survives a database restart and trips at 2', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  const exit = resolveLoopSanctionedExit({
    guardId: 'max-iterations',
    unitType: 'orchestration',
    unitId: 'workflow',
    failurePayload: 'max-iterations',
  });
  const record = () => recordNonAdvancingOutcome(
    { ...sig('max-iterations', 'max-iterations', 'workflow'), unitType: 'orchestration' },
    { sanctionedExit: exit },
  );

  assert.equal(record().tripped, false);
  closeDatabase();
  openDatabase(dbPath);

  const tripped = record();
  assert.equal(tripped.tripped, true, 'the restart must not reset the preflight counter');
  if (!tripped.tripped) return;
  assert.match(tripped.wedge.sanctionedExit, /`\/gsd status`/);
  assert.match(formatWedgeRefusalNotice(tripped.wedge), /`\/gsd status`/);
});

test('hashBackstopInput is deterministic and payload-faithful', () => {
  assert.notEqual(
    hashBackstopInput('verdict payload 1'),
    hashBackstopInput('verdict payload 2'),
  );
  assert.equal(hashBackstopInput('same'), hashBackstopInput('same'));
});

test('#2159: validate-milestone target advances when validation verdict is persisted', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'complete', depends: [] });

  const before = readTargetSnapshot('validate-milestone', 'M001');
  assert.ok(before, 'validate-milestone snapshot available when milestone rows exist');

  insertAssessment({
    path: '.gsd/phases/01-fixture/01-VALIDATION.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'pass',
    scope: 'milestone-validation',
    fullContent: 'validation passed',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'MV01', scope: 'milestone' });
  saveGateResult({
    milestoneId: 'M001',
    sliceId: 'S01',
    gateId: 'MV01',
    verdict: 'pass',
    rationale: 'criteria met',
    findings: '',
  });

  const after = readTargetSnapshot('validate-milestone', 'M001');
  assert.notEqual(after, before, 'persisted validation must advance the validate-milestone target');
});

test('#2159: garbageCollectResolvedWedges auto-acks a stale completed-no-advance wedge', async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'task', status: 'pending' });

  const atWedge = readTargetSnapshot('complete-slice', 'M001/S01');
  assert.ok(atWedge);
  const record = () => recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: 'complete-slice',
    unitId: 'M001/S01',
    inputPayload: atWedge!,
  });
  assert.equal(record().tripped, false);
  const tripped = record();
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  updateTaskStatus('M001', 'S01', 'T01', 'complete');
  const gc = await garbageCollectResolvedWedges(SCOPE, async (wedge) => recheckCompletedNoAdvanceWedge(wedge));
  assert.equal(gc.ok, true);
  if (!gc.ok) return;
  assert.equal(gc.acknowledged.length, 1);
  assert.equal(gc.acknowledged[0]!.wedgeId, tripped.wedge.wedgeId);
  assert.equal(readOpenWedge(), null, 'stale wedge must be garbage-collected after target advancement');
});

test('#2159: abandoned closeout clears finalize-retry recurrence counters', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  const record = () => recordNonAdvancingRecurrence({
    scopeId: SCOPE,
    guardId: 'finalize-retry',
    unitType: 'validate-milestone',
    unitId: 'M001',
    inputPayload: 'finalize-retry: missing artifact',
  });
  assert.equal(record().recurred, false);
  clearAbandonedCloseoutSignatures(SCOPE, 'validate-milestone', 'M001');
  const afterAbandon = record();
  assert.equal(afterAbandon.recurred, false, 'abandoned attempt must not inherit the killed run counter');
  assert.equal(afterAbandon.count, 1);
});

test('#2344: reassess-roadmap target advances when a roadmap assessment is persisted', async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'complete', depends: [] });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'S2', status: 'pending', depends: ['S01'] });

  // A "roadmap is fine" verdict moves no milestone/slice/task row — before the
  // fix the wedge input hash could never change, so --resume-wedge failed forever.
  const atDispatch = readTargetSnapshot('reassess-roadmap', 'M001/S01');
  assert.ok(atDispatch, 'reassess-roadmap snapshot available when slice rows exist');
  const record = () => recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: 'reassess-roadmap',
    unitId: 'M001/S01',
    inputPayload: atDispatch!,
  });
  assert.equal(record().tripped, false);
  const tripped = record();
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  insertAssessment({
    path: '.gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'no-changes',
    scope: 'roadmap',
    fullContent: 'roadmap is fine',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const afterAssessment = readTargetSnapshot('reassess-roadmap', 'M001/S01');
  assert.notEqual(afterAssessment, atDispatch, 'a persisted roadmap assessment must advance the reassess-roadmap target');

  const gc = await garbageCollectResolvedWedges(SCOPE, async (wedge) => recheckCompletedNoAdvanceWedge(wedge));
  assert.equal(gc.ok, true);
  if (!gc.ok) return;
  assert.equal(gc.acknowledged.length, 1, 'the wedged reassess-roadmap unit must be acknowledgeable after the assessment lands');
  assert.equal(gc.acknowledged[0]!.wedgeId, tripped.wedge.wedgeId);
  assert.equal(readOpenWedge(), null, 'stale wedge must be garbage-collected after the assessment advances the hash');
});

test('#2344: a roadmap assessment does not unblock wedges of unit types that ignore it', async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'task', status: 'pending' });

  const atDispatch = readTargetSnapshot('complete-slice', 'M001/S01');
  assert.ok(atDispatch);
  const record = () => recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: 'complete-slice',
    unitId: 'M001/S01',
    inputPayload: atDispatch!,
  });
  assert.equal(record().tripped, false);
  const tripped = record();
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  insertAssessment({
    path: '.gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md',
    milestoneId: 'M001',
    sliceId: 'S01',
    status: 'no-changes',
    scope: 'roadmap',
    fullContent: 'roadmap is fine',
    createdAt: '2026-01-02T00:00:00.000Z',
  });

  assert.equal(
    readTargetSnapshot('complete-slice', 'M001/S01'),
    atDispatch,
    'the roadmap row must stay out of the complete-slice snapshot',
  );
  const gc = await garbageCollectResolvedWedges(SCOPE, async (wedge) => recheckCompletedNoAdvanceWedge(wedge));
  assert.equal(gc.ok, true);
  if (!gc.ok) return;
  assert.equal(gc.acknowledged.length, 0, 'an out-of-scope assessment row must not ack another unit type\'s wedge');
});

test('#2344: a second reassessment run advances the target even with an identical verdict', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'complete', depends: [] });

  // reassess-roadmap upserts one roadmap-scoped row per milestone (the
  // projection path is deterministic per milestone), so two runs with the
  // same verdict differ only in the row they rewrite.
  const insertRun = (createdAt: string): void => {
    insertAssessment({
      path: '.gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md',
      milestoneId: 'M001',
      sliceId: 'S01',
      status: 'no-changes',
      scope: 'roadmap',
      fullContent: 'roadmap is fine',
      createdAt,
    });
  };

  insertRun('2026-01-01T00:00:00.000Z');
  const afterFirst = readTargetSnapshot('reassess-roadmap', 'M001/S01');
  assert.ok(afterFirst, 'first run snapshot available');
  insertRun('2026-01-02T00:00:00.000Z');
  const afterSecond = readTargetSnapshot('reassess-roadmap', 'M001/S01');
  assert.notEqual(afterSecond, afterFirst, 'the second run must hash differently so its wedge stays acknowledgeable');
});

test('#2411: parallel-research sentinel target advances when slice or RESEARCH rows land', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });

  // The sentinel unit id "{mid}/parallel-research" maps to no real slice row,
  // so before the fix the snapshot hashed only the constant milestones row and
  // the completed-no-advance guard could never observe an advance — the wedge
  // was unacknowledgeable via --resume-wedge.
  const empty = readTargetSnapshot('research-slice', 'M001/parallel-research');
  assert.ok(empty, 'snapshot available once the milestone row exists');
  assert.equal(
    readTargetSnapshot('research-slice', 'M001/parallel-research'),
    empty,
    'zero-work completion leaves the hash identical',
  );

  // While nothing has landed, a completed-no-advance wedge for the sentinel
  // still blocks its recheck.
  assert.equal(
    recheckCompletedNoAdvanceWedge({
      guardId: 'completed-no-advance',
      unitType: 'research-slice',
      unitId: 'M001/parallel-research',
      inputHash: hashBackstopInput(empty),
    }).blocking,
    true,
    'the wedge recheck blocks while the snapshot is unchanged',
  );

  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  const afterSlice = readTargetSnapshot('research-slice', 'M001/parallel-research');
  assert.notEqual(afterSlice, empty, 'a slice row landing must advance the hash');

  insertArtifact({
    path: '.gsd/milestones/M001/research-S01.md',
    artifact_type: 'RESEARCH',
    milestone_id: 'M001',
    slice_id: 'S01',
    task_id: null,
    full_content: 'research for S01',
  });
  const afterArtifact = readTargetSnapshot('research-slice', 'M001/parallel-research');
  assert.ok(afterArtifact, 'snapshot after the RESEARCH artifact lands');
  assert.notEqual(afterArtifact, afterSlice, 'a slice RESEARCH artifact landing must advance the hash again');

  // A bookkeeping-only rewrite (same content, fresh imported_at) is not
  // advancement — pins the explicit-column selection.
  _getAdapter()!.prepare(
    "UPDATE artifacts SET imported_at = '2030-01-01T00:00:00.000Z' WHERE path = :path",
  ).run({ ':path': '.gsd/milestones/M001/research-S01.md' });
  assert.equal(
    readTargetSnapshot('research-slice', 'M001/parallel-research'),
    afterArtifact,
    'an imported_at touch must not change the hash',
  );

  // A task-level RESEARCH artifact is not this unit's deliverable — it must
  // not mask a no-op sentinel dispatch.
  insertArtifact({
    path: '.gsd/milestones/M001/slices/S01/tasks/S01-T01-RESEARCH.md',
    artifact_type: 'RESEARCH',
    milestone_id: 'M001',
    slice_id: 'S01',
    task_id: 'S01-T01',
    full_content: 'task-level research',
  });
  assert.equal(
    readTargetSnapshot('research-slice', 'M001/parallel-research'),
    afterArtifact,
    'a task-level RESEARCH artifact must not change the hash',
  );

  // The user-visible contract: once per-slice research has landed, the
  // empty-state wedge no longer blocks its recheck — while a wedge recorded
  // against the current state still does (a genuine no-op stays blocked).
  assert.equal(
    recheckCompletedNoAdvanceWedge({
      guardId: 'completed-no-advance',
      unitType: 'research-slice',
      unitId: 'M001/parallel-research',
      inputHash: hashBackstopInput(empty),
    }).blocking,
    false,
    'the wedge recheck clears once slice research has landed',
  );
  assert.equal(
    recheckCompletedNoAdvanceWedge({
      guardId: 'completed-no-advance',
      unitType: 'research-slice',
      unitId: 'M001/parallel-research',
      inputHash: hashBackstopInput(afterArtifact),
    }).blocking,
    true,
    'a wedge against the current state still blocks a genuine no-op',
  );
});
