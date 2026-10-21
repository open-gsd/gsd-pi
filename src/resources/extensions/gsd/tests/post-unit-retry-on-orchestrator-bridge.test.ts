import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";

import { postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  checkPostUnitHooks,
  isRetryPending,
  peekRetryTrigger,
  persistHookState,
  resetHookState,
  resolveHookArtifactPath,
  restoreHookState,
} from "../post-unit-hooks.ts";
import { getOrCreateRegistry } from "../rule-registry.ts";
import { emitJournalEvent } from "../journal.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  _getAdapter,
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  completeLegacyTaskForVerifiedAttempt,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { reopenTask } from "../task-lifecycle-domain-operation.ts";

function writePreferences(basePath: string): void {
  const content = `---
post_unit_hooks:
  - name: review-arbiter
    after:
      - execute-task
    prompt: Review {taskId}
    agent: arbiter
    artifact: REVIEW-DEBATE.md
    retry_on: NEEDS-REWORK.md
    max_cycles: 3
    enabled: true
---
`;
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
}

function writeFailingHookPreferences(basePath: string): void {
  const content = `---
post_unit_hooks:
  - name: review-arbiter
    after:
      - execute-task
    prompt: Review {taskId}
    artifact: REVIEW-DEBATE.md
    max_cycles: 1
    enabled: true
  - name: follow-up-review
    after:
      - execute-task
    prompt: Follow-up review {taskId}
    enabled: true
---
`;
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
}

function writeBlockingPreferences(basePath: string): void {
  const content = `---
post_unit_hooks:
  - name: review-arbiter
    after:
      - execute-task
    prompt: Review {taskId}
    agent: arbiter
    artifact: REVIEW-DEBATE.md
    criticality: blocking
    max_cycles: 2
    enabled: true
---
`;
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
}

function createRetryBridgeContext(
  basePath: string,
  retryActiveUnit: (unit: { unitType: string; unitId: string }) => Promise<void>,
): PostUnitContext {
  const session = new AutoSession();
  session.basePath = basePath;
  session.active = true;
  session.currentUnit = { type: "hook/review-arbiter", id: "M001/S01/T01", startedAt: Date.now() };
  session.orchestration = {
    start: async () => ({ kind: "started" }),
    advance: async () => ({ kind: "stopped", reason: "unused" }),
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit,
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "resumed" }),
    stop: async (reason: string) => ({ kind: "stopped", reason }),
    getStatus: () => ({ phase: "running", transitionCount: 0 }),
  };
  return {
    s: session,
    ctx: {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} },
      model: { id: "test-model" },
    } as any,
    pi: { sendMessage: async () => {}, setModel: async () => true } as any,
    buildSnapshotOpts: () => ({}),
    lockBase: () => basePath,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };
}

