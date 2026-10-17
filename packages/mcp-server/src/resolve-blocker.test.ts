// Project/App: gsd-pi
// File Purpose: gsd_resolve_blocker resolves either a persisted escalation or
// one exact auto-pause blocker with no live session (including after restart).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

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
import { pauseAuto } from "../../../src/resources/extensions/gsd/auto.ts";
import { autoSession } from "../../../src/resources/extensions/gsd/auto-runtime-state.ts";
import {
  _getAdapter,
  closeDatabase,
  SCHEMA_VERSION,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { openExistingWorkflowDatabase } from "../../../src/resources/extensions/gsd/db-workspace.ts";
import { createWorkflowMcpAdapterToolDefs } from "./mcp-adapter-tools.ts";
import { createMcpServer } from "./server.ts";
import { SessionManager } from "./session-manager.ts";
import {
  _runSerializedWorkflowOperationForTest,
  derivePrivateMcpTraceId,
} from "./workflow-tools.ts";

// The server reads the gate through the module instance that this file seeds.
// A second instance (the built dist copy) keeps its own database connection,
// which this file cannot close before it removes the project directory.
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/bootstrap/write-gate.${import.meta.url.includes("/dist-test/") ? "js" : "ts"}`,
  import.meta.url,
));

/** A project whose database holds one open escalation on M001/S01/T01. The database is closed. */
function seedProjectWithOpenEscalation(t: { after(fn: () => void): void }): string {
  const originalCwd = process.cwd();
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-resolve-blocker-"));
  t.after(() => {
    try {
      try { closeDatabase(); } catch { /* The server may have closed it. */ }
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
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
  return (
    args: Record<string, unknown>,
    identity?: string | Record<string, unknown>,
  ): Promise<ToolResult> => tool.handler(args, {
    _meta: typeof identity === "string"
      ? { "io.opengsd/idempotency-key": identity }
      : identity ?? { "io.opengsd/idempotency-key": `resolve-blocker-test:${++callSequence}` },
  });
}

async function seedProjectWithOpenAutoPause(t: TestContext): Promise<{
  projectDir: string;
  blockerId: string;
  revision: number;
  authorityEpoch: number;
}> {
  const originalCwd = process.cwd();
  const projectDir = seedProjectWithOpenEscalation(t);
  t.after(() => {
    try {
      autoSession.reset();
    } finally {
      process.chdir(originalCwd);
    }
  });
  openDatabase(join(projectDir, ".gsd", "gsd.db"));
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = projectDir;
  autoSession.originalBasePath = projectDir;
  autoSession.currentMilestoneId = "M001";
  autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
  process.chdir(projectDir);
  await pauseAuto(undefined, undefined, "consent", {
    message: "Operator confirmation required",
    category: "unknown",
  });
  const blocker = _getAdapter()!.prepare(`
    SELECT blocker_id FROM workflow_blockers WHERE blocker_status = 'open'
    ORDER BY opened_at DESC LIMIT 1
  `).get()!;
  closeDatabase();
  autoSession.reset();
  process.chdir(originalCwd);

  const reopened = openExistingWorkflowDatabase(projectDir);
  if (!reopened.ok) assert.fail(reopened.error?.message ?? reopened.reason);
  const fence = readDomainOperationFence();
  return {
    projectDir,
    blockerId: String(blocker["blocker_id"]),
    revision: fence.revision,
    authorityEpoch: fence.authorityEpoch,
  };
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

test("gsd_resolve_blocker public schema enforces escalation and pause selector combinations", async () => {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const schema = (server as any)._registeredTools.gsd_resolve_blocker.inputSchema;

  assert.equal(schema.safeParse({ sessionId: "live", response: "answer" }).success, true);
  assert.equal(schema.safeParse({ projectDir: "/tmp/project", response: "accept" }).success, true);
  assert.equal(schema.safeParse({
    projectDir: "/tmp/project",
    pauseBlockerId: "blocker-1",
    rationale: "operator reviewed it",
    expectedRevision: 7,
    expectedAuthorityEpoch: 2,
  }).success, true);

  for (const invalid of [
    { projectDir: "/tmp/project", pauseBlockerId: "blocker-1" },
    { projectDir: "/tmp/project", rationale: "orphan rationale" },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: 7, expectedAuthorityEpoch: 2, response: "accept",
    },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: 7, expectedAuthorityEpoch: 2, questionId: "question-1",
    },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "   ",
      expectedRevision: 7, expectedAuthorityEpoch: 2,
    },
    { projectDir: "/tmp/project" },
  ]) {
    assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});

test("gsd_resolve_blocker handler rejects invalid pause combinations without success fallback", async () => {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const handler = (server as any)._registeredTools.gsd_resolve_blocker.handler;
  for (const invalid of [
    { projectDir: "/tmp/project", pauseBlockerId: "blocker-1" },
    { projectDir: "/tmp/project", rationale: "reason" },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: 1, expectedAuthorityEpoch: 0, response: "accept",
    },
  ]) {
    const result: ToolResult = await handler(invalid, {
      _meta: { "io.opengsd/idempotency-key": `invalid:${++callSequence}` },
    });
    assert.equal(result.isError, true, JSON.stringify(invalid));
  }
});

test("gsd_resolve_blocker resolves an exact auto-pause after restart and replays the stable response", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();
  const args = {
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "Operator approved clear-only resolution",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  };

  const first = await resolveBlocker(args, "auto-pause-replay");
  const replay = await resolveBlocker(args, "auto-pause-replay");
  assert.notEqual(first.isError, true, first.content[0]?.text);
  assert.deepEqual(JSON.parse(replay.content[0]!.text), JSON.parse(first.content[0]!.text));
  assert.ok(JSON.parse(replay.content[0]!.text).scope);

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  const operation = _getAdapter()!.prepare(`
    SELECT *
    FROM workflow_operations WHERE operation_type = 'pause.blocker.resolve.by-id'
  `).get()!;
  assert.equal(operation["actor_type"], "agent");
  assert.equal(operation["source_transport"], "workflow-mcp");
  assert.equal(
    operation["trace_id"],
    derivePrivateMcpTraceId({
      canonicalToolName: "gsd_resolve_blocker",
      sourceTransport: "workflow-mcp",
      actorType: "agent",
      stableInput: "auto-pause-replay",
    }),
  );
  assert.match(String(operation["trace_id"]), /^workflow-mcp-trace:v1:sha256:[a-f0-9]{64}$/);
  assert.equal(
    Object.values(operation).some((value) => String(value).includes("auto-pause-replay")),
    false,
    "raw OpenGSD idempotency metadata must not appear in any persisted operation field",
  );
  assert.match(
    String(operation["idempotency_key"]),
    /^resolve-auto-pause-blocker:v1:sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(String(operation["idempotency_key"]), /auto-pause-replay/);
  assert.equal(
    _getAdapter()!.prepare(
      `SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id`,
    ).get({ ":id": selected.blockerId })!["blocker_status"],
    "resolved",
  );
  assert.equal(
    _getAdapter()!.prepare(
      `SELECT COUNT(*) AS count FROM auto_pauses WHERE blocker_id = :id AND closed_at IS NULL`,
    ).get({ ":id": selected.blockerId })!["count"],
    0,
  );
  assert.ok(readTaskEscalation("M001", "S01", "T01"), "the unrelated escalation remains open");
});

test("gsd_resolve_blocker hashes Claude Code tool-use identity out of every operation field", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();
  const rawToolUseId = "toolu_private_claude_replay_identity";
  const args = {
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "Claude Code approved clear-only resolution",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  };
  const identity = { "claudecode/toolUseId": rawToolUseId };

  const first = await resolveBlocker(args, identity);
  const replay = await resolveBlocker(args, identity);
  assert.notEqual(first.isError, true, first.content[0]?.text);
  assert.deepEqual(replay, first);

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  const operation = _getAdapter()!.prepare(`
    SELECT * FROM workflow_operations
    WHERE operation_type = 'pause.blocker.resolve.by-id'
  `).get()!;
  const expectedTrace = derivePrivateMcpTraceId({
    canonicalToolName: "gsd_resolve_blocker",
    sourceTransport: "workflow-mcp",
    actorType: "agent",
    stableInput: `transport:claude-code:${rawToolUseId}`,
  });
  assert.equal(operation["trace_id"], expectedTrace);
  assert.match(String(operation["trace_id"]), /^workflow-mcp-trace:v1:sha256:[a-f0-9]{64}$/);
  assert.equal(
    Object.values(operation).some((value) => String(value).includes(rawToolUseId)),
    false,
    "raw Claude Code tool-use identity must not appear in any persisted operation field",
  );
});

test("private MCP trace correlation is stable and separated by tool and transport", () => {
  const logicalCall = {
    canonicalToolName: "gsd_resolve_blocker",
    sourceTransport: "workflow-mcp" as const,
    actorType: "agent",
    stableInput: "same-private-input",
  };
  const trace = derivePrivateMcpTraceId(logicalCall);

  assert.equal(derivePrivateMcpTraceId(logicalCall), trace);
  assert.notEqual(
    derivePrivateMcpTraceId({ ...logicalCall, canonicalToolName: "gsd_requirement_save" }),
    trace,
  );
  assert.notEqual(
    derivePrivateMcpTraceId({ ...logicalCall, sourceTransport: "pi-tool" }),
    trace,
  );
  assert.doesNotMatch(trace, /same-private-input/);
});

test("gsd_resolve_blocker conflicts when a replay key is reused with a changed pause payload", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();
  const args = {
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "first rationale",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  };
  assert.notEqual((await resolveBlocker(args, "auto-pause-conflict")).isError, true);
  const conflict = await resolveBlocker(
    { ...args, rationale: "changed rationale" },
    "auto-pause-conflict",
  );
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0]!.text, /idempotency|different request/i);
});

test("GSD-mode adapter propagates tool-call identity for resolve replay and payload conflict", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  const tools = await createWorkflowMcpAdapterToolDefs(new SessionManager());
  const resolveBlocker = tools.find((tool) => tool.name === "gsd_resolve_blocker");
  assert.ok(resolveBlocker, "GSD-mode adapter should expose gsd_resolve_blocker");
  const args = {
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "adapter identity is replay-stable",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  };

  const first = await resolveBlocker.execute("adapter-resolve-replay", args);
  const replay = await resolveBlocker.execute("adapter-resolve-replay", args);
  assert.notEqual(first.isError, true, first.content[0]?.text);
  assert.deepEqual(replay, first);

  const conflict = await resolveBlocker.execute("adapter-resolve-replay", {
    ...args,
    rationale: "changed adapter payload",
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0]?.text ?? "", /idempotency|different request/i);

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  const operation = _getAdapter()!.prepare(`
    SELECT *
    FROM workflow_operations WHERE operation_type = 'pause.blocker.resolve.by-id'
  `).get()!;
  assert.equal(operation["source_transport"], "workflow-mcp");
  assert.equal(
    operation["trace_id"],
    derivePrivateMcpTraceId({
      canonicalToolName: "gsd_resolve_blocker",
      sourceTransport: "workflow-mcp",
      actorType: "agent",
      stableInput: "adapter-resolve-replay",
    }),
  );
  assert.equal(
    Object.values(operation).some((value) => String(value).includes("adapter-resolve-replay")),
    false,
  );
  assert.match(
    String(operation["idempotency_key"]),
    /^resolve-auto-pause-blocker:v1:sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(String(operation["idempotency_key"]), /adapter-resolve-replay/);
});

test("gsd_resolve_blocker pause selection obeys the workflow write gate", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  hostWriteGateAdapter.setPending("review-before-write", selected.projectDir);
  t.after(() => hostWriteGateAdapter.clearPending(selected.projectDir));
  closeDatabase();
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const refused = await resolveBlocker({
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "must not bypass gate",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /Discussion gate .* has not been confirmed/);

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  assert.equal(
    _getAdapter()!.prepare(
      `SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id`,
    ).get({ ":id": selected.blockerId })!["blocker_status"],
    "open",
  );
});

test("gsd_resolve_blocker waits behind another project's serialized operation before switching the global database", async (t) => {
  const projectA = seedProjectWithOpenEscalation(t);
  const projectB = seedProjectWithOpenEscalation(t);
  let releaseProjectA!: () => void;
  const holdProjectA = new Promise<void>((resolve) => {
    releaseProjectA = resolve;
  });
  let projectAStarted!: () => void;
  const projectAStartedPromise = new Promise<void>((resolve) => {
    projectAStarted = resolve;
  });

  const activeProjectAOperation = _runSerializedWorkflowOperationForTest(async () => {
    openDatabase(join(projectA, ".gsd", "gsd.db"));
    const projectAAdapter = _getAdapter();
    projectAStarted();
    await holdProjectA;
    assert.strictEqual(
      _getAdapter(),
      projectAAdapter,
      "project B must not replace the process-global adapter while project A owns the queue",
    );
  });
  await projectAStartedPromise;
  const projectAAdapter = _getAdapter();

  const resolveBlocker = await resolveBlockerToolAfterRestart();
  let projectBSettled = false;
  const projectBResolution = resolveBlocker(
    { projectDir: projectB, response: "accept" },
    "cross-project-serialization",
  ).finally(() => {
    projectBSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    assert.equal(projectBSettled, false, "project B must wait for project A's operation");
    assert.strictEqual(
      _getAdapter(),
      projectAAdapter,
      "project B write-gate preflight must not switch the global database before project A settles",
    );
  } finally {
    releaseProjectA();
  }
  await activeProjectAOperation;
  const result = await projectBResolution;
  assert.notEqual(result.isError, true, result.content[0]?.text);
});

test("gsd_resolve_blocker rejects pause selection during queue mode", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  writeWriteGateSnapshot(selected.projectDir, { activeQueuePhase: true });
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const refused = await resolveBlocker({
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "queue mode must not clear pauses",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /not permitted during queue mode/);

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  assert.equal(
    _getAdapter()!.prepare(
      `SELECT blocker_status FROM workflow_blockers WHERE blocker_id = :id`,
    ).get({ ":id": selected.blockerId })!["blocker_status"],
    "open",
  );
  assert.equal(
    _getAdapter()!.prepare(
      `SELECT COUNT(*) AS count FROM workflow_operations
       WHERE operation_type = 'pause.blocker.resolve.by-id'`,
    ).get()!["count"],
    0,
  );
});

test("gsd_resolve_blocker pause selection reports missing and open-failed databases", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-resolve-db-boundary-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* no open database */ }
    rmSync(root, { recursive: true, force: true });
  });
  const missing = join(root, "missing");
  mkdirSync(join(missing, ".gsd"), { recursive: true });
  const invalid = join(root, "invalid");
  mkdirSync(join(invalid, ".gsd"), { recursive: true });
  writeFileSync(join(invalid, ".gsd", "gsd.db"), "not a sqlite database");
  const resolveBlocker = await resolveBlockerToolAfterRestart();
  const args = {
    pauseBlockerId: "selected-blocker",
    rationale: "must reach the database boundary",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
  };

  const missingResult = await resolveBlocker({ ...args, projectDir: missing });
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0]!.text, /database is not available \(missing-database\)/);

  const invalidResult = await resolveBlocker({ ...args, projectDir: invalid });
  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0]!.text, /not a database|open-failed/i);
});

test("gsd_resolve_blocker pause selection keeps schema-too-new and checkout-unbound loud", async (t) => {
  const tooNew = await seedProjectWithOpenAutoPause(t);
  openDatabase(join(tooNew.projectDir, ".gsd", "gsd.db"));
  _getAdapter()!.prepare(
    `INSERT INTO schema_version (version, applied_at) VALUES (:version, :appliedAt)`,
  ).run({ ":version": SCHEMA_VERSION + 1, ":appliedAt": "2026-10-17T00:00:00.000Z" });
  closeDatabase();
  const resolveBlocker = await resolveBlockerToolAfterRestart();
  const args = {
    pauseBlockerId: tooNew.blockerId,
    rationale: "must not downgrade or rebind",
    expectedRevision: tooNew.revision,
    expectedAuthorityEpoch: tooNew.authorityEpoch,
  };

  const schemaResult = await resolveBlocker({ ...args, projectDir: tooNew.projectDir });
  assert.equal(schemaResult.isError, true, schemaResult.content[0]?.text);
  assert.match(schemaResult.content[0]!.text, /schema.*newer|schema-too-new/i);

  const unbound = await seedProjectWithOpenAutoPause(t);
  openDatabase(join(unbound.projectDir, ".gsd", "gsd.db"));
  _getAdapter()!.prepare(
    `UPDATE project_authority SET project_root_realpath = :other WHERE singleton = 1`,
  ).run({ ":other": join(tmpdir(), "another-checkout") });
  closeDatabase();
  const unboundResult = await resolveBlocker({
    ...args,
    projectDir: unbound.projectDir,
    pauseBlockerId: unbound.blockerId,
    expectedRevision: unbound.revision,
    expectedAuthorityEpoch: unbound.authorityEpoch,
  });
  assert.equal(unboundResult.isError, true);
  assert.match(unboundResult.content[0]!.text, /checkout-unbound|belongs to the checkout/i);
});

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
