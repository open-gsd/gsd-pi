// Project/App: gsd-pi
// File Purpose: Executable contract for fail-closed canonical Task execution in auto-mode.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.js";
import {
  executeDomainOperation,
} from "../db/domain-operation.js";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.js";
import { ReconciliationFailedError } from "../state-reconciliation.js";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.js";
import {
  readTaskRecoveryResumeEligibility,
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
  resumeTaskRecovery,
} from "../task-recovery-domain-operation.js";
import { reopenTask } from "../task-lifecycle-domain-operation.js";
import {
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.js";
import { readTerminalTaskRecoveryAbort } from "../artifact-verification.js";
import { publishVerifiedTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";

// The stuck-state resume key must ride along with every terminal abort break so an
// operator can run /gsd recover without querying the database by hand.
const TASK_RECOVERY_ABORT_REASON =
  "task-recovery-abort (recoveryActionId: recovery-action-1; resume with /gsd recover recovery-action-1 or gsd_task_recovery_resume)";

type UnitPhaseResult =
  | { action: "break"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "next"; data: { requestDispatchedAt?: number } };

interface TaskIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface AttemptSnapshot {
  attemptId: string;
  resultId?: string;
  resultFailureClass?: string;
  resultSummary?: string;
  attemptNumber: number;
  retryOfAttemptId?: string;
  state: "running" | "settled";
  outcome?: "succeeded" | "failed" | "interrupted";
  nextStage: "execute" | "verify" | "route" | "closeout" | "settled";
  coordinationDispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
}

interface CutoverInput {
  unitType: string;
  unitId: string;
  dispatchId: number | null;
  workerId: string | null;
  milestoneLeaseToken: number | null;
  traceId: string;
  turnId: string;
  markCanonicalDispatchSettled(): void;
}

interface CutoverDeps {
  readLatestTaskAttempt(task: TaskIdentity): AttemptSnapshot | null;
  readTerminalTaskRecoveryAbort(task: TaskIdentity): { recoveryActionId: string } | null;
  readTaskAttempt(attemptId: string): AttemptSnapshot | null;
  readTaskRecoveryRoute(attemptId: string): {
    recoveryActionId: string;
    recoveryOwner: "agent" | "user" | "external";
    action: "retry" | "repair" | "remediate" | "replan" | "abort" | "clarify" | "pause";
    resumeAuthorized?: boolean;
    resumeEligibility?: {
      recoveryActionId: string;
      eligible: boolean;
      failedGuard?: string;
      detail?: string;
    };
  } | null;
  readTaskTechnicalVerdict(attemptId: string): {
    attemptId: string;
    verdictId: string;
    evidenceId: string;
    verdict: "pass" | "fail" | "inconclusive";
    testedSourceRevision: string;
    nextStage: "verify" | "route";
    operationId: string;
    resultingRevision: number;
  } | null;
  claimTaskAttempt(input: {
    invocation: {
      idempotencyKey: string;
      sourceTransport: "internal";
      actorType: string;
      actorId?: string;
      traceId?: string;
      turnId?: string;
    };
    task: TaskIdentity;
    workerId: string;
    milestoneLeaseToken: number;
    coordinationDispatchId: number;
    retryOfAttemptId?: string;
  }): {
    status: "committed" | "replayed";
    operationId: string;
    resultingRevision: number;
    attemptId: string;
    attemptNumber: number;
  };
  settleTaskAttempt(input: {
    invocation: { idempotencyKey: string; sourceTransport: "internal"; actorType: string };
    attemptId: string;
    outcome: "succeeded" | "failed" | "interrupted";
    failureClass: string;
    summary: string;
    output: Record<string, unknown>;
    recovery?: { workerId: string; milestoneLeaseToken: number };
  }): {
    status: "committed" | "replayed";
    operationId: string;
    resultingRevision: number;
    resultId: string;
    nextStage: "route";
  };
  routeTaskFailure(input: {
    invocation: { idempotencyKey: string; sourceTransport: "internal"; actorType: string };
    attemptId: string;
    resultId: string;
    owner: "agent";
    classification: { failureKind: string; action?: "retry" | "escalate" | "stop" };
    summary: string;
    evidence: Record<string, unknown>;
    rationale: string;
  }): {
    status: "committed" | "replayed";
    action: "retry" | "repair" | "remediate" | "replan" | "abort";
    recoveryActionId: string;
  };
}

interface CutoverSubject {
  isTaskExecutionReadyForHostVerification(
    unitType: string,
    unitId: string,
    deps: { readLatestTaskAttempt(task: TaskIdentity): AttemptSnapshot | null },
  ): boolean;
  runWithTaskExecutionAttempt<T extends UnitPhaseResult>(
    input: CutoverInput,
    run: () => Promise<T>,
    deps: CutoverDeps,
  ): Promise<T>;
  publishVerifiedTaskExecution(
    input: Pick<CutoverInput, "unitType" | "unitId" | "workerId" | "traceId" | "turnId"> & { basePath: string },
    deps: {
      readLatestTaskAttempt(task: TaskIdentity): AttemptSnapshot | null;
      readTaskLifecycleStatus?(task: TaskIdentity): string | null;
      publishVerifiedTaskCompletion(input: {
        invocation: {
          idempotencyKey: string;
          sourceTransport: "internal";
          actorType: string;
          actorId?: string;
          traceId?: string;
          turnId?: string;
        };
        basePath: string;
        task: TaskIdentity;
        attemptId: string;
      }): Promise<unknown>;
    },
  ): Promise<void>;
}

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("only a canonical succeeded Task Attempt at verify is ready for host verification", async () => {
  const { isTaskExecutionReadyForHostVerification } = await subject();
  const attempt: AttemptSnapshot = {
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "verify",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  };
  const seen: TaskIdentity[] = [];
  const deps = {
    readLatestTaskAttempt(task: TaskIdentity) {
      seen.push(task);
      return attempt;
    },
  };

  assert.equal(isTaskExecutionReadyForHostVerification("execute-task", "M001/S01/T01", deps), true);
  assert.deepEqual(seen, [{ milestoneId: "M001", sliceId: "S01", taskId: "T01" }]);

  attempt.outcome = "failed";
  attempt.nextStage = "route";
  assert.equal(isTaskExecutionReadyForHostVerification("execute-task", "M001/S01/T01", deps), false);
  assert.equal(isTaskExecutionReadyForHostVerification("plan-slice", "M001/S01", deps), false);
  assert.equal(isTaskExecutionReadyForHostVerification("execute-task", "invalid", deps), false);
  assert.equal(isTaskExecutionReadyForHostVerification("execute-task", "M001/S01/T01", {
    readLatestTaskAttempt() {
      throw new Error("database unavailable");
    },
  }), false);
});

async function subject(): Promise<CutoverSubject> {
  return import("../auto/task-execution-cutover.js") as Promise<CutoverSubject>;
}

function input(overrides: Partial<CutoverInput> = {}): CutoverInput {
  return {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    dispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    traceId: "trace-1",
    turnId: "turn-1",
    markCanonicalDispatchSettled() {},
    ...overrides,
  };
}

function fakeDomain() {
  const calls: Array<{ name: string; value?: unknown }> = [];
  const attempts: AttemptSnapshot[] = [];
  const claims: Array<Parameters<CutoverDeps["claimTaskAttempt"]>[0]> = [];
  const settlements: Array<Parameters<CutoverDeps["settleTaskAttempt"]>[0]> = [];
  const routes: Array<Parameters<CutoverDeps["routeTaskFailure"]>[0]> = [];

  const deps: CutoverDeps = {
    readLatestTaskAttempt(task) {
      calls.push({ name: "read-latest", value: task });
      const attempt = attempts.at(-1);
      // Reads return point-in-time snapshots, like the canonical DB readers —
      // later settlements must not mutate what a caller already saw.
      return attempt ? { ...attempt } : null;
    },
    readTerminalTaskRecoveryAbort() {
      return null;
    },
    readTaskAttempt(attemptId) {
      calls.push({ name: "read-attempt", value: attemptId });
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      return attempt ? { ...attempt } : null;
    },
    readTaskRecoveryRoute(attemptId) {
      calls.push({ name: "read-recovery", value: attemptId });
      return { recoveryActionId: "recovery-action-1", recoveryOwner: "agent", action: "retry" };
    },
    readTaskTechnicalVerdict() {
      return null;
    },
    claimTaskAttempt(claim) {
      calls.push({ name: "claim", value: claim });
      claims.push(claim);
      const attempt: AttemptSnapshot = {
        attemptId: `attempt-${attempts.length + 1}`,
        attemptNumber: attempts.length + 1,
        ...(claim.retryOfAttemptId ? { retryOfAttemptId: claim.retryOfAttemptId } : {}),
        state: "running",
        nextStage: "execute",
        coordinationDispatchId: claim.coordinationDispatchId,
        workerId: claim.workerId,
        milestoneLeaseToken: claim.milestoneLeaseToken,
      };
      attempts.push(attempt);
      return {
        status: "committed",
        operationId: `claim-operation-${attempt.attemptNumber}`,
        resultingRevision: attempt.attemptNumber,
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
      };
    },
    settleTaskAttempt(settlement) {
      calls.push({ name: "settle", value: settlement });
      settlements.push(settlement);
      const attempt = attempts.find((candidate) => candidate.attemptId === settlement.attemptId);
      assert.ok(attempt);
      attempt.state = "settled";
      attempt.outcome = settlement.outcome;
      attempt.nextStage = settlement.outcome === "succeeded" ? "verify" : "route";
      attempt.resultId = `result-${attempt.attemptNumber}`;
      attempt.resultFailureClass = settlement.failureClass;
      attempt.resultSummary = settlement.summary;
      return {
        status: "committed",
        operationId: `settle-operation-${attempt.attemptNumber}`,
        resultingRevision: attempt.attemptNumber + 1,
        resultId: `result-${attempt.attemptNumber}`,
        nextStage: "route",
      };
    },
    routeTaskFailure(route) {
      calls.push({ name: "route", value: route });
      routes.push(route);
      return { status: "replayed", action: "retry", recoveryActionId: "recovery-action-1" };
    },
  };

  return {
    calls,
    claims,
    settlements,
    routes,
    attempts,
    deps,
    completeSucceeded(attemptId: string) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      assert.ok(attempt);
      attempt.state = "settled";
      attempt.outcome = "succeeded";
      attempt.nextStage = "verify";
    },
    completeBlocked(attemptId: string) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      assert.ok(attempt);
      attempt.state = "settled";
      attempt.outcome = "failed";
      attempt.nextStage = "route";
      attempt.resultId = `result-${attempt.attemptNumber}`;
      attempt.resultFailureClass = "blocker-discovered";
    },
  };
}

