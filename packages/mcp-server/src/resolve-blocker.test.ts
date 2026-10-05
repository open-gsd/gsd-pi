// Project/App: gsd-pi
// File Purpose: gsd_resolve_blocker resolves the pending blocker that the project database holds, with no session (after a server restart).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
import { internalExecutionInvocation } from "../../../src/resources/extensions/gsd/execution-invocation.ts";
import {
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

/** The gsd_resolve_blocker handler of a new server that tracks no session: the state after a restart. */
async function resolveBlockerToolAfterRestart() {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools?.gsd_resolve_blocker;
  assert.ok(tool, "gsd_resolve_blocker should be registered");
  return tool.handler as (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
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

  closeDatabase();
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  assert.equal(readTaskEscalation("M001", "S01", "T01")?.respondedAt, undefined);
});

test("gsd_resolve_blocker with an unknown session and no projectDir names the database path", async () => {
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ sessionId: "gone-after-restart", response: "A" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Session not found: gone-after-restart\. Pass projectDir/);
});
