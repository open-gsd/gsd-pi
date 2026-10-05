// Project/App: gsd-pi
// File Purpose: Tests for resolving the pending escalation from the database with no session and no task reference.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  _getAdapter,
} from "../gsd-db.ts";
import { buildEscalationArtifact, detectPendingEscalation, openTaskEscalation, readTaskEscalation } from "../escalation.ts";
import { listOpenEscalations, resolvePendingEscalation } from "../escalation-resolution.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { internalExecutionInvocation, type ExecutionInvocation } from "../execution-invocation.ts";
import { getAllDecisionsFromMemories } from "../context-store.ts";

/** The caller identity that the workflow MCP server passes. */
const MCP_CALLER: ExecutionInvocation = {
  idempotencyKey: "mcp:gsd_resolve_blocker:test",
  sourceTransport: "workflow-mcp",
  actorType: "agent",
};

function makeBase(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-escalation-resolution-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* The test may have closed it. */ }
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  return base;
}

/** A completed Task with a canonical lifecycle and an open escalation. */
function seedEscalation(base: string, taskId: string, question: string): void {
  insertTask({ id: taskId, sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.adopt",
    idempotencyKey: `fixture/task/adopt/${taskId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId, lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.adopted", entityType: "task", entityId: `M001/S01/${taskId}`,
        payload: { taskId }, destinations: ["test"],
      }],
      projections: [{ projectionKey: `test/task/${taskId}`.toLowerCase(), projectionKind: "test", rendererVersion: "1" }],
    };
  });
  openTaskEscalation(base, buildEscalationArtifact({
    taskId, sliceId: "S01", milestoneId: "M001",
    question,
    options: [
      { id: "A", label: "Separate table", tradeoffs: "More flexible; requires migration." },
      { id: "B", label: "JSON array", tradeoffs: "Simpler; limited to ~1000 entries." },
    ],
    recommendation: "A", recommendationRationale: "Flexible",
    continueWithDefault: false,
  }), internalExecutionInvocation(`test:escalation:${taskId}`));
}

test("the pending escalation is resolved from the database after a restart, with no session and no task reference", async (t) => {
  const base = makeBase(t);
  seedEscalation(base, "T01", "Which store?");

  // Restart: only the database carries the blocker.
  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  const [pending] = listOpenEscalations();
  assert.equal(pending?.taskId, "T01");
  assert.equal(pending?.question, "Which store?");

  const result = await resolvePendingEscalation(base, "B fewer moving parts", MCP_CALLER);
  assert.equal(result.status, "resolved");
  assert.equal(result.questionId, pending!.questionId);
  assert.equal(result.taskId, "T01");

  const stored = readTaskEscalation("M001", "S01", "T01");
  assert.equal(stored?.userChoice, "B");
  assert.equal(stored?.userRationale, "fewer moving parts");
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T01")!]), null, "the pause is gone");
  assert.deepEqual(listOpenEscalations(), []);

  const decision = getAllDecisionsFromMemories().find((row) => row.id === result.decisionId);
  assert.equal(decision?.scope, "M001/S01/T01");
  assert.equal(decision?.choice, "JSON array");
  assert.equal(decision?.made_by, "agent", "the decision names the caller, not the user");

  await assert.rejects(resolvePendingEscalation(base, "A", MCP_CALLER), /No pending blocker/);
});

test("a response that is not a valid choice leaves the escalation open", async (t) => {
  const base = makeBase(t);
  seedEscalation(base, "T01", "Which store?");

  const result = await resolvePendingEscalation(base, "Z", MCP_CALLER);
  assert.equal(result.status, "invalid-choice");
  assert.match(result.message, /Valid choices: accept, reject-blocker, A, B/);
  assert.equal(listOpenEscalations().length, 1);
  assert.equal(
    Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_answers").get()?.["count"]),
    0,
  );
});

test("more than one open escalation needs a questionId, and only that one is resolved", async (t) => {
  const base = makeBase(t);
  seedEscalation(base, "T01", "First?");
  seedEscalation(base, "T02", "Second?");
  const second = listOpenEscalations().find((escalation) => escalation.taskId === "T02")!;

  await assert.rejects(resolvePendingEscalation(base, "accept", MCP_CALLER), /More than one escalation is open/);
  await assert.rejects(resolvePendingEscalation(base, "accept", MCP_CALLER, "no-such-question"), /No open escalation with questionId/);

  const result = await resolvePendingEscalation(base, "reject-blocker none fit", MCP_CALLER, second.questionId);
  assert.equal(result.status, "rejected-to-blocker");
  assert.equal(result.decisionId, undefined, "a rejection records no decision");
  assert.deepEqual(listOpenEscalations().map((escalation) => escalation.taskId), ["T01"]);
  assert.equal(getTask("M001", "S01", "T02")?.blocker_source, "reject-escalation");
});