function transitionTaskLifecycle(
  lifecycleStatus: "in_progress" | "completed",
  idempotencyKey: string,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: `test.task.${lifecycleStatus}`,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { lifecycleStatus },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus,
    });
    if (lifecycleStatus === "completed") {
      completeLegacyTaskForVerifiedAttempt(context, {
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
      });
    }
    return {
      events: [{
        eventType: `test.task.${lifecycleStatus}`,
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/task/${idempotencyKey}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function seedPersistedTaskRetry(
  basePath: string,
  completionOperationId: string,
): void {
  const registry = getOrCreateRegistry();
  registry.retryPending = true;
  registry.retryTrigger = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    completionOperationId,
  };
  persistHookState(basePath);
}

test("post-unit retry_on marks trigger unit as retry in orchestrator before redispatch", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    const hookDispatch = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.ok(hookDispatch, "hook should dispatch for execute-task");

    const retryPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
    writeFileSync(retryPath, "rework requested", "utf-8");

    const retryActiveUnit = mock.fn(async (_unit: { unitType: string; unitId: string }) => {});
    const pctx = createRetryBridgeContext(base, retryActiveUnit);

    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "continue");
    assert.equal(retryActiveUnit.mock.callCount(), 1);
    assert.deepEqual(retryActiveUnit.mock.calls[0]?.arguments[0], {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    assert.equal(
      _getAdapter()?.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = 'T01'").get()?.lifecycle_status,
      "ready",
    );
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry keeps its trigger and orchestration unchanged when canonical reopen fails", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-reopen-failure-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base));
    const retryPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
    writeFileSync(retryPath, "rework requested", "utf-8");

    const retryActiveUnit = mock.fn(async () => {});
    const pctx = createRetryBridgeContext(base, retryActiveUnit);

    await assert.rejects(postUnitPostVerification(pctx), /closed slice/);
    assert.equal(retryActiveUnit.mock.callCount(), 0, "orchestration is untouched when reopen fails");
    assert.equal(isRetryPending(), true, "the retry trigger remains pending");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(existsSync(retryPath), true, "retry evidence remains for the next attempt");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry replays after a lost orchestration response when the Task is already ready", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-lost-response-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base));
    const retryPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
    const summaryPath = join(taskDir, "T01-SUMMARY.md");
    writeFileSync(retryPath, "rework requested", "utf-8");
    writeFileSync(summaryPath, "completed work", "utf-8");

    let loseResponse = true;
    const retryActiveUnit = mock.fn(async () => {
      if (!loseResponse) return;
      loseResponse = false;
      throw new Error("lost orchestration response");
    });
    const pctx = createRetryBridgeContext(base, retryActiveUnit);

    await assert.rejects(postUnitPostVerification(pctx), /lost orchestration response/);
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending", "canonical reopen precedes orchestration");
    assert.equal(isRetryPending(), true, "lost response leaves the trigger pending");
    assert.equal(existsSync(summaryPath), false);
    assert.equal(existsSync(retryPath), false);

    assert.equal(await postUnitPostVerification(pctx), "continue");
    assert.equal(retryActiveUnit.mock.callCount(), 2, "replay retries the idempotent orchestration bridge");
    assert.equal(isRetryPending(), false, "successful replay consumes the trigger");
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    assert.equal(
      _getAdapter()?.prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'task.reopen'").get()?.count,
      1,
      "already-ready replay does not create another canonical reopen",
    );
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry cannot reopen a newer Task completion", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-stale-completion-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    transitionTaskLifecycle("completed", "test/hook-retry/reviewed-completion-a");
    const reviewedCompletionOperationId = String(_getAdapter()?.prepare(`
      SELECT last_operation_id
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
    `).get()?.["last_operation_id"]);

    assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base));
    persistHookState(base);
    resetHookState();
    restoreHookState(base);

    reopenTask({
      invocation: internalExecutionInvocation("test/hook-retry/intervening-reopen"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      reason: "Intervening correction while completion A's hook was still running",
    });
    transitionTaskLifecycle("in_progress", "test/hook-retry/newer-attempt");
    transitionTaskLifecycle("completed", "test/hook-retry/newer-completion-b");
    const newerCompletionOperationId = String(_getAdapter()?.prepare(`
      SELECT last_operation_id
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
    `).get()?.["last_operation_id"]);

    const retryPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
    writeFileSync(retryPath, "rework requested for the first completion", "utf-8");
    assert.equal(checkPostUnitHooks("hook/review-arbiter", "M001/S01/T01", base), null);
    assert.equal(isRetryPending(), true);
    assert.equal(
      peekRetryTrigger()?.completionOperationId,
      reviewedCompletionOperationId,
      "the retry remains bound to completion A after completion B replaces it",
    );

    const retryActiveUnit = mock.fn(async () => {});
    const result = await postUnitPostVerification(createRetryBridgeContext(base, retryActiveUnit));

    assert.equal(result, "continue");
    assert.equal(retryActiveUnit.mock.callCount(), 0, "stale trigger cannot retry orchestration");
    assert.equal(isRetryPending(), false, "stale trigger is acknowledged as obsolete");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(
      _getAdapter()?.prepare(`
        SELECT lifecycle_status, last_operation_id
        FROM workflow_item_lifecycles
        WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
      `).get()?.["last_operation_id"],
      newerCompletionOperationId,
      "newer completion remains the canonical head",
    );
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry without a canonical completion identity fails closed across restart", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-missing-identity-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
    _getAdapter()?.prepare(`
      UPDATE tasks SET completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    seedPersistedTaskRetry(base, "reviewed-completion-a");

    const retryActiveUnit = mock.fn(async () => {});
    await assert.rejects(
      postUnitPostVerification(createRetryBridgeContext(base, retryActiveUnit)),
      /canonical completion identity/i,
    );
    assert.equal(retryActiveUnit.mock.callCount(), 0);
    assert.equal(isRetryPending(), true, "missing canonical identity does not obsolete the retry");

    resetHookState();
    restoreHookState(base);
    assert.equal(isRetryPending(), true, "restart restores the unacknowledged retry signal");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry keeps its durable signal when the database is unavailable", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-db-unavailable-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    seedPersistedTaskRetry(base, "reviewed-completion-a");

    const retryActiveUnit = mock.fn(async () => {});
    await assert.rejects(
      postUnitPostVerification(createRetryBridgeContext(base, retryActiveUnit)),
      /database unavailable/i,
    );
    assert.equal(retryActiveUnit.mock.callCount(), 0);
    assert.equal(isRetryPending(), true, "DB outage leaves the retry pending");

    resetHookState();
    restoreHookState(base);
    assert.equal(isRetryPending(), true, "restart restores the retry after a DB outage");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry keeps its durable signal when completion identity lookup fails", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-query-failure-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
    seedPersistedTaskRetry(base, "reviewed-completion-a");
    _getAdapter()?.exec("DROP TABLE workflow_item_lifecycles");

    const retryActiveUnit = mock.fn(async () => {});
    await assert.rejects(
      postUnitPostVerification(createRetryBridgeContext(base, retryActiveUnit)),
      /workflow_item_lifecycles/,
    );
    assert.equal(retryActiveUnit.mock.callCount(), 0);
    assert.equal(isRetryPending(), true, "query failure leaves the retry pending");

    resetHookState();
    restoreHookState(base);
    assert.equal(isRetryPending(), true, "restart restores the retry after a query failure");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("execute-task hook capture failure leaves registry state untouched", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-hook-capture-failure-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  try {
    resetHookState();
    invalidateAllCaches();
    writePreferences(base);
    const registry = getOrCreateRegistry();

    assert.throws(
      () => checkPostUnitHooks("execute-task", "M001/S01/T01", base),
      /database unavailable/i,
    );
    assert.equal(registry.activeHook, null, "failed capture does not create an active hook");
    assert.equal(registry.hookQueue.length, 0, "failed capture does not enqueue hooks");
    assert.equal(registry.cycleCounts.size, 0, "failed capture does not charge a hook cycle");

    persistHookState(base);
    resetHookState();
    restoreHookState(base);
    assert.equal(getOrCreateRegistry().activeHook, null);
    assert.equal(getOrCreateRegistry().hookQueue.length, 0);
  } finally {
    closeDatabase();
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook retry persistence failure preserves the retry across restart", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-persist-failure-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  const hookStatePath = join(base, ".gsd", "hook-state.json");
  const temporaryHookStatePath = `${hookStatePath}.tmp`;

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base));
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md"),
      "rework requested",
      "utf-8",
    );
    assert.equal(checkPostUnitHooks("hook/review-arbiter", "M001/S01/T01", base), null);
    persistHookState(base);

    let injectWriteFault = true;
    const retryActiveUnit = mock.fn(async () => {
      if (!injectWriteFault) return;
      injectWriteFault = false;
      mkdirSync(temporaryHookStatePath);
    });
    const pctx = createRetryBridgeContext(base, retryActiveUnit);

    await assert.rejects(
      postUnitPostVerification(pctx),
      /failed to persist hook state/i,
      "retry acknowledgement must fail closed when durable state cannot be updated",
    );
    assert.equal(retryActiveUnit.mock.callCount(), 1);
    assert.equal(isRetryPending(), true, "in-memory retry remains pending after the failed acknowledgement");

    rmSync(temporaryHookStatePath, { recursive: true, force: true });
    resetHookState();
    restoreHookState(base);
    assert.equal(isRetryPending(), true, "restart restores the unacknowledged retry");

    assert.equal(await postUnitPostVerification(pctx), "continue");
    assert.equal(retryActiveUnit.mock.callCount(), 2, "restart replays the same-completion orchestration retry");
    assert.equal(isRetryPending(), false);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("failed post-unit hook pauses auto-mode even when its artifact exists", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-hook-failed-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writeFailingHookPreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    const hookDispatch = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.equal(hookDispatch?.hookName, "review-arbiter");

    const artifactPath = resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW-DEBATE.md");
    writeFileSync(artifactPath, "partial review", "utf-8");
    emitJournalEvent(base, {
      ts: "2026-06-03T12:00:00.000Z",
      flowId: "flow-hook-failed",
      seq: 3,
      eventType: "unit-end",
      data: {
        unitType: "hook/review-arbiter",
        unitId: "M001/S01/T01",
        status: "cancelled",
        artifactVerified: false,
      },
    });

    const pauseAuto = mock.fn(async () => {});
    const notifications: string[] = [];
    const s = new AutoSession();
    s.basePath = base;
    s.active = true;
    s.currentUnit = { type: "hook/review-arbiter", id: "M001/S01/T01", startedAt: Date.now() };

    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: {
          notify: (message: string) => { notifications.push(message); },
          setStatus: () => {},
          setWidget: () => {},
          setFooter: () => {},
        },
        model: { id: "test-model" },
      } as any,
      pi: { sendMessage: async () => {}, setModel: async () => true } as any,
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto,
      updateProgressWidget: () => {},
    };

    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "stopped");
    assert.equal(pauseAuto.mock.callCount(), 1);
    assert.ok(
      notifications.some(message => message.includes("Post-unit hook review-arbiter failed")),
      "pause notification should explain the failed hook",
    );
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("post-unit blocking gate pauses auto-mode on needs-attention verdict", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-gate-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writeBlockingPreferences(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });

    const hookDispatch = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.ok(hookDispatch, "hook should dispatch for execute-task");

    const artifactPath = resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW-DEBATE.md");
    writeFileSync(artifactPath, "---\nverdict: needs-attention\n---\n\nManual review required.\n", "utf-8");

    const pauseAuto = mock.fn(async () => {});
    const s = new AutoSession();
    s.basePath = base;
    s.active = true;
    s.currentUnit = { type: "hook/review-arbiter", id: "M001/S01/T01", startedAt: Date.now() };
    s.orchestration = {
      start: async () => ({ kind: "started" }),
      advance: async () => ({ kind: "stopped", reason: "unused" }),
      settle: async () => {},
    completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "resumed" }),
      stop: async (reason: string) => ({ kind: "stopped", reason }),
      getStatus: () => ({ phase: "running", transitionCount: 0 }),
    };

    const notifications: string[] = [];
    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: {
          notify: (message: string) => { notifications.push(message); },
          setStatus: () => {},
          setWidget: () => {},
          setFooter: () => {},
        },
        model: { id: "test-model" },
      } as any,
      pi: { sendMessage: async () => {}, setModel: async () => true } as any,
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto,
      updateProgressWidget: () => {},
    };

    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "stopped");
    assert.equal(pauseAuto.mock.callCount(), 1);
    // Regression (#1245): the block message must name BOTH the hook's trigger
    // unit (execute-task M001/S01/T01) and the just-completed unit that surfaced
    // the block (s.currentUnit = hook/review-arbiter M001/S01/T01), so the pause
    // is unambiguous to triage. The pre-fix message stopped at the trigger unit.
    assert.match(
      notifications.join("\n"),
      /Post-unit gate "review-arbiter" blocked execute-task M001\/S01\/T01 \(detected on completion of hook\/review-arbiter M001\/S01\/T01\)/,
    );
    assert.match(notifications.join("\n"), /\/gsd status/);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});
