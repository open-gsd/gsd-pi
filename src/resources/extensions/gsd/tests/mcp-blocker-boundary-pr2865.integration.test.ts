// Project/App: gsd-pi
// File Purpose: Native-backed MCP escalation persistence, pause denial, and write-gate parity.
// Run with the native source loader; never include in the MCP package compiler.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  hostWriteGateAdapter,
  setQueuePhaseActive,
} from "../bootstrap/write-gate.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  buildEscalationArtifact,
  openTaskEscalation,
  readTaskEscalation,
} from "../escalation.ts";
import { getAllDecisionsFromMemories } from "../context-store.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { pauseAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import type { AutoPauseBlockerKind } from "../recovery-policy.ts";
import {
  _getAdapter,
  closeDatabase,
  SCHEMA_VERSION,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { openExistingWorkflowDatabase } from "../db-workspace.ts";
import { createWorkflowMcpAdapterToolDefs } from "../../../../../packages/mcp-server/src/mcp-adapter-tools.ts";
import { createMcpServer } from "../../../../../packages/mcp-server/src/server.ts";
import { SessionManager } from "../../../../../packages/mcp-server/src/session-manager.ts";
import {
  _runSerializedWorkflowOperationForTest,
  derivePrivateMcpTraceId,
} from "../../../../../packages/mcp-server/src/workflow-tools.ts";

// The server reads the gate through the module instance that this file seeds.
// A second instance (the built dist copy) keeps its own database connection,
// which this file cannot close before it removes the project directory.
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../bootstrap/write-gate.${import.meta.url.includes("/dist-test/") ? "js" : "ts"}`,
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

async function seedProjectWithOpenAutoPause(
  t: TestContext,
  unitType = "execute-task",
  blockerKind: AutoPauseBlockerKind = "consent",
): Promise<{
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
  autoSession.currentUnit = { type: unitType, id: "M001/S01/T01", startedAt: Date.now() };
  process.chdir(projectDir);
  await pauseAuto(undefined, undefined, blockerKind, {
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
  assert.equal(schema.safeParse({ sessionId: "live", response: "" }).success, true);
  assert.equal(schema.safeParse({ projectDir: "/tmp/project", response: "accept" }).success, true);
  assert.equal(schema.safeParse({ projectDir: "/tmp/project", response: "" }).success, false);
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

test("pauseAuto opens a blocker for an exact task lifecycle during replan-task", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t, "replan-task");

  openDatabase(join(selected.projectDir, ".gsd", "gsd.db"));
  const db = _getAdapter();
  assert.ok(db);
  const taskLifecycle = db.prepare(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
  `).get() as { lifecycle_id: string } | undefined;
  assert.ok(taskLifecycle);
  const blocker = db.prepare(`
    SELECT lifecycle_id FROM workflow_blockers WHERE blocker_id = :id
  `).get({ ":id": selected.blockerId }) as { lifecycle_id: string } | undefined;
  assert.ok(blocker);
  assert.equal(blocker.lifecycle_id, taskLifecycle.lifecycle_id);
});

