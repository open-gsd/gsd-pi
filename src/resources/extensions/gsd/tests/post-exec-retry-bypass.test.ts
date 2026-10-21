// Project/App: gsd-pi
// File Purpose: Tests for automated verification retry and terminal failure handling.
/**
 * post-exec-retry-bypass.test.ts — Tests for post-execution verification retry behavior.
 *
 * Verifies that when post-execution checks fail (postExecBlockingFailure is true),
 * the retry system gets a chance to repair the task before auto-mode asks for help.
 */

import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  runPostUnitVerification,
  type TaskVerificationAuthority,
  type VerificationContext,
} from "../auto-verification.ts";
import { AutoSession } from "../auto/session.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, _getAdapter } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { initMetrics, resetMetrics } from "../metrics.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { _setDomainOperationFaultForTest, executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let originalCwd: string;

function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {},
      setWidget: () => {},
      setFooter: () => {},
    },
    model: { id: "test-model" },
  } as any;
}

function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true),
  } as any;
}

function makeMockSession(basePath: string, currentUnit?: { type: string; id: string }): AutoSession {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  // verificationRetryCount is readonly but initialized as an empty Map in AutoSession
  s.pendingVerificationRetry = null;
  if (currentUnit) {
    s.currentUnit = {
      type: currentUnit.type,
      id: currentUnit.id,
      startedAt: Date.now(),
    };
  }
  return s;
}

function makeVerificationContext(
  s: AutoSession,
  ctx: ReturnType<typeof makeMockCtx>,
  pi: ReturnType<typeof makeMockPi>,
): VerificationContext {
  const taskAuthority: TaskVerificationAuthority = {
    readLatestTaskAttempt: () => ({
      attemptId: "attempt-test",
      resultId: "result-test",
      state: "settled",
      outcome: "succeeded",
      nextStage: "verify",
    }),
    readTaskTechnicalVerdict: () => null,
    recordTaskTechnicalVerdict: (input) => verdictReceipt(input.verdict),
    invalidateTaskTechnicalPass: () => verdictReceipt("inconclusive"),
    routeTaskFailure: () => recoveryReceipt("remediate"),
  };
  return { s, ctx, pi, taskAuthority };
}

function verdictReceipt(verdict: "pass" | "fail" | "inconclusive") {
  return {
    status: "committed" as const,
    operationId: "verdict-operation",
    resultingRevision: 3,
    verdictId: "verdict-1",
    evidenceId: "evidence-1",
    nextStage: verdict === "pass" ? "verify" as const : "route" as const,
  };
}

function recoveryReceipt(action: "retry" | "repair" | "remediate" | "replan" | "abort") {
  return {
    status: "committed" as const,
    operationId: "recovery-operation",
    resultingRevision: 4,
    lifecycleId: "lifecycle-test",
    attemptId: "attempt-test",
    resultId: "result-test",
    failureObservationId: "observation-1",
    recoveryActionId: "action-1",
    action,
  };
}

function currentSourceRevision(): string {
  const captured = captureVerificationSourceSnapshot([{ id: "project", cwd: tempDir }]);
  assert.equal(captured.ok, true, captured.ok ? undefined : captured.error);
  return captured.snapshot.aggregateRevision;
}

