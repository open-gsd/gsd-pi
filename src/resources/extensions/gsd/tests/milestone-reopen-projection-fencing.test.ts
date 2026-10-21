// Project/App: gsd-pi
// File Purpose: RED contracts for operation-fenced Milestone reopen projection cleanup.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import { clearPathCache, targetMilestoneFile, targetSliceFile, targetTaskFile } from "../paths.ts";
import * as reopenTool from "../tools/reopen-milestone.ts";
import { executeMilestoneReopen } from "../tools/workflow-tool-executors.ts";

type CleanupDelivery = { artifactPath: string; operationId: string };
type SetCleanupInterleave = (hook: ((delivery: CleanupDelivery) => void) | null) => void;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function invocation(key: string): ExecutionInvocation {
  return { idempotencyKey: key, sourceTransport: "pi-tool", actorType: "agent", traceId: key };
}

function executeAtFence(type: string, key: string, write: (context: Readonly<DomainOperationContext>) => void): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: type,
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { key },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: type,
        entityType: "milestone",
        entityId: "M001",
        payload: { key },
        destinations: ["test"],
      }],
      projections: [{ projectionKey: `test/${key}`, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function artifactPaths(base: string): string[] {
  const milestoneTitle = "Projection fencing";
  return [
    targetMilestoneFile(base, "M001", "SUMMARY", milestoneTitle),
    targetSliceFile(base, "M001", "S01", "SUMMARY", milestoneTitle),
    targetSliceFile(base, "M001", "S01", "UAT", milestoneTitle),
    targetTaskFile(base, "M001", "S01", "T01", "SUMMARY", milestoneTitle),
  ];
}

function seedTerminalMilestone(): { base: string; dbPath: string; artifacts: string[] } {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-reopen-fence-"));
  const dbPath = join(base, ".gsd", "gsd.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Projection fencing", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
  executeAtFence("test.milestone-reopen.seed", "fixture/milestone-reopen/fence", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
  });
  const artifacts = artifactPaths(base);
  for (const path of artifacts) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `OLD ${path}\n`);
  }
  return { base, dbPath, artifacts };
}

function completeNewerHierarchy(): void {
  executeAtFence("test.milestone-reopen.newer-start", "fixture/milestone-reopen/newer-start", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "in_progress" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "in_progress",
    });
  });
  executeAtFence("milestone.complete", "fixture/milestone-reopen/newer-complete", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" });
    db().exec(`
      UPDATE milestones SET status = 'complete' WHERE id = 'M001';
      UPDATE slices SET status = 'complete' WHERE milestone_id = 'M001';
      UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001';
    `);
  });
}

function cleanup(base: string): void {
  const setInterleave = (reopenTool as unknown as { _setReopenMilestoneCleanupInterleaveForTest?: SetCleanupInterleave })
    ._setReopenMilestoneCleanupInterleaveForTest;
  setInterleave?.(null);
  clearPathCache();
  clearParseCache();
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

test("Milestone reopen fences every artifact against a completion committed during cleanup", async (t) => {
  const setInterleave = (reopenTool as unknown as { _setReopenMilestoneCleanupInterleaveForTest?: SetCleanupInterleave })
    ._setReopenMilestoneCleanupInterleaveForTest;
  assert.equal(typeof setInterleave, "function", "Milestone reopen must expose a deterministic cleanup interleave test seam");

  for (const artifactIndex of [0, 1, 2, 3]) {
    await t.test(`artifact ${artifactIndex}`, async () => {
      const fixture = seedTerminalMilestone();
      t.after(() => cleanup(fixture.base));
      let interleaved = false;
      setInterleave!(({ artifactPath }) => {
        if (artifactPath !== fixture.artifacts[artifactIndex] || interleaved) return;
        completeNewerHierarchy();
        for (const path of fixture.artifacts) writeFileSync(path, `NEW ${path}\n`);
        interleaved = true;
      });

      const result = await reopenTool.handleReopenMilestone(
        { milestoneId: "M001", reason: "Exercise per-artifact delivery fencing." },
        fixture.base,
        invocation(`milestone-reopen/fence/${artifactIndex}`),
      );

      assert.ok(!("error" in result));
      assert.equal(interleaved, true);
      assert.equal(result.stale, true);
      assert.equal(result.superseded, true);
      assert.equal(result.current, false);
      for (const path of fixture.artifacts) assert.equal(readFileSync(path, "utf8"), `NEW ${path}\n`);
    });
  }
});

test("Milestone reopen cleanup obstruction repairs on exact replay after restart", async (t) => {
  const fixture = seedTerminalMilestone();
  t.after(() => cleanup(fixture.base));
  const obstructedPath = fixture.artifacts[2]!;
  rmSync(obstructedPath);
  mkdirSync(obstructedPath);
  const stableInvocation = invocation("milestone-reopen/obstruction-restart");

  const first = await reopenTool.handleReopenMilestone(
    { milestoneId: "M001", reason: "Repair projection delivery after restart." },
    fixture.base,
    stableInvocation,
  );
  assert.ok(!("error" in first));
  assert.equal(first.stale, true);

  closeDatabase();
  clearPathCache();
  clearParseCache();
  rmSync(obstructedPath, { recursive: true });
  assert.equal(openDatabase(fixture.dbPath), true);
  const replay = await reopenTool.handleReopenMilestone(
    { milestoneId: "M001", reason: "Repair projection delivery after restart." },
    fixture.base,
    stableInvocation,
  );

  assert.ok(!("error" in replay));
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.stale, undefined);
  assert.equal(replay.superseded, undefined);
  assert.equal(replay.current, true);
  for (const path of fixture.artifacts) assert.equal(existsSync(path), false, path);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.reopen'").get()?.count, 1);
});