function database() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function seedCanonicalTaskFixture(): { basePath: string; dispatchId: number } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-phase-recovery-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  database().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Task recovery', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, full_summary_md)
    VALUES (
      'M001', 'S01', 'T01', 'Classify failure', 'pending',
      '# T01: Classify failure\n\nThe verification failure was remediated.\n'
    );
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
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
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { taskId: "T01" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return { basePath: dir, dispatchId: insertClaimedDispatch(1) };
}

function seedCanonicalTask(): number {
  return seedCanonicalTaskFixture().dispatchId;
}

function insertClaimedDispatch(attemptNumber: number): number {
  database().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (?, ?, 'worker-1', 7, 'M001', 'S01', 'T01',
      'execute-task', 'M001/S01/T01', 'claimed', ?, ?)
  `).run(
    `trace-dispatch-${attemptNumber}`,
    `turn-dispatch-${attemptNumber}`,
    attemptNumber,
    `2026-07-12T00:0${attemptNumber}:00.000Z`,
  );
  const row = database().prepare("SELECT MAX(id) AS id FROM unit_dispatches").get() as {
    id: number;
  };
  return Number(row.id);
}

function canonicalDeps(): CutoverDeps {
  return {
    readLatestTaskAttempt,
    readTerminalTaskRecoveryAbort(task) {
      return readTerminalTaskRecoveryAbort(task.milestoneId, task.sliceId, task.taskId);
    },
    readTaskAttempt,
    readTaskRecoveryRoute,
    readTaskTechnicalVerdict,
    claimTaskAttempt,
    settleTaskAttempt,
    routeTaskFailure(route) {
      return recordFailureAndSelectRecovery(
        route as Parameters<typeof recordFailureAndSelectRecovery>[0],
      );
    },
  } as CutoverDeps;
}

test("a Task reopened over a stale agent abort dispatches a fresh Attempt (#1948)", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const firstDispatchId = seedCanonicalTask();
  const task = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

  const first = claimTaskAttempt({
    invocation: { idempotencyKey: "reopen/claim/1", sourceTransport: "internal", actorType: "agent" },
    task,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: firstDispatchId,
  });
  const settled = settleTaskAttempt({
    invocation: { idempotencyKey: "reopen/settle/1", sourceTransport: "internal", actorType: "agent" },
    attemptId: first.attemptId,
    outcome: "failed",
    failureClass: "verification",
    summary: "closeout verification failed",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: { idempotencyKey: "reopen/route/1", sourceTransport: "internal", actorType: "agent" },
    attemptId: first.attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "verification-abort",
    evidence: { source: "test" },
    rationale: "abort",
  });
  assert.equal(abort.action, "abort");
  assert.deepEqual(readTerminalTaskRecoveryAbort("M001", "S01", "T01"), {
    recoveryActionId: abort.recoveryActionId,
  });

  // The lifecycle reaches a terminal head without advancing the Attempt's
  // Kernel lineage (reconcile/legacy completion), then the operator reopens.
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.complete",
    idempotencyKey: "reopen/complete",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "task", ...task, lifecycleStatus: "completed" });
    database().prepare(`UPDATE tasks SET status = 'complete' WHERE id = 'T01'`).run();
    return {
      events: [{ eventType: "test.task.complete", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/m001/s01/t01/complete", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  database().prepare(`UPDATE unit_dispatches SET status = 'failed' WHERE id = ?`).run(firstDispatchId);
  reopenTask({
    invocation: { idempotencyKey: "reopen/reopen", sourceTransport: "internal", actorType: "user", actorId: "user-1" },
    task,
    reason: "redo after fixing the verification guard",
  });

  assert.equal(readTaskRecoveryResumeEligibility(abort.recoveryActionId).eligible, false);
  assert.equal(
    readTerminalTaskRecoveryAbort("M001", "S01", "T01"),
    null,
    "no dispatch guard may advertise a resume the reopened lifecycle cannot satisfy",
  );

  let ran = false;
  const result = await runWithTaskExecutionAttempt(input({
    dispatchId: insertClaimedDispatch(2),
  }), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, canonicalDeps());

  assert.equal(ran, true, "the reopened Task must dispatch a fresh executor run");
  assert.notEqual(
    (result as { reason?: string }).reason?.includes(abort.recoveryActionId),
    true,
    "the stale abort must not be advertised after reopen",
  );
  const latest = readLatestTaskAttempt(task);
  assert.equal(latest?.attemptNumber, 2);
  assert.equal(latest?.retryOfAttemptId, first.attemptId);
  assert.equal(
    (database().prepare(`SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = 'T01'`).get() as { lifecycle_status: string }).lifecycle_status,
    "in_progress",
  );
});

test("agent remediation of a failed Technical Verdict runs in a lineage-linked Attempt", async () => {
  const { publishVerifiedTaskExecution, runWithTaskExecutionAttempt } = await subject();
  const { basePath, dispatchId: firstDispatchId } = seedCanonicalTaskFixture();
  const task = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, ".gitignore"), "gsd.db*\n.gsd/\n");
  writeFileSync(join(basePath, "tracked.txt"), "verified\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Recovery",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Classify failure** `est:30m`",
    "  - Do: Remediate failed host verification",
    "  - Verify: pnpm test",
    "",
  ].join("\n"));

  await runWithTaskExecutionAttempt(input({ dispatchId: firstDispatchId }), async () => {
    const attempt = readLatestTaskAttempt(task);
    assert.ok(attempt);
    assert.equal(attempt.state, "running");
    settleTaskAttempt({
      invocation: {
        idempotencyKey: "test:verification-remediation:settle:first",
        sourceTransport: "internal",
        actorType: "agent",
      },
      attemptId: attempt.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "Candidate implementation is ready for host verification.",
      output: { changedFiles: ["src/task.ts"] },
    });
    return { action: "next", data: {} };
  }, canonicalDeps());

  const firstAttempt = readLatestTaskAttempt(task);
  assert.ok(firstAttempt);
  assert.equal(firstAttempt.state, "settled");
  assert.equal(firstAttempt.outcome, "succeeded");
  assert.ok(firstAttempt.resultId);
  const firstResultId = firstAttempt.resultId;
  const failedVerdict = recordTaskTechnicalVerdict({
    invocation: {
      idempotencyKey: "test:verification-remediation:verdict:fail",
      sourceTransport: "internal",
      actorType: "agent",
    },
    attemptId: firstAttempt.attemptId,
    testedSourceRevision: "sha256:failed-source",
    verdict: "fail",
    rationale: "The host test failed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "pnpm test",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 1,
      observation: "failed",
      durableOutputRef: "db://host-verification/attempt-1",
      environment: { runner: "node-test", platform: "test" },
    },
  });
  recordFailureAndSelectRecovery({
    invocation: {
      idempotencyKey: "test:verification-remediation:route",
      sourceTransport: "internal",
      actorType: "agent",
    },
    attemptId: firstAttempt.attemptId,
    resultId: firstAttempt.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: "Host verification failed after successful execution.",
    evidence: {
      verdictId: failedVerdict.verdictId,
      evidenceId: failedVerdict.evidenceId,
      verdict: "fail",
    },
    rationale: "Remediate the failed verification evidence in a new Attempt.",
  });
  const immutableHistory = database().prepare(`
    SELECT result.result_id, result.output_json,
           verdict.verdict_id, verdict.tested_source_revision,
           evidence.evidence_id, evidence.durable_output_ref
    FROM workflow_attempt_results result
    JOIN workflow_technical_verdicts verdict ON verdict.attempt_id = result.attempt_id
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE result.attempt_id = ?
  `).get(firstAttempt.attemptId) as Record<string, unknown> | undefined;
  assert.ok(immutableHistory);
  assert.deepEqual({
    resultId: immutableHistory.result_id,
    verdictId: immutableHistory.verdict_id,
    evidenceId: immutableHistory.evidence_id,
  }, {
    resultId: firstResultId,
    verdictId: failedVerdict.verdictId,
    evidenceId: failedVerdict.evidenceId,
  });

  const secondDispatchId = insertClaimedDispatch(2);
  let repairRuns = 0;
  await runWithTaskExecutionAttempt(input({ dispatchId: secondDispatchId }), async () => {
    repairRuns += 1;
    const attempt = readLatestTaskAttempt(task);
    assert.ok(attempt);
    assert.equal(attempt.state, "running");
    settleTaskAttempt({
      invocation: {
        idempotencyKey: "test:verification-remediation:settle:second",
        sourceTransport: "internal",
        actorType: "agent",
      },
      attemptId: attempt.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "The verification failure was remediated.",
      output: { changedFiles: ["src/task.ts"] },
    });
    return { action: "next", data: {} };
  }, canonicalDeps());

  assert.equal(repairRuns, 1);
  const secondAttempt = readLatestTaskAttempt(task);
  assert.ok(secondAttempt);
  assert.notEqual(secondAttempt.attemptId, firstAttempt.attemptId);
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: {
      idempotencyKey: "test:verification-remediation:verdict:pass",
      sourceTransport: "internal",
      actorType: "agent",
    },
    attemptId: secondAttempt.attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "The remediated Result passed host verification.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "pnpm test",
      workingDirectory: basePath,
      startedAt: "2026-07-12T00:04:00.000Z",
      endedAt: "2026-07-12T00:04:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: "db://host-verification/attempt-2",
      environment: { runner: "node-test", platform: "test" },
    },
  });
  await publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-publication",
    turnId: "turn-publication",
    basePath,
  }, {
    readLatestTaskAttempt,
    publishVerifiedTaskCompletion,
  });

  assert.deepEqual(database().prepare(`
    SELECT attempt_number, retry_of_attempt_id, attempt_state
    FROM workflow_execution_attempts
    ORDER BY attempt_number
  `).all(), [
    { attempt_number: 1, retry_of_attempt_id: null, attempt_state: "settled" },
    {
      attempt_number: 2,
      retry_of_attempt_id: firstAttempt.attemptId,
      attempt_state: "settled",
    },
  ]);
  const observationCount = database().prepare(`
    SELECT COUNT(*) AS count FROM workflow_failure_observations
  `).get() as { count: number };
  assert.equal(observationCount.count, 1);
  assert.deepEqual(database().prepare(`
    SELECT attempt_id, verdict FROM workflow_technical_verdicts ORDER BY project_revision
  `).all(), [
    { attempt_id: firstAttempt.attemptId, verdict: "fail" },
    { attempt_id: secondAttempt.attemptId, verdict: "pass" },
  ]);
  assert.deepEqual(database().prepare(`
    SELECT result.result_id, result.output_json,
           verdict.verdict_id, verdict.tested_source_revision,
           evidence.evidence_id, evidence.durable_output_ref
    FROM workflow_attempt_results result
    JOIN workflow_technical_verdicts verdict ON verdict.attempt_id = result.attempt_id
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE result.attempt_id = ?
  `).get(firstAttempt.attemptId), immutableHistory);
  assert.deepEqual(database().prepare(`
    SELECT lifecycle.lifecycle_status, task.status, checkpoint.next_stage
    FROM workflow_item_lifecycles lifecycle
    JOIN tasks task
      ON task.milestone_id = lifecycle.milestone_id
     AND task.slice_id = lifecycle.slice_id
     AND task.id = lifecycle.task_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = ?
    WHERE lifecycle.milestone_id = 'M001'
      AND lifecycle.slice_id = 'S01'
      AND lifecycle.task_id = 'T01'
    ORDER BY checkpoint.sequence DESC LIMIT 1
  `).get(secondAttempt.attemptId), {
    lifecycle_status: "completed",
    status: "complete",
    next_stage: "settled",
  });
});

test("non-task units pass through without reading or mutating Task execution authority", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let runs = 0;
  const expected = { action: "next", data: { requestDispatchedAt: 123 } } as const;

  const result = await runWithTaskExecutionAttempt(input({
    unitType: "plan-slice",
    unitId: "M001/S01",
    dispatchId: null,
    workerId: null,
    milestoneLeaseToken: null,
  }), async () => {
    runs += 1;
    return expected;
  }, domain.deps);

  assert.equal(result, expected);
  assert.equal(runs, 1);
  assert.deepEqual(domain.calls, []);
});

for (const missing of [
  { field: "dispatch", overrides: { dispatchId: null } },
  { field: "worker", overrides: { workerId: null } },
  { field: "lease", overrides: { milestoneLeaseToken: null } },
] as const) {
  test(`execute-task fails closed without ${missing.field} identity before running the unit`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const domain = fakeDomain();
    let ran = false;

    await assert.rejects(
      runWithTaskExecutionAttempt(input(missing.overrides), async () => {
        ran = true;
        return { action: "next", data: {} };
      }, domain.deps),
      new RegExp(missing.field, "i"),
    );

    assert.equal(ran, false);
    assert.deepEqual(domain.calls, []);
  });
}

test("execute-task commits its canonical claim before running and accepts only succeeded verify-stage completion", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const order: string[] = [];
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      order.push("marked");
      dispatchSettled = true;
    },
  }), async () => {
    order.push("run");
    assert.equal(domain.attempts.length, 1, "Attempt must exist before provider execution");
    domain.completeSucceeded(domain.attempts[0].attemptId);
    return { action: "next", data: { requestDispatchedAt: 456 } };
  }, {
    ...domain.deps,
    claimTaskAttempt(claim) {
      order.push("claim");
      return domain.deps.claimTaskAttempt(claim);
    },
  });

  assert.deepEqual(order, ["claim", "run", "marked"]);
  assert.deepEqual(result, { action: "next", data: { requestDispatchedAt: 456 } });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 0);
  assert.deepEqual(domain.claims[0], {
    invocation: {
      idempotencyKey: "internal:auto:attempt.claim:41",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "worker-1",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: 41,
  });
});

test("execute-task next without a succeeded Result settles failed and becomes a retry", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => ({ action: "next", data: {} }), domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 1);
  assert.equal(domain.settlements[0].attemptId, "attempt-1");
  assert.equal(domain.settlements[0].outcome, "failed");
  assert.equal(domain.settlements[0].failureClass, "lifecycle-progression");
  assert.equal(
    domain.settlements[0].invocation.idempotencyKey,
    "internal:auto:attempt.settle:attempt-1",
  );
  assert.equal(domain.routes.length, 1);
  assert.equal(domain.routes[0].attemptId, "attempt-1");
  assert.equal(domain.routes[0].resultId, "result-1");
  assert.deepEqual(domain.routes[0].invocation, {
    idempotencyKey: "internal:auto:attempt.route:result-1",
    sourceTransport: "internal",
    actorType: "agent",
  });
});

test("execute-task next does not advance a failed canonical Result into verification", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => {
    const attempt = domain.attempts[0];
    attempt.state = "settled";
    attempt.outcome = "failed";
    attempt.nextStage = "route";
    attempt.resultId = "result-1";
    return { action: "next", data: {} };
  }, domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 0, "an immutable failed Result must not be settled twice");
  assert.equal(domain.routes.length, 1, "an existing unrouted Result must be routed before retry");
});

test("a newly recorded blocker defers attempt.route until the next dispatch", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    domain.completeBlocked("attempt-1");
    return { action: "next", data: {} };
  }, domain.deps);

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(domain.routes.length, 0, "gsd_task_complete must not pre-register attempt.route");
});

for (const phaseResult of [
  { action: "retry", reason: "zero-tool-calls" },
  { action: "break", reason: "provider-pause" },
] as const) {
  test(`a newly recorded blocker survives a later ${phaseResult.action} without attempt.route`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const domain = fakeDomain();

    const result = await runWithTaskExecutionAttempt(input(), async () => {
      domain.completeBlocked("attempt-1");
      return phaseResult;
    }, domain.deps);

    assert.deepEqual(result, phaseResult);
    assert.equal(domain.routes.length, 0, "the later phase outcome must not overwrite blocker routing");
  });
}

test("a newly recorded blocker survives a later executor exception without attempt.route", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    domain.completeBlocked("attempt-1");
    throw new Error("provider disconnected after blocker completion");
  }, domain.deps);

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(domain.routes.length, 0, "the later exception must not overwrite blocker routing");
});

test("a historical terminal abort short-circuits failed Result routing", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-2",
    resultId: "result-2",
    resultFailureClass: "blocker-discovered",
    resultSummary: "A blocker was recorded",
    attemptNumber: 2,
    state: "settled",
    outcome: "failed",
    nextStage: "route",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    throw new Error("provider execution must not run");
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return null;
    },
    readTerminalTaskRecoveryAbort() {
      return { recoveryActionId: "historical-abort" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: "task-recovery-abort (recoveryActionId: historical-abort; resume with /gsd recover historical-abort or gsd_task_recovery_resume)",
  });
  assert.equal(domain.routes.length, 0, "the stale attempt.route key must not be touched");
  assert.equal(domain.claims.length, 0);
});

test("a historical terminal abort short-circuits stored Technical Verdict routing", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-2",
    resultId: "result-2",
    attemptNumber: 2,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    throw new Error("provider execution must not run");
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return null;
    },
    readTaskTechnicalVerdict() {
      return {
        attemptId: "attempt-2",
        verdictId: "verdict-2",
        evidenceId: "evidence-2",
        verdict: "fail",
        testedSourceRevision: "revision-2",
        nextStage: "route",
        operationId: "verify-operation-2",
        resultingRevision: 2,
      };
    },
    readTerminalTaskRecoveryAbort() {
      return { recoveryActionId: "historical-abort" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: "task-recovery-abort (recoveryActionId: historical-abort; resume with /gsd recover historical-abort or gsd_task_recovery_resume)",
  });
  assert.equal(domain.routes.length, 0, "the stale attempt.route key must not be touched");
  assert.equal(domain.claims.length, 0);
});

for (const phaseResult of [
  { action: "retry", reason: "zero-tool-calls" },
  { action: "break", reason: "provider-pause" },
] as const) {
  test(`execute-task ${phaseResult.action} settles, routes, and follows the durable retry action`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const domain = fakeDomain();
    let dispatchSettled = false;

    const result = await runWithTaskExecutionAttempt(input({
      markCanonicalDispatchSettled() {
        dispatchSettled = true;
      },
    }), async () => phaseResult, domain.deps);

    assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
    assert.equal(dispatchSettled, true);
    assert.equal(domain.settlements.length, 1);
    assert.equal(domain.settlements[0].outcome, "failed");
    assert.match(domain.settlements[0].summary, new RegExp(phaseResult.reason, "i"));
    assert.equal(domain.routes.length, 1);
    if (phaseResult.action === "retry") {
      assert.notEqual(
        domain.routes[0].classification.failureKind,
        "provider",
        "an executor retry request cannot manufacture transient-provider authority",
      );
    }
  });
}

for (const phaseResult of [
  { action: "retry", reason: "zero-tool-calls" },
  { action: "break", reason: "provider-pause" },
  { action: "break", reason: "session-timeout" },
] as const) {
  test(`execute-task ${phaseResult.reason} selects durable transient recovery and admits Attempt 2`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const firstDispatchId = seedCanonicalTask();

    const firstResult = await runWithTaskExecutionAttempt(input({
      dispatchId: firstDispatchId,
    }), async () => phaseResult, canonicalDeps());

    assert.deepEqual(firstResult, { action: "retry", reason: "task-recovery-retry" });
    assert.deepEqual(database().prepare(`
      SELECT observation.failure_kind, action.action, budget.policy_class, budget.max_uses
      FROM workflow_failure_observations observation
      JOIN workflow_recovery_actions action
        ON action.failure_observation_id = observation.failure_observation_id
      LEFT JOIN workflow_recovery_budgets budget
        ON budget.recovery_budget_id = action.recovery_budget_id
    `).get(), {
      failure_kind: "transient-execution",
      action: "retry",
      policy_class: "transient-execution",
      max_uses: 2,
    });

    const secondDispatchId = insertClaimedDispatch(2);
    const terminalResult = await runWithTaskExecutionAttempt(input({
      dispatchId: secondDispatchId,
    }), async () => ({ action: "break", reason: "unit-hard-timeout" }), canonicalDeps());

    assert.equal(terminalResult.action, "break");
    assert.match(
      (terminalResult as { reason: string }).reason,
      /^task-recovery-abort \(recoveryActionId: ([0-9a-f-]{36}); resume with \/gsd recover \1 or gsd_task_recovery_resume\)$/,
    );
    const firstAttempt = database().prepare(`
      SELECT attempt_id FROM workflow_execution_attempts WHERE attempt_number = 1
    `).get() as { attempt_id: string };
    assert.deepEqual(database().prepare(`
      SELECT attempt_number, retry_of_attempt_id, attempt_state
      FROM workflow_execution_attempts
      ORDER BY attempt_number
    `).all(), [
      { attempt_number: 1, retry_of_attempt_id: null, attempt_state: "settled" },
      {
        attempt_number: 2,
        retry_of_attempt_id: firstAttempt.attempt_id,
        attempt_state: "settled",
      },
    ]);
    assert.deepEqual(database().prepare(`
      SELECT observation.failure_kind, action.action
      FROM workflow_failure_observations observation
      JOIN workflow_recovery_actions action
        ON action.failure_observation_id = observation.failure_observation_id
      ORDER BY observation.project_revision
    `).all(), [
      { failure_kind: "transient-execution", action: "retry" },
      { failure_kind: "runtime-unknown", action: "abort" },
    ]);
  });
}

test("a durable abort overrides an executor retry", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  const result = await runWithTaskExecutionAttempt(input(), async () => ({
    action: "retry",
    reason: "unknown executor failure",
  }), {
    ...domain.deps,
    routeTaskFailure(route) {
      domain.routes.push(route);
      return { status: "committed", action: "abort", recoveryActionId: "recovery-action-1" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: TASK_RECOVERY_ABORT_REASON,
  });
  assert.equal(domain.routes.length, 1);
});

test("a succeeded head reaches verification before a superseded terminal abort", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push(
    {
      attemptId: "attempt-aborted",
      resultId: "result-aborted",
      attemptNumber: 1,
      state: "settled",
      outcome: "failed",
      nextStage: "route",
      coordinationDispatchId: 40,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    },
    {
      attemptId: "attempt-superseding",
      resultId: "result-superseding",
      attemptNumber: 2,
      retryOfAttemptId: "attempt-aborted",
      state: "settled",
      outcome: "succeeded",
      nextStage: "verify",
      coordinationDispatchId: 41,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    },
  );
  let runs = 0;

  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    runs += 1;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTerminalTaskRecoveryAbort() {
      return { recoveryActionId: "recovery-action-aborted" };
    },
  });

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(runs, 0);
  assert.equal(domain.claims.length, 0);
});

test("an explicitly resumed durable abort claims one later Attempt", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "failed",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  let runs = 0;
  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    runs += 1;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    routeTaskFailure(route) {
      domain.routes.push(route);
      return {
        status: "replayed",
        action: "abort",
        resumeAuthorized: true,
        recoveryActionId: "recovery-action-1",
      };
    },
  });

  assert.equal(result.action, "next");
  assert.equal(runs, 1);
  assert.equal(domain.claims.length, 1);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
});

test("an authorized resume re-entry claims the successor instead of re-routing the routed Result (#2188)", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const firstDispatchId = seedCanonicalTask();
  const task = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  const first = claimTaskAttempt({
    invocation: { idempotencyKey: "resume/claim/1", sourceTransport: "internal", actorType: "agent" },
    task,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: firstDispatchId,
  });
  const settled = settleTaskAttempt({
    invocation: { idempotencyKey: "resume/settle/1", sourceTransport: "internal", actorType: "agent" },
    attemptId: first.attemptId,
    outcome: "failed",
    failureClass: "fatal",
    summary: "fatal execution failure",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: { idempotencyKey: "resume/route/1", sourceTransport: "internal", actorType: "agent" },
    attemptId: first.attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "fatal execution failure",
    evidence: { source: "test" },
    rationale: "abort",
  });
  assert.equal(abort.action, "abort");
  resumeTaskRecovery({
    invocation: { idempotencyKey: "resume/resume/1", sourceTransport: "internal", actorType: "user", actorId: "user-1" },
    recoveryActionId: abort.recoveryActionId,
    repairSummary: "The fatal condition was repaired.",
    evidence: { verification: "operator confirmed the repair" },
  });

  // Exact cutover-visible state right after the authorized resume: the kernel
  // still parks at route, so resumeAuthorized reads true while the eligibility
  // diagnosis reports the already-resumed marker. The #2113 refresh handling
  // must be reachable in this state, not gated behind !resumeAuthorized.
  const route = readTaskRecoveryRoute(first.attemptId);
  assert.equal(route?.recoveryOwner, "agent");
  assert.equal(route?.action, "abort");
  assert.equal(route?.resumeAuthorized, true);
  assert.equal(route?.resumeEligibility?.failedGuard, "already-resumed");

  const base = canonicalDeps();
  let routes = 0;
  const deps: CutoverDeps = {
    ...base,
    routeTaskFailure(routeInput) {
      routes += 1;
      return base.routeTaskFailure(routeInput);
    },
  };
  let ran = false;
  const result = await runWithTaskExecutionAttempt(input({
    dispatchId: insertClaimedDispatch(2),
  }), async () => {
    ran = true;
    const claimed = readLatestTaskAttempt(task);
    if (!claimed || claimed.attemptId === first.attemptId) {
      throw new Error("the authorized resume must claim a fresh successor Attempt before execution");
    }
    settleTaskAttempt({
      invocation: { idempotencyKey: "resume/settle/2", sourceTransport: "internal", actorType: "agent" },
      attemptId: claimed.attemptId,
      outcome: "succeeded",
      failureClass: "none",
      summary: "recovered execution finished",
      output: {},
    });
    return { action: "next", data: {} };
  }, deps);

  assert.equal(result.action, "next");
  assert.equal(ran, true);
  assert.equal(routes, 0, "the already-routed Result must not be routed again");
  const latest = readLatestTaskAttempt(task);
  assert.equal(latest?.attemptNumber, 2);
  assert.equal(latest?.retryOfAttemptId, first.attemptId);
});

test("execute-task exceptions settle, route, and return the durable recovery action", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const failure = new Error("provider exploded");
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => {
    throw failure;
  }, domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 1);
  assert.equal(domain.settlements[0].outcome, "failed");
  assert.match(domain.settlements[0].summary, /provider exploded/i);
  assert.equal(domain.routes.length, 1);
});

test("provider request timeouts settle as transient execution failures", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    throw new Error("Provider error: : Request timed out.");
  }, domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
  assert.equal(domain.settlements[0].failureClass, "provider");
  assert.equal(domain.routes[0].classification.failureKind, "provider");
  assert.equal(domain.routes[0].classification.action, "retry");
});

test("typed executor failures retain their canonical classification through settlement and routing", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const failure = new ReconciliationFailedError({});

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    throw failure;
  }, domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-retry" });
  assert.equal(domain.settlements[0].failureClass, "reconciliation-drift");
  assert.equal(domain.routes[0].classification.failureKind, "reconciliation-drift");
  assert.deepEqual(
    (domain.settlements[0].output.recoveryClassification as { failureKind: string }).failureKind,
    "reconciliation-drift",
  );
});

test("a durable abort for stale-worker takeover stops before replacement claim or execution", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input({
    dispatchId: 42,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  }), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    routeTaskFailure(route) {
      domain.routes.push(route);
      return { status: "committed", action: "abort", recoveryActionId: "recovery-action-1" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: TASK_RECOVERY_ABORT_REASON,
  });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
  assert.equal(domain.routes.length, 1);
});

test("a newly routed failed predecessor redispatches before its lineage-linked retry claim", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "failed",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  let routeStatus: "committed" | "replayed" = "committed";
  let runs = 0;
  const deps = {
    ...domain.deps,
    routeTaskFailure(route: Parameters<CutoverDeps["routeTaskFailure"]>[0]) {
      domain.calls.push({ name: "route", value: route });
      domain.routes.push(route);
      return { status: routeStatus, action: "repair" as const, recoveryActionId: "recovery-action-1" };
    },
  };

  const routed = await runWithTaskExecutionAttempt(input(), async () => {
    runs += 1;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, deps);

  assert.deepEqual(routed, { action: "retry", reason: "task-recovery-repair" });
  assert.equal(runs, 0);
  assert.equal(domain.claims.length, 0);
  assert.deepEqual(domain.calls.map((call) => call.name), ["read-latest", "read-recovery", "route"]);

  routeStatus = "replayed";
  const resumed = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    runs += 1;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, deps);

  assert.equal(resumed.action, "next");
  assert.equal(runs, 1);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
});

test("a succeeded predecessor awaiting verification resumes verification without executing again", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "verify",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, domain.deps);

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
});

test("an unresumed abort on a failed predecessor stops before a replacement claim", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "failed",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return { recoveryActionId: "recovery-action-1", recoveryOwner: "agent", action: "abort" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: TASK_RECOVERY_ABORT_REASON,
  });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
});

test("an abort rejected by a different resume guard remains fail-closed", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    throw new Error("an open blocker must prevent successor execution");
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return {
        recoveryActionId: "recovery-action-1",
        recoveryOwner: "agent",
        action: "abort",
        resumeAuthorized: false,
        resumeEligibility: {
          recoveryActionId: "recovery-action-1",
          eligible: false,
          failedGuard: "open-blockers",
          detail: "Task lifecycle has an open Blocker",
        },
      };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: TASK_RECOVERY_ABORT_REASON,
  });
  assert.equal(domain.claims.length, 0);
});

test("a historical terminal abort stops a failed predecessor before attempt.route", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-current",
    resultId: "result-current",
    attemptNumber: 2,
    state: "settled",
    outcome: "failed",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  const result = await runWithTaskExecutionAttempt(input(), async () => ({ action: "next", data: {} }), {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return null;
    },
    readTerminalTaskRecoveryAbort() {
      return { recoveryActionId: "recovery-action-historical" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: "task-recovery-abort (recoveryActionId: recovery-action-historical; resume with /gsd recover recovery-action-historical or gsd_task_recovery_resume)",
  });
  assert.equal(domain.routes.length, 0, "a historical abort must short-circuit before attempt.route");
  assert.equal(domain.claims.length, 0);
});

test("an unresumed verification abort stops before a replacement claim", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return { recoveryActionId: "recovery-action-1", recoveryOwner: "agent", action: "abort" };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: TASK_RECOVERY_ABORT_REASON,
  });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
});

test("a failed stored verdict with no route is routed before replacement execution", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return null;
    },
    readTaskTechnicalVerdict(attemptId) {
      return {
        attemptId,
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "fail",
        testedSourceRevision: "unavailable",
        nextStage: "route",
        operationId: "verdict-operation-1",
        resultingRevision: 4,
      };
    },
    routeTaskFailure(route) {
      domain.routes.push(route);
      return { status: "committed", action: "repair", recoveryActionId: "recovery-action-1" };
    },
  });

  assert.deepEqual(result, { action: "retry", reason: "task-recovery-repair" });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
  assert.equal(domain.routes.length, 1);
  assert.deepEqual(domain.routes[0].evidence, {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    verdictId: "verdict-1",
    evidenceId: "evidence-1",
    verdict: "fail",
  });
});

test("a historical terminal abort stops stored technical-failure routing before attempt.route", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-current",
    resultId: "result-current",
    attemptNumber: 2,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  const result = await runWithTaskExecutionAttempt(input(), async () => ({ action: "next", data: {} }), {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return null;
    },
    readTerminalTaskRecoveryAbort() {
      return { recoveryActionId: "recovery-action-historical" };
    },
    readTaskTechnicalVerdict(attemptId) {
      return {
        attemptId,
        verdictId: "verdict-current",
        evidenceId: "evidence-current",
        verdict: "fail",
        testedSourceRevision: "git:current",
        nextStage: "route",
        operationId: "verdict-operation-current",
        resultingRevision: 4,
      };
    },
  });

  assert.deepEqual(result, {
    action: "break",
    reason: "task-recovery-abort (recoveryActionId: recovery-action-historical; resume with /gsd recover recovery-action-historical or gsd_task_recovery_resume)",
  });
  assert.equal(domain.routes.length, 0, "a historical abort must short-circuit before attempt.route");
  assert.equal(domain.claims.length, 0);
});

test("an explicitly resumed verification abort claims one lineage-linked Attempt", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let runs = 0;

  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    runs += 1;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return { recoveryActionId: "recovery-action-1", recoveryOwner: "agent", action: "abort", resumeAuthorized: true };
    },
  });

  assert.equal(result.action, "next");
  assert.equal(runs, 1);
  assert.equal(domain.claims.length, 1);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
});

test("a user-owned verification route resumes verification without executing again", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input(), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    readTaskRecoveryRoute() {
      return {
        recoveryActionId: "recovery-action-1",
        recoveryOwner: "user",
        action: "clarify",
      };
    },
  });

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
});

test("a missing verification route and verdict fails closed", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    resultId: "result-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "succeeded",
    nextStage: "route",
    coordinationDispatchId: 40,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  await assert.rejects(runWithTaskExecutionAttempt(input(), async () => ({
    action: "next",
    data: {},
  }), {
    ...domain.deps,
    readTaskRecoveryRoute: () => null,
    readTaskTechnicalVerdict: () => null,
  }), /missing its failed Technical Verdict/);

  assert.equal(domain.claims.length, 0);
});

test("a retry claim links the immediately preceding settled Attempt", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  await runWithTaskExecutionAttempt(input(), async () => ({
    action: "retry",
    reason: "executor asked to retry",
  }), domain.deps);

  await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, domain.deps);

  assert.equal(domain.claims.length, 2);
  assert.equal(domain.claims[0].retryOfAttemptId, undefined);
  assert.equal(domain.claims[1].retryOfAttemptId, "attempt-1");
  assert.equal(domain.claims[1].invocation.idempotencyKey, "internal:auto:attempt.claim:42");
});

test("a replacement lease routes a stale running Attempt and redispatches before claiming its retry", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });

  let routeStatus: "committed" | "replayed" = "committed";
  let runs = 0;
  const deps = {
    ...domain.deps,
    routeTaskFailure(route: Parameters<CutoverDeps["routeTaskFailure"]>[0]) {
      domain.calls.push({ name: "route", value: route });
      domain.routes.push(route);
      return { status: routeStatus, action: "repair" as const, recoveryActionId: "recovery-action-1" };
    },
  };

  const routed = await runWithTaskExecutionAttempt(input({
    dispatchId: 42,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  }), async () => {
    runs += 1;
    return { action: "next", data: {} };
  }, deps);

  assert.deepEqual(routed, { action: "retry", reason: "task-recovery-repair" });
  assert.equal(runs, 0);
  assert.equal(domain.claims.length, 0);
  assert.deepEqual(domain.calls.slice(0, 3).map((call) => call.name), [
    "read-latest",
    "settle",
    "route",
  ]);
  assert.deepEqual(domain.settlements[0], {
    invocation: {
      idempotencyKey: "internal:auto:attempt.interrupt:attempt-1:worker-2:8",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "worker-2",
    },
    attemptId: "attempt-1",
    outcome: "interrupted",
    failureClass: "stale-worker",
    summary: "Replaced stale Task Attempt after milestone lease takeover",
    output: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      staleDispatchId: 41,
      staleWorkerId: "worker-1",
      staleMilestoneLeaseToken: 7,
      replacementDispatchId: 42,
      replacementWorkerId: "worker-2",
      replacementMilestoneLeaseToken: 8,
      recoveryClassification: {
        failureKind: "stale-worker",
        action: "stop",
        rationale: "Run `/gsd doctor` to detect and clear the stale worker or lock, then run `/gsd auto` to resume.",
      },
    },
    recovery: { workerId: "worker-2", milestoneLeaseToken: 8 },
  });

  routeStatus = "replayed";
  const resumed = await runWithTaskExecutionAttempt(input({
    dispatchId: 43,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  }), async () => {
    runs += 1;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, deps);

  assert.equal(resumed.action, "next");
  assert.equal(runs, 1);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
});

test("a same-lease running Attempt is interrupted through the same-session recovery path (#1740)", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;

  const result = await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    ran = true;
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, domain.deps);

  assert.deepEqual(result, { action: "next", data: {} });
  assert.equal(ran, true);
  assert.equal(domain.claims.length, 1);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
  assert.equal(domain.settlements.length, 1, "same-session authority must settle the predecessor");
  assert.equal(domain.settlements[0].attemptId, "attempt-1");
  assert.equal(domain.settlements[0].outcome, "interrupted");
  assert.equal(domain.settlements[0].failureClass, "stale-worker");
  assert.equal(
    domain.settlements[0].recovery,
    undefined,
    "an equal lease settles through the owning worker's lease rather than replacement fencing",
  );
  assert.match(
    domain.settlements[0].summary,
    /same-session re-dispatch/,
  );
  assert.equal(domain.attempts[0].state, "settled", "same-session re-dispatch must not strand the prior Attempt");
  assert.equal(domain.routes.length, 1, "the interrupted Result must route through durable recovery");
});

test("a same-session re-dispatch with an equal lease token leaves no running Attempt behind (#1740)", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const { dispatchId: firstDispatchId } = seedCanonicalTaskFixture();
  const task = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  const firstClaim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "test:lease-guard:claim:first",
      sourceTransport: "internal",
      actorType: "agent",
    },
    task,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: firstDispatchId,
  });
  assert.equal(readTaskAttempt(firstClaim.attemptId)?.state, "running");

  // The re-dispatch mints a fresh coordination dispatch for the same unit; the
  // stale first dispatch row has left ('claimed','running') — the partial
  // unique index on active dispatches demands it — but its Attempt stays
  // running (#1740). The V47 dispatch-scope trigger authorizes the worker's
  // own-lease settle of that orphaned Attempt.
  database().prepare(`
    UPDATE unit_dispatches SET status = 'canceled', ended_at = '2026-07-12T00:10:00.000Z'
    WHERE id = :id
  `).run({ ":id": firstDispatchId });
  const secondDispatchId = insertClaimedDispatch(2);
  let ran = false;
  const result = await runWithTaskExecutionAttempt(input({ dispatchId: secondDispatchId }), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, canonicalDeps());

  assert.equal(ran, false);
  assert.deepEqual(result, { action: "retry", reason: "task-recovery-repair" });
  const predecessor = readTaskAttempt(firstClaim.attemptId);
  assert.equal(predecessor?.state, "settled");
  assert.equal(predecessor?.outcome, "interrupted");
  assert.equal(predecessor?.resultFailureClass, "stale-worker");
  const running = database().prepare(`
    SELECT COUNT(*) AS count FROM workflow_execution_attempts WHERE attempt_state = 'running'
  `).get() as { count: number };
  assert.equal(running.count, 0, "no code path may leave an Attempt in running when the guard trips");
  const observation = database().prepare(`
    SELECT summary, failure_kind FROM workflow_failure_observations
  `).get() as { summary: string; failure_kind: string };
  assert.match(
    observation.summary,
    /same-session re-dispatch/,
    "the same-session interruption must surface through the durable failure route",
  );
  assert.equal(observation.failure_kind, "stale-worker");
});

test("lost first-claim response replays the exact claim without self-linking or interruption", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const running: AttemptSnapshot = {
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  };
  domain.attempts.push(running);

  await runWithTaskExecutionAttempt(input(), async () => {
    domain.completeSucceeded(running.attemptId);
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    claimTaskAttempt(claim) {
      domain.claims.push(claim);
      return {
        status: "replayed",
        operationId: "claim-operation-1",
        resultingRevision: 1,
        attemptId: running.attemptId,
        attemptNumber: running.attemptNumber,
      };
    },
  });

  assert.equal(domain.settlements.length, 0);
  assert.equal(domain.claims[0].retryOfAttemptId, undefined);
});

test("lost recovered-retry claim response replays with the original predecessor lineage", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "settled",
    outcome: "interrupted",
    nextStage: "route",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  const retry: AttemptSnapshot = {
    attemptId: "attempt-2",
    attemptNumber: 2,
    retryOfAttemptId: "attempt-1",
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 42,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  };
  domain.attempts.push(retry);

  await runWithTaskExecutionAttempt(input({
    dispatchId: 42,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  }), async () => {
    domain.completeSucceeded(retry.attemptId);
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    claimTaskAttempt(claim) {
      domain.claims.push(claim);
      return {
        status: "replayed",
        operationId: "claim-operation-2",
        resultingRevision: 3,
        attemptId: retry.attemptId,
        attemptNumber: retry.attemptNumber,
      };
    },
  });

  assert.equal(domain.settlements.length, 0);
  assert.equal(domain.claims[0].retryOfAttemptId, "attempt-1");
});

test("stale Attempt interruption failure aborts before retry claim or provider execution", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  domain.attempts.push({
    attemptId: "attempt-1",
    attemptNumber: 1,
    state: "running",
    nextStage: "execute",
    coordinationDispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
  });
  let ran = false;
  const rejected = new Error("replacement lease is not authoritative");

  await assert.rejects(runWithTaskExecutionAttempt(input({
    dispatchId: 42,
    workerId: "worker-2",
    milestoneLeaseToken: 8,
  }), async () => {
    ran = true;
    return { action: "next", data: {} };
  }, {
    ...domain.deps,
    settleTaskAttempt() {
      throw rejected;
    },
  }), rejected);

  assert.equal(ran, false);
  assert.equal(domain.claims.length, 0);
});

test("verified Task publication uses the latest succeeded Attempt and stable auto identity", async () => {
  const { publishVerifiedTaskExecution } = await subject();
  const published: unknown[] = [];

  await publishVerifiedTaskExecution({ ...input(), basePath: "/project" }, {
    readLatestTaskAttempt: () => ({
      attemptId: "attempt-7",
      attemptNumber: 7,
      state: "settled",
      outcome: "succeeded",
      nextStage: "verify",
      coordinationDispatchId: 41,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    }),
    async publishVerifiedTaskCompletion(value) {
      published.push(value);
    },
  });

  assert.deepEqual(published, [{
    invocation: {
      idempotencyKey: "internal:auto:task.publish:attempt-7",
      sourceTransport: "internal",
      actorType: "agent",
    },
    basePath: "/project",
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    attemptId: "attempt-7",
  }]);
});

test("settled Task publication delegates replay validation to the stable publication operation", async () => {
  const { publishVerifiedTaskExecution } = await subject();
  const rejected = new Error("settled Attempt does not belong to the stable publication operation");
  let publicationCalls = 0;

  await assert.rejects(publishVerifiedTaskExecution({ ...input(), basePath: "/project" }, {
    readLatestTaskAttempt: () => ({
      attemptId: "attempt-7",
      attemptNumber: 7,
      state: "settled",
      outcome: "succeeded",
      nextStage: "settled",
      coordinationDispatchId: 41,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    }),
    readTaskLifecycleStatus: () => "in_progress",
    async publishVerifiedTaskCompletion() {
      publicationCalls++;
      throw rejected;
    },
  }), rejected);

  assert.equal(publicationCalls, 1);
});

test("a voided settled Attempt on a reopened Task is not replayed as a publication (#1948)", async () => {
  const { publishVerifiedTaskExecution } = await subject();
  let publicationCalls = 0;

  await assert.rejects(publishVerifiedTaskExecution({ ...input(), basePath: "/project" }, {
    readLatestTaskAttempt: () => ({
      attemptId: "attempt-7",
      attemptNumber: 7,
      state: "settled",
      outcome: "succeeded",
      nextStage: "settled",
      coordinationDispatchId: 41,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    }),
    readTaskLifecycleStatus: () => "ready",
    async publishVerifiedTaskCompletion() {
      publicationCalls++;
    },
  }), /requires a succeeded Attempt at the verify stage/);

  assert.equal(publicationCalls, 0);
});

test("failed Task execution cannot publish after host verification", async () => {
  const { publishVerifiedTaskExecution } = await subject();
  let published = false;

  await assert.rejects(publishVerifiedTaskExecution({ ...input(), basePath: "/project" }, {
    readLatestTaskAttempt: () => ({
      attemptId: "attempt-7",
      attemptNumber: 7,
      state: "settled",
      outcome: "failed",
      nextStage: "route",
      coordinationDispatchId: 41,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    }),
    async publishVerifiedTaskCompletion() {
      published = true;
    },
  }), /succeeded|verify/i);

  assert.equal(published, false);
});
