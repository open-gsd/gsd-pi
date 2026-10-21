// Project/App: gsd-pi
// File Purpose: Capstone convergence proof for M003/S04 Task recovery across
// retry exhaustion, resume, genuine pause, reopen/cancel, projection safety,
// semantic shadow parity, and cross-transport identity.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  cancelTask,
  readPendingTaskRecoveryContext,
  readTaskRecoveryResumeEligibility,
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
  reopenTask,
  resolveTaskBlocker,
  resumeTaskRecovery,
} from "../task-recovery-domain-operation.ts";
import { claimTaskAttempt, readLatestTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import { readTerminalTaskRecoveryAbort } from "../artifact-verification.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  publishVerifiedTaskCompletion,
  stageTaskCompletion,
  type StageTaskCompletionInput,
} from "../task-completion-compatibility-adapter.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { executeTaskReopen } from "../tools/workflow-tool-executors.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";
import { handleReopenTask } from "../tools/reopen-task.ts";
import { writeReactiveExecuteBlocker } from "../auto-recovery.ts";
import { buildCustomEngineIterationData } from "../auto/workflow-custom-engine-iteration.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { buildRunUatCanonicalToolNames } from "../tool-presentation-plan.ts";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`).count ?? 0);
}

function invocation(
  key: string,
  actorType = "agent",
  sourceTransport: ExecutionInvocation["sourceTransport"] = "internal",
): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport,
    actorType,
    actorId: actorType === "user" ? "user-1" : "recovery-agent",
    traceId: `trace:${key}`,
    turnId: `turn:${key}`,
  };
}

type RegisteredPiTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { cwd: string },
  ) => Promise<unknown>;
};

function registeredPiTools(): RegisteredPiTool[] {
  const tools: RegisteredPiTool[] = [];
  registerDbTools({ registerTool: (tool: RegisteredPiTool) => tools.push(tool) } as never);
  return tools;
}

type RegisteredMcpTool = {
  name: string;
  handler: (args: Record<string, unknown>, extra?: { _meta?: Record<string, unknown> }) => Promise<unknown>;
};

function registeredMcpTools(): RegisteredMcpTool[] {
  const tools: RegisteredMcpTool[] = [];
  registerWorkflowTools({
    tool(
      name: string,
      _description: string,
      _params: Record<string, unknown>,
      handler: RegisteredMcpTool["handler"],
    ) {
      tools.push({ name, handler });
    },
  }, { advertiseAliases: false });
  return tools;
}

