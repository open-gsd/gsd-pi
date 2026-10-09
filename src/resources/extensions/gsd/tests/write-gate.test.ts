// gsd-pi - Write gate regression tests.
/**
 * Unit tests for the CONTEXT.md write-gate (D031 guard chain).
 *
 * Exercises shouldBlockContextWrite() — a pure function that implements:
 *   (a) toolName !== "write" → pass
 *   (b) milestone context must resolve to a verified milestone
 *   (c) path doesn't match /M\d+-CONTEXT\.md$/ → pass
 *   (d) non-context files → pass
 *   (e) else → block with actionable reason
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isDepthVerified,
  isDepthConfirmationAnswer,
  isQueuePhaseActive,
  shouldBlockContextWrite,
  setQueuePhaseActive,
} from '../index.ts';
import {
  childWriteGateAdapter,
  markDepthVerified,
  isMilestoneDepthVerified,
  markApprovalGateVerified,
  shouldBlockContextArtifactSave,
  shouldBlockContextArtifactSaveInSnapshot,
  shouldBlockRootArtifactSaveInSnapshot,
  clearDiscussionFlowState,
  loadWriteGateSnapshot,
} from '../bootstrap/write-gate.ts';

afterEach(() => {
  clearDiscussionFlowState(process.cwd());
});

// ─── Scenario 1: Blocks CONTEXT.md write during discussion without depth verification (absolute path) ──

test('write-gate: blocks CONTEXT.md write during discussion without depth verification (absolute path)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md',
    'M001',
    false,
  );
  assert.strictEqual(result.block, true, 'should block the write');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 2: Blocks CONTEXT.md write during discussion without depth verification (relative path) ──

test('write-gate: blocks CONTEXT.md write during discussion without depth verification (relative path)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M005/M005-CONTEXT.md',
    'M005',
    false,
  );
  assert.strictEqual(result.block, true, 'should block the write');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 3: Allows CONTEXT.md write after depth verification ──

test('write-gate: allows CONTEXT.md write after depth verification', () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified('M001');
  const result = shouldBlockContextWrite(
    'write',
    '/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md',
    'M001',
  );
  assert.strictEqual(result.block, false, 'should not block after depth verification');
  assert.strictEqual(result.reason, undefined, 'should have no reason');
});

// ─── Scenario 4: Ambiguous session context no longer bypasses the gate ──

test('write-gate: blocks CONTEXT.md write when milestoneId is ambiguous', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,
  );
  assert.strictEqual(result.block, true, 'should block when milestone context is ambiguous');
});

// ─── Scenario 5: Allows non-CONTEXT.md writes during discussion ──

test('write-gate: allows non-CONTEXT.md writes during discussion', () => {
  // DISCUSSION.md
  const r1 = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-DISCUSSION.md',
    'M001',
  );
  assert.strictEqual(r1.block, false, 'DISCUSSION.md should pass');

  // Slice file
  const r2 = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    'M001',
  );
  assert.strictEqual(r2.block, false, 'slice plan should pass');

  // Regular code file
  const r3 = shouldBlockContextWrite(
    'write',
    'src/index.ts',
    'M001',
  );
  assert.strictEqual(r3.block, false, 'regular code file should pass');
});

// ─── Scenario 6: Regex specificity — doesn't match S01-CONTEXT.md ──

test('write-gate: regex does not match slice context files (S01-CONTEXT.md)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/slices/S01/S01-CONTEXT.md',
    'M001',
  );
  assert.strictEqual(result.block, false, 'S01-CONTEXT.md should not be blocked');
});

// ─── Scenario 7: Error message contains actionable instruction and anti-bypass language ──

test('write-gate: blocked reason contains depth_verification keyword and anti-bypass language', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M999/M999-CONTEXT.md',
    'M999',
  );
  assert.strictEqual(result.block, true);
  assert.ok(result.reason!.includes('depth_verification'), 'reason should mention depth_verification question id');
  assert.ok(result.reason!.includes('depth_verification_M999_confirm'), 'reason should mention the exact milestone gate id');
  assert.ok(result.reason!.includes('ask_user_questions'), 'reason should mention ask_user_questions tool');
  assert.ok(result.reason!.includes('MUST NOT'), 'reason should include anti-bypass language');
  assert.ok(result.reason!.includes('(Recommended)'), 'reason should specify the required confirmation option');
});

// ─── Scenario 8: Queue mode blocks CONTEXT.md write without depth verification ──

test('write-gate: blocks CONTEXT.md write in queue mode without depth verification', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,   // no milestoneId in queue mode
    true,   // queue phase active
  );
  assert.strictEqual(result.block, true, 'should block in queue mode without depth verification');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 9: Queue mode allows CONTEXT.md write after depth verification ──

test('write-gate: allows CONTEXT.md write in queue mode after depth verification', () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified('M001');
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,   // no milestoneId in queue mode
    true,   // queue phase active
  );
  assert.strictEqual(result.block, false, 'should not block in queue mode after depth verification');
});

// ─── Scenario 10: depth verification is scoped per milestone, not global ──

test('write-gate: markDepthVerified unlocks only the matching milestone', () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified('M001');

  const allowed = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,
  );
  assert.strictEqual(allowed.block, false, 'should allow the verified milestone');

  const blockedOther = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M002/M002-CONTEXT.md',
    null,
  );
  assert.strictEqual(blockedOther.block, true, 'other milestones should remain blocked');
  assert.strictEqual(isMilestoneDepthVerified('M001'), true);
  assert.strictEqual(isMilestoneDepthVerified('M002'), false);
});

// ─── Scenario 11: gsd_summary_save CONTEXT contract is milestone-scoped ──

test('write-gate: gsd_summary_save only blocks final milestone CONTEXT writes', () => {
  clearDiscussionFlowState(process.cwd());

  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT-DRAFT', 'M001').block,
    false,
    'draft CONTEXT should be allowed',
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001', 'S01').block,
    false,
    'slice CONTEXT should be allowed',
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001').block,
    true,
    'final milestone CONTEXT should block before verification',
  );

  markDepthVerified('M001');
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001').block,
    false,
    'final milestone CONTEXT should pass after verification',
  );
});

test('write-gate: root PROJECT/REQUIREMENTS final saves block behind pending approval gate', () => {
  const snapshot = {
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: 'depth_verification_requirements_confirm',
  };

  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, 'REQUIREMENTS').block,
    true,
    'final REQUIREMENTS.md must wait for approval',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, 'PROJECT').block,
    true,
    'final PROJECT.md must wait for approval',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, 'REQUIREMENTS-DRAFT').block,
    false,
    'draft requirements can still be saved',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot({ ...snapshot, pendingGateId: null }, 'REQUIREMENTS').block,
    false,
    'no pending approval gate means final root artifacts can save',
  );
});

test('write-gate: deep root PROJECT/REQUIREMENTS final saves require verified approval', () => {
  const snapshot = {
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: null,
  };

  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      snapshot,
      'PROJECT',
      { requireVerifiedApproval: true },
    ).block,
    true,
    'deep PROJECT save is fail-closed without verified project approval',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ['depth_verification_project_confirm'] },
      'PROJECT',
      { requireVerifiedApproval: true },
    ).block,
    false,
    'verified project approval unlocks PROJECT',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ['depth_verification_project_confirm'] },
      'REQUIREMENTS',
      { requireVerifiedApproval: true },
    ).block,
    true,
    'project approval does not unlock REQUIREMENTS',
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ['depth_verification_requirements_confirm'] },
      'REQUIREMENTS',
      { requireVerifiedApproval: true },
    ).block,
    false,
    'verified requirements approval unlocks REQUIREMENTS',
  );
});

test('write-gate: reopening a gate revokes its previous verified approval', () => {
  const base = join(tmpdir(), `gsd-write-gate-reopen-${randomUUID()}`);
  mkdirSync(base, { recursive: true });

  try {
    clearDiscussionFlowState(base);

    markApprovalGateVerified('depth_verification_project_confirm', base);
    assert.strictEqual(
      shouldBlockRootArtifactSaveInSnapshot(
        loadWriteGateSnapshot(base),
        'PROJECT',
        { requireVerifiedApproval: true },
      ).block,
      false,
      'precondition: verified approval unlocks the final project artifact',
    );

    // A genuine re-ask originates from the workflow MCP child (where
    // ask_user_questions executes): the child adapter arms unconditionally,
    // revoking the prior approval. Host-side setPendingGate is guarded
    // (verified-on-disk wins) and would deliberately suppress this arm.
    childWriteGateAdapter.setPending('depth_verification_project_confirm', base);
    clearPendingGate(base);

    assert.strictEqual(
      shouldBlockRootArtifactSaveInSnapshot(
        loadWriteGateSnapshot(base),
        'PROJECT',
        { requireVerifiedApproval: true },
      ).block,
      true,
      'a re-asked gate must require a fresh approval',
    );
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Discussion gate enforcement tests (pending gate mechanism)
// ═══════════════════════════════════════════════════════════════════════

import {
  applyAskUserQuestionsGateResult,
  formatPendingAskUserQuestionsGateMessage,
  formatTimedOutAskUserQuestionsGateMessage,
  isGateQuestionId,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  setPendingGate,
  clearPendingGate,
  getPendingGate,
} from '../bootstrap/write-gate.ts';

// ─── Scenario 19: isGateQuestionId recognizes all gate patterns ──

test('write-gate: isGateQuestionId recognizes all gate patterns', () => {
  assert.strictEqual(isGateQuestionId('depth_verification'), true);
  assert.strictEqual(isGateQuestionId('depth_verification_M002'), true);
  assert.strictEqual(isGateQuestionId('depth_verification_confirm'), true);
  // Non-gate question IDs
  assert.strictEqual(isGateQuestionId('project_intent'), false);
  assert.strictEqual(isGateQuestionId('feature_priority'), false);
  assert.strictEqual(isGateQuestionId('layer1_scope_gate'), false);
  assert.strictEqual(isGateQuestionId(''), false);
});

// ─── Scenario 20: setPendingGate / getPendingGate / clearPendingGate lifecycle ──

test('write-gate: pending gate lifecycle (set, get, clear)', () => {
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(getPendingGate(), null, 'starts null');

  setPendingGate('depth_verification', process.cwd());
  assert.strictEqual(getPendingGate(), 'depth_verification', 'set correctly');

  clearPendingGate(process.cwd());
  assert.strictEqual(getPendingGate(), null, 'cleared correctly');

  // clearDiscussionFlowState also clears pending gate
  setPendingGate('depth_verification_M002', process.cwd());
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(getPendingGate(), null, 'clearDiscussionFlowState clears pending gate');
});

test('write-gate: applyAskUserQuestionsGateResult keeps cancelled pending gate waiting', () => {
  const base = join(tmpdir(), `gsd-write-gate-ask-waiting-${randomUUID()}`);
  const gateId = 'depth_verification_M001_confirm';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      details: { cancelled: true, interrupted: true },
    });

    assert.deepEqual(result, {
      status: 'waiting',
      pendingGateId: gateId,
      interrupted: true,
    });
    assert.strictEqual(getPendingGate(base), gateId, 'cancelled question must leave gate pending');
    assert.strictEqual(isMilestoneDepthVerified('M001', base), false, 'cancelled question must not verify depth');
    assert.match(
      formatPendingAskUserQuestionsGateMessage(gateId, true),
      /Re-call ask_user_questions with the same gate question id/,
    );
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test('write-gate: applyAskUserQuestionsGateResult verifies confirmed pending gate', () => {
  const base = join(tmpdir(), `gsd-write-gate-ask-verified-${randomUUID()}`);
  const gateId = 'depth_verification_M001_confirm';
  const confirmLabel = 'Confirm depth (Recommended)';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: confirmLabel }, { label: 'Needs adjustment' }],
      }],
      details: {
        response: {
          answers: {
            [gateId]: { selected: confirmLabel },
          },
        },
      },
    });

    assert.deepEqual(result, {
      status: 'verified',
      gateId,
      milestoneId: 'M001',
      verifiedGateIds: [gateId],
    });
    assert.strictEqual(getPendingGate(base), null, 'confirmed gate must clear pending state');
    assert.strictEqual(isMilestoneDepthVerified('M001', base), true, 'confirmed gate must verify milestone depth');
    assert.ok(
      loadWriteGateSnapshot(base).verifiedApprovalGates?.includes(gateId) ?? false,
      'confirmed gate must record verified approval',
    );
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test('write-gate: applyAskUserQuestionsGateResult reports declined pending gate (consent-verdict semantics)', () => {
  const base = join(tmpdir(), `gsd-write-gate-ask-declined-${randomUUID()}`);
  const gateId = 'depth_verification_M001_confirm';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      details: {
        response: { answers: { [gateId]: { selected: 'Needs adjustment' } } },
      },
    });

    assert.deepEqual(result, { status: 'declined', gateId });
    assert.strictEqual(getPendingGate(base), gateId, 'declined gate must stay pending');
    assert.strictEqual(isMilestoneDepthVerified('M001', base), false, 'declined gate must not verify depth');
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test('write-gate: applyAskUserQuestionsGateResult keeps empty-selection pending gate waiting (consent-verdict semantics)', () => {
  // An empty selection is never an answer (fail-closed): the round used to
  // report "answered" here, silently treating a missing selection as resolved.
  const base = join(tmpdir(), `gsd-write-gate-ask-empty-${randomUUID()}`);
  const gateId = 'depth_verification_M001_confirm';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      details: {
        response: { answers: { [gateId]: { selected: '' } } },
      },
    });

    assert.deepEqual(result, { status: 'waiting', pendingGateId: gateId, interrupted: false });
    assert.strictEqual(getPendingGate(base), gateId, 'unanswered gate must stay pending');
    assert.strictEqual(isMilestoneDepthVerified('M001', base), false, 'unanswered gate must not verify depth');
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Scenario 20e: several gate questions in one round (#2653) ──────────────
//
// The payload validator allows 1-3 questions per round, and arming stores one
// pending slot (the last gate id wins). Verifying only that slot silently
// dropped the user's other confirmations: M028 unlocked, M025/M027 came back
// as HARD BLOCK on save. Every gate question answered in the round must be
// evaluated against the round's answers.

function gateQuestion(id: string) {
  return { id, options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }] };
}

const CONFIRM = 'Confirm depth (Recommended)';
const DECLINE = 'Needs adjustment';

function makeGateBase(t: { after: (fn: () => void) => void }, label: string): string {
  const base = join(tmpdir(), `gsd-write-gate-ask-${label}-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  clearDiscussionFlowState(base);
  t.after(() => {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test('write-gate: applyAskUserQuestionsGateResult verifies every confirmed gate in a multi-gate round (#2653)', (t) => {
  const base = makeGateBase(t, 'multi');
  const gates = ['depth_verification_M025_confirm', 'depth_verification_M027_confirm', 'depth_verification_M028_confirm'];

  // Mirror recordAskUserQuestionsPendingGate: every gate id armed, single
  // slot keeps the last.
  for (const id of gates) setPendingGate(id, base);
  assert.strictEqual(getPendingGate(base), gates[gates.length - 1]);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: gates.map(gateQuestion),
    details: {
      response: {
        answers: Object.fromEntries(gates.map((id) => [id, { selected: CONFIRM }])),
      },
    },
  });

  assert.deepEqual(result, {
    status: 'verified',
    gateId: gates[gates.length - 1],
    milestoneId: 'M028',
    verifiedGateIds: gates,
  });
  for (const id of gates) {
    const milestone = id.replace('depth_verification_', '').replace('_confirm', '');
    assert.strictEqual(
      isMilestoneDepthVerified(milestone, base),
      true,
      `${milestone} must be unlocked by its in-round confirmation`,
    );
    assert.ok(
      loadWriteGateSnapshot(base).verifiedApprovalGates?.includes(id) ?? false,
      `${id} must record verified approval`,
    );
  }
  assert.strictEqual(getPendingGate(base), null, 'a fully verified round clears the pending slot');
});

test('write-gate: applyAskUserQuestionsGateResult fails closed when one gate of a multi-gate round is declined (#2653)', (t) => {
  const base = makeGateBase(t, 'multi-declined');
  const confirm = 'depth_verification_M025_confirm';
  const declined = 'depth_verification_M027_confirm';

  for (const id of [confirm, declined]) setPendingGate(id, base);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(confirm), gateQuestion(declined)],
    details: {
      response: {
        answers: {
          [confirm]: { selected: CONFIRM },
          [declined]: { selected: DECLINE },
        },
      },
    },
  });

  assert.deepEqual(result, { status: 'declined', gateId: declined, verifiedGateIds: [confirm] });
  assert.strictEqual(isMilestoneDepthVerified('M025', base), true, 'the confirmed gate still unlocks');
  assert.strictEqual(isMilestoneDepthVerified('M027', base), false, 'the declined gate stays locked');
  assert.strictEqual(getPendingGate(base), declined, 'the declined gate is the pending gate');
});

test('write-gate: declined armed gate keeps pending while a later gate verifies (#2653)', (t) => {
  // Reversed order: the ARMED (last-armed) gate is declined and an earlier
  // question is confirmed — the decline must win the pending slot over the
  // armed-slot clear.
  const base = makeGateBase(t, 'multi-declined-armed');
  const confirm = 'depth_verification_M025_confirm';
  const declinedArmed = 'depth_verification_M027_confirm';

  for (const id of [confirm, declinedArmed]) setPendingGate(id, base);
  assert.strictEqual(getPendingGate(base), declinedArmed);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(confirm), gateQuestion(declinedArmed)],
    details: {
      response: {
        answers: {
          [confirm]: { selected: CONFIRM },
          [declinedArmed]: { selected: DECLINE },
        },
      },
    },
  });

  assert.equal(result.status, 'declined');
  assert.strictEqual(isMilestoneDepthVerified('M025', base), true);
  assert.strictEqual(getPendingGate(base), declinedArmed, 'decline wins over the armed-slot clear');
});

test('write-gate: an unanswered gate keeps the pending block when the armed gate confirms (#2653)', (t) => {
  // Reversed order: the unanswered gate comes FIRST, the armed (last) gate is
  // confirmed. Clearing the armed slot must not drop the unanswered gate's
  // pending block — otherwise shouldBlockPendingGate stops freezing tools
  // while a gate is still unverified.
  const base = makeGateBase(t, 'multi-waiting-clears');
  const answered = 'depth_verification_M027_confirm';
  const unansweredArmed = 'depth_verification_M025_confirm';

  for (const id of [unansweredArmed, answered]) setPendingGate(id, base);
  assert.strictEqual(getPendingGate(base), answered);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(unansweredArmed), gateQuestion(answered)],
    details: {
      response: { answers: { [answered]: { selected: CONFIRM } } },
    },
  });

  assert.deepEqual(result, {
    status: 'waiting',
    pendingGateId: unansweredArmed,
    interrupted: false,
    verifiedGateIds: [answered],
  });
  assert.strictEqual(isMilestoneDepthVerified('M027', base), true, 'the answered gate still unlocks');
  assert.strictEqual(isMilestoneDepthVerified('M025', base), false, 'the unanswered gate stays locked');
  assert.strictEqual(getPendingGate(base), unansweredArmed, 'the unanswered gate owns the pending slot');
});

test('write-gate: a confirmation for a gate other than the armed one does not report success (#2653)', (t) => {
  // The armed gate was left pending by an earlier round; this round asks and
  // confirms a different gate. The new confirmation is recorded, but the
  // result must name the armed gate as unresolved so the caller re-asks it.
  const base = makeGateBase(t, 'multi-armed-absent');
  const armed = 'depth_verification_M025_confirm';
  const asked = 'depth_verification_M027_confirm';

  setPendingGate(armed, base);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(asked)],
    details: {
      response: { answers: { [asked]: { selected: CONFIRM } } },
    },
  });

  assert.deepEqual(result, {
    status: 'waiting',
    pendingGateId: armed,
    interrupted: false,
    verifiedGateIds: [asked],
  });
  assert.strictEqual(isMilestoneDepthVerified('M027', base), true, 'the answered gate is still recorded');
  assert.strictEqual(isMilestoneDepthVerified('M025', base), false, 'the armed gate stays locked');
  assert.strictEqual(getPendingGate(base), armed, 'the armed gate stays pending');
});

test('write-gate: a declined gate does not displace the armed unanswered gate in the pending slot (#2653)', (t) => {
  // Armed gate A went unanswered; gate B was explicitly declined. The result
  // names A (the caller re-asks A), so the pending slot must hold A too — a
  // decline re-arm must not overwrite it, or the next confirmed round would
  // clear the freeze while B is still unresolved.
  const base = makeGateBase(t, 'multi-armed-waiting-declined');
  const armedWaiting = 'depth_verification_M025_confirm';
  const declined = 'depth_verification_M027_confirm';

  for (const id of [declined, armedWaiting]) setPendingGate(id, base);
  assert.strictEqual(getPendingGate(base), armedWaiting);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(armedWaiting), gateQuestion(declined)],
    details: {
      response: { answers: { [declined]: { selected: DECLINE } } },
    },
  });

  assert.deepEqual(result, {
    status: 'waiting',
    pendingGateId: armedWaiting,
    interrupted: false,
  });
  assert.strictEqual(isMilestoneDepthVerified('M025', base), false);
  assert.strictEqual(isMilestoneDepthVerified('M027', base), false, 'the declined gate stays locked');
  assert.strictEqual(getPendingGate(base), armedWaiting, 'the armed unanswered gate owns the pending slot');
});

test('write-gate: applyAskUserQuestionsGateResult fails closed when one gate of a multi-gate round is unanswered (#2653)', (t) => {
  const base = makeGateBase(t, 'multi-empty');
  const answered = 'depth_verification_M025_confirm';
  const unanswered = 'depth_verification_M027_confirm';

  for (const id of [answered, unanswered]) setPendingGate(id, base);

  const result = applyAskUserQuestionsGateResult({
    basePath: base,
    questions: [gateQuestion(answered), gateQuestion(unanswered)],
    details: {
      response: { answers: { [answered]: { selected: '' } } },
    },
  });

  assert.deepEqual(result, { status: 'waiting', pendingGateId: unanswered, interrupted: false });
  assert.strictEqual(isMilestoneDepthVerified('M025', base), false, 'the empty selection is not an answer');
  assert.strictEqual(isMilestoneDepthVerified('M027', base), false, 'the unanswered gate stays locked');
});

// ─── Scenario 20d: applyAskUserQuestionsGateResult reports timed_out gate (#852) ──
//
// A host elicitation timeout must NOT be laundered into "waiting" (which tells
// the model to re-ask — that just hits the same timeout again) nor into
// "verified" (a timeout is never approval). The gate stays pending (fail-
// closed) but the status is "timeout" so the caller pauses-and-waits.

test('write-gate: applyAskUserQuestionsGateResult reports timed_out pending gate (#852)', () => {
  const base = join(tmpdir(), `gsd-write-gate-ask-timeout-${randomUUID()}`);
  const gateId = 'depth_verification_M001_confirm';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      // A timed-out round is marked cancelled:true + timed_out:true (the
      // structuredContent the MCP child returns on host timeout).
      details: { cancelled: true, timed_out: true, interrupted: false },
    });

    assert.deepEqual(result, {
      status: 'timeout',
      pendingGateId: gateId,
      interrupted: false,
    });
    assert.strictEqual(getPendingGate(base), gateId, 'timed-out gate must stay pending (fail-closed)');
    assert.strictEqual(isMilestoneDepthVerified('M001', base), false, 'timed-out gate must not verify depth');
    // The timeout message must NOT tell the model to immediately re-ask.
    const message = formatTimedOutAskUserQuestionsGateMessage(gateId);
    assert.match(message, /timed out/, 'message says timed out');
    assert.doesNotMatch(message, /Re-call ask_user_questions/, 'message must NOT invite immediate re-ask');
    assert.match(message, /do not re-ask/i, 'message explicitly says do not re-ask');
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test('write-gate: applyAskUserQuestionsGateResult reports timed_out even with interrupted:true', () => {
  // timed_out wins over the interrupted flag — both are host-side failures,
  // but timeout is the more specific signal and must reach the caller.
  const base = join(tmpdir(), `gsd-write-gate-ask-timeout-interrupted-${randomUUID()}`);
  const gateId = 'depth_verification_M002_confirm';

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);
    setPendingGate(gateId, base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: gateId,
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      details: { cancelled: true, timed_out: true, interrupted: true },
    });

    assert.deepEqual(result, {
      status: 'timeout',
      pendingGateId: gateId,
      interrupted: true,
    });
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test('write-gate: timed_out gate with no pending gate returns not-gate', () => {
  // A timed-out round arriving when no gate is armed (e.g. informational
  // question) is not a gate concern — fail-open here, matching cancelled.
  const base = join(tmpdir(), `gsd-write-gate-ask-timeout-nogate-${randomUUID()}`);

  try {
    mkdirSync(base, { recursive: true });
    clearDiscussionFlowState(base);

    const result = applyAskUserQuestionsGateResult({
      basePath: base,
      questions: [{
        id: 'depth_verification_M001_confirm',
        options: [{ label: 'Confirm depth (Recommended)' }, { label: 'Needs adjustment' }],
      }],
      details: { cancelled: true, timed_out: true },
    });

    assert.deepEqual(result, { status: 'not-gate' });
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Scenario 21: shouldBlockPendingGate blocks non-safe tools when gate is pending ──

test('write-gate: shouldBlockPendingGate blocks write/edit during pending gate', () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate('depth_verification', process.cwd());

  // write should be blocked during discussion
  const writeResult = shouldBlockPendingGate('write', 'M001', false);
  assert.strictEqual(writeResult.block, true, 'write should be blocked');
  assert.ok(writeResult.reason!.includes('depth_verification'), 'reason mentions the gate');

  // edit should be blocked
  const editResult = shouldBlockPendingGate('edit', 'M001', false);
  assert.strictEqual(editResult.block, true, 'edit should be blocked');

  // gsd tools should be blocked
  const gsdResult = shouldBlockPendingGate('gsd_plan_milestone', 'M001', false);
  assert.strictEqual(gsdResult.block, true, 'gsd tools should be blocked');
});

// ─── Scenario 22: shouldBlockPendingGate allows only re-asking when gate is pending ──

test('write-gate: shouldBlockPendingGate blocks read-only tools and allows ask_user_questions during pending gate', () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate('depth_verification', process.cwd());

  // ask_user_questions is always safe (model needs to re-ask)
  assert.strictEqual(shouldBlockPendingGate('ask_user_questions', 'M001').block, false);
  // read-only tools are blocked so the user-facing question remains visible
  assert.strictEqual(shouldBlockPendingGate('read', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGate('grep', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGate('glob', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGate('ls', 'M001').block, true);
});

// ─── Scenario 23: shouldBlockPendingGate still blocks when the session is ambiguous ──

test('write-gate: shouldBlockPendingGate blocks outside discussion when a gate is pending', () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate('depth_verification', process.cwd());

  // No milestoneId and no queue phase — still block because the gate is pending
  const result = shouldBlockPendingGate('write', null, false);
  assert.strictEqual(result.block, true, 'should block even when milestoneId is null');
});

// ─── Scenario 24: shouldBlockPendingGate blocks in queue mode ──

test('write-gate: shouldBlockPendingGate blocks in queue mode when gate is pending', () => {
  clearDiscussionFlowState(process.cwd());
  setQueuePhaseActive(true, process.cwd());
  setPendingGate('depth_verification', process.cwd());

  const result = shouldBlockPendingGate('write', null, true);
  assert.strictEqual(result.block, true, 'should block in queue mode');
});

// ─── Scenario 25: shouldBlockPendingGateBash blocks read-only commands ──

test('write-gate: shouldBlockPendingGateBash blocks read-only commands during pending gate', () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate('depth_verification', process.cwd());

  assert.strictEqual(shouldBlockPendingGateBash('cat file.txt', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGateBash('git log --oneline', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGateBash('grep -r pattern .', 'M001').block, true);
  assert.strictEqual(shouldBlockPendingGateBash('ls -la', 'M001').block, true);
});

// ─── Scenario 26: shouldBlockPendingGateBash blocks mutating commands ──

test('write-gate: shouldBlockPendingGateBash blocks mutating commands during pending gate', () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate('depth_verification', process.cwd());

  const result = shouldBlockPendingGateBash('npm run build', 'M001');
  assert.strictEqual(result.block, true, 'mutating bash should be blocked');
  assert.ok(result.reason!.includes('depth_verification'));
});

// ─── Scenario 27: no pending gate means no blocking ──

test('write-gate: no pending gate means no blocking', () => {
  clearDiscussionFlowState(process.cwd());

  assert.strictEqual(shouldBlockPendingGate('write', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGateBash('npm run build', 'M001').block, false);
});

// ─── Scenario 28: clearDiscussionFlowState clears pending gate ──

test('write-gate: clearDiscussionFlowState clears pending gate', () => {
  setPendingGate('depth_verification', process.cwd());
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(getPendingGate(), null);
});

test('write-gate: in-memory state is scoped by basePath', () => {
  const workspaceA = join(tmpdir(), `gsd-write-gate-isolation-a-${randomUUID()}`);
  const workspaceB = join(tmpdir(), `gsd-write-gate-isolation-b-${randomUUID()}`);

  try {
    clearDiscussionFlowState(workspaceA);
    clearDiscussionFlowState(workspaceB);

    setPendingGate('depth_verification_M777', workspaceA);
    assert.strictEqual(getPendingGate(workspaceA), 'depth_verification_M777', 'workspace A should see its pending gate');
    assert.strictEqual(getPendingGate(workspaceB), null, 'workspace B should not see workspace A pending gate');

    clearPendingGate(workspaceA);
    setQueuePhaseActive(true, workspaceA);
    assert.strictEqual(isQueuePhaseActive(workspaceA), true, 'workspace A should see queue mode active');
    assert.strictEqual(isQueuePhaseActive(workspaceB), false, 'workspace B should not see workspace A queue mode');

    markDepthVerified('M777', workspaceA);
    assert.strictEqual(isMilestoneDepthVerified('M777', workspaceA), true, 'workspace A should see its verified milestone');
    assert.strictEqual(isMilestoneDepthVerified('M777', workspaceB), false, 'workspace B should not see workspace A milestone verification');
    assert.strictEqual(isDepthVerified(workspaceB), false, 'workspace B should have no verified depth state');
  } finally {
    clearDiscussionFlowState(workspaceA);
    clearDiscussionFlowState(workspaceB);
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  }
});

// ─── Standard options fixture used across depth confirmation tests ──

const STANDARD_OPTIONS = [
  { label: 'Yes, you got it (Recommended)' },
  { label: 'Not quite — let me clarify' },
];

// ─── Scenario 11: accepts first option (confirmation) with structural validation ──

test('write-gate: isDepthConfirmationAnswer accepts first option with options present', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)', STANDARD_OPTIONS),
    true,
    'should accept exact match of first option label',
  );
});

// ─── Scenario 12: rejects second option (decline) ──

test('write-gate: isDepthConfirmationAnswer rejects decline option', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('Not quite — let me clarify', STANDARD_OPTIONS),
    false,
    'should reject the clarification option',
  );
});

// ─── Scenario 13: rejects "None of the above" ──

test('write-gate: isDepthConfirmationAnswer rejects None of the above', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('None of the above', STANDARD_OPTIONS),
    false,
    'should reject None of the above',
  );
});

// ─── Scenario 14: rejects garbage/empty input ──

test('write-gate: isDepthConfirmationAnswer rejects garbage and edge cases', () => {
  assert.strictEqual(isDepthConfirmationAnswer('discord', STANDARD_OPTIONS), false, 'garbage string');
  assert.strictEqual(isDepthConfirmationAnswer('', STANDARD_OPTIONS), false, 'empty string');
  assert.strictEqual(isDepthConfirmationAnswer(undefined, STANDARD_OPTIONS), false, 'undefined');
  assert.strictEqual(isDepthConfirmationAnswer(null, STANDARD_OPTIONS), false, 'null');
  assert.strictEqual(isDepthConfirmationAnswer(42, STANDARD_OPTIONS), false, 'number');
});

// ─── Scenario 15: handles array-wrapped selection ──

test('write-gate: isDepthConfirmationAnswer handles array-wrapped selected value', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer(['Yes, you got it (Recommended)'], STANDARD_OPTIONS),
    true,
    'should accept array-wrapped confirmation',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer(['Not quite — let me clarify'], STANDARD_OPTIONS),
    false,
    'should reject array-wrapped decline',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer([], STANDARD_OPTIONS),
    false,
    'should reject empty array',
  );
});

// ─── Scenario 16: rejects free-form "Other" text that contains "(Recommended)" ──

test('write-gate: isDepthConfirmationAnswer rejects free-form text containing Recommended', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('I think this is fine (Recommended)', STANDARD_OPTIONS),
    false,
    'free-form text with (Recommended) substring must not unlock gate',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('(Recommended)', STANDARD_OPTIONS),
    false,
    'bare (Recommended) string must not unlock gate',
  );
});

// ─── Scenario 17: works with changed label text (decoupled from specific copy) ──

test('write-gate: isDepthConfirmationAnswer works with different label text', () => {
  const customOptions = [
    { label: 'Looks good, proceed' },
    { label: 'Needs more discussion' },
  ];
  assert.strictEqual(
    isDepthConfirmationAnswer('Looks good, proceed', customOptions),
    true,
    'should accept first option regardless of label text',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('Needs more discussion', customOptions),
    false,
    'should reject second option',
  );
  // Old label should NOT work with new options
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)', customOptions),
    false,
    'old label text should not match new options',
  );
});

// ─── Scenario 18: fail-closed when options not available (#4950) ──

test('write-gate: isDepthConfirmationAnswer fails closed when options are missing (#4950)', () => {
  // After #4950 the substring fallback was removed. Without options the gate
  // can never be unlocked — every input must return false.
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)'),
    false,
    'no-options + Recommended substring must NOT unlock the gate',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('Not quite — let me clarify'),
    false,
    'no-options + non-Recommended must NOT unlock the gate',
  );
});