test("gsd_resolve_blocker passes an empty response through to a live session", async () => {
  const sessionManager = new SessionManager();
  let sentResponse: { blockerId: string; value: string } | undefined;
  (sessionManager as any).sessions.set("/tmp/live-session", {
    sessionId: "live-session",
    projectDir: "/tmp/live-session",
    status: "blocked",
    client: {
      sendUIResponse: (blockerId: string, response: { value: string }) => {
        sentResponse = { blockerId, value: response.value };
      },
    },
    events: [],
    pendingBlocker: { id: "question-1" },
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    startTime: Date.now(),
  });
  const { server } = await createMcpServer(sessionManager, { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools.gsd_resolve_blocker;

  const result: ToolResult = await tool.handler({ sessionId: "live-session", response: "" }, {
    _meta: { "io.opengsd/idempotency-key": `resolve-blocker-test:${++callSequence}` },
  });

  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(sentResponse, { blockerId: "question-1", value: "" });
});

test("gsd_resolve_blocker rejects blank escalation responses", async (t) => {
  const projectDir = seedProjectWithOpenEscalation(t);
  const resolveBlocker = await resolveBlockerToolAfterRestart();

  const result = await resolveBlocker({ projectDir, response: "" });

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /response must not be blank/);
  assertEscalationStillOpen(projectDir);
});

test("gsd_resolve_blocker handler rejects invalid pause combinations without success fallback", async () => {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const { handler, inputSchema } = (server as any)._registeredTools.gsd_resolve_blocker;
  for (const invalid of [
    { projectDir: "/tmp/project", pauseBlockerId: "blocker-1" },
    { projectDir: "/tmp/project", rationale: "reason" },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: 1, expectedAuthorityEpoch: 0, response: "accept",
    },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "   ",
      expectedRevision: 1, expectedAuthorityEpoch: 0,
    },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: Number.MAX_SAFE_INTEGER + 1, expectedAuthorityEpoch: 0,
    },
    {
      projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
      expectedRevision: 1, expectedAuthorityEpoch: Number.MAX_SAFE_INTEGER + 1,
    },
    { projectDir: "/tmp/project", response: 42 },
    { projectDir: "/tmp/project" },
    { response: "answer" },
  ]) {
    const parsed = inputSchema.safeParse(invalid);
    assert.equal(parsed.success, false, JSON.stringify(invalid));
    const result: ToolResult = await handler(invalid, {
      _meta: { "io.opengsd/idempotency-key": `invalid:${++callSequence}` },
    });
    assert.equal(result.isError, true, JSON.stringify(invalid));
    assert.equal(result.content[0]!.text, parsed.error.issues[0].message);
  }
  const missingRationale: ToolResult = await handler({
    projectDir: "/tmp/project", pauseBlockerId: "blocker-1",
  });
  assert.equal(missingRationale.content[0]!.text, "rationale is required with pauseBlockerId.");
  const conflictingSelection: ToolResult = await handler({
    projectDir: "/tmp/project", pauseBlockerId: "blocker-1", rationale: "reason",
    expectedRevision: 1, expectedAuthorityEpoch: 0, response: "answer",
  });
  assert.equal(conflictingSelection.content[0]!.text, "sessionId, questionId, and response conflict with pauseBlockerId.");
});

// Rationale text never delegates the user ownership of consent, authority,
// UAT, or generic pauses to the agent identity used by MCP.
for (const [unitType, blockerKind] of [
  ["execute-task", "consent"],
  ["replan-task", "consent"],
  ["execute-task", "missing_authority"],
  ["execute-task", "subjective_uat"],
  ["execute-task", "ambiguous_intent"],
] as const) {
  for (const adapter of [false, true]) {
    test(`gsd_resolve_blocker refuses user-owned ${blockerKind} pauses during ${unitType} (${adapter ? "MCP adapter" : "packaged MCP"})`, async (t) => {
      const selected = await seedProjectWithOpenAutoPause(t, unitType, blockerKind);
      const snapshot = () => {
        assert.equal(openExistingWorkflowDatabase(selected.projectDir).ok, true);
        const db = _getAdapter()!;
        return {
          blockers: db.prepare("SELECT * FROM workflow_blockers ORDER BY blocker_id").all(),
          pauses: db.prepare("SELECT * FROM auto_pauses ORDER BY scope").all(),
          authority: db.prepare("SELECT * FROM project_authority").all(),
          lifecycles: db.prepare("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
          operations: db.prepare("SELECT * FROM workflow_operations ORDER BY operation_id").all(),
          decisions: getAllDecisionsFromMemories(),
          escalation: readTaskEscalation("M001", "S01", "T01"),
        };
      };
      const before = snapshot();
      const blocker = before.blockers.find((row) => row.blocker_id === selected.blockerId);
      assert.ok(blocker);
      assert.equal(blocker.resolution_owner, "user");
      assert.equal(blocker.blocker_kind, blockerKind);
      const args = {
        projectDir: selected.projectDir,
        pauseBlockerId: selected.blockerId,
        rationale: "Operator approved clear-only resolution",
        expectedRevision: selected.revision,
        expectedAuthorityEpoch: selected.authorityEpoch,
      };
      const packaged = await resolveBlockerToolAfterRestart();
      const adapterTool = (await createWorkflowMcpAdapterToolDefs(new SessionManager()))
        .find((tool) => tool.name === "gsd_resolve_blocker");
      assert.ok(adapterTool);
      const invoke = () => adapter
        ? adapterTool.execute("owner-preserving-refusal", args, new AbortController().signal)
        : packaged(args, "owner-preserving-refusal");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await invoke();
        const refusalText = result.content[0]?.text;
        assert.equal(result.isError, true, refusalText);
        assert.ok(typeof refusalText === "string", "refusal must include diagnostic text");
        assert.match(refusalText, /user|owner|authority/i);
        assert.deepEqual(snapshot(), before, "refusal and retry must not mutate workflow state");
      }
    });
  }
}

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