/** Seeds one milestone/slice plus a fixed roster of pending tasks in a fresh DB. */
function seedProject(taskIds: string[], initializeGit = true): { basePath: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-task-recovery-convergence-")));
  tempDirs.add(dir);
  if (initializeGit) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "verified\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  }
  const dbPath = join(dir, ".gsd", "gsd.db");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(dbPath), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Recovery', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO requirements (id, class, status, description)
    VALUES
      ('R001', 'primary-user-loop', 'active', 'Recovery remains bounded'),
      ('R002', 'quality-attribute', 'active', 'Waiver ownership remains exact');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '${dir.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
  `);
  for (const taskId of taskIds) {
    db().prepare(`
      INSERT INTO tasks (milestone_id, slice_id, id, title, status)
      VALUES ('M001', 'S01', :task_id, 'Recover atomically', 'pending')
    `).run({ ":task_id": taskId });
  }
  const phaseDir = join(dir, ".gsd", "phases", "01-recovery");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Recovery operation",
    "",
    "## Tasks",
    "",
    ...taskIds.map((taskId) => `- [ ] **${taskId}: Recover atomically**`),
    "",
  ].join("\n"));
  return { basePath: dir };
}

function completionInput(basePath: string, taskId: string, key: string): StageTaskCompletionInput {
  return {
    invocation: invocation(key),
    basePath,
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    completion: {
      oneLiner: "Recovered execution completed",
      narrative: "The repaired executor produced a candidate result.",
      verification: "Host verification remains authoritative.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["src/convergence.ts"],
      keyDecisions: ["Preserve immutable recovery history."],
      blockerDiscovered: false,
      verificationEvidence: [{ command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1 }],
    },
  };
}

function recordPassingVerdict(basePath: string, attemptId: string, key: string): void {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: invocation(key),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Host verification passed after the repair.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "npm test",
      workingDirectory: basePath,
      startedAt: "2026-07-13T02:00:04.000Z",
      endedAt: "2026-07-13T02:00:05.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function insertClaimedDispatch(taskId: string, attemptNumber: number): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', :attempt_n, :started_at
    )
  `).run({
    ":trace_id": `convergence-trace-${taskId}-${attemptNumber}`,
    ":turn_id": `convergence-turn-${taskId}-${attemptNumber}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
    ":attempt_n": attemptNumber,
    ":started_at": `2026-07-13T02:00:0${attemptNumber}.000Z`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function adoptReady(taskId: string): string {
  const fence = readDomainOperationFence();
  let lifecycleId = "";
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: `fixture/${taskId}/ready`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    lifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "ready",
    }).lifecycleId;
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: `M001/S01/${taskId}`,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{ projectionKey: `test/${taskId}/ready`.toLowerCase(), projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return lifecycleId;
}

function seedFailedAttempt(taskId: string): { attemptId: string; resultId: string } {
  adoptReady(taskId);
  const dispatchId = insertClaimedDispatch(taskId, 1);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim/1`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  const settlement = settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle/1`),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });
  return { attemptId: claim.attemptId, resultId: settlement.resultId };
}

function seedRetryFailure(
  taskId: string,
  priorAttemptId: string,
  attemptNumber: number,
): { attemptId: string; resultId: string } {
  const dispatchId = insertClaimedDispatch(taskId, attemptNumber);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim/${attemptNumber}`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId: priorAttemptId,
  });
  const settlement = settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle/${attemptNumber}`),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });
  return { attemptId: claim.attemptId, resultId: settlement.resultId };
}

function completeTaskWithHistory(taskId: string): string {
  const lifecycleId = adoptReady(taskId);
  const dispatchId = insertClaimedDispatch(taskId, 1);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/completed/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/completed/settle`),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Task completed",
    output: { summary: "durable history" },
  });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.complete",
    idempotencyKey: `fixture/${taskId}/completed/closeout`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-13T01:00:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :task_id
    `).run({ ":task_id": taskId });
    return {
      events: [{ eventType: "test.task.complete", entityType: "task", entityId: `M001/S01/${taskId}`, payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: `test/${taskId}/complete`.toLowerCase(), projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return lifecycleId;
}

function domainEventShadow(eventType: string, taskId: string): Record<string, unknown> {
  const stored = row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = :event_type AND entity_id = :entity_id
    ORDER BY project_revision DESC LIMIT 1
  `, { ":event_type": eventType, ":entity_id": `M001/S01/${taskId}` });
  const payload = JSON.parse(String(stored.payload_json)) as Record<string, unknown>;
  return payload.shadow as Record<string, unknown>;
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("agent recovery exhausts durably, resumes once, then passes host verification and publishes", async () => {
  const taskId = "T01";
  const { basePath } = seedProject([taskId]);
  const first = seedFailedAttempt(taskId);

  const route = (key: string, failure: { attemptId: string; resultId: string }) =>
    recordFailureAndSelectRecovery({
      invocation: invocation(key),
      attemptId: failure.attemptId,
      resultId: failure.resultId,
      owner: "agent",
      classification: { failureKind: "tool-unavailable" },
      summary: `tool surface unavailable for ${key}`,
      evidence: { source: "executor", trigger: key },
      rationale: "apply the durable recovery policy",
    });

  const routed1 = route("convergence/route/1", first);
  const second = seedRetryFailure(taskId, first.attemptId, 2);
  const routed2 = route("convergence/route/2", second);
  const third = seedRetryFailure(taskId, second.attemptId, 3);
  const routed3 = route("convergence/route/3", third);

  assert.deepEqual(
    [routed1.action, routed2.action, routed3.action],
    ["retry", "retry", "abort"],
    "the fixed transient-execution budget must exhaust to abort on its third use",
  );
  assert.equal(routed2.recoveryBudgetId, routed1.recoveryBudgetId);
  assert.equal(count("workflow_recovery_budgets"), 1, "one durable budget must govern every use of this fingerprint");

  const resumed = resumeTaskRecovery({
    invocation: invocation("convergence/resume/1"),
    recoveryActionId: routed3.recoveryActionId,
    repairSummary: "The missing tool surface was restored in the executor runtime.",
    evidence: { fix: "open-gsd/gsd-pi#convergence", verification: "focused recovery tests passed" },
  });
  assert.equal(resumed.status, "committed");
  assert.equal(readTaskRecoveryRoute(third.attemptId)?.resumeAuthorized, true);

  const recoveryPrompt = (await buildCustomEngineIterationData({
    step: {
      unitType: "execute-task",
      unitId: `M001/S01/${taskId}`,
      prompt: "Continue the custom-engine Task.",
    },
    basePath,
    canonicalProjectRoot: basePath,
    currentMilestoneId: "M001",
    deriveState: async () => ({
      activeMilestone: { id: "M001", title: "Recovery" },
      activeSlice: { id: "S01", title: "Convergence" },
      activeTask: { id: taskId, title: "Task T01" },
      phase: "executing",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
    }),
    logPostDerive: () => {},
  })).prompt;
  const dispatchId4 = insertClaimedDispatch(taskId, 4);
  const claim4 = claimTaskAttempt({
    invocation: invocation("convergence/claim/4"),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId4,
    retryOfAttemptId: third.attemptId,
  });
  assert.match(recoveryPrompt, /Required action:\*\* continue/);
  assert.match(recoveryPrompt, /do not call `gsd_task_recovery_resume`/i);
  assert.doesNotMatch(recoveryPrompt, /Required action:\*\* resume/);
  const settled4 = await stageTaskCompletion(
    completionInput(basePath, taskId, "convergence/settle/4"),
  );
  assert.equal(
    readPendingTaskRecoveryContext({ milestoneId: "M001", sliceId: "S01", taskId }),
    null,
    "the successor claim must consume the resumed-abort prompt authority",
  );
  assert.throws(() => resumeTaskRecovery({
    invocation: invocation("convergence/resume/reuse"),
    recoveryActionId: routed3.recoveryActionId,
    repairSummary: "Attempting to reuse already-consumed authorization.",
    evidence: { verification: "must be rejected" },
  }), /already-resumed guard|latest-attempt guard|already been consumed|current (?:agent-owned )?abort|pending recovery/i);

  recordPassingVerdict(basePath, claim4.attemptId, "convergence/verdict/4");
  const published = await publishVerifiedTaskCompletion({
    invocation: invocation("convergence/publish/4"),
    basePath,
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    attemptId: claim4.attemptId,
  });
  assert.equal(published.status, "committed");

  assert.equal(count("workflow_failure_observations"), 3);
  assert.equal(count("workflow_recovery_actions"), 3);
  assert.deepEqual(
    db().prepare(`SELECT action FROM workflow_recovery_actions ORDER BY project_revision`).all(),
    [{ action: "retry" }, { action: "retry" }, { action: "abort" }],
  );
  assert.equal(count("workflow_recovery_budgets"), 1);
  assert.equal(count("workflow_work_checkpoints"), 4);
  assert.equal(count("workflow_execution_attempts"), 4, "no Attempt history is erased by recovery");
  assert.equal(count("workflow_attempt_results"), 4);
  assert.deepEqual(
    db().prepare(`SELECT status FROM unit_dispatches ORDER BY attempt_n`).all(),
    [{ status: "failed" }, { status: "failed" }, { status: "failed" }, { status: "completed" }],
  );
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "completed");
  assert.equal(row(`SELECT status FROM tasks WHERE id = 'T01'`).status, "complete");
  assert.equal(row(`SELECT verdict FROM workflow_technical_verdicts`).verdict, "pass");
  assert.equal(count("workflow_verification_evidence"), 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'task.completion.publish'
  `).count), 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE event_type = 'task.completion.published'
  `).count), 1);
  const revisions = db().prepare(`
    SELECT resulting_revision FROM workflow_operations ORDER BY resulting_revision
  `).all().map((entry) => Number((entry as Record<string, unknown>).resulting_revision));
  assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));
  assert.equal(new Set(revisions).size, revisions.length, "every committed operation owns one revision");
});

