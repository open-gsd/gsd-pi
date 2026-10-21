// Project/App: gsd-pi
// File Purpose: Adopted complete-milestone surfaces and repairs projection obstructions.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { clearPathCache } from "../paths.ts";
import {
  handleCompleteMilestone,
  type CompleteMilestoneParams,
} from "../tools/complete-milestone.ts";
import { executeCompleteMilestone } from "../tools/workflow-tool-executors.ts";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { _setProjectionFlushAfterRenderForTest } from "../projection-flush.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { discardProjectionEvidence } from "./projection-evidence-helpers.ts";

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "milestone-projection-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function completionParams(): CompleteMilestoneParams {
  return {
    milestoneId: "M001",
    title: "M001: Projection delivery",
    oneLiner: "Milestone authority remains committed while projections catch up.",
    narrative: "The readable status can be repaired by an exact completion retry.",
    verificationPassed: false,
  };
}

const validationParams: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

async function seedAdoptedMilestone(basePath: string): Promise<void> {
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'projection delivery';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Projection delivery", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Complete Slice", status: "complete" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Complete Task",
    status: "complete",
  });
  executeAtFence("test.milestone.fixture", "fixture/milestone/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  const validation = await handleValidateMilestone(validationParams, basePath, {
    invocation: invocation("fixture/milestone/validate"),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in validation), `validation fixture failed: ${"error" in validation ? validation.error : ""}`);
}