test("GSD-mode adapter rejects empty conflicting selectors without resolving an auto-pause", async (t) => {
  const selected = await seedProjectWithOpenAutoPause(t);
  const tools = await createWorkflowMcpAdapterToolDefs(new SessionManager());
  const resolveBlocker = tools.find((tool) => tool.name === "gsd_resolve_blocker");
  assert.ok(resolveBlocker, "GSD-mode adapter should expose gsd_resolve_blocker");
  const args = {
    projectDir: selected.projectDir,
    pauseBlockerId: selected.blockerId,
    rationale: "valid pause selection must still reject a conflicting selector",
    expectedRevision: selected.revision,
    expectedAuthorityEpoch: selected.authorityEpoch,
  };

  for (const [selector, value] of [["sessionId", ""], ["questionId", ""]] as const) {
    const result = await resolveBlocker.execute(`adapter-empty-${selector}`, {
      ...args,
      [selector]: value,
    });
    assert.equal(result.isError, true, `${selector} must be rejected when present`);

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
    closeDatabase();
  }
});

test("MCP pause selection refuses before discussion-gate or database access", async (t) => {
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
  assert.match(refused.content[0]!.text, /owner-mismatch/);

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

test("MCP pause selection remains denied during queue mode without consulting the backend", async (t) => {
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
  assert.match(refused.content[0]!.text, /owner-mismatch/);

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

test("MCP pause selection refuses without creating missing or opening invalid databases", async (t) => {
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
    rationale: "must refuse before the database boundary",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
  };

  const missingResult = await resolveBlocker({ ...args, projectDir: missing });
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0]!.text, /owner-mismatch/);
  assert.equal(existsSync(join(missing, ".gsd", "gsd.db")), false);

  const invalidResult = await resolveBlocker({ ...args, projectDir: invalid });
  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0]!.text, /owner-mismatch/);
  assert.equal(readFileSync(join(invalid, ".gsd", "gsd.db"), "utf8"), "not a sqlite database");
});

test("MCP pause selection refuses before inspecting unsupported schema or checkout state", async (t) => {
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
  assert.match(schemaResult.content[0]!.text, /owner-mismatch/);
  // A valid legacy response reaches storage policy instead of the by-id owner
  // refusal. Keep actual negative schema coverage on that eligible route.
  const legacySchemaResult = await resolveBlocker({
    projectDir: tooNew.projectDir, response: "Proceed only if the database is supported",
  });
  assert.equal(legacySchemaResult.isError, true, legacySchemaResult.content[0]?.text);
  assert.match(legacySchemaResult.content[0]!.text, /schema.*newer|schema-too-new/i);

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
  assert.match(unboundResult.content[0]!.text, /owner-mismatch/);
  const legacyUnboundResult = await resolveBlocker({
    projectDir: unbound.projectDir, response: "Proceed only in the original checkout",
  });
  assert.equal(legacyUnboundResult.isError, true, legacyUnboundResult.content[0]?.text);
  assert.match(legacyUnboundResult.content[0]!.text, /checkout-unbound|belongs to the checkout/i);
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