test("Milestone reopen removes coexisting canonical and plan-number-only Slice projections", async (t) => {
  const fixture = seedTerminalMilestone();
  t.after(() => cleanup(fixture.base));
  insertSlice({ id: "S02", milestoneId: "M001", title: "Compatibility Slice", status: "complete" });
  insertTask({ id: "T02", milestoneId: "M001", sliceId: "S02", title: "Compatibility Task", status: "complete" });
  executeAtFence("test.milestone-reopen.seed-s02", "fixture/milestone-reopen/seed-s02", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T02", lifecycleStatus: "completed",
    });
  });

  const canonicalSummary = targetSliceFile(fixture.base, "M001", "S02", "SUMMARY", "Projection fencing");
  const canonicalUat = targetSliceFile(fixture.base, "M001", "S02", "UAT", "Projection fencing");
  const planOnlySummary = join(dirname(canonicalSummary), "02-SUMMARY.md");
  const planOnlyUat = join(dirname(canonicalUat), "02-UAT.md");
  const sliceArtifacts = [canonicalSummary, canonicalUat, planOnlySummary, planOnlyUat];
  for (const path of sliceArtifacts) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `STALE ${path}\n`);
  }

  const result = await reopenTool.handleReopenMilestone(
    { milestoneId: "M001", reason: "Remove every supported Slice completion projection." },
    fixture.base,
    invocation("milestone-reopen/coexisting-slice-paths"),
  );

  assert.ok(!("error" in result));
  for (const path of sliceArtifacts) assert.equal(existsSync(path), false, path);
});

test("delayed Milestone reopen replay preserves projections from newer completion", async (t) => {
  const fixture = seedTerminalMilestone();
  t.after(() => cleanup(fixture.base));
  const stableInvocation = invocation("milestone-reopen/delayed-replay");
  const request = { milestoneId: "M001", reason: "A newer completion supersedes this reopen." };
  const first = await reopenTool.handleReopenMilestone(request, fixture.base, stableInvocation);
  assert.ok(!("error" in first));
  completeNewerHierarchy();
  for (const path of fixture.artifacts) writeFileSync(path, `NEW ${path}\n`);

  const replay = await reopenTool.handleReopenMilestone(request, fixture.base, stableInvocation);

  assert.ok(!("error" in replay));
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.superseded, true);
  assert.equal(replay.stale, undefined);
  for (const path of fixture.artifacts) assert.equal(readFileSync(path, "utf8"), `NEW ${path}\n`);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.reopen'").get()?.count, 1);

  const executorReplay = await executeMilestoneReopen(request, fixture.base, stableInvocation);
  assert.doesNotMatch(String(executorReplay.content[0]?.text), /^Reopened milestone\b/i);
  assert.match(
    String(executorReplay.content[0]?.text),
    /historical|superseded|no longer current/i,
  );
  assert.equal(executorReplay.details.replayed, true);
  assert.equal(executorReplay.details.current, false);
  assert.equal(executorReplay.details.superseded, true);
});

test("full DB rebuild cannot resurrect completion artifacts after Milestone reopen", async (t) => {
  const fixture = seedTerminalMilestone();
  t.after(() => cleanup(fixture.base));
  const result = await reopenTool.handleReopenMilestone(
    { milestoneId: "M001", reason: "Completion projections must stay deleted." },
    fixture.base,
    invocation("milestone-reopen/rebuild"),
  );
  assert.ok(!("error" in result));

  const rebuilt = await rebuildMarkdownProjectionsFromDb(fixture.base);

  assert.deepEqual(rebuilt.errors, []);
  for (const path of fixture.artifacts) assert.equal(existsSync(path), false, path);
});
