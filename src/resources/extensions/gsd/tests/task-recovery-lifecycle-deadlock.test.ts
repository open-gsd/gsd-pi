// Project/App: gsd-pi
// File Purpose: Regression test for the stale timeout-recovery state that wedges a re-dispatched Task.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { recoverTimedOutUnit } from "../auto-timeout-recovery.js";
import { resolveArtifactVerificationBase, resolveExpectedArtifactPath } from "../auto-recovery.js";
import { resolveDispatchRecoveryAttempts } from "../auto/unit-phase.js";
import { executeDomainOperation } from "../db/domain-operation.js";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.js";
import { _getAdapter, closeDatabase, getTask, openDatabase } from "../gsd-db.js";
import { publishVerifiedTaskCompletion, resolveTaskCompletionAuthority, stageTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.js";
import { readTaskRecoveryRoute, recordFailureAndSelectRecovery, resumeTaskRecovery } from "../task-recovery-domain-operation.js";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../unit-runtime.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" } as const;
const UNIT = "M001/S01/T01";
const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function database() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function invocation(idempotencyKey: string, actorType: "agent" | "user" = "agent") {
  return {
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType,
    ...(actorType === "user" ? { actorId: "operator-1" } : {}),
  };
}

function insertDispatch(basePath: string, attemptNumber: number): number {
  database().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (?, ?, 'worker-1', 7, 'M001', 'S01', 'T01',
      'execute-task', 'M001/S01/T01', 'claimed', ?, ?)
  `).run(
    `trace-${attemptNumber}`,
    `turn-${attemptNumber}`,
    attemptNumber,
    `2026-11-10T00:0${attemptNumber}:00.000Z`,
  );
  const row = database().prepare("SELECT MAX(id) AS id FROM unit_dispatches").get() as { id: number };
  return Number(row.id);
}

function seedProject(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-recovery-lifecycle-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, ".gitignore"), "gsd.db*\n.gsd/\n");
  writeFileSync(join(basePath, "verify.mjs"), "console.log('ok')\n");
  execFileSync("git", ["add", ".gitignore", "verify.mjs"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });

  mkdirSync(join(basePath, ".gsd", "phases", "01-slice"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "phases", "01-slice", "01-01-PLAN.md"), [
    "# S01: Recovery lifecycle",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Recover the task** `est:30m`",
    "  - Do: Complete the recovered execution",
    "  - Verify: node verify.mjs",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  database().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Recovery lifecycle', 'active', '2026-11-10T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery', 'active', '2026-11-10T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, full_summary_md, verify)
    VALUES ('M001', 'S01', 'T01', 'Recover the task', 'pending', '# T01: Recover the task\n', 'node verify.mjs');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-11-10T00:00:00.000Z', 'test',
      '2026-11-10T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-11-10T00:00:00.000Z',
      '2099-11-10T00:00:00.000Z', 'held'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{ eventType: "test.task.ready", entityType: "task", entityId: UNIT, payload: { taskId: "T01" }, destinations: ["test"] }],
      projections: [{ projectionKey: "test/m001/s01/t01", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return basePath;
}

function claim(basePath: string, dispatchId: number, attemptNumber: number, retryOfAttemptId?: string) {
  return claimTaskAttempt({
    invocation: invocation(`fixture/claim/${attemptNumber}`),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
  });
}

function recordFailingVerdict(attemptId: string, key: string) {
  return recordTaskTechnicalVerdict({
    invocation: invocation(key),
    attemptId,
    testedSourceRevision: "sha256:failed-source",
    verdict: "fail",
    rationale: "Host verification failed before the environment was repaired.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node verify.mjs",
      workingDirectory: "/tmp/project",
      startedAt: "2026-11-10T00:01:00.000Z",
      endedAt: "2026-11-10T00:01:01.000Z",
      exitCode: 1,
      observation: "failed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function recordPassingVerdict(basePath: string, attemptId: string, key: string) {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  return recordTaskTechnicalVerdict({
    invocation: invocation(key),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "The repaired Task passed host verification.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node verify.mjs",
      workingDirectory: basePath,
      startedAt: "2026-11-10T00:05:00.000Z",
      endedAt: "2026-11-10T00:05:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function runtimeRecoveryContext(basePath: string, startedAt: number) {
  return {
    basePath,
    verbose: false,
    currentUnitStartedAt: startedAt,
    unclaimedUnitBudgets: new Map<string, number>(),
  };
}

function startRun(basePath: string, startedAt: number) {
  return writeUnitRuntimeRecord(basePath, "execute-task", UNIT, startedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: startedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
    recoveryAttempts: resolveDispatchRecoveryAttempts(new Map(), "execute-task", UNIT),
  });
}

function blockerPath(basePath: string): string {
  const artifactBase = resolveArtifactVerificationBase(UNIT, basePath);
  const summary = resolveExpectedArtifactPath("execute-task", UNIT, artifactBase);
  assert.ok(summary, "execute-task projection path resolves");
  return summary.replace(/-SUMMARY\.md$/u, "-RECOVERY-BLOCKER.md");
}

function recordingHarness() {
  const messages: Array<{ content?: string }> = [];
  const notifications: string[] = [];
  return {
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as never,
    pi: { sendMessage: (message: { content?: string }) => messages.push(message) } as never,
    messages,
    notifications,
  };
}

test("a re-dispatched Attempt gets a fresh recovery budget and can complete the Task", async () => {
  const basePath = seedProject();
  const firstDispatch = insertDispatch(basePath, 1);
  const first = claim(basePath, firstDispatch, 1);
  const firstSettlement = settleTaskAttempt({
    invocation: invocation("fixture/settle/1"),
    attemptId: first.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Candidate implementation is ready for host verification.",
    output: { changedFiles: ["verify.mjs"] },
  });
  assert.equal(firstSettlement.nextStage, "verify");
  recordFailingVerdict(first.attemptId, "fixture/verdict/1");

  // First verification failure: durable remediation, not a terminal abort.
  const remediation = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/route/1"),
    attemptId: first.attemptId,
    resultId: firstSettlement.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: "Host verification failed.",
    evidence: { command: "node verify.mjs", exitCode: 1 },
    rationale: "Repair the failed verification evidence in the successor Attempt.",
  });
  assert.equal(remediation.action, "remediate");

  // The successor Attempt ends without a succeeded executor Result and is
  // parked at the route head before the abort.
  const secondDispatch = insertDispatch(basePath, 2);
  const second = claim(basePath, secondDispatch, 2, first.attemptId);
  const secondSettlement = settleTaskAttempt({
    invocation: invocation("fixture/settle/2"),
    attemptId: second.attemptId,
    outcome: "failed",
    failureClass: "lifecycle-progression",
    summary: "execute-task ended without a succeeded executor Result",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/route/2"),
    attemptId: second.attemptId,
    resultId: secondSettlement.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "execute-task ended without a succeeded executor Result",
    evidence: { source: "reconcile" },
    rationale: "The Task cannot progress from this failure route.",
  });
  assert.equal(abort.action, "abort");
  assert.equal(readTaskRecoveryRoute(second.attemptId)?.action, "abort");

  // Recovery resume authorizes exactly one successor Attempt.
  resumeTaskRecovery({
    invocation: invocation("fixture/resume/1", "user"),
    recoveryActionId: abort.recoveryActionId,
    repairSummary: "The verification environment was restored.",
    evidence: { command: "node verify.mjs", exitCode: 0, verdict: "PASS" },
  });

  const staleStartedAt = Date.now() - 60_000;
  writeUnitRuntimeRecord(basePath, "execute-task", UNIT, staleStartedAt, {
    phase: "recovered",
    timeoutAt: Date.now() - 30_000,
    recoveryAttempts: 2,
    lastRecoveryReason: "idle",
  });

  // Auto-mode claims the authorized successor and starts a new run.
  const thirdDispatch = insertDispatch(basePath, 3);
  const third = claim(basePath, thirdDispatch, 3, second.attemptId);
  const thirdStartedAt = Date.now();
  const fresh = startRun(basePath, thirdStartedAt);

  // This assertion fails on the original implementation: the stale run's
  // recoveryAttempts/timeoutAt survive into the new Attempt.
  assert.equal(fresh.recoveryAttempts, 0, "a new dispatch must start with a fresh recovery budget");
  assert.equal(fresh.timeoutAt, null, "a new dispatch must not inherit the prior run's timeout");

  const harness = recordingHarness();
  const recovered = await recoverTimedOutUnit(
    harness.ctx,
    harness.pi,
    "execute-task",
    UNIT,
    "idle",
    runtimeRecoveryContext(basePath, thirdStartedAt),
  );
  assert.equal(recovered, "recovered");
  assert.equal(harness.messages.length, 1, "the successor Attempt receives its first steering recovery");
  const afterRecovery = readUnitRuntimeRecord(basePath, "execute-task", UNIT);
  assert.equal(afterRecovery?.recoveryAttempts, 1);
  assert.equal(existsSync(blockerPath(basePath)), false);

  // The recovered executor stages a fresh completion, verification passes,
  // and canonical publication closes the Task.
  assert.equal(resolveTaskCompletionAuthority(TASK), "canonical");
  await stageTaskCompletion({
    invocation: invocation("fixture/stage/3"),
    basePath,
    task: TASK,
    completion: {
      oneLiner: "Recovered the Task after restoring the verification environment.",
      narrative: "The executor completed the Task in the authorized successor Attempt.",
      verification: "node verify.mjs exited 0",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["verify.mjs"],
      keyDecisions: ["Use the recovery-authorized successor Attempt."],
      blockerDiscovered: false,
      verificationEvidence: [{ command: "node verify.mjs", exitCode: 0, verdict: "PASS", durationMs: 10 }],
    },
  });
  recordPassingVerdict(basePath, third.attemptId, "fixture/verdict/3");
  const published = await publishVerifiedTaskCompletion({
    invocation: invocation("fixture/publish/3"),
    basePath,
    task: TASK,
    attemptId: third.attemptId,
  });
  assert.equal(published.status, "committed");
  assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
  assert.equal(database().prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id='T01'").get()?.lifecycle_status, "completed");
});

test("repeated idle recovery is bounded per dispatch and a new dispatch resets it", async () => {
  const basePath = seedProject();
  const dispatchId = insertDispatch(basePath, 1);
  const attempt1 = claim(basePath, dispatchId, 1);
  const startedAt = Date.now();
  startRun(basePath, startedAt);

  const harness = recordingHarness();
  const context = () => runtimeRecoveryContext(basePath, startedAt);

  const first = await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  const second = await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  assert.equal(first, "recovered");
  assert.equal(second, "recovered");
  assert.equal(harness.messages.length, 2, "the first two per-dispatch recoveries steer");

  const third = await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  assert.equal(third, "recovered");
  assert.equal(harness.messages.length, 2, "the exhausted third recovery must not steer again");
  assert.equal(existsSync(blockerPath(basePath)), true);
  assert.equal(readUnitRuntimeRecord(basePath, "execute-task", UNIT)?.recoveryAttempts, 3);

  // A new dispatch (and therefore a new Attempt) starts its own budget.
  settleTaskAttempt({
    invocation: invocation("fixture/settle/1"),
    attemptId: attempt1.attemptId,
    outcome: "failed",
    failureClass: "lifecycle-progression",
    summary: "execute-task ended without a succeeded executor Result",
    output: {},
  });
  const nextDispatch = insertDispatch(basePath, 2);
  const nextStartedAt = Date.now();
  const nextRun = startRun(basePath, nextStartedAt);
  assert.equal(nextRun.recoveryAttempts, 0, "the new dispatch must not inherit the exhausted counter");
  const nextRecovery = await recoverTimedOutUnit(
    harness.ctx,
    harness.pi,
    "execute-task",
    UNIT,
    "idle",
    runtimeRecoveryContext(basePath, nextStartedAt),
  );
  assert.equal(nextRecovery, "recovered");
  assert.equal(harness.messages.length, 3, "the new dispatch gets a steering recovery");
});


test("an exhausted recovery stays attempt-scoped and fails completion closed", async () => {
  const basePath = seedProject();
  const dispatchId = insertDispatch(basePath, 1);
  const attempt1 = claim(basePath, dispatchId, 1);
  const startedAt = Date.now();
  startRun(basePath, startedAt);
  const harness = recordingHarness();
  const context = () => runtimeRecoveryContext(basePath, startedAt);

  await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  await recoverTimedOutUnit(harness.ctx, harness.pi, "execute-task", UNIT, "idle", context());
  assert.equal(existsSync(blockerPath(basePath)), true, "the third recovery is durably exhausted");

  // Auto-mode's durable handoff ends the timed-out unit without a result.
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/settle/exhausted"),
    attemptId: attempt1.attemptId,
    outcome: "failed",
    failureClass: "lifecycle-progression",
    summary: "execute-task ended without a succeeded executor Result",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/route/exhausted"),
    attemptId: attempt1.attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "execute-task ended without a succeeded executor Result",
    evidence: { source: "reconcile" },
    rationale: "The exhausted recovery cannot progress from this failure route.",
  });
  assert.equal(abort.action, "abort");

  // Completion remains attempt-scoped: no running Attempt means the agent
  // cannot close the Task by removing the gate.
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK),
    /no running Attempt to close/u,
  );

  // The sanctioned operator resume still authorizes exactly one successor.
  resumeTaskRecovery({
    invocation: invocation("fixture/resume/exhausted", "user"),
    recoveryActionId: abort.recoveryActionId,
    repairSummary: "The environment was repaired after the exhausted timeout.",
    evidence: { command: "node verify.mjs", exitCode: 0, verdict: "PASS" },
  });
  const nextDispatch = insertDispatch(basePath, 2);
  const successor = claim(basePath, nextDispatch, 2, attempt1.attemptId);
  const successorStartedAt = Date.now();
  const successorRun = startRun(basePath, successorStartedAt);
  assert.equal(successorRun.recoveryAttempts, 0, "the recovered successor gets the full per-dispatch budget");

  const recovered = await recoverTimedOutUnit(
    harness.ctx,
    harness.pi,
    "execute-task",
    UNIT,
    "idle",
    runtimeRecoveryContext(basePath, successorStartedAt),
  );
  assert.equal(recovered, "recovered");
  assert.equal(harness.messages.length, 3, "the exhausted run does not steer, the successor does");
  assert.equal(readUnitRuntimeRecord(basePath, "execute-task", UNIT)?.recoveryAttempts, 1);
});
