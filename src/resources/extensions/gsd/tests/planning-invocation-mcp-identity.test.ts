// Project/App: gsd-pi
// File Purpose: Contract tests for private MCP planning request identity across canonical and alias tools.

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

import { _getAdapter, closeDatabase, openDatabase } from "../mcp-bridge.ts";
import { invalidateAllCaches } from "../cache.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";

interface RequestExtra {
  requestId: string | number;
  sessionId?: string;
  _meta?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface RegisteredTool {
  name: string;
  params: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra?: RequestExtra) => Promise<Record<string, unknown>>;
}

function makeBase(): string {
  const base = join(tmpdir(), `gsd-planning-invocation-mcp-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "phases", "01-identity"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

function makeServer(): { tools: RegisteredTool[]; tool: (...args: any[]) => void } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    tool(name: string, _description: string, params: Record<string, unknown>, handler: RegisteredTool["handler"]) {
      tools.push({ name, params, handler });
    },
  };
}

function params(base: string, title = "MCP planning identity") {
  return {
    projectDir: base,
    milestoneId: "M001",
    title,
    vision: "Make MCP retries safe without exposing concurrency fields.",
    slices: [{
      sliceId: "S01",
      title: "Identity contract",
      risk: "low",
      depends: [],
      demo: "Canonical and alias retries share one operation.",
      goal: "Bind planning to MCP request identity.",
      successCriteria: "A repeated invocation cannot mutate planning twice.",
      proofLevel: "integration",
      integrationClosure: "The MCP handler forwards private request metadata.",
      observabilityImpact: "The workflow operation ledger exposes replay behavior.",
    }],
  };
}

function operations(): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db, "workflow MCP must open the database");
  return db.prepare(`
    SELECT operation_type, idempotency_key, expected_revision, resulting_revision
    FROM workflow_operations ORDER BY resulting_revision
  `).all();
}

function tool(server: ReturnType<typeof makeServer>, name: string): RegisteredTool {
  const registered = server.tools.find((candidate) => candidate.name === name);
  assert.ok(registered, `${name} must be registered`);
  return registered;
}

test("MCP canonical and alias planning calls replay one explicit private request key", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const canonical = tool(server, "gsd_plan_milestone");
    const alias = tool(server, "gsd_milestone_plan");
    assert.equal(canonical.params["idempotencyKey"], undefined);
    assert.equal(canonical.params["expectedRevision"], undefined);

    const meta = { "io.opengsd/idempotency-key": "planning-retry-42" };
    const first = await canonical.handler(params(base), {
      requestId: "rpc-canonical",
      sessionId: "session-a",
      _meta: { ...meta, "claudecode/toolUseId": "toolu-first" },
    });
    const replay = await alias.handler(params(base), {
      requestId: "rpc-alias",
      sessionId: "session-b",
      _meta: { ...meta, "claudecode/toolUseId": "toolu-second" },
    });

    assert.deepEqual(replay, first, "canonical and alias retries must preserve the public MCP result");
    assert.deepEqual(Object.keys(first).sort(), ["content", "structuredContent"]);
    assert.deepEqual(operations(), [{
      operation_type: "workflow.milestone.plan",
      idempotency_key: "mcp:gsd_plan_milestone:planning-retry-42",
      expected_revision: 0,
      resulting_revision: 1,
    }]);
  } finally {
    cleanup(base);
  }
});

test("MCP canonical and alias planning calls replay one Claude Code tool identity", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const canonical = tool(server, "gsd_plan_milestone");
    const alias = tool(server, "gsd_milestone_plan");
    const privateMeta = { "claudecode/toolUseId": "toolu_planning_retry_42" };

    const first = await canonical.handler(params(base), {
      requestId: "rpc-canonical",
      sessionId: "session-a",
      _meta: privateMeta,
    });
    const replay = await alias.handler(params(base), {
      requestId: "rpc-alias",
      sessionId: "session-b",
      _meta: privateMeta,
    });

    assert.deepEqual(replay, first, "Claude Code transport retries must preserve the public MCP result");
    assert.deepEqual(operations(), [{
      operation_type: "workflow.milestone.plan",
      idempotency_key: "mcp:gsd_plan_milestone:transport:claude-code:toolu_planning_retry_42",
      expected_revision: 0,
      resulting_revision: 1,
    }]);
  } finally {
    cleanup(base);
  }
});

test("MCP planning without explicit private request identity fails before mutation", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0], { advertiseAliases: false });
    const canonical = tool(server, "gsd_plan_milestone");

    const result = await canonical.handler(params(base), {
      requestId: 7,
      sessionId: "session-a",
    });

    assert.equal(result["isError"], true);
    assert.match(JSON.stringify(result), /requires replay-stable private request metadata/i);
    assert.deepEqual(operations(), []);
  } finally {
    cleanup(base);
  }
});

test("MCP planning rejects malformed explicit identity instead of falling back to Claude metadata", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0], { advertiseAliases: false });
    const canonical = tool(server, "gsd_plan_milestone");

    for (const explicitKey of ["   ", 42]) {
      const result = await canonical.handler(params(base), {
        requestId: `rpc-malformed-${String(explicitKey)}`,
        _meta: {
          "io.opengsd/idempotency-key": explicitKey,
          "claudecode/toolUseId": "toolu_valid_fallback",
        },
      });
      assert.equal(result["isError"], true);
      assert.match(JSON.stringify(result), /requires replay-stable private request metadata/i);
    }
    assert.deepEqual(operations(), []);
  } finally {
    cleanup(base);
  }
});

test("MCP planning reserves the Claude transport identity namespace", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0], { advertiseAliases: false });
    const canonical = tool(server, "gsd_plan_milestone");
    const result = await canonical.handler(params(base), {
      requestId: "rpc-reserved-namespace",
      _meta: {
        "io.opengsd/idempotency-key": "transport:claude-code:toolu_collision",
        "claudecode/toolUseId": "toolu_other_call",
      },
    });

    assert.equal(result["isError"], true);
    assert.match(JSON.stringify(result), /reserved.*Claude Code transport identity/i);
    assert.deepEqual(operations(), []);
  } finally {
    cleanup(base);
  }
});

test("MCP planning rejects changed payload under the same explicit private request key", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0], { advertiseAliases: false });
    const canonical = tool(server, "gsd_plan_milestone");
    const extra = {
      requestId: "rpc-conflict",
      sessionId: "session-a",
      _meta: { "io.opengsd/idempotency-key": "planning-conflict" },
    };

    const first = await canonical.handler(params(base), extra);
    assert.equal(first["isError"], undefined);
    const conflict = await canonical.handler(params(base, "Changed title must not commit"), extra);

    assert.equal(conflict["isError"], true);
    assert.match(JSON.stringify(conflict), /idempotency conflict/i);
    assert.equal(operations().length, 1);
  } finally {
    cleanup(base);
  }
});

test("MCP planning rejects changed payload under the same Claude Code tool identity", async () => {
  const base = makeBase();
  try {
    const server = makeServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0], { advertiseAliases: false });
    const canonical = tool(server, "gsd_plan_milestone");
    const extra = {
      requestId: "rpc-first",
      _meta: { "claudecode/toolUseId": "toolu_planning_conflict" },
    };

    const first = await canonical.handler(params(base), extra);
    assert.equal(first["isError"], undefined);
    const conflict = await canonical.handler(params(base, "Changed title must not commit"), {
      ...extra,
      requestId: "rpc-retry",
    });

    assert.equal(conflict["isError"], true);
    assert.match(JSON.stringify(conflict), /idempotency conflict/i);
    assert.equal(operations().length, 1);
  } finally {
    cleanup(base);
  }
});
