// Project/App: gsd-pi
// File Purpose: Tests packaged workflow tools exposed by the GSD MCP server.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { symlinkSync, realpathSync } from "node:fs";
import { SUMMARY_SAVE_CONTENT_MAX_LENGTH } from "@opengsd/contracts";

import {
  _getAdapter,
  closeDatabase,
  getSliceTasks,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertMilestonePlanning,
} from "../../../src/resources/extensions/gsd/mcp-bridge.ts";
import { createMemory } from "../../../src/resources/extensions/gsd/memory-store.ts";
import { buildReassessRoadmapPrompt } from "../../../src/resources/extensions/gsd/auto-prompts.ts";
import { invalidateAllCaches } from "../../../src/resources/extensions/gsd/cache.ts";
import { resolveToolPresentationPlan } from "../../../src/resources/extensions/gsd/tool-presentation-plan.ts";
import { claimTaskAttempt } from "../../../src/resources/extensions/gsd/task-execution-domain-operation.ts";
import { seedSliceCompletionAuthority } from "../../../src/resources/extensions/gsd/tests/slice-completion-fixture.ts";
import {
  _setDatabaseOpenBeforeRawForTest,
  _setStartupSchemaDetectionForTest,
} from "../../../src/resources/extensions/gsd/db/engine.ts";
import {
  _buildBridgeImportCandidates,
  _buildImportCandidates,
  readProjectProgressViaBridge,
  registerWorkflowTools,
  resolveRecoveryActionProjectDir,
  WORKFLOW_TOOL_NAMES,
  CANONICAL_WORKFLOW_TOOL_NAMES,
  WORKFLOW_TOOL_ALIAS_NAMES,
  validateProjectDir,
  _parseWorkflowArgsForTest,
  _summarySaveSchemaForTest,
  _runSerializedWorkflowOperationForTest,
  _sliceCompleteSchemaForTest,
} from "./workflow-tools.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-mcp-workflow-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    // swallow
  }
  invalidateAllCaches();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