test("reopen closes a stale route head so the prior abort is history, not a lever (#1948)", async () => {
  const taskId = "T01";
  seedProject([taskId]);
  const failed = seedFailedAttempt(taskId);
  const abort = recordFailureAndSelectRecovery({
    invocation: invocation("reopen-void/route"),
    attemptId: failed.attemptId,
    resultId: failed.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "verification-abort",
    evidence: { source: "test" },
    rationale: "abort",
  });
  assert.equal(abort.action, "abort");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId })?.nextStage, "route");

  // Terminal lifecycle head reached without advancing the Attempt Kernel lineage.
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.complete",
    idempotencyKey: "reopen-void/complete",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "completed",
    });
    db().prepare(`UPDATE tasks SET status = 'complete' WHERE id = :task_id`).run({ ":task_id": taskId });
    return {
      events: [{ eventType: "test.task.complete", entityType: "task", entityId: `M001/S01/${taskId}`, payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: `test/${taskId}/complete-void`.toLowerCase(), projectionKind: "test", rendererVersion: "1" }],
    };
  });

  const reopened = reopenTask({
    invocation: invocation("reopen-void/reopen", "user"),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    reason: "redo after repair",
  });
  assert.equal(reopened.canonicalStatus, "ready");

  const latest = readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId });
  assert.equal(latest?.attemptId, failed.attemptId, "reopen must not erase Attempt history");
  assert.equal(latest?.nextStage, "settled", "reopen closes the stale route head");
  assert.equal(readTaskRecoveryResumeEligibility(abort.recoveryActionId).eligible, false);
  assert.equal(readTerminalTaskRecoveryAbort("M001", "S01", taskId), null);
  assert.equal(count("workflow_execution_attempts"), 1);
});

