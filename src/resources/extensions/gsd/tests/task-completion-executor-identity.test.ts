// Project/App: gsd-pi
// File Purpose: Executable contract for private Pi identity at the staged Task completion boundary.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { executeTaskComplete } from "../tools/workflow-tool-executors.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<Record<string, unknown>>;
}

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: key,
  };
}

function completionParams(): Record<string, unknown> {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    oneLiner: "Staged the executor result",
    narrative: "The executor result is ready for independent host verification.",
    verification: "Executor reports the focused test passed.",
    deviations: "None.",
    knownIssues: "None.",
    keyFiles: ["src/task.ts"],
    keyDecisions: ["Host verification owns completion."],
    blockerDiscovered: false,
    verificationEvidence: [{
      command: "npm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 10,
    }],
  };
}

function createBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-task-completion-executor-"));
  tempDirs.add(basePath);
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Completion identity",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage result** `est:10m`",
    "  - Do: Stage executor output",
    "  - Verify: npm test",
    "",
  ].join("\n"));
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Completion identity', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Completion seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Stage result', 'in_progress', 'npm test', 1);
  `);
  return basePath;
}

function adoptCanonicalLifecycle(): void {
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
      projections: [{ projectionKey: "test/task-ready", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function claimCanonicalAttempt(basePath: string): string {
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-claim', 'turn-claim', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return claim.attemptId;
}

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerDbTools({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  return tools;
}

function registeredCompletionTools(): RegisteredTool[] {
  return registeredTools().filter(
    (tool) => tool.name === "gsd_task_complete" || tool.name === "gsd_complete_task",
  );
}

function registeredReopenTools(): RegisteredTool[] {
  return registeredTools().filter(
    (tool) => tool.name === "gsd_task_reopen" || tool.name === "gsd_reopen_task",
  );
}

function registeredTaskRecoveryResumeTool(): RegisteredTool {
  const tool = registeredTools().find((candidate) => candidate.name === "gsd_task_recovery_resume");
  assert.ok(tool);
  return tool;
}

function completeCanonicalFixture(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.completed",
    idempotencyKey: "fixture/task-completed",
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
      lifecycleStatus: "completed",
    });
    db().prepare(`UPDATE tasks SET status = 'complete' WHERE id = 'T01'`).run();
    return {
      events: [{
        eventType: "test.task.completed",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{ projectionKey: "test/task-completed", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

afterEach(() => {
  closeDatabase();
  delete process.env.GSD_ADVERTISE_TOOL_ALIASES;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("execution invocation constructors keep transport identity private and deterministic", async () => {
  const { internalExecutionInvocation, piExecutionInvocation } = await import("../execution-invocation.js");

  assert.deepEqual(piExecutionInvocation("gsd_task_complete", "call-7"), {
    idempotencyKey: "pi:gsd_task_complete:call-7",
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: "call-7",
  });
  assert.deepEqual(internalExecutionInvocation("auto:settle:attempt-1", {
    actorId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
  }), {
    idempotencyKey: "auto:settle:attempt-1",
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
  });
});

test("Pi task recovery resume derives replay identity from the private tool call", async () => {
  const basePath = createBase();
  adoptCanonicalLifecycle();
  const attemptId = claimCanonicalAttempt(basePath);
  const settled = settleTaskAttempt({
    invocation: invocation("fixture/settle-fatal"),
    attemptId,
    outcome: "failed",
    failureClass: "fatal",
    summary: "The executor runtime is invalid.",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/route-fatal"),
    attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "The executor runtime is invalid.",
    evidence: { source: "executor" },
    rationale: "Stop until the executor is repaired.",
  });
  assert.equal(abort.action, "abort");

  const tool = registeredTaskRecoveryResumeTool();
  const params = {
    recoveryActionId: abort.recoveryActionId,
    repairSummary: "The executor runtime was rebuilt and verified.",
    evidence: { pullRequest: 1457, check: "recovery test passed" },
  };
  const committed = await tool.execute("resume-call-42", params, undefined, undefined, { cwd: basePath });
  const replayed = await tool.execute("resume-call-42", params, undefined, undefined, { cwd: basePath });

  assert.equal(committed.isError, undefined);
  assert.equal((committed.details as { status?: string }).status, "committed");
  assert.equal((replayed.details as { status?: string }).status, "replayed");
  assert.deepEqual(row(`
    SELECT idempotency_key, operation_type
    FROM workflow_operations
    WHERE operation_type = 'task.recovery.resume'
  `), {
    idempotency_key: "pi:gsd_task_recovery_resume:resume-call-42",
    operation_type: "task.recovery.resume",
  });
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_domain_events
    WHERE event_type = 'task.recovery.resumed'
  `).count), 1);
});

test("a running canonical Attempt requires private invocation identity before completion mutation", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);

  const result = await executeTaskComplete(completionParams() as never, basePath);

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /private|invocation|identity/i);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});

test("a canonical lifecycle without an Attempt fails closed instead of using legacy completion", async () => {
  const basePath = createBase();
  adoptCanonicalLifecycle();

  const result = await executeTaskComplete(completionParams() as never, basePath);

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /canonical.*Attempt|Attempt.*canonical/i);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});

test("private completion identity cannot fall back when the canonical lifecycle is missing", async () => {
  const basePath = createBase();

  const result = await executeTaskComplete(
    completionParams() as never,
    basePath,
    invocation("pi:gsd_task_complete:missing-lifecycle"),
  );

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /canonical.*lifecycle|lifecycle.*canonical/i);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
});