function claimCanonicalTaskAuthority(
  base: string,
  task: { milestoneId: string; sliceId: string; taskId: string },
): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  const db = _getAdapter();
  assert.ok(db, "DB should be open before claiming canonical task authority");
  const workerId = `mcp-fixture-${task.milestoneId}-${task.sliceId}-${task.taskId}`;
  const unitId = `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
  const now = "2026-07-12T00:00:00.000Z";
  db.prepare(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES (?, 'MCP fixture milestone', 'active', ?)
  `).run(task.milestoneId, now);
  db.prepare(`
    INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
    VALUES (?, ?, 'MCP fixture slice', 'active', ?)
  `).run(task.milestoneId, task.sliceId, now);
  db.prepare(`
    INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES (?, ?, ?, 'MCP fixture task', 'in_progress', 'npm test', 1)
  `).run(task.milestoneId, task.sliceId, task.taskId);
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (?, 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(workerId, now, now, realpathSync(base));
  db.prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (?, ?, 7, ?, '2099-07-12T00:00:00.000Z', 'held')
  `).run(task.milestoneId, workerId, now);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES ('fixture-trace', 'fixture-turn', ?, 7, ?, ?, ?, 'execute-task', ?, 'claimed', 1, ?)
  `).run(workerId, task.milestoneId, task.sliceId, task.taskId, unitId, now);
  claimTaskAttempt({
    invocation: {
      idempotencyKey: `fixture:mcp:claim:${unitId}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: workerId,
    },
    task,
    workerId,
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
}

function seedCompletedTaskState(task: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}): void {
  const db = _getAdapter();
  assert.ok(db, "DB should be open before seeding completed task authority");
  db.prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at, sequence
    ) VALUES (?, ?, ?, 'Completed prerequisite', 'pending', NULL, 1)
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      status = 'pending', completed_at = NULL
  `).run(task.milestoneId, task.sliceId, task.taskId);
  seedSliceCompletionAuthority({
    milestoneId: task.milestoneId,
    sliceId: task.sliceId,
    completedTaskIds: [task.taskId],
    runId: `mcp-${task.taskId}`,
  });
}

function seedContextModeFixture(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Context Mode", status: "active", depends_on: [] });
  upsertMilestonePlanning("M001", {
    title: "Context Mode",
    status: "active",
    vision: "Verify the bundled context-mode contract",
    successCriteria: ["Prompt, tool, and persisted evidence surfaces agree"],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: "",
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Contract",
    status: "complete",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001\n\n## Slices\n\n- [x] **S01: Contract** `risk:low` `depends:[]`\n",
    "utf-8",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    "# S01 Summary\n\n**Context mode contract is ready for reassessment.**\n",
    "utf-8",
  );
  writeFileSync(
    join(base, ".gsd", "last-snapshot.md"),
    "# GSD context snapshot\n\nContext mode resume evidence.\n",
    "utf-8",
  );
}

function writeWriteGateSnapshot(
  base: string,
  snapshot: { verifiedDepthMilestones?: string[]; activeQueuePhase?: boolean; pendingGateId?: string | null },
): void {
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "write-gate-state.json"),
    JSON.stringify(
      {
        verifiedDepthMilestones: snapshot.verifiedDepthMilestones ?? [],
        activeQueuePhase: snapshot.activeQueuePhase ?? false,
        pendingGateId: snapshot.pendingGateId ?? null,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function makeMockServer() {
  type TestRequestExtra = {
    signal?: AbortSignal;
    requestId?: string | number;
    sessionId?: string;
    _meta?: Record<string, unknown>;
  };
  const tools: Array<{
    name: string;
    description: string;
    params: Record<string, unknown>;
    handler: (args: Record<string, unknown>, extra?: TestRequestExtra) => Promise<unknown>;
  }> = [];
  let callSequence = 0;
  return {
    tools,
    tool(
      name: string,
      description: string,
      params: Record<string, unknown>,
      handler: (args: Record<string, unknown>, extra?: TestRequestExtra) => Promise<unknown>,
    ) {
      tools.push({
        name,
        description,
        params,
        handler: (args, extra) => handler(args, extra ?? {
          _meta: { "io.opengsd/idempotency-key": `workflow-tools-test:${name}:${++callSequence}` },
        }),
      });
    },
  };
}

function assertToolError(result: unknown, expected: RegExp | string): string {
  const record = result as { isError?: boolean; content?: Array<{ text?: unknown }> };
  assert.equal(record.isError, true, "tool result should be marked as an MCP error");
  const text = record.content?.[0]?.text;
  assert.equal(typeof text, "string", "tool error result should contain text");
  if (expected instanceof RegExp) {
    assert.match(text, expected);
  } else {
    assert.ok(text.includes(expected), `error should mention ${expected}, got: ${text}`);
  }
  return text;
}

function runUatMcpPresentation() {
  const plan = resolveToolPresentationPlan({
    phase: "run-uat",
    surface: "mcp",
    workflowMcpServerName: "gsd-workflow",
  });
  return {
    surface: plan.surface,
    presentedTools: plan.presentedToolNames,
    blockedTools: plan.blockedToolNames,
  };
}

function cacheBustedWorkflowToolsImport(tag: string): string {
  const extension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
  return `./workflow-tools.${extension}?${tag}=${randomUUID()}`;
}

const workflowBridgeExtension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
process.env.GSD_WORKFLOW_EXECUTORS_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/tools/workflow-tool-executors.${workflowBridgeExtension}`,
  import.meta.url,
));
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/bootstrap/write-gate.${workflowBridgeExtension}`,
  import.meta.url,
));

describe("warmWorkflowToolBridges", () => {
  it("resolves when the executor and write-gate bridges load and shape-check", async () => {
    const { warmWorkflowToolBridges: freshWarm } = await import(
      cacheBustedWorkflowToolsImport("warm-ok")
    );
    await freshWarm();
  });

  it("rejects with an actionable error when the executor module config is broken", async () => {
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    try {
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = "data:text/javascript,export default {}";
      const { warmWorkflowToolBridges: freshWarm } = await import(
        cacheBustedWorkflowToolsImport("warm-broken")
      );
      await assert.rejects(freshWarm(), /only supports file: URLs or filesystem paths/);
    } finally {
      if (prevModule === undefined) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
    }
  });
});

describe("runSerializedWorkflowOperation", () => {
  it("keeps the queue held until a timed-out operation settles", async () => {
    const previousTimeout = process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS;
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let second: Promise<string> | undefined;

    try {
      process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS = "20";

      const first = _runSerializedWorkflowOperationForTest(async () => {
        events.push("first-start");
        await firstCanFinish;
        events.push("first-finish");
        return "first";
      });

      await assert.rejects(first, /Workflow operation exceeded 20ms deadline/);
      events.push("first-timeout-returned");

      let secondSettled = false;
      second = _runSerializedWorkflowOperationForTest(async () => {
        events.push("second-start");
        return "second";
      }).then((value) => {
        secondSettled = true;
        events.push("second-finish");
        return value;
      });

      await delay(30);
      assert.equal(
        secondSettled,
        false,
        "retry should remain queued while the timed-out operation is still running",
      );
      assert.deepEqual(events, ["first-start", "first-timeout-returned"]);

      releaseFirst?.();
      assert.equal(await second, "second");
      assert.deepEqual(events, [
        "first-start",
        "first-timeout-returned",
        "first-finish",
        "second-start",
        "second-finish",
      ]);
    } finally {
      releaseFirst?.();
      if (second) await second.catch(() => undefined);
      if (previousTimeout === undefined) {
        delete process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS;
      } else {
        process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});

describe("workflow MCP tools", () => {
  it("registers the full headless-safe workflow tool surface", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);

    assert.equal(server.tools.length, WORKFLOW_TOOL_NAMES.length);
    assert.deepEqual(
      server.tools.map((t) => t.name).sort(),
      [...WORKFLOW_TOOL_NAMES].sort(),
    );
  });

  it("omits backwards-compatibility aliases when advertiseAliases is false", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any, { advertiseAliases: false });

    const toolNames = server.tools.map((t) => t.name);
    assert.equal(toolNames.length, CANONICAL_WORKFLOW_TOOL_NAMES.length);
    assert.deepEqual(
      [...toolNames].sort(),
      [...CANONICAL_WORKFLOW_TOOL_NAMES].sort(),
    );
    for (const alias of WORKFLOW_TOOL_ALIAS_NAMES) {
      assert.ok(!toolNames.includes(alias), `alias ${alias} should not be advertised`);
    }
    // Every canonical tool is still present.
    for (const canonical of CANONICAL_WORKFLOW_TOOL_NAMES) {
      assert.ok(toolNames.includes(canonical), `canonical ${canonical} must be registered`);
    }
  });

  it("registers task reopen in the workflow MCP tool surface", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);

    const toolNames = server.tools.map((t) => t.name);
    assert.ok(toolNames.includes("gsd_task_reopen"));
    assert.ok(toolNames.includes("gsd_reopen_task"));

    const taskReopen = server.tools.find((t) => t.name === "gsd_task_reopen");
    assert.ok(taskReopen);
    assert.ok("milestoneId" in taskReopen.params);
    assert.ok("sliceId" in taskReopen.params);
    assert.ok("taskId" in taskReopen.params);
    assert.ok("reason" in taskReopen.params);
  });

  it("registers exact task recovery resume inputs without public identity", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);

    const tool = server.tools.find((candidate) => candidate.name === "gsd_task_recovery_resume");
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.params).sort(), [
      "evidence",
      "projectDir",
      "recoveryActionId",
      "repairSummary",
    ]);
    assert.ok(!("idempotencyKey" in tool.params));
  });

  it("keeps Milestone lifecycle invocation identity out of public schemas", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);

    for (const name of [
      "gsd_complete_milestone",
      "gsd_milestone_complete",
      "gsd_milestone_reopen",
      "gsd_reopen_milestone",
      "gsd_prepare_milestone_subjective_uat",
      "gsd_answer_milestone_subjective_uat",
    ]) {
      const tool = server.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.ok(!("idempotencyKey" in tool.params), `${name} identity must remain private`);
      assert.ok(!("actorId" in tool.params), `${name} actor identity must remain private`);
    }
    const answer = server.tools.find((candidate) =>
      candidate.name === "gsd_answer_milestone_subjective_uat"
    );
    assert.ok(answer);
    assert.ok("selectedOptionId" in answer.params);
    assert.ok("verbatimResponse" in answer.params);
  });

  it("routes task recovery resume to the worktree owning the action", async () => {
    const base = makeTmpBase();
    const first = join(base, ".gsd-worktrees", "M001-first");
    const second = join(base, ".gsd-worktrees", "M002-second");
    for (const worktree of [first, second]) {
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n");
    }
    try {
      assert.equal(await resolveRecoveryActionProjectDir(
        base,
        "recovery-action-2",
        async (_projectDir, actionId) => actionId === "recovery-action-2" ? "M002-second" : null,
      ), second);
    } finally {
      cleanup(base);
    }
  });

  it("caps gsd_summary_save content before executor invocation", () => {
    assert.doesNotThrow(() => {
      _parseWorkflowArgsForTest(_summarySaveSchemaForTest, {
        milestone_id: "M001",
        artifact_type: "CONTEXT-DRAFT",
        content: "x".repeat(SUMMARY_SAVE_CONTENT_MAX_LENGTH),
      });
    });

    assert.throws(
      () => _parseWorkflowArgsForTest(_summarySaveSchemaForTest, {
        milestone_id: "M001",
        artifact_type: "CONTEXT-DRAFT",
        content: "x".repeat(SUMMARY_SAVE_CONTENT_MAX_LENGTH + 1),
      }),
      /content must be at most 50000 characters per save/,
    );
  });

  it("registers gsd_checkpoint_db and flushes the open WAL", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_checkpoint_db");
      assert.ok(tool, "gsd_checkpoint_db must be registered");
      assert.ok("projectDir" in tool.params);

      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertDecision({
        id: "D001",
        when_context: "test",
        scope: "global",
        decision: "Expose checkpoint tool over MCP",
        choice: "register gsd_checkpoint_db",
        rationale: "MCP clients need to flush WAL before staging gsd.db",
        revisable: "yes",
        made_by: "agent",
        superseded_by: null,
      });

      const walPath = `${dbPath}-wal`;
      assert.ok(existsSync(walPath), "WAL file should exist after a write");
      assert.ok(statSync(walPath).size > 0, "WAL file should be non-empty after a write");

      const result = await tool.handler({ projectDir: base });
      const record = result as { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
      assert.equal(record.content?.[0]?.text, "WAL checkpoint complete. gsd.db is now up to date and safe to stage with git add.");
      assert.deepEqual(record.structuredContent, { operation: "checkpoint_db", status: "ok" });

      const walSizeAfter = existsSync(walPath) ? statSync(walPath).size : 0;
      assert.equal(walSizeAfter, 0, "WAL file should be truncated to 0 after MCP checkpoint");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_memory_query opens the project DB when invoked from a GSD worktree without projectDir", async () => {
    const base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    const worktree = join(base, ".gsd-worktrees", "M001");
    const originalCwd = process.cwd();
    try {
      openDatabase(dbPath);
      createMemory({
        category: "gotcha",
        content: "worktree memory query should use the project database",
        confidence: 0.9,
      });
      closeDatabase();

      mkdirSync(join(worktree, ".gsd"), { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M001")}\n`, "utf-8");
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_memory_query");
      assert.ok(tool, "gsd_memory_query should be registered");

      process.chdir(worktree);
      const result = await tool.handler({ query: "worktree memory" });
      const record = result as { isError?: boolean; content?: Array<{ text?: string }> };
      assert.notEqual(record.isError, true, record.content?.[0]?.text ?? "memory query should not fail");
      assert.match(record.content?.[0]?.text ?? "", /worktree memory query should use the project database/);
    } finally {
      process.chdir(originalCwd);
      cleanup(base);
    }
  });

  it("prefers source TypeScript for generic local module imports", () => {
    assert.deepEqual(
      _buildImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js"),
      [
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts",
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js",
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.ts",
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js",
      ],
    );
  });

  it("prefers compiled runtime bridge modules before source fallbacks", () => {
    assert.deepEqual(
      _buildBridgeImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js"),
      [
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js",
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.ts",
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js",
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts",
      ],
    );
  });

  it("gsd_summary_save writes artifact through the shared executor", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const originalCwd = process.cwd();

      const result = await tool!.handler({
        projectDir: base,
        milestone_id: "M001",
        slice_id: "S01",
        artifact_type: "SUMMARY",
        content: "# Summary\n\nHello",
      });

      const text = (result as any).content[0].text as string;
      assert.match(text, /Saved SUMMARY artifact/);
      assert.equal(process.cwd(), originalCwd, "workflow MCP tools should not mutate process.cwd");
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "01-m001", "01-01-SUMMARY.md")),
        "summary file should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec runs by default, preserves cwd, and returns structured metadata", async () => {
    const base = makeTmpBase();
    const originalCwd = process.cwd();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        runtime: "node",
        script: "console.log(process.cwd()); console.log('context mode default on');",
        purpose: "default-on smoke",
      });

      const record = result as any;
      assert.equal(record.isError, false);
      assert.match(record.content[0].text as string, /context mode default on/);
      assert.equal(record.structuredContent.operation, "gsd_exec");
      assert.equal(record.structuredContent.runtime, "node");
      assert.ok(existsSync(record.structuredContent.stdout_path), "stdout should be persisted");
      assert.equal(process.cwd(), originalCwd, "gsd_exec must not mutate process.cwd");
      assert.match(
        readFileSync(record.structuredContent.stdout_path, "utf-8"),
        new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "script should run relative to the requested projectDir",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec accepts command alias without an explicit runtime", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        command: "echo mcp-command-alias-defaults-to-bash",
      });

      const record = result as any;
      assert.equal(record.isError, false);
      assert.equal(record.structuredContent.runtime, "bash");
      assert.match(record.content[0].text as string, /mcp-command-alias-defaults-to-bash/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec honors MCP abort signal before the sandbox timeout", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");

      const controller = new AbortController();
      controller.abort();
      const timeoutMs = 5_000;

      const result = await tool!.handler(
        {
          projectDir: base,
          runtime: "node",
          script: "setTimeout(() => {}, 30_000);",
          timeout_ms: timeoutMs,
        },
        { signal: controller.signal },
      );

      const record = result as any;
      assert.equal(record.isError, true);
      assert.equal(record.structuredContent.operation, "gsd_exec");
      assert.equal(record.structuredContent.aborted, true);
      assert.equal(record.structuredContent.timed_out, false);
      assert.ok(
        record.structuredContent.duration_ms < timeoutMs,
        `expected abort before ${timeoutMs}ms timeout, got ${record.structuredContent.duration_ms}ms`,
      );
      assert.match(record.content[0].text as string, /exit=aborted/);
      const meta = JSON.parse(readFileSync(record.structuredContent.meta_path, "utf-8"));
      assert.equal(meta.aborted, true);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_uat_exec records typed UAT metadata and blocks unsafe UAT commands", async () => {
    const base = makeTmpBase();
    const originalCwd = process.cwd();
    try {
      seedContextModeFixture(base);
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_uat_exec");
      assert.ok(tool, "UAT exec tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        checkId: "UAT-01",
        intent: "uat-runtime-check",
        command: "echo UAT_OK",
        expected: "UAT_OK appears in stdout",
      });

      const record = result as any;
      assert.equal(record.isError, false);
      assert.equal(record.structuredContent.operation, "gsd_uat_exec");
      assert.equal(record.structuredContent.milestoneId, "M001");
      assert.equal(record.structuredContent.sliceId, "S01");
      assert.equal(record.structuredContent.checkId, "UAT-01");
      assert.equal(record.structuredContent.intent, "uat-runtime-check");
      assert.equal(typeof record.structuredContent.id, "string");
      assert.ok(existsSync(record.structuredContent.meta_path), "meta should be persisted");
      const meta = JSON.parse(readFileSync(record.structuredContent.meta_path, "utf-8")) as {
        metadata?: Record<string, unknown>;
      };
      assert.deepEqual(meta.metadata, {
        kind: "uat_exec",
        milestoneId: "M001",
        sliceId: "S01",
        checkId: "UAT-01",
        intent: "uat-runtime-check",
        expected: "UAT_OK appears in stdout",
      });
      assert.equal(process.cwd(), originalCwd, "gsd_uat_exec must not mutate process.cwd");

      const blocked = await tool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        checkId: "UAT-02",
        intent: "uat-runtime-check",
        command: "npm install left-pad",
      });
      assertToolError(blocked, /blocked command/);
      assert.equal((blocked as any).structuredContent.operation, "gsd_uat_exec");
      assert.equal((blocked as any).structuredContent.error, "uat_exec_policy_block");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_uat_result_save validates evidence and persists aggregate UAT gate state", async () => {
    const base = makeTmpBase();
    try {
      seedContextModeFixture(base);
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const execTool = server.tools.find((t) => t.name === "gsd_uat_exec");
      const saveTool = server.tools.find((t) => t.name === "gsd_uat_result_save");
      assert.ok(execTool, "UAT exec tool should be registered");
      assert.ok(saveTool, "UAT result tool should be registered");

      const execResult = await execTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        checkId: "UAT-01",
        intent: "uat-runtime-check",
        command: "echo UAT_RESULT_OK",
      });
      const evidenceId = (execResult as any).structuredContent.id;
      assert.equal(typeof evidenceId, "string");

      const invalidPresentation = runUatMcpPresentation();
      invalidPresentation.presentedTools = invalidPresentation.presentedTools.filter(
        (toolName) => !toolName.endsWith("__gsd_journal_query"),
      );
      const missingPresentedTool = await saveTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{
          id: "UAT-01",
          description: "Runtime check has evidence",
          mode: "runtime",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        }],
        presentation: invalidPresentation,
      });
      assertToolError(missingPresentedTool, /missing required UAT tool "gsd_journal_query"/);

      const incompletePresentation = await saveTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{
          id: "UAT-01",
          description: "Runtime check has evidence",
          mode: "runtime",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        }],
        presentation: {
          surface: "mcp",
          presentedTools: ["gsd_uat_exec", "gsd_uat_result_save"],
          blockedTools: [],
        },
      });
      const incompletePresentationText = assertToolError(incompletePresentation, /missing required UAT tools/);
      assert.match(incompletePresentationText, /"gsd_resume", "gsd_milestone_status", "gsd_journal_query"/);
      assert.match(incompletePresentationText, /"gsd_exec", "gsd_summary_save", "gsd_save_gate_result" as blocked during run-uat/);

      const missingEvidence = await saveTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{
          id: "UAT-01",
          description: "Runtime check has evidence",
          mode: "runtime",
          result: "PASS",
          evidence: [],
        }],
        presentation: runUatMcpPresentation(),
      });
      assertToolError(missingEvidence, /objective evidence/);

      const result = await saveTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{
          id: "UAT-01",
          description: "Runtime check has evidence",
          mode: "runtime",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
          notes: "Command produced the expected marker.",
        }],
        presentation: runUatMcpPresentation(),
        notes: "UAT passed with objective runtime evidence.",
      });

      const record = result as any;
      assert.equal(record.isError, undefined);
      assert.equal(record.structuredContent.operation, "save_uat_result");
      assert.equal(record.structuredContent.verdict, "PASS");
      assert.equal(record.structuredContent.gateVerdict, "pass");
      assert.equal(record.structuredContent.attempt, 1);
      assert.equal(record.structuredContent.recommendedNextUnit, null);
      assert.ok(
        existsSync(join(base, ".gsd", record.structuredContent.attemptPath)),
        "attempt JSON should be persisted",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md")),
        "ASSESSMENT artifact should be persisted",
      );

      const gateRow = _getAdapter()!.prepare(
        "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''",
      ).get("M001", "S01", "UAT") as Record<string, unknown> | undefined;
      assert.ok(gateRow, "aggregate UAT quality gate row should exist");
      assert.equal(gateRow["status"], "complete");
      assert.equal(gateRow["verdict"], "pass");

      const gateRun = _getAdapter()!.prepare(
        "SELECT gate_type, unit_type, outcome, failure_class FROM gate_runs WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?",
      ).get("M001", "S01", "UAT") as Record<string, unknown> | undefined;
      assert.ok(gateRun, "UAT gate run should be recorded");
      assert.equal(gateRun["gate_type"], "uat");
      assert.equal(gateRun["unit_type"], "run-uat");
      assert.equal(gateRun["outcome"], "pass");
      assert.equal(gateRun["failure_class"], "none");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8",
      );
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        runtime: "bash",
        script: "echo should-not-run",
      });

      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal((result as any).structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec is blocked by the MCP discussion-gate write gate", async () => {
    const base = makeTmpBase();
    try {
      writeWriteGateSnapshot(base, { pendingGateId: "depth_verification_M001_confirm" });
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        runtime: "bash",
        script: "echo should-not-run",
      });

      assertToolError(result, /Discussion gate .* has not been confirmed/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec_search finds a prior gsd_exec run", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const execTool = server.tools.find((t) => t.name === "gsd_exec");
      const searchTool = server.tools.find((t) => t.name === "gsd_exec_search");
      assert.ok(execTool, "exec tool should be registered");
      assert.ok(searchTool, "exec search tool should be registered");

      await execTool!.handler({
        projectDir: base,
        runtime: "bash",
        script: "printf 'needle-output\\n'",
        purpose: "find-me-later",
      });

      const result = await searchTool!.handler({
        projectDir: base,
        query: "find-me",
      });

      assert.match((result as any).content[0].text as string, /find-me-later/);
      assert.equal((result as any).structuredContent.operation, "gsd_exec_search");
      assert.equal((result as any).structuredContent.matches, 1);
      assert.match((result as any).structuredContent.results[0].stdout_path, /\.gsd[\\/]exec[\\/].*\.stdout$/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_exec_search returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8",
      );
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_exec_search");
      assert.ok(tool, "exec search tool should be registered");

      const result = await tool!.handler({ projectDir: base, query: "anything" });

      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal((result as any).structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_resume reads the context snapshot", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "last-snapshot.md"),
        "# GSD context snapshot\n\nResume from here.\n",
        "utf-8",
      );
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_resume");
      assert.ok(tool, "resume tool should be registered");

      const result = await tool!.handler({ projectDir: base });

      assert.match((result as any).content[0].text as string, /Resume from here/);
      assert.deepEqual((result as any).structuredContent, {
        operation: "gsd_resume",
        found: true,
        bytes: Buffer.byteLength("# GSD context snapshot\n\nResume from here.\n", "utf-8"),
      });
    } finally {
      cleanup(base);
    }
  });

  it("gsd_resume returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8",
      );
      writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nHidden.\n", "utf-8");
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_resume");
      assert.ok(tool, "resume tool should be registered");

      const result = await tool!.handler({ projectDir: base });

      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal((result as any).structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });

  it("Context Mode contract is wired through prompts, MCP tools, persisted evidence, and disabled-mode blocking", async () => {
    const base = makeTmpBase();
    try {
      seedContextModeFixture(base);
      invalidateAllCaches();

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const execTool = server.tools.find((t) => t.name === "gsd_exec");
      const searchTool = server.tools.find((t) => t.name === "gsd_exec_search");
      const resumeTool = server.tools.find((t) => t.name === "gsd_resume");
      assert.ok(execTool, "exec tool should be registered");
      assert.ok(searchTool, "exec search tool should be registered");
      assert.ok(resumeTool, "resume tool should be registered");

      const prompt = await buildReassessRoadmapPrompt("M001", "Context Mode", "S01", base);
      assert.match(prompt, /## Context Mode/);
      assert.match(prompt, /Lane: \*\*planning lane\*\*/);
      assert.match(prompt, /## Context Snapshot/);
      assert.match(prompt, /Context mode resume evidence/);
      assert.ok(
        prompt.indexOf("## Context Mode") < prompt.indexOf("## Context Snapshot"),
        "prompt should explain Context Mode before injecting the snapshot",
      );

      const execResult = await execTool!.handler({
        projectDir: base,
        runtime: "node",
        script: "console.log('context-contract-e2e');",
        purpose: "context-contract-e2e",
      });
      assert.equal((execResult as any).isError, false);
      assert.equal((execResult as any).structuredContent.operation, "gsd_exec");
      assert.ok(existsSync((execResult as any).structuredContent.stdout_path), "stdout should be persisted");

      const searchResult = await searchTool!.handler({
        projectDir: base,
        query: "context-contract-e2e",
      });
      assert.equal((searchResult as any).structuredContent.operation, "gsd_exec_search");
      assert.equal((searchResult as any).structuredContent.matches, 1);
      assert.equal(
        (searchResult as any).structuredContent.results[0].stdout_path,
        (execResult as any).structuredContent.stdout_path,
        "search should rediscover the persisted exec evidence instead of rerunning it",
      );

      const resumeResult = await resumeTool!.handler({ projectDir: base });
      assert.deepEqual((resumeResult as any).structuredContent, {
        operation: "gsd_resume",
        found: true,
        bytes: Buffer.byteLength("# GSD context snapshot\n\nContext mode resume evidence.\n", "utf-8"),
      });
      assert.match((resumeResult as any).content[0].text as string, /Context mode resume evidence/);

      const worktree = join(base, ".gsd", "worktrees", "M001");
      mkdirSync(worktree, { recursive: true });
      const rootSafetyResult = await execTool!.handler({
        projectDir: worktree,
        runtime: "node",
        script: `console.log(${JSON.stringify(base)});`,
      });
      assertToolError(rootSafetyResult, /original project root/);

      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8",
      );
      invalidateAllCaches();

      const disabledPrompt = await buildReassessRoadmapPrompt("M001", "Context Mode", "S01", base);
      assert.doesNotMatch(disabledPrompt, /## Context Mode|## Context Snapshot|Context mode resume evidence/);

      for (const [tool, args] of [
        [execTool, { projectDir: base, runtime: "node", script: "console.log('blocked');" }],
        [searchTool, { projectDir: base, query: "context-contract-e2e" }],
        [resumeTool, { projectDir: base }],
      ] as const) {
        const result = await tool!.handler(args);
        assertToolError(result, /context_mode\.enabled: false/);
        assert.equal((result as any).structuredContent.error, "context_mode_disabled");
      }
    } finally {
      cleanup(base);
    }
  });

  it("gsd_summary_save supports root-level PROJECT artifacts without milestone_id", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      const milestoneParam = tool!.params.milestone_id as { isOptional?: () => boolean };
      assert.equal(
        milestoneParam.isOptional?.(),
        true,
        "workflow MCP schema must advertise milestone_id as optional for root artifacts",
      );

      const projectFixture = [
        "# Project",
        "",
        "Root artifact",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "",
      ].join("\n");

      const result = await tool!.handler({
        projectDir: base,
        artifact_type: "PROJECT",
        content: projectFixture,
      });

      const text = (result as any).content[0].text as string;
      assert.match(text, /Saved PROJECT artifact/);
      assert.ok(
        existsSync(join(base, ".gsd", "PROJECT.md")),
        "root project artifact should exist on disk",
      );
      assert.equal(
        readFileSync(join(base, ".gsd", "PROJECT.md"), "utf-8"),
        projectFixture,
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_summary_save rejects milestone-scoped artifacts without milestone_id", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        artifact_type: "SUMMARY",
        content: "# Summary\n",
      });

      const text = (result as any).content?.[0]?.text as string;
      assert.match(
        text,
        /milestone_id is required for milestone-scoped artifact types/,
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_summary_save renders root REQUIREMENTS from DB rows, not provided markdown", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const requirementTool = server.tools.find((t) => t.name === "gsd_requirement_save");
      const summaryTool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(requirementTool, "requirement tool should be registered");
      assert.ok(summaryTool, "summary tool should be registered");

      await requirementTool!.handler({
        projectDir: base,
        class: "primary-user-loop",
        description: "MCP user can add a task",
        why: "Core loop",
        source: "user",
        status: "active",
        primary_owner: "M001/none yet",
        supporting_slices: "none",
        validation: "unmapped",
      });

      const result = await summaryTool!.handler({
        projectDir: base,
        artifact_type: "REQUIREMENTS",
        content: "# Requirements\n\n## Active\n\n### R999 — Wrong markdown source\n\n- Description: This content must not become canonical.\n",
      });

      const text = (result as any).content[0].text as string;
      assert.match(text, /Saved REQUIREMENTS artifact/);

      const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
      const markdown = readFileSync(requirementsPath, "utf-8");
      assert.match(markdown, /MCP user can add a task/);
      assert.doesNotMatch(markdown, /R999|Wrong markdown source|This content must not become canonical/);

      const row = _getAdapter()!
        .prepare("SELECT id, description FROM requirements WHERE description = ?")
        .get("MCP user can add a task") as Record<string, unknown> | undefined;
      assert.ok(row, "requirement row should remain the canonical source");

      const artifact = _getAdapter()!
        .prepare("SELECT full_content FROM artifacts WHERE path = ?")
        .get("REQUIREMENTS.md") as Record<string, unknown> | undefined;
      assert.equal(artifact?.full_content, markdown);
    } finally {
      cleanup(base);
    }
  });

  it("rejects workflow tool calls outside the configured project root", async () => {
    const base = makeTmpBase();
    const otherBase = makeTmpBase();
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      const result = await tool!.handler({
        projectDir: otherBase,
        milestone_id: "M001",
        artifact_type: "SUMMARY",
        content: "# Summary",
      });
      assertToolError(result, /configured workflow project root/);
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
      cleanup(otherBase);
    }
  });

  it("rejects non-file executor module URLs", async () => {
    const base = makeTmpBase();
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = "data:text/javascript,export default {}";
      const { registerWorkflowTools: freshRegisterWorkflowTools } = await import(
        cacheBustedWorkflowToolsImport("bad-module")
      );
      const server = makeMockServer();
      freshRegisterWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      const result = await tool!.handler({
        projectDir: base,
        milestone_id: "M001",
        artifact_type: "SUMMARY",
        content: "# Summary",
      });
      assertToolError(result, /only supports file: URLs or filesystem paths/);
    } finally {
      if (prevModule === undefined) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
    }
  });

  it("blocks workflow mutation tools while a discussion gate is pending", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      writeWriteGateSnapshot(base, { pendingGateId: "depth_verification_M001_confirm" });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      const result = await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test",
      });
      assertToolError(result, /Discussion gate .* has not been confirmed/);
    } finally {
      cleanup(base);
    }
  });

  it("blocks workflow mutation tools during queue mode", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      writeWriteGateSnapshot(base, { activeQueuePhase: true });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      const result = await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test",
      });
      assertToolError(result, /planning tool .* not executes work|Cannot gsd_task_complete|Unknown tools are not permitted during queue mode/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_task_complete and gsd_milestone_status work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      claimCanonicalTaskAuthority(base, { milestoneId: "M001", sliceId: "S01", taskId: "T01" });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const statusTool = server.tools.find((t) => t.name === "gsd_milestone_status");
      assert.ok(taskTool, "task tool should be registered");
      assert.ok(statusTool, "status tool should be registered");

      const taskResult = await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test",
      });

      assert.match((taskResult as any).content[0].text as string, /Staged task T01; awaiting host verification/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md")),
        "task summary should be written to disk",
      );

      const statusResult = await statusTool!.handler({
        projectDir: base,
        milestoneId: "M001",
      });
      const parsed = JSON.parse((statusResult as any).content[0].text as string);
      assert.equal(parsed.milestoneId, "M001");
      assert.equal(parsed.sliceCount, 1);
      assert.equal(parsed.slices[0].id, "S01");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_skip_slice cascades pending/active tasks to skipped", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const planTaskTool = server.tools.find((t) => t.name === "gsd_plan_task");
      const skipTool = server.tools.find((t) => t.name === "gsd_skip_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(planTaskTool, "task planning tool should be registered");
      assert.ok(skipTool, "skip slice tool should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Skip slice cascade",
        vision: "Ensure skip cascades task statuses.",
        slices: [
          {
            sliceId: "S01",
            title: "Slice to skip",
            risk: "low",
            depends: [],
            demo: "Tasks are skipped when slice is skipped.",
            goal: "Create pending tasks and skip the slice.",
            successCriteria: "Tasks become skipped after gsd_skip_slice.",
            proofLevel: "integration",
            integrationClosure: "MCP skip tool updates slice and tasks together.",
            observabilityImpact: "Regression test guards pending-task dead-end.",
          },
        ],
      });

      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Create tasks that should be cascaded.",
        tasks: [
          {
            taskId: "T01",
            title: "Pending one",
            description: "Will be skipped via cascade.",
            estimate: "5m",
            files: ["src/a.ts"],
            verify: "node --test",
            inputs: ["M001-ROADMAP.md"],
            expectedOutput: ["T01-PLAN.md"],
            requiredWorkflowTools: [],
          },
          {
            taskId: "T02",
            title: "Pending two",
            description: "Will be skipped via cascade.",
            estimate: "5m",
            files: ["src/b.ts"],
            verify: "node --test",
            inputs: ["M001-ROADMAP.md"],
            expectedOutput: ["T02-PLAN.md"],
            requiredWorkflowTools: [],
          },
        ],
      });

      await planTaskTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        title: "Pending one",
        description: "Will be skipped via cascade.",
        estimate: "5m",
        files: ["src/a.ts"],
        verify: "node --test",
        inputs: ["M001-ROADMAP.md"],
        expectedOutput: ["T01-PLAN.md"],
        requiredWorkflowTools: [],
      });

      await planTaskTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T02",
        title: "Pending two",
        description: "Will be skipped via cascade.",
        estimate: "5m",
        files: ["src/b.ts"],
        verify: "node --test",
        inputs: ["M001-ROADMAP.md"],
        expectedOutput: ["T02-PLAN.md"],
        requiredWorkflowTools: [],
      });

      _getAdapter()!
        .prepare("UPDATE tasks SET status = 'active' WHERE milestone_id = ? AND slice_id = ? AND id = ?")
        .run("M001", "S01", "T02");

      const skipResult = await skipTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        reason: "descoped",
      });
      assert.match((skipResult as any).content[0].text as string, /Skipped slice S01/);

      const tasks = getSliceTasks("M001", "S01");
      assert.equal(tasks.length, 2, "expected planned tasks to exist");
      for (const task of tasks) {
        assert.equal(task.status, "skipped", `task ${task.id} should be skipped by cascade`);
      }
    } finally {
      cleanup(base);
    }
  });

  it("gsd_task_complete accepts JSON-stringified evidence when verification summary is omitted", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      claimCanonicalTaskAuthority(base, { milestoneId: "M001", sliceId: "S01", taskId: "T01" });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      const taskResult = await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verificationEvidence: JSON.stringify([
          { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 },
        ]),
      }, {
        requestId: "rpc-task-complete",
        _meta: { "claudecode/toolUseId": "toolu_task_complete" },
      });

      assert.match((taskResult as any).content[0].text as string, /Staged task T01; awaiting host verification/);
      const db = _getAdapter();
      assert.ok(db, "DB should be open after tool completion");
      const row = db!.prepare(
        "SELECT verification_result FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      ).get("M001", "S01", "T01") as Record<string, unknown> | undefined;
      assert.match(String(row?.verification_result), /`npm test` exited 0 \(pass\)/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_task_complete rejects missing replay-stable private execution metadata", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((tool) => tool.name === "gsd_task_complete");
      assert.ok(taskTool);

      const result = await taskTool.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Must not execute",
        narrative: "Private replay identity is missing.",
        verification: "npm test",
      }, { _meta: { "io.opengsd/idempotency-key": "   " } });
      assertToolError(
        result,
        /Task execution mutation gsd_task_complete requires replay-stable.*io\.opengsd\/idempotency-key/i,
      );
      assert.equal(existsSync(join(base, ".gsd", "gsd.db")), false);
    } finally {
      cleanup(base);
    }
  });

  it("Workflow lifecycle mutations reject missing replay-stable private execution metadata", async (t) => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);
    const cases = [
      {
        name: "gsd_slice_complete",
        params: {
          milestoneId: "M001",
          sliceId: "S01",
          sliceTitle: "Must not execute",
          oneLiner: "Missing identity",
          narrative: "The request must fail before mutation.",
          uatContent: "## UAT\n\nPASS",
        },
      },
      {
        name: "gsd_slice_reopen",
        params: { milestoneId: "M001", sliceId: "S01", reason: "Must not execute." },
      },
      {
        name: "gsd_skip_slice",
        params: { milestoneId: "M001", sliceId: "S01", reason: "Must not execute." },
      },
      {
        name: "gsd_validate_milestone",
        params: {
          milestoneId: "M001",
          verdict: "pass",
          remediationRound: 0,
          successCriteriaChecklist: "- [x] Complete",
          sliceDeliveryAudit: "| S01 | pass |",
          crossSliceIntegration: "Passed",
          requirementCoverage: "Covered",
          verdictRationale: "Must not execute.",
        },
      },
      {
        name: "gsd_complete_milestone",
        params: {
          milestoneId: "M001",
          title: "Must not execute",
          oneLiner: "Missing identity",
          narrative: "The request must fail before mutation.",
          verificationPassed: true,
        },
      },
      {
        name: "gsd_milestone_reopen",
        params: { milestoneId: "M001", reason: "Must not execute." },
      },
    ];

    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const base = makeTmpBase();
        try {
          const tool = server.tools.find((candidate) => candidate.name === entry.name);
          assert.ok(tool, `${entry.name} must be registered`);
          const result = await tool.handler({ projectDir: base, ...entry.params }, {
            _meta: { "io.opengsd/idempotency-key": "   " },
          });
          assertToolError(result, /replay-stable.*io\.opengsd\/idempotency-key/i);
          assert.equal(existsSync(join(base, ".gsd", "gsd.db")), false);
        } finally {
          cleanup(base);
        }
      });
    }
  });

  it("forwards private execution identity and complete Task fields to shared executors", async () => {
    // Locks in the class-fix from PR #4477 review: handleTaskComplete previously
    // destructured args into a hand-listed set of fields and rebuilt the call
    // payload, which silently dropped ADR-011's `escalation` field (and any
    // future schema field added without updating the rebuild). The fix passes
    // `args` through directly, matching the spread pattern of sibling
    // handlers. This test verifies the contract by injecting a mock executor
    // module that captures the args, calling gsd_task_complete with an
    // `escalation` payload, and asserting the field reached the executor.
    const base = makeTmpBase();
    const capturePath = join(base, "captured-args.json");
    const reopenCapturePath = join(base, "captured-reopen-args.json");
    const resumeCapturePath = join(base, "captured-recovery-resume-args.json");
    const sliceCapturePath = join(base, "captured-slice-lifecycle-args.json");
    const milestoneCapturePath = join(base, "captured-milestone-lifecycle-args.json");
    const validationCapturePath = join(base, "captured-milestone-validation-args.json");
    const mockModulePath = join(base, "mock-executors.mjs");
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevCapture = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
    const prevReopenCapture = process.env.GSD_TEST_TASK_REOPEN_CAPTURE_PATH;
    const prevResumeCapture = process.env.GSD_TEST_TASK_RECOVERY_RESUME_CAPTURE_PATH;
    const prevSliceCapture = process.env.GSD_TEST_SLICE_LIFECYCLE_CAPTURE_PATH;
    const prevMilestoneCapture = process.env.GSD_TEST_MILESTONE_LIFECYCLE_CAPTURE_PATH;
    const prevValidationCapture = process.env.GSD_TEST_MILESTONE_VALIDATION_CAPTURE_PATH;
    try {
      // Mock module: implements the WorkflowToolExecutors shape.
      // executeTaskComplete writes its received args to disk for assertion.
      // Other executors are no-op stubs to satisfy isWorkflowToolExecutors.
      const mockSource = `
import { readFileSync, writeFileSync } from "node:fs";

const noop = async () => ({ content: [{ type: "text", text: "noop" }] });

function readCaptures(capturePath) {
  try {
    return JSON.parse(readFileSync(capturePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const captureSliceLifecycle = async (executor, params, projectDir, invocation) => {
  const capturePath = process.env.GSD_TEST_SLICE_LIFECYCLE_CAPTURE_PATH;
  if (capturePath) {
    const captures = readCaptures(capturePath);
    captures.push({ executor, params, projectDir, invocation });
    writeFileSync(capturePath, JSON.stringify(captures, null, 2));
  }
  return { content: [{ type: "text", text: "mock slice " + executor }] };
};

const captureMilestoneLifecycle = async (executor, params, projectDir, invocation) => {
  const capturePath = process.env.GSD_TEST_MILESTONE_LIFECYCLE_CAPTURE_PATH;
  if (capturePath) {
    const captures = readCaptures(capturePath);
    captures.push({ executor, params, projectDir, invocation });
    writeFileSync(capturePath, JSON.stringify(captures, null, 2));
  }
  return { content: [{ type: "text", text: "mock milestone " + executor }] };
};

const captureMilestoneValidation = async (params, projectDir, options) => {
  const capturePath = process.env.GSD_TEST_MILESTONE_VALIDATION_CAPTURE_PATH;
  if (capturePath) {
    const captures = readCaptures(capturePath);
    captures.push({ params, projectDir, invocation: options?.invocation });
    writeFileSync(capturePath, JSON.stringify(captures, null, 2));
  }
  return { content: [{ type: "text", text: "mock milestone validate" }] };
};

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = ["SUMMARY", "UAT", "CONTEXT", "PLAN"];
export const resolveMilestoneStatusObservationTokenState = () => "malformed";
export const executeMilestoneStatus = noop;
export const executePlanMilestone = noop;
export const executePlanSlice = noop;
export const executeReplanSlice = noop;
export const executeReplanTask = noop;
export const executeReworkBriefSave = noop;
export const executeSliceComplete = (params, projectDir, invocation) =>
  captureSliceLifecycle("complete", params, projectDir, invocation);
export const executeCompleteMilestone = (params, projectDir, invocation) =>
  captureMilestoneLifecycle("complete", params, projectDir, invocation);
export const executeValidateMilestone = captureMilestoneValidation;
export const executeReassessRoadmap = noop;
export const executeSaveGateResult = noop;
export const executeSummarySave = noop;
export const executeUatResultSave = noop;
export const executeSliceReopen = (params, projectDir, invocation) =>
  captureSliceLifecycle("reopen", params, projectDir, invocation);
export const executeSkipSlice = (params, projectDir, invocation) =>
  captureSliceLifecycle("skip", params, projectDir, invocation);
export const executeMilestoneReopen = (params, projectDir, invocation) =>
  captureMilestoneLifecycle("reopen", params, projectDir, invocation);

export const executeTaskReopen = async (params, projectDir, invocation) => {
  const capturePath = process.env.GSD_TEST_TASK_REOPEN_CAPTURE_PATH;
  if (capturePath) {
    let captures = [];
    try { captures = JSON.parse(readFileSync(capturePath, "utf8")); } catch {}
    captures.push({ params, projectDir, invocation });
    writeFileSync(capturePath, JSON.stringify(captures, null, 2));
  }
  return { content: [{ type: "text", text: "mock task reopen" }] };
};

export const executeTaskRecoveryResume = async (params, projectDir, invocation) => {
  const capturePath = process.env.GSD_TEST_TASK_RECOVERY_RESUME_CAPTURE_PATH;
  if (capturePath) {
    writeFileSync(capturePath, JSON.stringify({ params, projectDir, invocation }, null, 2));
  }
  return { content: [{ type: "text", text: "mock task recovery resume" }] };
};

export const executeTaskSettle = async (params, projectDir, invocation) => {
  return { content: [{ type: "text", text: "mock task settle" }] };
};

export const executeTaskComplete = async (params, projectDir, invocation) => {
  const capturePath = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
  if (capturePath) {
    writeFileSync(capturePath, JSON.stringify({ params, projectDir, invocation }, null, 2));
  }
  return {
    content: [{ type: "text", text: "mock task complete" }],
    details: { taskId: params.taskId },
  };
};
`;
      writeFileSync(mockModulePath, mockSource, "utf-8");
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = mockModulePath;
      process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = capturePath;
      process.env.GSD_TEST_TASK_REOPEN_CAPTURE_PATH = reopenCapturePath;
      process.env.GSD_TEST_TASK_RECOVERY_RESUME_CAPTURE_PATH = resumeCapturePath;
      process.env.GSD_TEST_SLICE_LIFECYCLE_CAPTURE_PATH = sliceCapturePath;
      process.env.GSD_TEST_MILESTONE_LIFECYCLE_CAPTURE_PATH = milestoneCapturePath;
      process.env.GSD_TEST_MILESTONE_VALIDATION_CAPTURE_PATH = validationCapturePath;

      // Fresh import bypasses the cached workflowToolExecutorsPromise so the
      // mock module is actually loaded for this test.
      const {
        registerWorkflowTools: freshRegisterWorkflowTools,
        resolveMilestoneStatusObservationTokenState: freshResolveObservationTokenState,
      } = await import(
        cacheBustedWorkflowToolsImport("escalation-test")
      );
      assert.equal(
        await freshResolveObservationTokenState(base, "opaque-token"),
        "unavailable",
      );
      const server = makeMockServer();
      freshRegisterWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_task");
      const reopenTool = server.tools.find((t) => t.name === "gsd_task_reopen");
      const reopenAlias = server.tools.find((t) => t.name === "gsd_reopen_task");
      const resumeTool = server.tools.find((t) => t.name === "gsd_task_recovery_resume");
      const sliceCompleteTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const sliceCompleteAlias = server.tools.find((t) => t.name === "gsd_complete_slice");
      const sliceReopenTool = server.tools.find((t) => t.name === "gsd_slice_reopen");
      const sliceReopenAlias = server.tools.find((t) => t.name === "gsd_reopen_slice");
      const skipSliceTool = server.tools.find((t) => t.name === "gsd_skip_slice");
      const validateMilestoneTool = server.tools.find((t) => t.name === "gsd_validate_milestone");
      const validateMilestoneAlias = server.tools.find((t) => t.name === "gsd_milestone_validate");
      const completeMilestoneTool = server.tools.find((t) => t.name === "gsd_complete_milestone");
      const completeMilestoneAlias = server.tools.find((t) => t.name === "gsd_milestone_complete");
      const reopenMilestoneTool = server.tools.find((t) => t.name === "gsd_milestone_reopen");
      const reopenMilestoneAlias = server.tools.find((t) => t.name === "gsd_reopen_milestone");
      assert.ok(taskTool, "task tool should be registered");
      assert.ok(aliasTool, "task completion alias should be registered");
      assert.ok(reopenTool, "task reopen tool should be registered");
      assert.ok(reopenAlias, "task reopen alias should be registered");
      assert.ok(resumeTool, "task recovery resume tool should be registered");
      assert.ok(sliceCompleteTool, "slice completion tool should be registered");
      assert.ok(sliceCompleteAlias, "slice completion alias should be registered");
      assert.ok(sliceReopenTool, "slice reopen tool should be registered");
      assert.ok(sliceReopenAlias, "slice reopen alias should be registered");
      assert.ok(skipSliceTool, "slice skip tool should be registered");
      assert.ok(validateMilestoneTool, "milestone validation tool should be registered");
      assert.ok(validateMilestoneAlias, "milestone validation alias should be registered");
      assert.ok(completeMilestoneTool, "milestone completion tool should be registered");
      assert.ok(completeMilestoneAlias, "milestone completion alias should be registered");
      assert.ok(reopenMilestoneTool, "milestone reopen tool should be registered");
      assert.ok(reopenMilestoneAlias, "milestone reopen alias should be registered");

      // Mirrors the ADR-011 escalation schema: question + 2-4 options
      // (each with id/label/tradeoffs) + recommendation + rationale +
      // continueWithDefault flag.
      const escalationPayload = {
        question: "Should the auth flow use OAuth or PAT?",
        options: [
          { id: "A", label: "OAuth", tradeoffs: "Best UX; requires more setup." },
          { id: "B", label: "PAT", tradeoffs: "Simpler; weaker rotation story." },
        ],
        recommendation: "A",
        recommendationRationale: "Initial requirement implied multi-user; OAuth fits better.",
        continueWithDefault: true,
      };

      const taskArgs = {
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task with escalation",
        narrative: "Did the work but flagged an ambiguity",
        verification: "npm test",
        escalation: escalationPayload,
        verificationEvidence: [
          { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 },
        ],
      };
      const metadata = { _meta: { "io.opengsd/idempotency-key": "stable-task-retry" } };
      await taskTool!.handler(taskArgs, metadata);

      assert.ok(existsSync(capturePath), "mock executor should have written captured args to disk");
      const captured = JSON.parse(readFileSync(capturePath, "utf-8"));

      // The handler resolves projectDir via realpathSync (security/symlink check),
      // so on macOS where /var symlinks to /private/var, the captured path will
      // be the realpath form. Normalize both sides.
      assert.equal(captured.projectDir, realpathSync(base), "projectDir should be passed as second arg");
      assert.deepEqual(
        captured.params.escalation,
        escalationPayload,
        "escalation payload must reach the executor verbatim — regression guard for the destructure-rebuild bug class (#4477 review)",
      );
      // Spot-check a couple of other fields to ensure the spread pattern
      // doesn't accidentally exclude the rest while including escalation.
      assert.equal(captured.params.taskId, "T01", "taskId must be forwarded");
      assert.equal(captured.params.milestoneId, "M001", "milestoneId must be forwarded");
      assert.deepEqual(
        captured.params.verificationEvidence,
        [{ command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 }],
        "verificationEvidence must be forwarded (existing field)",
      );
      // Ensure no projectDir leak into params (it should be the second arg only).
      assert.equal(
        captured.params.projectDir,
        undefined,
        "projectDir must NOT appear in params — it's stripped via the spread destructure",
      );
      assert.deepEqual(captured.invocation, {
        idempotencyKey: "mcp:gsd_task_complete:stable-task-retry",
        sourceTransport: "workflow-mcp",
        actorType: "agent",
        traceId: "stable-task-retry",
      });

      await aliasTool!.handler(taskArgs, metadata);
      const aliasCapture = JSON.parse(readFileSync(capturePath, "utf-8"));
      assert.deepEqual(
        aliasCapture.invocation,
        captured.invocation,
        "canonical and alias task completion must share one private execution identity",
      );

      const reopenArgs = {
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        reason: "verification found a regression",
      };
      const reopenMetadata = { _meta: { "io.opengsd/idempotency-key": "stable-task-reopen" } };
      await reopenTool!.handler(reopenArgs, reopenMetadata);
      await reopenAlias!.handler(reopenArgs, reopenMetadata);
      const reopenCaptures = JSON.parse(readFileSync(reopenCapturePath, "utf-8"));
      assert.equal(reopenCaptures.length, 2);
      for (const reopenCapture of reopenCaptures) {
        assert.equal(reopenCapture.projectDir, realpathSync(base));
        assert.equal(reopenCapture.params.projectDir, undefined);
        assert.deepEqual(reopenCapture.invocation, {
          idempotencyKey: "mcp:gsd_task_reopen:stable-task-reopen",
          sourceTransport: "workflow-mcp",
          actorType: "agent",
          traceId: "stable-task-reopen",
        });
      }

      const resumeArgs = {
        projectDir: base,
        recoveryActionId: "recovery-action-1",
        repairSummary: "The executor defect was repaired.",
        evidence: { pullRequest: 1457, check: "focused recovery tests passed" },
      };
      const resumeMetadata = { _meta: { "claudecode/toolUseId": "toolu_recovery_resume" } };
      await resumeTool!.handler(resumeArgs, resumeMetadata);
      const resumeCapture = JSON.parse(readFileSync(resumeCapturePath, "utf-8"));
      assert.equal(resumeCapture.projectDir, realpathSync(base));
      assert.equal(resumeCapture.params.projectDir, undefined);
      assert.deepEqual(resumeCapture.params, {
        recoveryActionId: resumeArgs.recoveryActionId,
        repairSummary: resumeArgs.repairSummary,
        evidence: resumeArgs.evidence,
      });
      assert.deepEqual(resumeCapture.invocation, {
        idempotencyKey: "mcp:gsd_task_recovery_resume:transport:claude-code:toolu_recovery_resume",
        sourceTransport: "workflow-mcp",
        actorType: "agent",
        traceId: "transport:claude-code:toolu_recovery_resume",
      });

      const sliceArgs = {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
      };
      const sliceCases = [
        {
          tools: [sliceCompleteTool!, sliceCompleteAlias!],
          executor: "complete",
          canonicalName: "gsd_slice_complete",
          params: {
            ...sliceArgs,
            sliceTitle: "Slice identity",
            oneLiner: "One completion operation",
            narrative: "Canonical and alias calls converge.",
            uatContent: "## UAT\n\nPASS",
            actorName: "lifecycle-agent",
            triggerReason: "All automated checks passed.",
          },
        },
        {
          tools: [sliceReopenTool!, sliceReopenAlias!],
          executor: "reopen",
          canonicalName: "gsd_slice_reopen",
          params: { ...sliceArgs, reason: "Redo the Slice." },
        },
        {
          tools: [skipSliceTool!],
          executor: "skip",
          canonicalName: "gsd_skip_slice",
          params: { ...sliceArgs, reason: "Descoped." },
        },
      ] as const;
      for (const entry of sliceCases) {
        for (const tool of entry.tools) {
          await tool.handler(entry.params, {
            requestId: `request-${entry.executor}`,
            _meta: { "io.opengsd/idempotency-key": `stable-slice-${entry.executor}` },
          });
        }
      }

      const validationEvidence = [{
        verificationClass: "UAT",
        evidenceClass: "browser",
        rationale: "The browser journey passed.",
        commandOrTool: "gsd-browser",
        workingDirectory: realpathSync(base),
        startedAt: "2026-07-14T12:00:00.000Z",
        endedAt: "2026-07-14T12:01:00.000Z",
        observation: "passed",
        durableOutputRef: "artifact://uat/browser-run",
        testedSourceRevision: "sha256:tested-source",
        environment: { browser: "chromium" },
      }];
      const validationArgs = {
        projectDir: base,
        milestoneId: "M001",
        verdict: "pass",
        remediationRound: 0,
        successCriteriaChecklist: "- [x] Complete",
        sliceDeliveryAudit: "| S01 | pass |",
        crossSliceIntegration: "Passed",
        requirementCoverage: "Covered",
        verdictRationale: "Current structured evidence passed.",
        verificationEvidence: validationEvidence,
      };
      const validationMetadata = {
        _meta: { "io.opengsd/idempotency-key": "stable-milestone-validation" },
      };
      await validateMilestoneTool!.handler(validationArgs, validationMetadata);
      const firstValidationCapture = readFileSync(validationCapturePath, "utf-8");
      writeFileSync(validationCapturePath, "{malformed", "utf-8");
      const malformedCaptureResult = await validateMilestoneAlias!.handler(validationArgs, validationMetadata);
      assertToolError(malformedCaptureResult, /JSON|Unexpected|position/i);
      writeFileSync(validationCapturePath, firstValidationCapture, "utf-8");
      await validateMilestoneAlias!.handler(validationArgs, validationMetadata);
      const validationCaptures = JSON.parse(readFileSync(validationCapturePath, "utf-8"));
      assert.equal(validationCaptures.length, 2);
      for (const capture of validationCaptures) {
        assert.equal(capture.projectDir, realpathSync(base));
        assert.equal(capture.params.projectDir, undefined);
        assert.deepEqual(capture.params.verificationEvidence, validationEvidence);
        assert.deepEqual(capture.invocation, {
          idempotencyKey: "mcp:gsd_validate_milestone:stable-milestone-validation",
          sourceTransport: "workflow-mcp",
          actorType: "agent",
          traceId: "stable-milestone-validation",
        });
      }
      const invalidEvidence = await validateMilestoneTool!.handler({
          ...validationArgs,
          verificationEvidence: validationEvidence.map(({ testedSourceRevision: _tested, ...evidence }) => evidence),
        }, {
          _meta: { "io.opengsd/idempotency-key": "invalid-milestone-validation" },
        });
      assertToolError(invalidEvidence, /testedSourceRevision/i);

      const milestoneCases = [
        {
          tools: [completeMilestoneTool!, completeMilestoneAlias!],
          executor: "complete",
          canonicalName: "gsd_complete_milestone",
          params: {
            projectDir: base,
            milestoneId: "M001",
            title: "Milestone identity",
            oneLiner: "One completion operation",
            narrative: "Canonical and alias calls converge.",
            verificationPassed: true,
            actorName: "milestone-agent",
            triggerReason: "Current validation passed.",
          },
        },
        {
          tools: [reopenMilestoneTool!, reopenMilestoneAlias!],
          executor: "reopen",
          canonicalName: "gsd_milestone_reopen",
          params: {
            projectDir: base,
            milestoneId: "M001",
            reason: "Redo the Milestone.",
            actorName: "milestone-agent",
            triggerReason: "A post-closeout regression was confirmed.",
          },
        },
      ] as const;
      for (const entry of milestoneCases) {
        for (const tool of entry.tools) {
          await tool.handler(entry.params, {
            requestId: `request-${entry.executor}`,
            _meta: { "io.opengsd/idempotency-key": `stable-milestone-${entry.executor}` },
          });
        }
      }

      const milestoneCaptures = JSON.parse(readFileSync(milestoneCapturePath, "utf-8"));
      assert.equal(milestoneCaptures.length, 4);
      for (const entry of milestoneCases) {
        const matching = milestoneCaptures.filter((capture: any) => capture.executor === entry.executor);
        assert.equal(matching.length, entry.tools.length);
        for (const capture of matching) {
          assert.equal(capture.projectDir, realpathSync(base));
          assert.equal(capture.params.projectDir, undefined);
          assert.equal(capture.params.actorName, entry.params.actorName);
          assert.equal(capture.params.triggerReason, entry.params.triggerReason);
          assert.deepEqual(capture.invocation, {
            idempotencyKey: `mcp:${entry.canonicalName}:stable-milestone-${entry.executor}`,
            sourceTransport: "workflow-mcp",
            actorType: "agent",
            traceId: `stable-milestone-${entry.executor}`,
          });
        }
      }

      const sliceCaptures = JSON.parse(readFileSync(sliceCapturePath, "utf-8"));
      assert.equal(sliceCaptures.length, 5);
      for (const entry of sliceCases) {
        const matching = sliceCaptures.filter((capture: any) => capture.executor === entry.executor);
        assert.equal(matching.length, entry.tools.length);
        for (const capture of matching) {
          assert.equal(capture.projectDir, realpathSync(base));
          assert.equal(capture.params.projectDir, undefined);
          if (entry.executor === "complete") {
            assert.equal(capture.params.actorName, "lifecycle-agent");
            assert.equal(capture.params.triggerReason, "All automated checks passed.");
          }
          assert.deepEqual(capture.invocation, {
            idempotencyKey: `mcp:${entry.canonicalName}:stable-slice-${entry.executor}`,
            sourceTransport: "workflow-mcp",
            actorType: "agent",
            traceId: `stable-slice-${entry.executor}`,
          });
        }
      }
    } finally {
      if (prevModule === undefined) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevCapture === undefined) {
        delete process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = prevCapture;
      }
      if (prevReopenCapture === undefined) {
        delete process.env.GSD_TEST_TASK_REOPEN_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_TASK_REOPEN_CAPTURE_PATH = prevReopenCapture;
      }
      if (prevResumeCapture === undefined) {
        delete process.env.GSD_TEST_TASK_RECOVERY_RESUME_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_TASK_RECOVERY_RESUME_CAPTURE_PATH = prevResumeCapture;
      }
      if (prevSliceCapture === undefined) {
        delete process.env.GSD_TEST_SLICE_LIFECYCLE_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_SLICE_LIFECYCLE_CAPTURE_PATH = prevSliceCapture;
      }
      if (prevMilestoneCapture === undefined) {
        delete process.env.GSD_TEST_MILESTONE_LIFECYCLE_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_MILESTONE_LIFECYCLE_CAPTURE_PATH = prevMilestoneCapture;
      }
      if (prevValidationCapture === undefined) {
        delete process.env.GSD_TEST_MILESTONE_VALIDATION_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_MILESTONE_VALIDATION_CAPTURE_PATH = prevValidationCapture;
      }
      cleanup(base);
    }
  });

  it("gsd_complete_task alias delegates to gsd_task_complete behavior", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S02"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M002", "slices", "S02", "S02-PLAN.md"),
        "# S02\n\n- [ ] **T02: Demo** `est:5m`\n",
      );
      claimCanonicalTaskAuthority(base, { milestoneId: "M002", sliceId: "S02", taskId: "T02" });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_task");
      assert.ok(aliasTool, "task completion alias should be registered");

      const result = await aliasTool!.handler({
        projectDir: base,
        taskId: "T02",
        sliceId: "S02",
        milestoneId: "M002",
        oneLiner: "Completed task via alias",
        narrative: "Did the work through alias",
        verification: "npm test",
      });

      assert.match((result as any).content[0].text as string, /Staged task T02; awaiting host verification/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M002", "slices", "S02", "tasks", "T02-SUMMARY.md")),
        "alias should write task summary to disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone and gsd_plan_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");

      const milestoneResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Workflow MCP planning",
        vision: "Plan milestone over MCP.",
        slices: [
          {
            sliceId: "S01",
            title: "Bridge planning",
            risk: "medium",
            depends: [],
            demo: "Milestone plan persists through MCP.",
            goal: "Persist roadmap state.",
            successCriteria: "ROADMAP.md renders from DB.",
            proofLevel: "integration",
            integrationClosure: "Prompts and MCP call the same handler.",
            observabilityImpact: "Executor tests cover output paths.",
          },
        ],
      });
      assert.match((milestoneResult as any).content[0].text as string, /Planned milestone M001/);

      const sliceResult = await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan over MCP.",
        tasks: [
          {
            taskId: "T01",
            title: "Add planning bridge",
            description: "Implement the shared executor path.",
            estimate: "15m",
            files: ["src/resources/extensions/gsd/tools/workflow-tool-executors.ts"],
            verify: "node --test",
            inputs: [],
            expectedOutput: ["src/bridge-status.md"],
            requiredWorkflowTools: [],
          },
        ],
      });
      assert.match((sliceResult as any).content[0].text as string, /Planned slice S01/);
      // Flat-phase: M001 "Workflow MCP planning" → phases/01-workflow-mcp-planning/, S01 → 01-01-PLAN.md
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "01-workflow-mcp-planning", "01-01-PLAN.md")),
        "slice plan should exist on disk",
      );
      const incompatible = await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Must fail before assigning lifecycle work to execution.",
        tasks: [{
          taskId: "T01",
          title: "Invalid lifecycle task",
          description: "Terminalize a requirement during execution.",
          estimate: "5m",
          files: [],
          verify: "node --test",
          inputs: [],
          expectedOutput: [],
          requiredWorkflowTools: ["gsd_requirement_update"],
        }],
      });
      assert.equal((incompatible as any).isError, true);
      assert.match((incompatible as any).content[0].text as string, /gsd_requirement_update.*execute-task/i);
      assert.deepEqual(
        _getAdapter()!.prepare("SELECT title, required_workflow_tools FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get(),
        { title: "Add planning bridge", required_workflow_tools: "[]" },
        "rejected lifecycle work must not mutate the persisted task",
      );
      // Flat-phase: tasks are checkboxes inside the slice plan file, no per-task T01-PLAN.md
    } finally {
      cleanup(base);
    }
  });

  it("planning mutations reject requests without replay-stable private metadata", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((tool) => tool.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      const result = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Replay identity required",
        vision: "Refuse planning that cannot converge after a lost response.",
        slices: [{
          sliceId: "S01",
          title: "Identity boundary",
          risk: "low",
          depends: [],
          demo: "The MCP boundary rejects an unsafe mutation.",
          goal: "Require a stable private invocation key.",
          successCriteria: "No planning state changes without replay identity.",
          proofLevel: "integration",
          integrationClosure: "The registered MCP handler enforces the boundary.",
          observabilityImpact: "The rejection is returned before a Domain Operation starts.",
        }],
      }, { _meta: { "io.opengsd/idempotency-key": "   " } });
      assertToolError(result, /replay-stable.*io\.opengsd\/idempotency-key/i);
      assert.equal(existsSync(join(base, ".gsd", "gsd.db")), false);
    } finally {
      cleanup(base);
    }
  });

  it("MCP canonical and alias retries share one explicit planning identity", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const canonical = server.tools.find((tool) => tool.name === "gsd_plan_milestone");
      const alias = server.tools.find((tool) => tool.name === "gsd_milestone_plan");
      assert.ok(canonical);
      assert.ok(alias);
      const args = {
        projectDir: base,
        milestoneId: "M001",
        title: "Stable MCP identity",
        vision: "Replay canonical and alias calls as one Domain Operation.",
        slices: [{
          sliceId: "S01",
          title: "MCP replay",
          risk: "low",
          depends: [],
          demo: "Both names return the same committed plan.",
          goal: "Normalize aliases before applying identity.",
          successCriteria: "One operation is committed.",
          proofLevel: "integration",
          integrationClosure: "The MCP boundary passes the same private key.",
          observabilityImpact: "The operation ledger proves one commit.",
        }],
      };
      const metadata = {
        requestId: "request-one",
        sessionId: "session-one",
        _meta: { "io.opengsd/idempotency-key": "stable-retry" },
      };

      const first = await canonical.handler(args, metadata);
      const replay = await alias.handler(args, {
        ...metadata,
        requestId: "request-two",
        sessionId: "session-two",
      });

      assert.deepEqual(replay, first);
      const operations = _getAdapter()!.prepare(`
        SELECT idempotency_key, source_transport FROM workflow_operations
      `).all();
      assert.deepEqual(operations, [{
        idempotency_key: "mcp:gsd_plan_milestone:stable-retry",
        source_transport: "workflow-mcp",
      }]);
    } finally {
      cleanup(base);
    }
  });

  it("other workflow tools reject empty required strings at the schema layer", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);

      const expectRejection = async (toolName: string, args: Record<string, unknown>, expectedField: string) => {
        const tool = server.tools.find((t) => t.name === toolName);
        assert.ok(tool, `${toolName} should be registered`);
        const result = await tool!.handler(args);
        assertToolError(result, expectedField);
      };

      // Empty sliceId top-level
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "",
        goal: "Persist slice plan.",
        tasks: [],
      }, "sliceId");

      // Empty task verify inside tasks array
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts"],
            verify: "",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"],
            requiredWorkflowTools: [],
          },
        ],
      }, "verify");

      // Empty element inside files[] array
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts", "   "],
            verify: "node --test",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"],
            requiredWorkflowTools: [],
          },
        ],
      }, "files");

      // Empty milestoneId on gsd_plan_task
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: [],
        requiredWorkflowTools: [],
      }, "milestoneId");

      // Empty observabilityImpact explicitly rejected (optional-but-non-empty)
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: [],
        requiredWorkflowTools: [],
        observabilityImpact: "   ",
      }, "observabilityImpact");

      // Empty assessment on gsd_reassess_roadmap
      await expectRejection("gsd_reassess_roadmap", {
        projectDir: base,
        milestoneId: "M001",
        completedSliceId: "S01",
        verdict: "roadmap-confirmed",
        assessment: "",
        sliceChanges: { modified: [], added: [], removed: [] },
      }, "assessment");

      // Empty keyRisks[i].risk on gsd_plan_milestone top-level arrays
      await expectRejection("gsd_plan_milestone", {
        projectDir: base,
        milestoneId: "M001",
        title: "T",
        vision: "V",
        slices: [],
        keyRisks: [{ risk: "", whyItMatters: "because." }],
      }, "risk");

      // Empty blockerDescription on gsd_replan_slice
      await expectRejection("gsd_replan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        blockerTaskId: "T01",
        blockerDescription: "",
        whatChanged: "x",
        updatedTasks: [],
        removedTaskIds: [],
      }, "blockerDescription");

      // Empty milestoneId on gsd_task_complete
      await expectRejection("gsd_task_complete", {
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "",
        oneLiner: "ol",
        narrative: "n",
        verification: "v",
      }, "milestoneId");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone rejects empty slice fields up front with all violations", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      const result = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Workflow MCP planning",
        vision: "Plan milestone over MCP.",
        slices: [
          {
            sliceId: "S01",
            title: "Bridge planning",
            risk: "medium",
            depends: [],
            demo: "Milestone plan persists through MCP.",
            goal: "Persist roadmap state.",
            successCriteria: "",
            proofLevel: "",
            integrationClosure: "   ",
            observabilityImpact: "",
          },
        ],
      });
      const message = assertToolError(result, "successCriteria");
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          message.includes(field),
          `parse error should mention ${field}, got: ${message}`,
        );
      }
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone rejects a full slice with missing heavy fields via a behavioral round-trip", async () => {
    // Behavioral guard for the full-vs-sketch conditional. The original
    // regression (invisible "required unless isSketch" requirement) is
    // surfaced to users through two distinct runtime channels:
    //   1. A parse-time rejection when the tool is called with empty heavy
    //      fields on a non-sketch slice (no isSketch=true).
    //   2. An acceptance when isSketch=true + sketchScope is supplied and
    //      heavy fields are omitted.
    // Both arms are exercised below against the live handler — any schema
    // refactor that preserves the user-observable contract (rejection +
    // acceptance) passes, and any refactor that breaks the contract
    // fails, regardless of whether internal `.describe()` prose changes.
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      // Arm 1: full slice (isSketch omitted) with the heavy fields missing
      // must reject and name ALL four fields so the agent can self-correct.
      const fullResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Full slice path",
        vision: "Behavioral test for isSketch conditional.",
        slices: [
          {
            sliceId: "S01",
            title: "Heavy slice",
            risk: "medium",
            depends: [],
            demo: "Demo.",
            goal: "Goal.",
            // heavy fields intentionally omitted
          },
        ],
      });
      const fullMsg = assertToolError(fullResult, "successCriteria");
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          fullMsg.includes(field),
          `rejection must name ${field} so agents can recover without a second round-trip; got: ${fullMsg}`,
        );
      }

      // Arm 2: sketch slice (isSketch=true + sketchScope) with heavy fields
      // omitted must be accepted — proving the conditional is live. Assert
      // success directly rather than just checking a thrown message omits
      // the heavy-field names: a generic failure would otherwise silently
      // pass this arm.
      const sketchResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M002",
        title: "Sketch slice path",
        vision: "Behavioral test for isSketch conditional.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "medium",
            depends: [],
            demo: "Demo.",
            goal: "Goal.",
            isSketch: true,
            sketchScope: "Two-sentence scope. Boundary defined.",
          },
        ],
      });
      assert.match(
        (sketchResult as any).content[0].text as string,
        /Planned milestone M002/,
        "sketch slice with isSketch=true must be accepted by the handler",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone requires sketchScope when isSketch=true and skips heavy fields", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      const emptySketchResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Sketch milestone",
        vision: "Sketch first, refine later.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "low",
            depends: [],
            demo: "Stub demo.",
            goal: "Stub goal.",
            isSketch: true,
            sketchScope: "",
          },
        ],
      });
      assertToolError(emptySketchResult, "sketchScope");

      const sketchResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Sketch milestone",
        vision: "Sketch first, refine later.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "low",
            depends: [],
            demo: "Stub demo.",
            goal: "Stub goal.",
            isSketch: true,
            sketchScope: "Defer heavy planning fields until refine-slice.",
          },
        ],
      });
      assert.match((sketchResult as any).content[0].text as string, /Planned milestone M001/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_requirement_save opens the DB before inline requirement writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const requirementTool = server.tools.find((t) => t.name === "gsd_requirement_save");
      assert.ok(requirementTool, "requirement tool should be registered");

      closeDatabase();

      const result = await requirementTool!.handler({
        projectDir: base,
        class: "operability",
        description: "Inline MCP requirement save regression",
        why: "Reproduce missing ensureDbOpen in workflow-tools",
        source: "user",
        status: "active",
        primary_owner: "M010/S10",
        validation: "n/a",
      });

      assert.match((result as any).content[0].text as string, /Saved requirement R\d+/);
      assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), "REQUIREMENTS.md should be written to disk");
      const row = _getAdapter()!
        .prepare("SELECT id, class, description FROM requirements WHERE description = ?")
        .get("Inline MCP requirement save regression") as Record<string, unknown> | undefined;
      assert.ok(row, "requirement should be written to the database");
      assert.equal(row["class"], "operability");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_milestone_generate_id skips DB-only queued milestone rows", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_milestone_generate_id");
      assert.ok(tool, "milestone ID tool should be registered");

      const first = await tool!.handler({ projectDir: base });
      assert.equal((first as any).content[0].text, "M001");
      assert.ok(!existsSync(join(base, ".gsd", "milestones", "M001")), "ID generation should not create a milestone dir");

      closeDatabase();

      const second = await tool!.handler({ projectDir: base });
      assert.equal((second as any).content[0].text, "M002");

      const rows = _getAdapter()!
        .prepare("SELECT id FROM milestones ORDER BY id")
        .all() as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map((row) => row["id"]), ["M001", "M002"]);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_task reopens the DB before inline task planning writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_plan_task");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task planning tool should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        title: "Inline task planning DB reopen",
        vision: "Seed a slice, close the DB, then plan another task inline.",
        slices: [
          {
            sliceId: "S10",
            title: "Inline task planning",
            risk: "medium",
            depends: [],
            demo: "Inline gsd_plan_task reopens the DB after it was closed.",
            goal: "Preserve MCP task planning after the DB adapter is closed.",
            successCriteria: "The second task plan persists after a closed DB is reopened.",
            proofLevel: "integration",
            integrationClosure: "The inline MCP handler reopens the DB before planning.",
            observabilityImpact: "workflow-tools MCP tests cover the inline reopen path.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        goal: "Create the initial slice plan before closing the DB.",
        tasks: [
          {
            taskId: "T10",
            title: "Seed existing task",
            description: "Create the initial task plan before closing the DB.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M010-ROADMAP.md"],
            expectedOutput: ["T10-PLAN.md"],
            requiredWorkflowTools: [],
          },
        ],
      });

      closeDatabase();

      const result = await taskTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        taskId: "T11",
        title: "Reopen and plan",
        description: "Exercise the inline plan-task path after the DB was closed.",
        estimate: "5m",
        files: ["packages/mcp-server/src/workflow-tools.ts"],
        verify: "node --test",
        inputs: ["M010-ROADMAP.md", "S10-PLAN.md"],
        expectedOutput: ["T11-PLAN.md"],
        requiredWorkflowTools: [],
      });

      assert.match((result as any).content[0].text as string, /Planned task T11/);
      const slicePlanPath = join(base, ".gsd", "phases", "10-inline-task-planning-db-reopen", "10-10-PLAN.md");
      assert.ok(
        existsSync(slicePlanPath),
        "slice plan should be written after reopening the DB",
      );
      assert.match(readFileSync(slicePlanPath, "utf-8"), /T11/);
      assert.equal(
        existsSync(join(base, ".gsd", "phases", "10-inline-task-planning-db-reopen", "T11-PLAN.md")),
        false,
        "flat-phase task planning should not create standalone task PLAN files",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_replan_slice and gsd_slice_replan work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_replan_slice");
      const aliasTool = server.tools.find((t) => t.name === "gsd_slice_replan");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(canonicalTool, "slice replanning tool should be registered");
      assert.ok(aliasTool, "slice replanning alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        title: "Slice replanning",
        vision: "Drive replan parity over MCP.",
        slices: [
          {
            sliceId: "S09",
            title: "Replan slice",
            risk: "medium",
            depends: [],
            demo: "Slice replans after a blocker task completes.",
            goal: "Prepare replan state.",
            successCriteria: "Plan and replan artifacts update over MCP.",
            proofLevel: "integration",
            integrationClosure: "Replan uses the shared executor path.",
            observabilityImpact: "Tests cover replan artifacts.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        goal: "Plan a slice that will be replanned.",
        tasks: [
          {
            taskId: "T09",
            title: "Blocker task",
            description: "Finish the blocker-discovery task.",
            estimate: "5m",
            files: ["src/blocker.ts"],
            verify: "node --test",
            inputs: ["M099-ROADMAP.md"],
            expectedOutput: ["T09-SUMMARY.md"],
            requiredWorkflowTools: [],
          },
          {
            taskId: "T10",
            title: "Pending task",
            description: "Original follow-up task.",
            estimate: "10m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
            requiredWorkflowTools: [],
          },
        ],
      });
      seedCompletedTaskState({ milestoneId: "M099", sliceId: "S09", taskId: "T09" });

      const canonicalResult = await canonicalTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Original approach is no longer viable.",
        whatChanged: "Updated the remaining task and added remediation work.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated)",
            description: "Updated follow-up task after replanning.",
            estimate: "15m",
            files: ["src/pending.ts", "src/replanned.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
            requiredWorkflowTools: [],
          },
          {
            taskId: "T11",
            title: "Remediation task",
            description: "New task introduced by the replan.",
            estimate: "20m",
            files: ["src/remediation.ts"],
            verify: "node --test",
            inputs: ["S09-REPLAN.md"],
            expectedOutput: ["Remediation patch"],
            requiredWorkflowTools: [],
          },
        ],
        removedTaskIds: [],
      });
      assert.match((canonicalResult as any).content[0].text as string, /Replanned slice S09/);

      const aliasResult = await aliasTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Alias path confirms the same replan flow.",
        whatChanged: "Removed the remediation task after the alias check.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated again)",
            description: "Alias adjusted the remaining pending task.",
            estimate: "12m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
            requiredWorkflowTools: [],
          },
        ],
        removedTaskIds: ["T11"],
      });
      assert.match((aliasResult as any).content[0].text as string, /Replanned slice S09/);
      // Flat-phase: M099 "Slice replanning" → phases/99-slice-replanning/, S09 → 99-09-*
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "99-slice-replanning", "99-09-REPLAN.md")),
        "replan artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "99-slice-replanning", "99-09-PLAN.md")),
        "updated plan should exist on disk",
      );
      const removedTask = _getAdapter()!.prepare(
        "SELECT id, status FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      ).get("M099", "S09", "T11");
      assert.deepEqual(removedTask, { id: "T11", status: "skipped" }, "alias should durably cancel the replanned task");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_slice_complete and gsd_complete_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(canonicalTool, "slice completion tool should be registered");
      assert.ok(aliasTool, "slice completion alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        title: "Demo milestone",
        vision: "Prepare canonical slice completion state.",
        slices: [
          {
            sliceId: "S03",
            title: "Demo Slice",
            risk: "medium",
            depends: [],
            demo: "Canonical slice completes through MCP.",
            goal: "Seed workflow state.",
            successCriteria: "Slice summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Planning and completion share the MCP bridge.",
            observabilityImpact: "Workflow tests cover canonical completion.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        goal: "Complete canonical slice over MCP.",
        tasks: [
          {
            taskId: "T03",
            title: "Canonical task",
            description: "Seed a completed task for slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M003-ROADMAP.md"],
            expectedOutput: ["S03-SUMMARY.md", "S03-UAT.md"],
            requiredWorkflowTools: [],
          },
        ],
      });
      seedCompletedTaskState({ milestoneId: "M003", sliceId: "S03", taskId: "T03" });

      const canonicalResult = await canonicalTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        sliceTitle: "Demo Slice",
        oneLiner: "Completed canonical slice",
        narrative: "Did the slice work",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS",
      });
      assert.match((canonicalResult as any).content[0].text as string, /Completed slice S03/);

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        title: "Alias milestone",
        vision: "Prepare alias slice completion state.",
        slices: [
          {
            sliceId: "S04",
            title: "Alias Slice",
            risk: "medium",
            depends: [],
            demo: "Alias slice completes through MCP.",
            goal: "Seed alias workflow state.",
            successCriteria: "Alias summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Alias reaches the shared slice executor.",
            observabilityImpact: "Workflow tests cover alias completion.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        goal: "Complete alias slice over MCP.",
        tasks: [
          {
            taskId: "T04",
            title: "Alias task",
            description: "Seed a completed task for alias slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M004-ROADMAP.md"],
            expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"],
            requiredWorkflowTools: [],
          },
        ],
      });
      seedCompletedTaskState({ milestoneId: "M004", sliceId: "S04", taskId: "T04" });

      const aliasResult = await aliasTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        sliceTitle: "Alias Slice",
        oneLiner: "Completed alias slice",
        narrative: "Did the slice work via alias",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS",
      });
      assert.match((aliasResult as any).content[0].text as string, /Completed slice S04/);
      // Flat-phase: M004 "Alias milestone" → phases/04-alias-milestone/, S04 → 04-04-*
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "04-alias-milestone", "04-04-SUMMARY.md")),
        "alias should write slice summary to disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "04-alias-milestone", "04-04-UAT.md")),
        "alias should write slice UAT to disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_slice_complete accepts omitted verification at the schema layer", () => {
    const parsed = _parseWorkflowArgsForTest(_sliceCompleteSchemaForTest, {
      projectDir: join(tmpdir(), "gsd-slice-complete-schema"),
      sliceId: "S01",
      milestoneId: "M001",
      sliceTitle: "Test slice",
      oneLiner: "Did the thing",
      narrative: "We did it step by step.",
      uatContent: "## UAT\n- [x] Works",
    });
    assert.equal(parsed.verification, undefined);
  });

  it("gsd_validate_milestone and gsd_milestone_complete work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(join(base, "source.ts"), "export const source = 'validated';\n");
      execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
      execFileSync("git", ["add", "source.ts"], { cwd: base });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: base, stdio: "ignore" });
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const validateTool = server.tools.find((t) => t.name === "gsd_validate_milestone");
      const completeMilestoneAlias = server.tools.find((t) => t.name === "gsd_milestone_complete");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(validateTool, "milestone validation tool should be registered");
      assert.ok(completeMilestoneAlias, "milestone completion alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        vision: "Drive validation and completion over MCP.",
        slices: [
          {
            sliceId: "S05",
            title: "Lifecycle slice",
            risk: "medium",
            depends: [],
            demo: "Milestone can validate and complete.",
            goal: "Seed milestone completion state.",
            successCriteria: "Summary and validation artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Lifecycle tools share the MCP bridge.",
            observabilityImpact: "Tests cover milestone end-to-end behavior.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        goal: "Prepare a complete milestone.",
        tasks: [
          {
            taskId: "T05",
            title: "Lifecycle task",
            description: "Seed a fully completed slice.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M005-ROADMAP.md"],
            expectedOutput: ["M005-VALIDATION.md", "M005-SUMMARY.md"],
            requiredWorkflowTools: [],
          },
        ],
      });
      seedCompletedTaskState({ milestoneId: "M005", sliceId: "S05", taskId: "T05" });
      await completeSliceTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        sliceTitle: "Lifecycle Slice",
        oneLiner: "Completed lifecycle slice",
        narrative: "Closed the milestone slice.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS",
      });

      const validationResult = await validateTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        verdict: "pass",
        remediationRound: 0,
        successCriteriaChecklist: "- [x] Lifecycle verified",
        sliceDeliveryAudit: "| Slice | Verdict |\n| --- | --- |\n| S05 | pass |",
        crossSliceIntegration: "No cross-slice mismatches found.",
        requirementCoverage: "No requirement gaps remain.",
        verdictRationale: "The milestone delivered its scope.",
      }, {
        _meta: { "io.opengsd/idempotency-key": "m005-validation" },
      });
      assert.match((validationResult as any).content[0].text as string, /Validated milestone M005/);
      const validationDetails = (validationResult as any).structuredContent;
      assert.match(validationDetails.operationId, /\S/);
      assert.equal(typeof validationDetails.resultingRevision, "number");
      assert.match(validationDetails.attemptId, /\S/);
      assert.match(validationDetails.resultId, /\S/);

      const completionResult = await completeMilestoneAlias!.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        oneLiner: "Milestone closed successfully",
        narrative: "Validation passed and all slices were complete.",
        verificationPassed: true,
      });
      assert.match((completionResult as any).content[0].text as string, /Completed milestone M005/);
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "05-milestone-lifecycle", "05-VALIDATION.md")),
        "validation artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "05-milestone-lifecycle", "05-SUMMARY.md")),
        "milestone summary should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_reassess_roadmap, gsd_roadmap_reassess, and gsd_save_gate_result work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const reassessTool = server.tools.find((t) => t.name === "gsd_reassess_roadmap");
      const reassessAlias = server.tools.find((t) => t.name === "gsd_roadmap_reassess");
      const gateTool = server.tools.find((t) => t.name === "gsd_save_gate_result");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(reassessTool, "roadmap reassessment tool should be registered");
      assert.ok(reassessAlias, "roadmap reassessment alias should be registered");
      assert.ok(gateTool, "gate result tool should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        title: "Roadmap reassessment",
        vision: "Drive gate results and reassessment over MCP.",
        slices: [
          {
            sliceId: "S06",
            title: "Completed slice",
            risk: "medium",
            depends: [],
            demo: "Completed slice triggers reassessment.",
            goal: "Seed reassessment state.",
            successCriteria: "Assessment and roadmap artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Roadmap updates share the MCP bridge.",
            observabilityImpact: "Tests cover reassessment behavior.",
          },
          {
            sliceId: "S07",
            title: "Follow-up slice",
            risk: "low",
            depends: ["S06"],
            demo: "Follow-up slice remains pending.",
            goal: "Leave room for roadmap edits.",
            successCriteria: "Roadmap mutation succeeds.",
            proofLevel: "integration",
            integrationClosure: "Pending slice can be modified after reassessment.",
            observabilityImpact: "Tests observe roadmap mutation output.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        goal: "Complete the first slice.",
        tasks: [
          {
            taskId: "T06",
            title: "Seed completed slice",
            description: "Prepare gate and reassessment state.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: [],
            expectedOutput: ["src/gate-seed.md"],
            requiredWorkflowTools: [],
          },
        ],
      });

      const gateResult = await gateTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        gateId: "Q3",
        verdict: "pass",
        rationale: "Threat surface is covered.",
        findings: "No new attack surface was introduced.",
      });
      assert.match((gateResult as any).content[0].text as string, /Gate Q3 result saved/);
      // #4472: executor `details` must be adapted to MCP `structuredContent`
      // so it survives the protocol transport intact. Asserting property
      // *absence* rather than `=== undefined` so a future regression that
      // explicitly sets `details: undefined` (rather than removing it) still
      // fails this contract test.
      assert.equal(
        Object.prototype.hasOwnProperty.call(gateResult, "details"),
        false,
        "executor `details` field must be stripped from MCP tool result",
      );
      assert.deepEqual(
        (gateResult as any).structuredContent,
        { operation: "save_gate_result", gateId: "Q3", verdict: "pass" },
        "executor details must be forwarded on the MCP `structuredContent` channel",
      );
      const gateRows = _getAdapter()!.prepare(
        "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?",
      ).all("M006", "S06", "Q3") as Array<Record<string, unknown>>;
      assert.equal(gateRows.length, 1);
      assert.equal(gateRows[0]["status"], "complete");
      assert.equal(gateRows[0]["verdict"], "pass");

      const gateInputSchema = z.object(gateTool!.params as any);
      const inferredGateArgs = gateInputSchema.parse({
        projectDir: base,
        gateId: "Q4",
        verdict: "omitted",
        rationale: "No existing requirements are touched by this slice.",
        findings: "",
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(inferredGateArgs, "milestoneId"),
        false,
        "MCP input schema must allow gate result calls before milestoneId is inferred",
      );
      const inferredGateResult = await gateTool!.handler(inferredGateArgs);
      assert.match((inferredGateResult as any).content[0].text as string, /Gate Q4 result saved/);
      const inferredGateRows = _getAdapter()!.prepare(
        "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?",
      ).all("M006", "S06", "Q4") as Array<Record<string, unknown>>;
      assert.equal(inferredGateRows.length, 1);
      assert.equal(inferredGateRows[0]["status"], "complete");
      assert.equal(inferredGateRows[0]["verdict"], "omitted");

      seedCompletedTaskState({ milestoneId: "M006", sliceId: "S06", taskId: "T06" });
      await completeSliceTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        sliceTitle: "Completed slice",
        oneLiner: "Completed reassessment slice",
        narrative: "Closed the completed slice before reassessment.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS",
      });

      const reassessResult = await reassessTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-adjusted",
        assessment: "Insert remediation work after the completed slice.",
        sliceChanges: {
          modified: [
            {
              sliceId: "S07",
              title: "Follow-up slice (adjusted)",
              risk: "medium",
              depends: ["S06"],
              demo: "Adjusted demo",
            },
          ],
          added: [
            {
              sliceId: "S08",
              title: "Remediation slice",
              risk: "high",
              depends: ["S07"],
              demo: "Remediation demo",
            },
          ],
          removed: [],
        },
        metadataCorrections: {
          milestone: {
            successCriteria: ["Corrected runtime acceptance evidence is durable."],
            verificationContract: "Use the corrected runtime evidence contract.",
            requirementCoverage: "R006 remains covered by completed S06 evidence.",
            boundaryMapMarkdown: "S06 -> corrected runtime evidence",
          },
          completedSlices: [{
            sliceId: "S06",
            demo: "Completed S06 demonstrates the corrected acceptance policy.",
            successCriteria: "Corrected runtime evidence is recorded.",
          }],
        },
      });
      assert.match((reassessResult as any).content[0].text as string, /Reassessed roadmap for milestone M006 after S06/);
      assert.deepEqual(
        _getAdapter()!.prepare("SELECT status, success_criteria, requirement_coverage, boundary_map_markdown FROM milestones WHERE id = 'M006'").get(),
        {
          status: "active",
          success_criteria: '["Corrected runtime acceptance evidence is durable."]',
          requirement_coverage: "R006 remains covered by completed S06 evidence.",
          boundary_map_markdown: "S06 -> corrected runtime evidence",
        },
      );
      assert.deepEqual(
        _getAdapter()!.prepare("SELECT status, demo, success_criteria FROM slices WHERE milestone_id = 'M006' AND id = 'S06'").get(),
        {
          status: "complete",
          demo: "Completed S06 demonstrates the corrected acceptance policy.",
          success_criteria: "Corrected runtime evidence is recorded.",
        },
      );
      assert.equal(
        _getAdapter()!.prepare("SELECT status FROM tasks WHERE milestone_id = 'M006' AND slice_id = 'S06' AND id = 'T06'").get()?.["status"],
        "complete",
        "metadata correction must preserve completed task status",
      );

      const reassessAliasResult = await reassessAlias!.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-confirmed",
        assessment: "No further changes needed after the first reassessment.",
        sliceChanges: {
          modified: [],
          added: [],
          removed: [],
        },
      });
      assert.match((reassessAliasResult as any).content[0].text as string, /Reassessed roadmap for milestone M006 after S06/);
      // Flat-phase roadmap reassessments are milestone-level artifacts.
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "06-roadmap-reassessment", "06-ROADMAP-ASSESSMENT.md")),
        "assessment artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "phases", "06-roadmap-reassessment", "06-ROADMAP.md")),
        "roadmap artifact should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });
});