test("reopen and cancel survive projection obstruction while stale artifacts and UAT scopes remain non-authoritative", async () => {
  const taskIdA = "T01";
  const taskIdB = "T02";
  const artifactTaskId = "T03";
  const { basePath } = seedProject([taskIdA, taskIdB, artifactTaskId]);

  // Round trip A: complete -> reopen. Legacy/canonical raw values differ
  // (pending vs ready) but the comparison must still record an explicit
  // semantic match rather than silently coercing the raw statuses together.
  const completed = completeTaskWithHistory(taskIdA);
  const beforeReopen = {
    attempts: count("workflow_execution_attempts"),
    results: count("workflow_attempt_results"),
  };
  const obstructedSummary = join(
    basePath,
    ".gsd",
    "phases",
    "01-recovery",
    "01-01-T01-SUMMARY.md",
  );
  mkdirSync(obstructedSummary);
  const reopened = await handleReopenTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: taskIdA,
    reason: "fresh verification found a regression",
  }, basePath, invocation("convergence/reopen/completed", "agent", "internal"));
  assert.deepEqual(reopened, { milestoneId: "M001", sliceId: "S01", taskId: taskIdA });
  assert.equal(row(`SELECT status FROM tasks WHERE id = :task_id`, { ":task_id": taskIdA }).status, "pending");
  assert.deepEqual(domainEventShadow("task.reopened", taskIdA), {
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: taskIdA,
    kind: "semantic_match_exact_delta",
    legacyStatus: "pending",
    canonicalStatus: "ready",
    normalizedLegacyStatus: "pending",
    normalizedCanonicalStatus: "ready",
  });
  assert.deepEqual({
    attempts: count("workflow_execution_attempts"),
    results: count("workflow_attempt_results"),
  }, beforeReopen, "reopen must not erase or fabricate Attempt/Result history");
  assert.equal(count("workflow_execution_attempts"), 1);
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = :lifecycle_id
  `, { ":lifecycle_id": completed }).lifecycle_status, "ready");
  assert.deepEqual(row(`
    SELECT delivery_state, attempt_count, last_error
    FROM workflow_projection_work
    WHERE projection_key = 'lifecycle/m001/s01/t01'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_projection_work successor
        WHERE successor.supersedes_projection_work_id = workflow_projection_work.projection_work_id
      )
  `), { delivery_state: "pending", attempt_count: 0, last_error: "" });

  // Round trip B: ready -> cancel -> reopen. Legacy/canonical raw values
  // differ again (skipped vs cancelled) and must resolve the same way.
  adoptReady(taskIdB);
  const cancelled = cancelTask({
    invocation: invocation("convergence/cancel/ready", "agent", "internal"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: taskIdB },
    reason: "the work is intentionally omitted",
  });
  assert.equal(cancelled.canonicalStatus, "cancelled");
  assert.equal(cancelled.legacyStatus, "skipped");
  assert.deepEqual(domainEventShadow("task.cancelled", taskIdB), {
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: taskIdB,
    kind: "semantic_match_exact_delta",
    legacyStatus: "skipped",
    canonicalStatus: "cancelled",
    normalizedLegacyStatus: "cancelled",
    normalizedCanonicalStatus: "cancelled",
  });

  reopenTask({
    invocation: invocation("convergence/reopen/cancelled", "agent", "internal"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: taskIdB },
    reason: "the omitted work is required again",
  });
  assert.equal(row(`SELECT status FROM tasks WHERE id = :task_id`, { ":task_id": taskIdB }).status, "pending");
  assert.deepEqual(domainEventShadow("task.reopened", taskIdB), {
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: taskIdB,
    kind: "semantic_match_exact_delta",
    legacyStatus: "pending",
    canonicalStatus: "ready",
    normalizedLegacyStatus: "pending",
    normalizedCanonicalStatus: "ready",
  });

  adoptReady(artifactTaskId);
  const staleSummary = join(
    basePath,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "tasks",
    `${artifactTaskId}-SUMMARY.md`,
  );
  mkdirSync(join(staleSummary, ".."), { recursive: true });
  writeFileSync(staleSummary, "# Stale projection claiming completion\n");
  const artifactRecovery = writeReactiveExecuteBlocker(
    `M001/S01/reactive+${artifactTaskId}`,
    basePath,
    "projection obstruction convergence proof",
  );
  assert.ok(artifactRecovery);
  assert.deepEqual(artifactRecovery.completedTaskIds, []);
  assert.deepEqual(artifactRecovery.skippedTaskIds, []);
  assert.deepEqual(artifactRecovery.unchangedTaskIds, [artifactTaskId]);
  assert.equal(row(`SELECT status FROM tasks WHERE id = :task_id`, { ":task_id": artifactTaskId }).status, "pending");
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = :task_id
  `, { ":task_id": artifactTaskId }).lifecycle_status, "ready");

  assert.equal(
    shouldBlockAutoUnitToolCall(
      "execute-task",
      "gsd_task_recovery_resume",
      { recoveryActionId: "execute-task-repair" },
      `M001/S01/${artifactTaskId}`,
    ).block,
    false,
  );
  const uatTools = buildRunUatCanonicalToolNames();
  for (const lifecycleTool of ["gsd_task_recovery_resume", "gsd_task_reopen", "gsd_slice_reopen"]) {
    assert.ok(!uatTools.includes(lifecycleTool), `${lifecycleTool} must not be available to run-uat`);
  }
});