test("Pi canonical and alias completion calls converge on one private staged Result", async () => {
  process.env.GSD_ADVERTISE_TOOL_ALIASES = "1";
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);
  const tools = registeredCompletionTools();
  const canonical = tools.find((tool) => tool.name === "gsd_task_complete");
  const alias = tools.find((tool) => tool.name === "gsd_complete_task");
  assert.ok(canonical);
  assert.ok(alias);
  assert.equal(canonical.parameters.properties?.["idempotencyKey"], undefined);
  assert.equal(alias.parameters.properties?.["idempotencyKey"], undefined);

  const first = await canonical.execute("completion-call-42", completionParams(), undefined, undefined, { cwd: basePath });
  const replay = await alias.execute("completion-call-42", completionParams(), undefined, undefined, { cwd: basePath });

  assert.deepEqual(replay, first);
  assert.equal(first.isError, undefined);
  const firstContent = first.content as Array<{ text?: unknown }>;
  assert.match(String(firstContent[0]?.text), /awaiting host verification/i);
  assert.equal((first.details as Record<string, unknown>).attemptId, attemptId);
  assert.deepEqual(row(`
    SELECT operation.operation_type, operation.idempotency_key, operation.source_transport,
           result.attempt_id, result.outcome
    FROM workflow_operations operation
    JOIN workflow_attempt_results result ON result.operation_id = operation.operation_id
  `), {
    operation_type: "attempt.settle",
    idempotency_key: "pi:gsd_task_complete:completion-call-42",
    source_transport: "pi-tool",
    attempt_id: attemptId,
    outcome: "succeeded",
  });
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});

test("Pi canonical and alias reopen calls converge without replaying projection cleanup", async () => {
  process.env.GSD_ADVERTISE_TOOL_ALIASES = "1";
  const basePath = createBase();
  completeCanonicalFixture();
  const tools = registeredReopenTools();
  const canonical = tools.find((tool) => tool.name === "gsd_task_reopen");
  const alias = tools.find((tool) => tool.name === "gsd_reopen_task");
  assert.ok(canonical);
  assert.ok(alias);

  const params = {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    reason: "new verification found a regression",
  };
  const first = await canonical.execute("reopen-call-42", params, undefined, undefined, { cwd: basePath });
  const summaryPath = join(basePath, ".gsd", "phases", "01-test", "01-01-T01-SUMMARY.md");
  writeFileSync(summaryPath, "# Newer summary\n");
  const replay = await alias.execute("reopen-call-42", params, undefined, undefined, { cwd: basePath });

  assert.deepEqual(replay, first);
  assert.ok(existsSync(summaryPath), "replay must not delete a projection created after the original reopen");
  assert.deepEqual(row(`
    SELECT operation_type, idempotency_key, source_transport
    FROM workflow_operations WHERE operation_type = 'task.reopen'
  `), {
    operation_type: "task.reopen",
    idempotency_key: "pi:gsd_task_reopen:reopen-call-42",
    source_transport: "pi-tool",
  });
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_work_checkpoints`).count, 1);
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "ready");
  assert.equal(row(`SELECT status FROM tasks WHERE id = 'T01'`).status, "pending");
});

test("a canonical blocker submission records a failed Result and routes instead of awaiting verification", async () => {
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);

  const result = await executeTaskComplete({
    ...completionParams(),
    blockerDiscovered: true,
  } as never, basePath, invocation("pi:gsd_task_complete:blocker-call"));

  assert.equal(result.isError, undefined);
  assert.match(String(result.content[0]?.text), /blocker|routed for recovery/i);
  assert.doesNotMatch(String(result.content[0]?.text), /awaiting host verification/i);
  assert.equal((result.details as Record<string, unknown>).nextStage, "route");
  assert.deepEqual(row(`
    SELECT attempt_id, outcome, failure_class
    FROM workflow_attempt_results
  `), {
    attempt_id: attemptId,
    outcome: "failed",
    failure_class: "blocker-discovered",
  });
});

test("canonical escalation fails closed until the durable adapter can persist it", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);

  const result = await executeTaskComplete({
    ...completionParams(),
    escalation: {
      question: "Which recovery should run?",
      options: [
        { id: "A", label: "Repair", tradeoffs: "Fix now." },
        { id: "B", label: "Pause", tradeoffs: "Wait for direction." },
      ],
      recommendation: "A",
      recommendationRationale: "The repair is reversible.",
      continueWithDefault: false,
    },
  } as never, basePath, invocation("pi:gsd_task_complete:escalation-call"));

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /canonical.*escalation|escalation.*durable/i);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});

test("canonical soft escalation is dropped and staged instead of dead-ending closeout", async () => {
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);

  // With phases.mid_execution_escalation disabled (the default) a soft
  // escalation (continueWithDefault !== false) is ignored on the legacy path,
  // so the canonical path must stage the completion rather than throwing.
  const result = await executeTaskComplete({
    ...completionParams(),
    escalation: {
      question: "Files changed outside the task plan — proceed?",
      options: [
        { id: "A", label: "Continue", tradeoffs: "Accept the incidental changes." },
        { id: "B", label: "Pause", tradeoffs: "Wait for direction." },
      ],
      recommendation: "A",
      recommendationRationale: "The changes are incidental to the verified work.",
      continueWithDefault: true,
    },
  } as never, basePath, invocation("pi:gsd_task_complete:soft-escalation-call"));

  assert.notEqual(result.isError, true);
  assert.match(String(result.content[0]?.text), /awaiting host verification/i);
  assert.equal((result.details as Record<string, unknown>).attemptId, attemptId);
  assert.equal(row("SELECT outcome FROM workflow_attempt_results").outcome, "succeeded");
});