describe("URL scheme regex — Windows drive letter safety", () => {
  // This is the regex used in getWriteGateModuleCandidates() and
  // getWorkflowExecutorModuleCandidates() to reject non-file URL schemes.
  // It must NOT match single-letter Windows drive prefixes (C:, D:, etc.).
  const urlSchemeRegex = /^[a-z]{2,}:/i;

  it("rejects multi-letter URL schemes", () => {
    assert.ok(urlSchemeRegex.test("http://example.com"), "http: should match");
    assert.ok(urlSchemeRegex.test("https://example.com"), "https: should match");
    assert.ok(urlSchemeRegex.test("ftp://files.example.com"), "ftp: should match");
    assert.ok(urlSchemeRegex.test("file:///C:/Users"), "file: should match");
    assert.ok(urlSchemeRegex.test("node:fs"), "node: should match");
  });

  it("allows single-letter Windows drive prefixes", () => {
    assert.ok(!urlSchemeRegex.test("C:\\Users\\user\\project"), "C:\\ should not match");
    assert.ok(!urlSchemeRegex.test("D:\\other\\path"), "D:\\ should not match");
    assert.ok(!urlSchemeRegex.test("c:\\lowercase\\drive"), "c:\\ should not match");
    assert.ok(!urlSchemeRegex.test("E:/forward/slash/path"), "E:/ should not match");
  });

  it("allows bare filesystem paths", () => {
    assert.ok(!urlSchemeRegex.test("/usr/local/lib/module.js"), "unix absolute path should not match");
    assert.ok(!urlSchemeRegex.test("./relative/path.js"), "relative path should not match");
    assert.ok(!urlSchemeRegex.test("../parent/path.js"), "parent relative path should not match");
  });
});