test("Pi, workflow MCP, and internal entry points converge on identical reopen results", async () => {
  const taskIds = ["T01", "T02", "T03"] as const;
  const { basePath } = seedProject([...taskIds], false);
  for (const taskId of taskIds) completeTaskWithHistory(taskId);

  const params = (taskId: string) => ({
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
    reason: "cross-transport convergence proof",
  });
  const piTool = registeredPiTools().find((tool) => tool.name === "gsd_task_reopen");
  assert.ok(piTool);
  _setDomainOperationFaultForTest("after-commit");
  const lostPiResponse = await piTool.execute(
    "pi-reopen-T01",
    params("T01"),
    undefined,
    undefined,
    { cwd: basePath },
  );
  _setDomainOperationFaultForTest(null);
  assert.equal((lostPiResponse as { isError?: boolean }).isError, true);
  assert.equal(row(`SELECT status FROM tasks WHERE id = 'T01'`).status, "pending");
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = 'T01'
  `).lifecycle_status, "ready");
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'task.reopen' AND source_transport = 'pi-tool'
  `).count), 1, "the lost response must occur after the reopen commits");

  closeDatabase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const piResult = await piTool.execute(
    "pi-reopen-T01",
    params("T01"),
    undefined,
    undefined,
    { cwd: basePath },
  );

  const mcpTool = registeredMcpTools().find((tool) => tool.name === "gsd_task_reopen");
  assert.ok(mcpTool);
  _setDomainOperationFaultForTest("after-commit");
  const lostMcpResponse = await mcpTool.handler(
    { projectDir: basePath, ...params("T02") },
    { _meta: { "io.opengsd/idempotency-key": "mcp-reopen-T02" } },
  );
  _setDomainOperationFaultForTest(null);
  assert.equal((lostMcpResponse as { isError?: boolean }).isError, true);
  assert.equal(row(`SELECT status FROM tasks WHERE id = 'T02'`).status, "pending");

  closeDatabase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const mcpResult = await mcpTool.handler(
    { projectDir: basePath, ...params("T02") },
    { _meta: { "io.opengsd/idempotency-key": "mcp-reopen-T02" } },
  );

  _setDomainOperationFaultForTest("after-commit");
  const lostInternalResponse = await executeTaskReopen(
    params("T03"),
    basePath,
    invocation("internal-reopen-T03", "agent", "internal"),
  );
  _setDomainOperationFaultForTest(null);
  assert.equal(lostInternalResponse.isError, true);
  assert.equal(row(`SELECT status FROM tasks WHERE id = 'T03'`).status, "pending");

  closeDatabase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const internalResult = await executeTaskReopen(
    params("T03"),
    basePath,
    invocation("internal-reopen-T03", "agent", "internal"),
  );

  for (const [entryPoint, taskId, result] of [
    ["pi", "T01", piResult],
    ["mcp", "T02", mcpResult],
    ["internal", "T03", internalResult],
  ] as const) {
    const receipt = result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
      structuredContent?: Record<string, unknown>;
    };
    assert.notEqual(receipt.isError, true, `${entryPoint}: ${JSON.stringify(receipt)}`);
    assert.match(receipt.content[0]!.text, /^Reopened task T0[123] \(S01\/M001\)$/);
    assert.deepEqual(
      entryPoint === "mcp" ? receipt.structuredContent : receipt.details,
      { operation: "reopen_task", taskId, sliceId: "S01", milestoneId: "M001" },
    );
  }

  const transports: Array<{ taskId: string; transport: ExecutionInvocation["sourceTransport"] }> = [
    { taskId: "T01", transport: "pi-tool" },
    { taskId: "T02", transport: "workflow-mcp" },
    { taskId: "T03", transport: "internal" },
  ];
  for (const { taskId, transport } of transports) {
    assert.equal(row(`SELECT status FROM tasks WHERE id = :task_id`, { ":task_id": taskId }).status, "pending");
    assert.equal(row(`
      SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = :task_id
    `, { ":task_id": taskId }).lifecycle_status, "ready");
    const shadow = domainEventShadow("task.reopened", taskId);
    assert.equal(shadow.kind, "semantic_match_exact_delta");
    assert.equal(shadow.normalizedLegacyStatus, "pending");
    assert.equal(shadow.normalizedCanonicalStatus, "ready");
    assert.equal(
      Number(row(`
        SELECT COUNT(*) AS count FROM workflow_operations
        WHERE operation_type = 'task.reopen' AND source_transport = :source_transport
      `, { ":source_transport": transport }).count),
      1,
      `the ${transport} entry point must persist its own transport provenance`,
    );
  }
});

