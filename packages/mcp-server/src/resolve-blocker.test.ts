// Project/App: gsd-pi
// File Purpose: gsd_resolve_blocker resolves the pending blocker that the project database holds, with no session (after a server restart).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  hostWriteGateAdapter,
  setQueuePhaseActive,
} from "../../../src/resources/extensions/gsd/bootstrap/write-gate.ts";
import { executeDomainOperation } from "../../../src/resources/extensions/gsd/db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../../../src/resources/extensions/gsd/db/writers/lifecycle-commands.ts";
import {
  buildEscalationArtifact,
  openTaskEscalation,
  readTaskEscalation,
} from "../../../src/resources/extensions/gsd/escalation.ts";
import { getAllDecisionsFromMemories } from "../../../src/resources/extensions/gsd/context-store.ts";
import { internalExecutionInvocation } from "../../../src/resources/extensions/gsd/execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { createMcpServer } from "./server.ts";
import { SessionManager } from "./session-manager.ts";

/** A project whose database holds one open escalation on M001/S01/T01. The database is closed. */
function seedProjectWithOpenEscalation(t: { after(fn: () => void): void }): string {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-resolve-blocker-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* The server may have closed it. */ }
    rmSync(projectDir, { recursive: true, force: true });
  });
  mkdirSync(join(projectDir, ".gsd"));
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.adopt",
    idempotencyKey: "fixture/task/adopt/T01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.adopted", entityType: "task", entityId: "M001/S01/T01",
        payload: { taskId: "T01" }, destinations: ["test"],
      }],
      projections: [{ projectionKey: "test/task/t01", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  openTaskEscalation(projectDir, buildEscalationArtifact({
    taskId: "T01", sliceId: "S01", milestoneId: "M001",
    question: "Which store?",
    options: [
      { id: "A", label: "Separate table", tradeoffs: "More flexible; requires migration." },
      { id: "B", label: "JSON array", tradeoffs: "Simpler; limited to ~1000 entries." },
    ],
    recommendation: "A", recommendationRationale: "Flexible",
    continueWithDefault: false,
  }), internalExecutionInvocation("test:escalation:T01"));
  closeDatabase();
  return projectDir;
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

let callSequence = 0;

/**
 * The gsd_resolve_blocker handler of a new server that tracks no session: the
 * state after a restart. Each call carries the request identity that an MCP
 * client sends.
 */
async function resolveBlockerToolAfterRestart() {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools?.gsd_resolve_blocker;
  assert.ok(tool, "gsd_resolve_blocker should be registered");
  return (args: Record<string, unknown>): Promise<ToolResult> => tool.handler(args, {
    _meta: { "io.opengsd/idempotency-key": `resolve-blocker-test:${++callSequence}` },
  });
}

/** The write-gate rows that the extension host leaves in the project database. The database is closed. */
function writeWriteGateSnapshot(
  projectDir: string,
  snapshot: { activeQueuePhase?: boolean; pendingGateId?: string },
): void {
  if (snapshot.pendingGateId) hostWriteGateAdapter.setPending(snapshot.pendingGateId, projectDir);
  if (snapshot.activeQueuePhase) setQueuePhaseActive(true, projectDir);
  closeDatabase();
}

function assertEscalationStillOpen(projectDir: string): void {
  closeDatabase();
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  assert.equal(readTaskEscalation("M001", "S01", "T01")?.respondedAt, undefined);
}

test("gsd_resolve_blocker resolves the open escalation from the project database after a server restart", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "B fewer moving parts" });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const payload = JSON.parse(result.content[0]!.text);
  assert.equal(payload.resolved, true);
  assert.equal(payload.source, "database");
  assert.equal(payload.taskId, "T01");

  closeDatabase();
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  const stored = readTaskEscalation("M001", "S01", "T01");
  assert.equal(stored?.userChoice, "B", "the answer row holds the response");
  assert.equal(stored?.userRationale, "fewer moving parts");
  closeDatabase();

  // The blocker is gone: a second call has nothing to resolve.
  const again = await resolveBlocker({ projectDir, response: "A" });
  assert.equal(again.isError, true);
  assert.match(again.content[0]!.text, /No pending blocker/);
});

test("gsd_resolve_blocker rejects a response that is not a valid choice and keeps the escalation open", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "Z" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Valid choices: accept, reject-blocker, A, B/);

  assertEscalationStillOpen(projectDir);
});

test("gsd_resolve_blocker does not resolve the escalation while a discussion gate is pending", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  writeWriteGateSnapshot(projectDir, { pendingGateId: "depth_verification_M001_confirm" });
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "accept" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Discussion gate .* has not been confirmed/);

  assertEscalationStillOpen(projectDir);
});

test("gsd_resolve_blocker does not resolve the escalation in queue mode", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  writeWriteGateSnapshot(projectDir, { activeQueuePhase: true });
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "accept" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /not permitted during queue mode/);

  assertEscalationStillOpen(projectDir);
});

test("gsd_resolve_blocker records the MCP transport and the agent actor on the answer and on the decision", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "accept" });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const { decisionId } = JSON.parse(result.content[0]!.text);

  closeDatabase();
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  const operations = _getAdapter()!.prepare(`
    SELECT operation_type, actor_type, source_transport FROM workflow_operations
    WHERE operation_type IN ('task.escalation.resolve', 'decision.save')
    ORDER BY resulting_revision
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(operations, [
    { operation_type: "task.escalation.resolve", actor_type: "agent", source_transport: "workflow-mcp" },
    { operation_type: "decision.save", actor_type: "agent", source_transport: "workflow-mcp" },
  ]);
  assert.equal(getAllDecisionsFromMemories().find((row) => row.id === decisionId)?.made_by, "agent");
});

test("gsd_resolve_blocker does not resolve the escalation for a request with no replay-stable identity", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools.gsd_resolve_blocker;

  const result: ToolResult = await tool.handler({ projectDir, response: "accept" }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /requires replay-stable private request metadata/);

  assertEscalationStillOpen(projectDir);
});

test("gsd_resolve_blocker with only the sessionId of a live session that has no pending blocker does not resolve the escalation", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const sessionManager = new SessionManager();
  (sessionManager as any).sessions.set(projectDir, { sessionId: "live-session", projectDir, pendingBlocker: null });
  const { server } = await createMcpServer(sessionManager, { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools.gsd_resolve_blocker;

  const result: ToolResult = await tool.handler({ sessionId: "live-session", response: "accept" }, {
    _meta: { "io.opengsd/idempotency-key": `resolve-blocker-test:${++callSequence}` },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /No pending blocker for session live-session/);

  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  assert.equal(readTaskEscalation("M001", "S01", "T01")?.respondedAt, undefined);
});

test("gsd_resolve_blocker with an unknown session and no projectDir names the database path", async () => {
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ sessionId: "gone-after-restart", response: "A" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Session not found: gone-after-restart\. Pass projectDir/);
});