function completionLineage(): Record<string, unknown> {
  return {
    operations: row(`
      SELECT COUNT(*) AS count FROM workflow_operations
      WHERE operation_type = 'milestone.complete'
    `).count,
    events: row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.completed' AND entity_id = 'M001'
    `).count,
  };
}

test("adopted complete-milestone commits through projection obstruction and repairs exact retry", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-stale-"));
  t.after(() => {
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  await seedAdoptedMilestone(basePath);

  const statePath = join(basePath, ".gsd", "STATE.md");
  mkdirSync(statePath);
  const stableInvocation = invocation("milestone-complete/projection-obstruction");
  const obstructed = await handleCompleteMilestone(
    completionParams(),
    basePath,
    stableInvocation,
  );

  assert.ok(!("error" in obstructed));
  assert.equal(obstructed.stale, true);
  assert.equal(obstructed.replayed, false);
  assert.equal(obstructed.current, true);
  assert.ok(obstructed.operationId);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.deepEqual(row(`
    SELECT lifecycle_status, last_operation_id
    FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
      AND slice_id IS NULL AND task_id IS NULL
  `), {
    lifecycle_status: "completed",
    last_operation_id: obstructed.operationId,
  });
  assert.deepEqual(completionLineage(), { operations: 1, events: 1 });

  discardProjectionEvidence(basePath);
  rmSync(statePath, { recursive: true });
  writeFileSync(join(basePath, "source.ts"), "export const source = 'drifted after completion';\n");
  const repaired = await handleCompleteMilestone(
    completionParams(),
    basePath,
    stableInvocation,
  );

  assert.ok(!("error" in repaired));
  assert.equal(repaired.alreadyComplete, true);
  assert.equal(repaired.replayed, true);
  assert.equal(repaired.current, true);
  assert.equal(repaired.operationId, obstructed.operationId);
  assert.equal(repaired.resultingRevision, obstructed.resultingRevision);
  assert.equal(repaired.stale, undefined);
  assert.equal(statSync(statePath).isFile(), true);
  assert.deepEqual(completionLineage(), { operations: 1, events: 1 });
});

test("delayed completion replay cannot resurrect its summary after a newer Milestone reopen", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-replay-fence-"));
  t.after(() => {
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  await seedAdoptedMilestone(basePath);
  const stableInvocation = invocation("milestone-complete/delayed-replay");
  const completed = await handleCompleteMilestone(completionParams(), basePath, stableInvocation);
  assert.ok(!("error" in completed));

  const reopened = await handleReopenMilestone(
    { milestoneId: "M001", reason: "A newer reopen supersedes completion delivery." },
    basePath,
    invocation("milestone-reopen/newer-than-completion"),
  );
  assert.ok(!("error" in reopened));
  assert.equal(statSync(completed.summaryPath, { throwIfNoEntry: false }), undefined);

  const replay = await handleCompleteMilestone(completionParams(), basePath, stableInvocation);

  assert.ok(!("error" in replay));
  assert.equal(replay.operationId, completed.operationId);
  assert.equal(replay.resultingRevision, completed.resultingRevision);
  assert.equal(replay.replayed, true);
  assert.equal(replay.current, false);
  assert.equal(replay.stale, true);
  assert.equal(statSync(completed.summaryPath, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(completionLineage(), { operations: 1, events: 1 });

  const executorReplay = await executeCompleteMilestone(
    { ...completionParams() },
    basePath,
    stableInvocation,
  );
  assert.doesNotMatch(String(executorReplay.content[0]?.text), /already complete|^Completed milestone\b/i);
  assert.match(
    String(executorReplay.content[0]?.text),
    /historical|superseded|no longer current/i,
  );
  assert.equal(executorReplay.details.replayed, true);
  assert.equal(executorReplay.details.current, false);
  assert.equal(executorReplay.details.superseded, true);
});

test("completion projection cannot publish after a newer Milestone reopen", async (t) => {
  const completeTool = await import("../tools/complete-milestone.ts");
  const setInterleave = (completeTool as unknown as {
    _setCompleteMilestoneProjectionInterleaveForTest?: (hook: (() => Promise<void>) | null) => void;
  })._setCompleteMilestoneProjectionInterleaveForTest;
  assert.equal(typeof setInterleave, "function", "Milestone completion must expose a deterministic projection interleave test seam");

  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-race-fence-"));
  t.after(() => {
    setInterleave?.(null);
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  await seedAdoptedMilestone(basePath);
  let reopenResult: Awaited<ReturnType<typeof handleReopenMilestone>> | undefined;
  setInterleave!(async () => {
    reopenResult = await handleReopenMilestone(
      { milestoneId: "M001", reason: "Reopen commits before completion can publish." },
      basePath,
      invocation("milestone-reopen/completion-interleave"),
    );
  });

  const completion = await handleCompleteMilestone(
    completionParams(),
    basePath,
    invocation("milestone-complete/interleaved-by-reopen"),
  );

  assert.ok(!("error" in completion));
  assert.ok(reopenResult && !("error" in reopenResult));
  assert.equal(completion.current, false);
  assert.equal(completion.stale, true);
  assert.equal(statSync(completion.summaryPath, { throwIfNoEntry: false }), undefined);
  assert.equal(getMilestone("M001")?.status, "active");
});

test("completion removes its summary when ownership is lost during projection flush", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-late-fence-"));
  t.after(() => {
    _setProjectionFlushAfterRenderForTest(null);
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  await seedAdoptedMilestone(basePath);

  _setProjectionFlushAfterRenderForTest(() => {
    reopenMilestone({
      milestoneId: "M001",
      reason: "A newer reopen commits while completion is flushing projections.",
      invocation: invocation("milestone-reopen/during-completion-flush"),
    });
  });

  const completion = await handleCompleteMilestone(
    completionParams(),
    basePath,
    invocation("milestone-complete/loses-fence-during-flush"),
  );

  assert.ok(!("error" in completion));
  assert.equal(completion.current, false);
  assert.equal(completion.stale, true);
  assert.equal(completion.superseded, true);
  assert.equal(statSync(completion.summaryPath, { throwIfNoEntry: false }), undefined);
  assert.equal(getMilestone("M001")?.status, "active");
});

test("superseded completion preserves a byte-identical summary owned by a newer completion", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-owned-compensation-"));
  t.after(() => {
    _setProjectionFlushAfterRenderForTest(null);
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  await seedAdoptedMilestone(basePath);

  let newerSummary = "";
  _setProjectionFlushAfterRenderForTest(() => {
    const summaryPath = join(basePath, ".gsd", "milestones", "M001", "M001-SUMMARY.md");
    newerSummary = readFileSync(summaryPath, "utf8");
    reopenMilestone({
      milestoneId: "M001",
      reason: "A newer completion supersedes the first completion delivery.",
      invocation: invocation("milestone-reopen/before-newer-completion"),
    });
    executeAtFence("test.milestone-reopen.newer-start", "fixture/newer-completion/start", (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone",
        milestoneId: "M001",
        lifecycleStatus: "in_progress",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "in_progress",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: "in_progress",
      });
    });
    executeAtFence("milestone.complete", "fixture/newer-completion/complete", (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: "completed",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "completed",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone",
        milestoneId: "M001",
        lifecycleStatus: "completed",
      });
      db().exec(`
        UPDATE milestones SET status = 'complete' WHERE id = 'M001';
        UPDATE slices SET status = 'complete' WHERE milestone_id = 'M001';
        UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001';
      `);
    });
    writeFileSync(summaryPath, newerSummary);
  });

  const completion = await handleCompleteMilestone(
    completionParams(),
    basePath,
    invocation("milestone-complete/superseded-by-newer-completion"),
  );

  assert.ok(!("error" in completion));
  assert.equal(completion.current, false);
  assert.equal(completion.stale, true);
  assert.equal(completion.superseded, true);
  assert.equal(readFileSync(completion.summaryPath, "utf8"), newerSummary);
  assert.equal(getMilestone("M001")?.status, "complete");
});