// ---------------------------------------------------------------------------
// validateProjectDir — symlink containment hardening (#4476)
// ---------------------------------------------------------------------------
//
// The regression: a symlink inside the allowed root could point outside it,
// and a lexical-only containment check would happily admit the path. The fix
// realpath()s the candidate (and the allowed root) before checking
// containment, falling back to the lexical path only when the candidate
// itself does not exist (a legitimate brand-new-worktree case).

describe("validateProjectDir", () => {
  it("rejects a symlink inside the allowed root that points outside it", () => {
    const allowedRoot = makeTmpBase();
    const outside = makeTmpBase();
    const linkInside = join(allowedRoot, "escape-link");
    symlinkSync(outside, linkInside, "dir");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      assert.throws(
        () => validateProjectDir(linkInside),
        /configured workflow project root/,
        "symlink-to-outside must not bypass the containment check",
      );
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(outside);
    }
  });

  it("accepts a non-existent path inside the allowed root (new worktree case)", () => {
    const allowedRoot = makeTmpBase();
    // Use the realpath form so that on platforms where /tmp resolves through a
    // symlink (macOS /var → /private/var) the lexical fallback for ENOENT
    // candidates still lines up with the allowed root.
    const canonicalRoot = realpathSync(allowedRoot);
    const futureWorktree = join(canonicalRoot, "worktrees", "M999-not-yet-created");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = canonicalRoot;
      const result = validateProjectDir(futureWorktree);
      assert.equal(result, futureWorktree, "ENOENT should fall back to the lexical path, not throw");
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });

  it("accepts a real directory inside the allowed root", () => {
    const allowedRoot = makeTmpBase();
    const child = join(allowedRoot, "child");
    mkdirSync(child, { recursive: true });

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      const result = validateProjectDir(child);
      // realpath may canonicalize macOS /var → /private/var; assert it ends with our child segment.
      assert.ok(result.endsWith("child"), `expected resolved path to end with 'child', got ${result}`);
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });

  it("accepts a worktree under the allowed root external .gsd state target", () => {
    const allowedRoot = makeTmpBase();
    const externalState = makeTmpBase();
    const worktree = join(externalState, "worktrees", "M001");
    mkdirSync(worktree, { recursive: true });
    rmSync(join(allowedRoot, ".gsd"), { recursive: true, force: true });
    symlinkSync(externalState, join(allowedRoot, ".gsd"), "dir");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      const result = validateProjectDir(worktree);
      assert.equal(result, realpathSync(worktree));
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(externalState);
    }
  });

  it("rejects external-state sibling paths that only share a prefix", () => {
    const allowedRoot = makeTmpBase();
    const externalState = makeTmpBase();
    const sibling = `${externalState}-sibling`;
    const siblingWorktree = join(sibling, "worktrees", "M001");
    mkdirSync(siblingWorktree, { recursive: true });
    rmSync(join(allowedRoot, ".gsd"), { recursive: true, force: true });
    symlinkSync(externalState, join(allowedRoot, ".gsd"), "dir");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      assert.throws(
        () => validateProjectDir(siblingWorktree),
        /configured workflow project root/,
      );
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(externalState);
      cleanup(sibling);
    }
  });

  it("rejects relative paths", () => {
    assert.throws(
      () => validateProjectDir("relative/path"),
      /must be an absolute path/,
    );
  });

  it("mirrors gsd_decision_list rows into structuredContent (details is stripped over the wire)", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_decision_list");
      assert.ok(tool, "gsd_decision_list must be registered");

      openDatabase(join(base, ".gsd", "gsd.db"));
      createMemory({
        category: "architecture",
        content: "decision memory fixture",
        scope: "global",
        confidence: 0.85,
        structuredFields: {
          sourceDecisionId: "D001",
          when_context: "test",
          scope: "global",
          decision: "Mirror read payloads over MCP",
          choice: "structuredContent",
          rationale: "the details field is dropped by the MCP transport",
          made_by: "agent",
          revisable: "yes",
          superseded_by: null,
        },
      });

      const result = await tool.handler({ projectDir: base }) as {
        content?: Array<{ text?: string }>;
        structuredContent?: { count?: number; decisions?: Array<{ id?: string }> };
      };
      assert.match(result.content?.[0]?.text ?? "", /Found 1 decision/);
      assert.ok(result.structuredContent, "payload must ride on structuredContent");
      assert.equal(result.structuredContent.count, 1);
      assert.equal(result.structuredContent.decisions?.[0]?.id, "D001");
    } finally {
      cleanup(base);
    }
  });

  it("mirrors canonical read errors into structuredContent", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_decision_list");
      assert.ok(tool, "gsd_decision_list must be registered");

      const result = await tool.handler({ projectDir: base }) as {
        content?: Array<{ text?: string }>;
        structuredContent?: { error?: string };
      };
      assert.match(result.content?.[0]?.text ?? "", /Error/);
      assert.ok(result.structuredContent, "error details must ride on structuredContent");
      assert.equal(result.structuredContent.error, "db_unavailable");
    } finally {
      cleanup(base);
    }
  });
});