test("genuine blockers pause and continue only through fresh agent-owned Attempts", async () => {
  const taskId = "T01";
  const externalTaskId = "T02";
  const { basePath } = seedProject([taskId, externalTaskId]);
  adoptReady(taskId);
  const dispatchId = insertClaimedDispatch(taskId, 1);
  const claim = claimTaskAttempt({
    invocation: invocation("sabotage/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  const settled = await stageTaskCompletion(
    completionInput(basePath, taskId, "subjective-review/settle"),
  );
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  const verdictEvidence = {
    evidenceClass: "command" as const,
    commandOrTool: "npm test",
    workingDirectory: "/tmp/project",
    startedAt: "2026-07-13T02:00:02.000Z",
    endedAt: "2026-07-13T02:00:03.000Z",
    exitCode: 1,
    observation: "inconclusive" as const,
    durableOutputRef: "db://host-verification/sabotage",
    environment: { runner: "node-test", platform: "test" },
  };
  const verdict = recordTaskTechnicalVerdict({
    invocation: invocation("sabotage/verdict"),
    attemptId: claim.attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "inconclusive",
    rationale: "Subjective UAT requires a human reviewer.",
    evidence: verdictEvidence,
  });

  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("sabotage/route"),
    attemptId: claim.attemptId,
    resultId: settled.resultId,
    owner: "user",
    classification: { failureKind: "verification-failed" },
    summary: "a human reviewer must confirm the delivered behavior",
    evidence: { verdict: "inconclusive" },
    rationale: "the user owns subjective acceptance",
    blocker: {
      blockerKind: "subjective_uat",
      description: "the delivered behavior needs human confirmation",
      requestedAction: "Review the change and confirm it satisfies the intent",
    },
  });
  assert.equal(routed.action, "clarify");

  resolveTaskBlocker({
    invocation: invocation("sabotage/blocker/resolve", "user"),
    blockerId: routed.blockerId!,
    disposition: "resolved",
    resolution: "the human reviewer confirmed the delivered behavior",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: "the reviewer confirmed the intended behavior",
      unresolvedSummary: "",
      evidenceSummary: "the user confirmed acceptance",
      suggestedNextAction: "close out the Task",
    },
  });

  const humanReviewReroute = recordFailureAndSelectRecovery({
    invocation: invocation("subjective-review/reroute"),
    attemptId: claim.attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: "The human reviewer confirmed the behavior; execution must re-verify on a successor Attempt.",
    evidence: { blockerId: routed.blockerId!, review: "approved" },
    rationale: "Continue through the bounded agent recovery policy.",
    supersedesResolvedBlockerId: routed.blockerId,
  });
  assert.equal(humanReviewReroute.action, "remediate");

  const successorDispatchId = insertClaimedDispatch(taskId, 2);
  const successorClaim = claimTaskAttempt({
    invocation: invocation("subjective-review/claim/2"),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: successorDispatchId,
    retryOfAttemptId: claim.attemptId,
  });
  await stageTaskCompletion(completionInput(basePath, taskId, "subjective-review/settle/2"));
  recordPassingVerdict(basePath, successorClaim.attemptId, "subjective-review/verdict/2");
  const published = await publishVerifiedTaskCompletion({
    invocation: invocation("subjective-review/publish"),
    basePath,
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    attemptId: successorClaim.attemptId,
  });
  assert.equal(published.status, "committed");
  assert.equal(successorClaim.attemptNumber, 2);
  assert.equal(row(`
    SELECT retry_of_attempt_id
    FROM workflow_execution_attempts
    WHERE attempt_id = :attempt_id
  `, { ":attempt_id": successorClaim.attemptId }).retry_of_attempt_id, claim.attemptId);
  assert.deepEqual(db().prepare(`
    SELECT verdict
    FROM workflow_technical_verdicts
    ORDER BY project_revision
  `).all(), [{ verdict: "inconclusive" }, { verdict: "pass" }]);

  // The Task's current, non-superseded verdict is now "pass" — the stale
  // inconclusive verdict row must not make this attempt/result look like it
  // is still in a failure route state. Without the superseded-verdict filter
  // in loadRoutedFailureScope/requireCurrentRouteHead, this call would
  // wrongly succeed and fabricate a second recovery cycle on passed work.
  assert.throws(
    () => recordFailureAndSelectRecovery({
      invocation: invocation("sabotage/route-again"),
      attemptId: claim.attemptId,
      resultId: settled.resultId,
      owner: "agent",
      classification: { failureKind: "objective-uat" },
      summary: "must not be routable after the human-review pass",
      evidence: { verdict: "inconclusive" },
      rationale: "attempting to reuse the stale inconclusive verdict",
      supersedesResolvedBlockerId: routed.blockerId,
    }),
    /Task recovery requires a current execute or verification failure route head/,
  );
  assert.equal(verdict.nextStage, "route");

  const externalFailure = seedFailedAttempt(externalTaskId);
  const externalPause = recordFailureAndSelectRecovery({
    invocation: invocation("external-dependency/pause"),
    attemptId: externalFailure.attemptId,
    resultId: externalFailure.resultId,
    owner: "external",
    classification: { failureKind: "tool-unavailable" },
    summary: "A required external service is unavailable.",
    evidence: { provider: "external-test-service" },
    rationale: "The agent cannot repair an independently operated service.",
    blocker: {
      blockerKind: "external_dependency",
      description: "The external test service is unavailable.",
      requestedAction: "Restore the service, then resume recovery.",
    },
  });
  assert.equal(externalPause.action, "pause");
  assert.equal(externalPause.recoveryBudgetId, undefined);
  const externalBlockerId = externalPause.blockerId;
  assert.ok(externalBlockerId);
  const resolved = resolveTaskBlocker({
    invocation: invocation("external-dependency/resolve", "external"),
    blockerId: externalBlockerId,
    disposition: "resolved",
    resolution: "The external service was restored and its health check passed.",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: "The external service is available again.",
      unresolvedSummary: "",
      evidenceSummary: "The service owner supplied a passing health check.",
      suggestedNextAction: "Reroute the failed Result and retry execution.",
    },
  });
  assert.equal(resolved.blockerStatus, "resolved");
  assert.equal(
    readPendingTaskRecoveryContext({ milestoneId: "M001", sliceId: "S01", taskId: externalTaskId }),
    null,
  );

  const rerouted = recordFailureAndSelectRecovery({
    invocation: invocation("external-dependency/reroute"),
    attemptId: externalFailure.attemptId,
    resultId: externalFailure.resultId,
    owner: "agent",
    classification: { failureKind: "tool-unavailable" },
    summary: "The external service is healthy again.",
    evidence: { blockerId: externalBlockerId, healthCheck: "passed" },
    rationale: "Resume through the bounded agent recovery policy.",
    supersedesResolvedBlockerId: externalBlockerId,
  });
  assert.equal(rerouted.action, "retry");

  const retryDispatchId = insertClaimedDispatch(externalTaskId, 2);
  const retryClaim = claimTaskAttempt({
    invocation: invocation("external-dependency/claim/2"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: externalTaskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: retryDispatchId,
    retryOfAttemptId: externalFailure.attemptId,
  });
  assert.equal(retryClaim.attemptNumber, 2);
  assert.equal(
    row(`SELECT retry_of_attempt_id FROM workflow_execution_attempts WHERE attempt_id = :attempt_id`, {
      ":attempt_id": retryClaim.attemptId,
    }).retry_of_attempt_id,
    externalFailure.attemptId,
  );
});