function setupTestEnvironment(): void {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `post-exec-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  const gsdDir = join(tempDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  const milestonesDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(milestonesDir, { recursive: true });

  process.chdir(tempDir);
  execFileSync("git", ["init", "-q"], { cwd: tempDir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
  writeFileSync(join(tempDir, ".gitignore"), ".gsd/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: tempDir });
  execFileSync("git", ["commit", "-qm", "test baseline"], { cwd: tempDir });
  invalidateAllCaches();
  _clearGsdRootCache();

  dbPath = join(gsdDir, "gsd.db");
  openDatabase(dbPath);
}

function cleanupTestEnvironment(): void {
  _setDomainOperationFaultForTest(null);
  try {
    process.chdir(originalCwd);
  } catch {
    // Ignore
  }
  try {
    closeDatabase();
  } catch {
    // Ignore
  }
  resetMetrics();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function writePreferences(prefs: Record<string, unknown>): void {
  const yamlLines = Object.entries(prefs).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const prefsContent = `---
${yamlLines.join("\n")}
---

# GSD Preferences
`;
  writeFileSync(join(tempDir, ".gsd", "PREFERENCES.md"), prefsContent);
  invalidateAllCaches();
  _clearGsdRootCache();
}

function useFlatPhaseLayout(): string {
  rmSync(join(tempDir, ".gsd", "milestones"), { recursive: true, force: true });
  const phaseDir = join(tempDir, ".gsd", "phases", "01-m001");
  mkdirSync(phaseDir, { recursive: true });
  invalidateAllCaches();
  _clearGsdRootCache();
  return phaseDir;
}

/**
 * Create a task in DB that will pass basic verification but allows us to test the flow.
 */
function createBasicTask(verify = "echo pass"): void {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  // Create a simple task
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Basic task",
    status: "pending",
    planning: {
      description: "A basic task for testing",
      estimate: "1h",
      files: [],
      verify,
      inputs: [],
      expectedOutput: ["output.ts"],
      observabilityImpact: "",
    },
    sequence: 0,
  });
}

function createCanonicalSucceededTaskAttempt(): string {
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'verification-worker', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '${tempDir.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'verification-worker', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'verification-trace', 'verification-turn', 'verification-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/verification-task-ready",
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
  const dispatch = adapter.prepare("SELECT id FROM unit_dispatches").get() as { id: number };
  const claimed = claimTaskAttempt({
    invocation: internalExecutionInvocation("fixture/verification-task-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "verification-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatch.id,
  });
  settleTaskAttempt({
    invocation: internalExecutionInvocation("fixture/verification-task-settle"),
    attemptId: claimed.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor completed",
    output: { changedFiles: [] },
  });
  return claimed.attemptId;
}

function createTaskWithoutVerify(status = "pending"): void {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task without host verification",
    status,
    planning: {
      description: "Task intentionally missing runnable verification",
      estimate: "1h",
      files: [],
      verify: "",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });
}

function createFailingVerifyTask(status = "pending"): void {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task with failing verification",
    status,
    planning: {
      description: "Task with deterministic failing verification",
      estimate: "1h",
      files: [],
      verify: "node -e \"process.exit(1)\"",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });
}

function createPostExecFailureTask(): void {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "broken.ts"),
    "import { missing } from './does-not-exist.js';\nexport const ok = 1;\n",
    "utf-8",
  );

  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task with broken import",
    status: "pending",
    keyFiles: ["src/broken.ts"],
    planning: {
      description: "Task that introduces an unresolved import in key files",
      estimate: "1h",
      files: ["src/broken.ts"],
      verify: "echo pass",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });
}

function createPostExecWarningTask(): void {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "prior.ts"),
    "export function formatName(name: string): string { return name; }\n",
    "utf-8",
  );
  writeFileSync(
    join(srcDir, "current.ts"),
    "export function formatName(first: string, last: string): string { return `${first} ${last}`; }\n",
    "utf-8",
  );

  insertTask({
    id: "T00",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Prior task",
    status: "complete",
    keyFiles: ["src/prior.ts"],
    planning: {
      description: "Prior task with original signature",
      estimate: "1h",
      files: ["src/prior.ts"],
      verify: "echo pass",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });

  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task with signature warning",
    status: "pending",
    keyFiles: ["src/current.ts"],
    planning: {
      description: "Task that changes a prior function signature",
      estimate: "1h",
      files: ["src/current.ts"],
      verify: "echo pass",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 1,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Post-execution blocking failure retry bypass", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test("skips verification when unit type is not execute-task", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });

    const vctx = makeVerificationContext(s, ctx, pi);
    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    // Non-execute-task units should return "continue" immediately
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("returns continue when verification passes", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const vctx = makeVerificationContext(s, ctx, pi);
    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    // When verification passes, should return "continue" and not call pauseAuto
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    
    // Retry state should be cleared
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("shell parse execution fault pauses without consuming a verification retry", async () => {
    createBasicTask();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async (_ctx?: unknown, _pi?: unknown, _errorContext?: { message: string }) => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const recordTaskTechnicalVerdict = mock.fn(() => verdictReceipt("fail"));
    const routeTaskFailure = mock.fn(() => recoveryReceipt("remediate"));
    vctx.runVerificationGate = () => ({
      passed: false,
      checks: [{
        command: `node -e '"const'`,
        exitCode: 1,
        stdout: "",
        stderr: "[eval]:1\nUnterminated string constant\nSyntaxError: Invalid or unexpected token",
        durationMs: 10,
        failureClass: "shell-parse",
      }],
      discoverySource: "preference",
      timestamp: Date.now(),
    });
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict,
      routeTaskFailure,
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.match(pauseAutoMock.mock.calls[0]?.arguments[2]?.message ?? "", /shell could not parse/i);
    assert.equal(recordTaskTechnicalVerdict.mock.callCount(), 0);
    assert.equal(routeTaskFailure.mock.callCount(), 0);
    assert.equal(s.verificationRetryCount.has("execute-task:M001/S01/T01"), false);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("source drift records an inconclusive verdict and routes to retry", async () => {
    const driftPath = join(tempDir, "drift-during-verification.txt");
    createBasicTask(`node -e "require('node:fs').writeFileSync('${driftPath}', 'changed')"`);
    writePreferences({ enhanced_verification: false, verification_auto_fix: true });
    const recorded: Parameters<TaskVerificationAuthority["recordTaskTechnicalVerdict"]>[0][] = [];
    const routed: Parameters<TaskVerificationAuthority["routeTaskFailure"]>[0][] = [];
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: (input) => {
        recorded.push(input);
        return verdictReceipt(input.verdict);
      },
      routeTaskFailure: (input) => {
        routed.push(input);
        return recoveryReceipt("remediate");
      },
    };

    const result = await runPostUnitVerification(vctx, mock.fn(async () => {}));

    assert.equal(result, "retry");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.verdict, "inconclusive");
    assert.equal(recorded[0]?.evidence.observation, "inconclusive");
    assert.match(recorded[0]?.rationale ?? "", /source.*changed|drift/i);
    assert.equal(routed.length, 1);
    const { invocation: routeInvocation, ...routeInput } = routed[0]!;
    assert.match(routeInvocation.idempotencyKey, /attempt\.route:result-test$/);
    assert.equal(routeInput.attemptId, "attempt-test");
    assert.equal(routeInput.resultId, "result-test");
    assert.equal(routeInput.owner, "agent");
    assert.deepEqual(routeInput.classification, { failureKind: "verification-failed" });
    assert.deepEqual(routeInput.evidence, { verdictId: "verdict-1", evidenceId: "evidence-1", verdict: "inconclusive" });
    assert.match(String(routeInput.summary), /inconclusive/);
    assert.match(String(routeInput.rationale), /gsd-source-integrity|source/);
    assert.match(String(routeInput.rationale), /expected/i);
    assert.doesNotMatch(String(routeInput.rationale), /Route built-in host verification through the durable recovery policy/);
    assert.doesNotMatch(String(routeInput.summary), /Built-in host verification did not pass/);
  });

  test("Git snapshot failure records inconclusive without running verification commands", async () => {
    const commandMarker = join(tempDir, "verification-command-ran.txt");
    createBasicTask(`node -e "require('node:fs').writeFileSync('${commandMarker}', 'ran')"`);
    writePreferences({ enhanced_verification: false, verification_auto_fix: true });
    rmSync(join(tempDir, ".git"), { recursive: true, force: true });
    const recorded: Parameters<TaskVerificationAuthority["recordTaskTechnicalVerdict"]>[0][] = [];
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: (input) => {
        recorded.push(input);
        return verdictReceipt(input.verdict);
      },
    };

    const result = await runPostUnitVerification(vctx, mock.fn(async () => {}));

    assert.equal(result, "retry");
    assert.equal(existsSync(commandMarker), false);
    assert.equal(recorded[0]?.verdict, "inconclusive");
    assert.doesNotMatch(recorded[0]?.testedSourceRevision ?? "", /^attempt:/);
  });

  test("lost verdict response replays before rerunning verification commands", async () => {
    const commandMarker = join(tempDir, "replayed-command-ran.txt");
    createBasicTask(`node -e "require('node:fs').writeFileSync('${commandMarker}', 'ran')"`);
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    let writes = 0;
    const testedSourceRevision = currentSourceRevision();
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readTaskTechnicalVerdict: () => ({
        attemptId: "attempt-test",
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "pass",
        testedSourceRevision,
        nextStage: "verify",
        operationId: "operation-1",
        resultingRevision: 3,
      }),
      recordTaskTechnicalVerdict: () => { writes++; return verdictReceipt("pass"); },
    };

    const result = await runPostUnitVerification(vctx, mock.fn(async () => {}));

    assert.equal(result, "continue");
    assert.equal(existsSync(commandMarker), false);
    assert.equal(writes, 0);
  });

  test("stored passing verdict is invalidated and routes source drift through durable recovery", async () => {
    const commandMarker = join(tempDir, "changed-replay-command-ran.txt");
    createBasicTask(`node -e "require('node:fs').writeFileSync('${commandMarker}', 'ran')"`);
    const testedSourceRevision = currentSourceRevision();
    writeFileSync(join(tempDir, "changed-after-verdict.ts"), "export const changed = true;\n");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const pauseAutoMock = mock.fn(async () => {});
    let writes = 0;
    const invalidations: Parameters<TaskVerificationAuthority["invalidateTaskTechnicalPass"]>[0][] = [];
    const routed: Parameters<TaskVerificationAuthority["routeTaskFailure"]>[0][] = [];
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readTaskTechnicalVerdict: () => ({
        attemptId: "attempt-test",
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "pass",
        testedSourceRevision,
        nextStage: "verify",
        operationId: "operation-1",
        resultingRevision: 3,
      }),
      recordTaskTechnicalVerdict: () => { writes++; return verdictReceipt("pass"); },
      invalidateTaskTechnicalPass: (input) => {
        invalidations.push(input);
        return verdictReceipt("inconclusive");
      },
      routeTaskFailure: (input) => {
        routed.push(input);
        return recoveryReceipt("remediate");
      },
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(existsSync(commandMarker), false);
    assert.equal(writes, 0);
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]?.attemptId, "attempt-test");
    assert.equal(invalidations[0]?.supersedesVerdictId, "verdict-1");
    assert.match(String(invalidations[0]?.rationale), /no longer matches|source/i);
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.classification.failureKind, "verification-drift");
    assert.equal(routed[0]?.resultId, "result-test");
    assert.equal(s.verificationRetryCount.get("execute-task:M001/S01/T01"), 1);
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("missing explicit verification targets route through durable recovery", async () => {
    createBasicTask();
    _getAdapter()!.prepare(`
      UPDATE tasks
      SET target_repositories = :targets
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run({ ":targets": JSON.stringify(["missing-repository"]) });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const verdicts: string[] = [];
    const routeTaskFailure = mock.fn(() => recoveryReceipt("remediate"));
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: (input) => {
        verdicts.push(input.verdict);
        return verdictReceipt(input.verdict);
      },
      routeTaskFailure,
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.deepEqual(verdicts, ["fail"]);
    assert.equal(routeTaskFailure.mock.callCount(), 1);
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("pre-verdict built-in verification exceptions persist inconclusive recovery instead of aborting", async () => {
    createBasicTask();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const recorded: Parameters<TaskVerificationAuthority["recordTaskTechnicalVerdict"]>[0][] = [];
    const routed: Parameters<TaskVerificationAuthority["routeTaskFailure"]>[0][] = [];
    vctx.runVerificationGate = () => { throw new Error("verification process could not start"); };
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: (input) => {
        recorded.push(input);
        return verdictReceipt(input.verdict);
      },
      routeTaskFailure: (input) => {
        routed.push(input);
        return recoveryReceipt("remediate");
      },
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.verdict, "inconclusive");
    assert.match(recorded[0]?.rationale ?? "", /could not start/);
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.classification.failureKind, "verification-failed");
    assert.equal(routed[0]?.resultId, "result-test");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("lost verdict and route responses resume from canonical facts without pausing", async () => {
    createBasicTask("node -e \"process.exit(1)\"");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    let storedVerdict: ReturnType<TaskVerificationAuthority["readTaskTechnicalVerdict"]> = null;
    let recordedVerdict: string | undefined;
    let routeCalls = 0;
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readTaskTechnicalVerdict: () => storedVerdict,
      recordTaskTechnicalVerdict: (input) => {
        recordedVerdict = input.verdict;
        storedVerdict = {
          attemptId: input.attemptId,
          verdictId: "verdict-lost-response",
          evidenceId: "evidence-lost-response",
          verdict: input.verdict,
          testedSourceRevision: input.testedSourceRevision,
          nextStage: "route",
          operationId: "operation-lost-response",
          resultingRevision: 3,
        };
        throw new Error("verdict committed but response was lost");
      },
      routeTaskFailure: () => {
        routeCalls++;
        if (routeCalls === 1) throw new Error("route committed but response was lost");
        return recoveryReceipt("remediate");
      },
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(recordedVerdict, "fail");
    assert.equal(routeCalls, 2);
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("stored non-pass verdict replays result-keyed durable recovery before retry state", async () => {
    const commandMarker = join(tempDir, "inconclusive-replay-command-ran.txt");
    createBasicTask(`node -e "require('node:fs').writeFileSync('${commandMarker}', 'ran')"`);
    writePreferences({ verification_auto_fix: false, verification_max_retries: 0 });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const routeTaskFailure = mock.fn(
      (_input: Parameters<TaskVerificationAuthority["routeTaskFailure"]>[0]) => recoveryReceipt("remediate"),
    );
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readLatestTaskAttempt: () => ({
        attemptId: "attempt-test",
        resultId: "result-exact",
        state: "settled",
        outcome: "succeeded",
        nextStage: "route",
      }),
      readTaskTechnicalVerdict: () => ({
        attemptId: "attempt-test",
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "inconclusive",
        testedSourceRevision: "unavailable",
        nextStage: "route",
        operationId: "operation-1",
        resultingRevision: 3,
      }),
      routeTaskFailure,
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(routeTaskFailure.mock.callCount(), 1);
    assert.equal(routeTaskFailure.mock.calls[0]?.arguments[0].resultId, "result-exact");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(existsSync(commandMarker), false);
    assert.equal(s.verificationRetryCount.get("execute-task:M001/S01/T01"), 1);
  });

  test("re-reading one stored failure does not consume another repair attempt", async () => {
    createBasicTask();
    writePreferences({ verification_auto_fix: true, verification_max_retries: 1 });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    const routeTaskFailure = mock.fn(() => recoveryReceipt("remediate"));
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readLatestTaskAttempt: () => ({
        attemptId: "attempt-test",
        resultId: "result-test",
        state: "settled",
        outcome: "succeeded",
        nextStage: "route",
      }),
      readTaskTechnicalVerdict: () => ({
        attemptId: "attempt-test",
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "fail",
        testedSourceRevision: currentSourceRevision(),
        nextStage: "route",
        operationId: "operation-1",
        resultingRevision: 3,
      }),
      routeTaskFailure,
    };

    assert.equal(await runPostUnitVerification(vctx, pauseAutoMock), "retry");
    assert.equal(await runPostUnitVerification(vctx, pauseAutoMock), "retry");
    assert.equal(s.verificationRetryCount.get("execute-task:M001/S01/T01"), 1);
    assert.equal(s.pendingVerificationRetry?.attempt, 1);
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(routeTaskFailure.mock.callCount(), 2);
  });

  test("durable abort ends verification without pausing for human review", async () => {
    createBasicTask();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      readLatestTaskAttempt: () => ({
        attemptId: "attempt-test",
        resultId: "result-test",
        state: "settled",
        outcome: "succeeded",
        nextStage: "route",
      }),
      readTaskTechnicalVerdict: () => ({
        attemptId: "attempt-test",
        verdictId: "verdict-1",
        evidenceId: "evidence-1",
        verdict: "fail",
        testedSourceRevision: currentSourceRevision(),
        nextStage: "route",
        operationId: "operation-1",
        resultingRevision: 3,
      }),
      routeTaskFailure: () => recoveryReceipt("abort"),
    };

    assert.equal(await runPostUnitVerification(vctx, pauseAutoMock), "abort");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("a pre-commit verdict fault propagates and the canonical verify stage retries cleanly", async () => {
    createBasicTask("node -e \"process.exit(1)\"");
    const attemptId = createCanonicalSucceededTaskAttempt();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = { s, ctx, pi } satisfies VerificationContext;

    _setDomainOperationFaultForTest("after-mutation");
    await assert.rejects(
      runPostUnitVerification(vctx, pauseAutoMock),
      /domain operation fault: after-mutation/,
    );

    assert.equal(readTaskTechnicalVerdict(attemptId), null);
    assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "verify");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    const adapter = _getAdapter();
    assert.ok(adapter);
    assert.equal(
      Number(adapter.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_actions").get()?.count ?? 0),
      0,
    );

    _setDomainOperationFaultForTest(null);
    assert.equal(await runPostUnitVerification(vctx, pauseAutoMock), "retry");
    assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "fail");
    assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "route");
  });

  test("an after-commit verdict response loss replays the canonical verdict and route", async () => {
    createBasicTask("node -e \"process.exit(1)\"");
    const attemptId = createCanonicalSucceededTaskAttempt();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    let routeCalls = 0;
    const taskAuthority: TaskVerificationAuthority = {
      readLatestTaskAttempt,
      readTaskTechnicalVerdict,
      recordTaskTechnicalVerdict: (input) => {
        _setDomainOperationFaultForTest("after-commit");
        try {
          return recordTaskTechnicalVerdict(input);
        } finally {
          _setDomainOperationFaultForTest(null);
        }
      },
      invalidateTaskTechnicalPass,
      routeTaskFailure: (input) => {
        routeCalls++;
        if (routeCalls !== 1) return recordFailureAndSelectRecovery(input);
        _setDomainOperationFaultForTest("after-commit");
        try {
          return recordFailureAndSelectRecovery(input);
        } finally {
          _setDomainOperationFaultForTest(null);
        }
      },
    };

    assert.equal(
      await runPostUnitVerification({ s, ctx, pi, taskAuthority }, pauseAutoMock),
      "retry",
    );

    assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "fail");
    assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "route");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(routeCalls, 2);
    const adapter = _getAdapter();
    assert.ok(adapter);
    assert.equal(
      Number(adapter.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_actions").get()?.count ?? 0),
      1,
    );
  });

  test("a canonical verdict write failure propagates without publishing new passing VERIFY evidence", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: false,
    });

    const evidencePath = join(
      tempDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-VERIFY.json",
    );
    const previousProjection = '{"passed":false,"sentinel":"previous"}\n';
    writeFileSync(evidencePath, previousProjection, "utf-8");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: () => {
        throw new Error("simulated canonical verdict write failure");
      },
    };

    await assert.rejects(
      runPostUnitVerification(vctx, pauseAutoMock),
      /simulated canonical verdict write failure/,
    );
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(readFileSync(evidencePath, "utf-8"), previousProjection);
  });

  test("verification retry count is cleared on success", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    
    // Pre-set some retry state
    s.verificationRetryCount.set("execute-task:M001/S01/T01", 2);

    const vctx = makeVerificationContext(s, ctx, pi);
    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    // On success, retry count should be cleared
    assert.equal(result, "continue");
    assert.equal(s.verificationRetryCount.has("execute-task:M001/S01/T01"), false);
  });

  test("cost spike during verification retry is warning telemetry, not the pause reason", async () => {
    createFailingVerifyTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: false,
      verification_auto_fix: true,
      verification_max_retries: 2,
      per_unit_cost_cap_usd: 10,
    });
    writeFileSync(
      join(tempDir, ".gsd", "metrics.json"),
      JSON.stringify({
        version: 1,
        projectStartedAt: Date.now(),
        units: [
          { type: "execute-task", id: "M001/S01/T01", startedAt: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 1.48, toolCalls: 1, assistantMessages: 1 },
          ...Array.from({ length: 9 }, (_, i) => ({ type: "execute-task", id: `M000/S00/T0${i}`, startedAt: 10 + i, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0.01, toolCalls: 1, assistantMessages: 1 })),
        ],
      }),
      "utf-8",
    );
    initMetrics(tempDir);

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");
    const messages = ctx.ui.notify.mock.calls.map((c: { arguments: unknown[] }) => String(c.arguments[0]));
    assert.ok(messages.some((m: string) => m.includes("cost spike detected") && m.includes("authoritative blocker")));
    assert.ok(messages.some((m: string) => m.includes("Verification failed") && m.includes("auto-fix attempt 1/2")));
  });

  test("post-execution checker infrastructure failure records inconclusive and retries", async () => {
    createPostExecFailureTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 2,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);
    let recordedVerdict = "unrecorded";
    vctx.taskAuthority = {
      ...vctx.taskAuthority!,
      recordTaskTechnicalVerdict: (input) => {
        recordedVerdict = input.verdict;
        return verdictReceipt(input.verdict);
      },
    };
    vctx.runPostExecutionChecks = () => {
      throw new Error("simulated checker infrastructure outage");
    };

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(recordedVerdict, "inconclusive");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /checker infrastructure outage/);
    const evidencePath = join(
      tempDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-VERIFY.json",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false, "inconclusive checker failure must not project a pass");
    assert.equal(evidence.retryAttempt, 1);
  });

  test("post-exec failure notification includes failing check details", async () => {
    createPostExecFailureTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const vctx = makeVerificationContext(s, ctx, pi);
    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /\[import\] src\/broken\.ts:1/);
    const notifyMessages = ctx.ui.notify.mock.calls.map((c: { arguments: unknown[] }) =>
      String(c.arguments[0])
    );
    assert.ok(
      notifyMessages.some(
        (m: string) =>
          m.includes("Verification failed ([import] src/broken.ts:1") &&
          m.includes("auto-fix attempt 1/3")
      )
    );
  });

  test("flat-phase post-unit evidence writes slice-task VERIFY.json at phase level", async () => {
    const phaseDir = useFlatPhaseLayout();
    createPostExecFailureTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    const evidencePath = join(phaseDir, "S01-T01-VERIFY.json");
    const legacyEvidencePath = join(phaseDir, "tasks", "T01-VERIFY.json");
    assert.ok(existsSync(evidencePath), "flat-phase evidence should be written at phase level");
    assert.equal(existsSync(legacyEvidencePath), false, "flat-phase evidence should not create legacy tasks/ path");

    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false);
    assert.ok(Array.isArray(evidence.postExecutionChecks), "post-execution checks should be included in rewritten evidence");
  });

  test("strict post-exec warning retry includes warning details", async () => {
    createPostExecWarningTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      enhanced_verification_strict: true,
      verification_auto_fix: true,
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /\[signature\] formatName:/);
    const notifyMessages = ctx.ui.notify.mock.calls.map((c: { arguments: unknown[] }) =>
      String(c.arguments[0])
    );
    assert.ok(
      notifyMessages.some(
        (m: string) =>
          m.includes("Verification failed ([signature] formatName:") &&
          m.includes("auto-fix attempt 1/3")
      )
    );
  });

  test("uok gate runner persists post-execution gate failures when enabled", async () => {
    createPostExecFailureTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 2,
      uok: {
        enabled: true,
        gates: { enabled: true },
      },
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = makeVerificationContext(s, ctx, pi);

    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);

    const adapter = _getAdapter();
    const row = adapter
      ?.prepare(
        `SELECT gate_id, outcome, failure_class
         FROM gate_runs
         WHERE gate_id = 'post-execution-checks'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get() as { gate_id: string; outcome: string; failure_class: string } | undefined;

    assert.ok(row, "post-execution gate run should be persisted when uok.gates is enabled");
    assert.equal(row?.gate_id, "post-execution-checks");
    assert.equal(row?.outcome, "fail");
    assert.equal(row?.failure_class, "artifact");
  });

  test("execute-task with no host-owned verification retries while auto-fix budget remains", async () => {
    createTaskWithoutVerify();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");

    const notifyMessages = ctx.ui.notify.mock.calls.map((c: { arguments: unknown[] }) =>
      String(c.arguments[0])
    );
    assert.ok(
      notifyMessages.some(
        (m: string) =>
          m.includes("Verification failed") &&
          m.includes("auto-fix attempt")
      ),
      "no-host-checks failure should enter the automated repair loop",
    );

    const evidencePath = join(tempDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-VERIFY.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.discoverySource, "none");
    assert.equal(evidence.retryAttempt, 1);
    assert.equal(evidence.maxRetries, 2);
  });

  test("completed browser-facing execute-task with no host-owned verification continues toward browser UAT", async () => {
    createTaskWithoutVerify("complete");
    writeFileSync(join(tempDir, "index.html"), "<!doctype html><button>Import</button>", "utf-8");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);

    const notifyMessages = ctx.ui.notify.mock.calls.map((c: { arguments: unknown[] }) =>
      String(c.arguments[0])
    );
    assert.ok(
      notifyMessages.some(
        (m: string) =>
          m.includes("canonical executor Result passed") &&
          m.includes("slice UAT") &&
          m.includes("automated")
      ),
      "completed web tasks without task-level commands should explain browser UAT handoff",
    );

    const evidencePath = join(tempDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-VERIFY.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.discoverySource, "none");
    assert.ok(!("retryAttempt" in evidence), "browser-UAT handoff evidence must not request a task retry");
  });

  test("auto-discovered package.json verification failure retries instead of continuing", async () => {
    createTaskWithoutVerify();
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
      "utf-8",
    );
    writePreferences({
      verification_auto_fix: true,
      verification_max_retries: 2,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /npm test/);
  });

  test("completed execute-task verification failure still retries", async () => {
    createFailingVerifyTask("complete");
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: false,
      verification_auto_fix: true,
      verification_max_retries: 2,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const result = await runPostUnitVerification(makeVerificationContext(s, ctx, pi), pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");
    assert.equal(s.verificationRetryCount.get("execute-task:M001/S01/T01"), 1);

    const evidencePath = join(tempDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-VERIFY.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.retryAttempt, 1);
    assert.equal(evidence.maxRetries, 2);
  });
});

describe("Post-execution retry behavior", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test("durable recovery retries even when the legacy autofix preference is disabled", async () => {
    // Create a task with a verify command that will fail
    insertMilestone({ id: "M001" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Test Slice",
      risk: "low",
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Failing task",
      status: "pending",
      planning: {
        description: "Task with failing verification",
        estimate: "1h",
        files: [],
        verify: "exit 1", // This will fail
        inputs: [],
        expectedOutput: [],
        observabilityImpact: "",
      },
      sequence: 0,
    });

    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: false, // Autofix disabled
      verification_max_retries: 3,
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });

    const vctx = makeVerificationContext(s, ctx, pi);
    const result = await runPostUnitVerification(vctx, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");
  });
});