describe("readProjectProgressViaBridge", () => {
  it("serves each project's own state across back-to-back calls (no wrong-handle leakage)", async (t) => {
    const baseA = makeTmpBase();
    const baseB = makeTmpBase();
    t.after(() => cleanup(baseA));
    t.after(() => cleanup(baseB));
    openDatabase(join(baseA, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Project A milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "A slice", status: "complete", risk: "low", depends: [], sequence: 1 });
    closeDatabase();

    openDatabase(join(baseB, ".gsd", "gsd.db"));
    insertMilestone({ id: "M002", title: "Project B milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M002", title: "B slice", status: "complete", risk: "low", depends: [], sequence: 1 });
    closeDatabase();

    const a = await readProjectProgressViaBridge(baseA) as { activeMilestone?: { id?: string; title?: string } };
    assert.equal(a.activeMilestone?.id, "M001");
    assert.equal(a.activeMilestone?.title, "Project A milestone");

    const b = await readProjectProgressViaBridge(baseB) as { activeMilestone?: { id?: string; title?: string } };
    assert.equal(b.activeMilestone?.id, "M002");
    assert.equal(b.activeMilestone?.title, "Project B milestone");
  });

  it("returns null when the project DB is missing (no DB created as a read side effect)", async (t) => {
    const base = makeTmpBase();
    t.after(() => cleanup(base));
    const result = await readProjectProgressViaBridge(base);
    assert.equal(result, null);
    assert.equal(existsSync(join(base, ".gsd", "gsd.db")), false, "a read must not create gsd.db");
  });

  it("returns null without recreating a DB removed at the open boundary", async (t) => {
    const base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    t.after(() => cleanup(base));
    t.after(() => _setDatabaseOpenBeforeRawForTest(null));
    assert.equal(openDatabase(dbPath), true);
    closeDatabase();
    _setDatabaseOpenBeforeRawForTest((path) => rmSync(path, { force: true }));

    const result = await readProjectProgressViaBridge(base);

    assert.equal(result, null);
    assert.equal(existsSync(dbPath), false, "a read must not recreate gsd.db");
  });

  it("returns null when the existing project DB is locked", async (t) => {
    const base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    t.after(() => cleanup(base));
    t.after(() => _setStartupSchemaDetectionForTest(null));
    assert.equal(openDatabase(dbPath), true);
    closeDatabase();
    _setStartupSchemaDetectionForTest(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 });
    });

    const result = await readProjectProgressViaBridge(base);

    assert.equal(result, null);
    assert.equal(existsSync(dbPath), true, "a locked read must preserve the existing DB");
  });
});
