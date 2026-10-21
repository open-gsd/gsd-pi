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
  insertMilestone,
  insertSlice,
  insertTask,
  insertAssessment,
  updateTaskStatus,
} from '../gsd-db.ts';
import {
  LIVENESS_TRIP_THRESHOLD,
  COMPLETED_NO_ADVANCE_GUARD_ID,
  acknowledgeWedge,
  formatWedgeRefusalNotice,
  formatWedgeTripNotice,
  getOpenWedge,
  hashBackstopInput,
  recordNonAdvancingOutcome,
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
