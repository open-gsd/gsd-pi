import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = new URL(
  "../tools/workflow-tool-executors.ts",
  import.meta.url,
).pathname;

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";
import {
  closeDatabase,
  getDb,
  openDatabase,
} from "../mcp-bridge.ts";
import { insertRequirement, insertMilestone, insertSlice, insertTask, getDbPath, getProjectAuthorityRow } from "../gsd-db.ts";
import { resolveProjectRootDbPath } from "../db-workspace.ts";
import { invalidateAllCaches } from "../cache.ts";

type NativeTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<Record<string, unknown>>;
};

type McpTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function makeProjectBase(prefix: string): string {
  const base = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(basePaths: string[]): void {
  try {
    closeDatabase();
  } catch {
    // noop
  }
  invalidateAllCaches();
  for (const base of basePaths) {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeNativeTools(): NativeTool[] {
  const tools: NativeTool[] = [];
  registerDbTools({
    registerTool(tool: NativeTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  return tools;
}

function makeMcpTools(): McpTool[] {
  const tools: McpTool[] = [];
  registerWorkflowTools({
    tool(name: string, _description: string, _params: Record<string, unknown>, handler: McpTool["handler"]) {
      tools.push({ name, handler });
    },
  } as Parameters<typeof registerWorkflowTools>[0]);
  return tools;
}

function nativeTool(tools: NativeTool[], name: string): NativeTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function mcpTool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function readError(result: Record<string, unknown>): string | undefined {
  // MCP transports drop the non-standard details field; errors ride on
  // structuredContent (see adaptExecutorResult). Native passes details through.
  const details = (result.structuredContent ?? result.details) as Record<string, unknown> | undefined;
  return typeof details?.error === "string" ? (details.error as string) : undefined;
}

function seedRequirement(id: string, description: string): void {
  insertRequirement({
    id,
    class: "core-capability",
    status: "active",
    description,
    why: "regression",
    source: "test",
    primary_owner: "M001/S01",
    supporting_slices: "",
    validation: "n/a",
    notes: "",
    full_content: `- [ ] **${id}: ${description}**`,
    superseded_by: null,
  });
}

test("canonical read tools: missing DB returns db_unavailable and does not create gsd.db", async () => {
  const base = makeProjectBase("gsd-canonical-missing-db");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();
    const dbPath = resolveProjectRootDbPath(base);

    assert.equal(existsSync(dbPath), false, "fixture starts without gsd.db");

    const nativeList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-1",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeList as { details?: Record<string, unknown> }).details;
    assert.equal(nativeDetails?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "native read should not create gsd.db as side effect");

    const mcpList = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });
    // MCP transports drop the non-standard details field; the error detail now
    // rides on structuredContent (see adaptExecutorResult).
    const mcpRecord = mcpList as { details?: Record<string, unknown>; structuredContent?: Record<string, unknown> };
    assert.equal(mcpRecord.structuredContent?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "MCP read should not create gsd.db as side effect");
  } finally {
    cleanup([base]);
  }
});

test("canonical read tools: reading project B does not switch global DB handle from project A", async () => {
  const baseA = makeProjectBase("gsd-canonical-global-a");
  const baseB = makeProjectBase("gsd-canonical-global-b");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(baseA));
    seedRequirement("R101", "A requirement");

    openDatabase(resolveProjectRootDbPath(baseB));
    seedRequirement("R201", "B requirement");

    openDatabase(resolveProjectRootDbPath(baseA));
    const before = getDbPath();
    assert.ok(before, "global DB should be open on project A");

    const nativeList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-2",
      { limit: 10 },
      undefined,
      undefined,
      { cwd: baseB },
    );
    const nativeCount = ((nativeList as { details?: { count?: number } }).details?.count ?? -1);
    assert.equal(nativeCount, 1, "native isolated read should query project B rows");
    assert.equal(getDbPath(), before, "native isolated read must keep global DB path unchanged");

    const mcpList = await mcpTool(mcp, "gsd_requirement_list").handler({
      projectDir: baseB,
      limit: 10,
    });
    const mcpCount = ((mcpList as { structuredContent?: { count?: number } }).structuredContent?.count ?? -1);
    assert.equal(mcpCount, 1, "MCP isolated read should query project B rows");
    assert.equal(getDbPath(), before, "MCP isolated read must keep global DB path unchanged");
  } finally {
    cleanup([baseA, baseB]);
  }
});

test("canonical read tools: query_error returns structured error and does not break subsequent isolated reads", async () => {
  const base = makeProjectBase("gsd-canonical-query-error");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();
    const dbPath = resolveProjectRootDbPath(base);

    openDatabase(dbPath);
    const db = (await import("../gsd-db.ts"))._getAdapter();
    assert.ok(db, "adapter should be available");
    db.prepare("DROP TABLE requirements").run();

    const nativeResult = await nativeTool(native, "gsd_requirement_list").execute(
      "call-3",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeResult as { details?: Record<string, unknown> }).details;
    assert.equal(nativeDetails?.error, "query_error");

    const mcpResult = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });
    const mcpDetails = (mcpResult as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.equal(mcpDetails?.error, "query_error");

    const isolated = (await import("../db-workspace.ts")).openWorkflowDatabaseIsolated(dbPath);
    assert.ok(isolated, "isolated open should still work after handled query_error");
    isolated?.close();
  } finally {
    cleanup([base]);
  }
});

test("canonical read tools: native and MCP read the same canonical requirement row", async () => {
  const base = makeProjectBase("gsd-canonical-parity");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    seedRequirement("R777", "Parity requirement");

    const nativeGet = await nativeTool(native, "gsd_requirement_get").execute(
      "call-4",
      { id: "R777" },
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeRequirement = (nativeGet as { details?: { requirement?: Record<string, unknown> } }).details?.requirement;

    const mcpGet = await mcpTool(mcp, "gsd_requirement_get").handler({
      projectDir: base,
      id: "R777",
    });
    const mcpRequirement = (mcpGet as { structuredContent?: { requirement?: Record<string, unknown> } }).structuredContent?.requirement;

    assert.equal(nativeRequirement?.id, "R777");
    assert.equal(mcpRequirement?.id, "R777");
    assert.equal(nativeRequirement?.description, "Parity requirement");
    assert.equal(mcpRequirement?.description, "Parity requirement");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: empty valid DB returns consistent empty list semantics", async () => {
  const base = makeProjectBase("gsd-canonical-empty-db");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    assert.ok(openDatabase(resolveProjectRootDbPath(base)), "fixture database should open successfully");

    const nativeList = await nativeTool(native, "gsd_decision_list").execute(
      "call-5",
      { limit: 20 },
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpList = await mcpTool(mcp, "gsd_decision_list").handler({
      projectDir: base,
      limit: 20,
    });

    const nativeDetails = nativeList.details as { count?: number; error?: string } | undefined;
    const mcpDetails = mcpList.structuredContent as { count?: number; error?: string } | undefined;

    assert.equal(nativeDetails?.error, undefined);
    assert.equal(mcpDetails?.error, undefined);
    assert.equal(nativeDetails?.count, 0);
    assert.equal(mcpDetails?.count, 0);
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: unknown ID returns not_found for native and MCP", async () => {
  const base = makeProjectBase("gsd-canonical-unknown-id");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    assert.ok(openDatabase(resolveProjectRootDbPath(base)), "fixture database should open successfully");

    const nativeGet = await nativeTool(native, "gsd_requirement_get").execute(
      "call-6",
      { id: "R999" },
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpGet = await mcpTool(mcp, "gsd_requirement_get").handler({
      projectDir: base,
      id: "R999",
    });

    assert.equal(readError(nativeGet), "not_found");
    assert.equal(readError(mcpGet), "not_found");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: corrupt requirements table returns query_error for native and MCP", async () => {
  const base = makeProjectBase("gsd-canonical-query-error-parity");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    const db = getDb();
    db.prepare("DROP TABLE requirements").run();

    const nativeReqList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-7",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpReqList = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });

    assert.equal(readError(nativeReqList), "query_error");
    assert.equal(readError(mcpReqList), "query_error");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: gsd_project_snapshot returns the same payload for native and MCP", async () => {
  const base = makeProjectBase("gsd-canonical-snapshot-parity");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    insertMilestone({ id: "M001", title: "Parity milestone", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Parity slice",
      status: "in_progress",
      risk: "low",
      depends: [],
      sequence: 1,
    });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Parity task",
      status: "pending",
      sequence: 1,
    });

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-8",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeSnapshotResult as {
      details?: { error?: string; snapshot?: Record<string, unknown> };
    }).details;

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: base });
    const mcpDetails = (mcpSnapshotResult as {
      structuredContent?: { error?: string; snapshot?: Record<string, unknown> };
    }).structuredContent;

    assert.equal(nativeDetails?.error, undefined);
    assert.equal(mcpDetails?.error, undefined);

    const nativeSnapshot = nativeDetails?.snapshot;
    const mcpSnapshot = mcpDetails?.snapshot;
    assert.ok(nativeSnapshot, "native result should carry details.snapshot");
    assert.ok(mcpSnapshot, "MCP result should carry structuredContent.snapshot");

    // capturedAt legitimately differs between the two executions; every other
    // section must be identical across the native and MCP surfaces.
    const stripCapturedAt = (snapshot: Record<string, unknown>) =>
      JSON.parse(JSON.stringify({ ...snapshot, capturedAt: "<capturedAt>" }));
    assert.deepEqual(stripCapturedAt(nativeSnapshot!), stripCapturedAt(mcpSnapshot!));

    assert.equal(typeof nativeSnapshot!.authority, "object");
    assert.ok(String((nativeSnapshot!.authority as { projectId?: unknown }).projectId ?? "").length > 0);
    assert.deepEqual((nativeSnapshot!.milestones as { items?: unknown[] }).items?.length, 1);
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: gsd_project_snapshot reads project B without switching the global DB handle", async () => {
  const baseA = makeProjectBase("gsd-canonical-snapshot-global-a");
  const baseB = makeProjectBase("gsd-canonical-snapshot-global-b");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(baseA));
    const authorityA = getProjectAuthorityRow();
    assert.ok(authorityA, "project A authority should exist");

    openDatabase(resolveProjectRootDbPath(baseB));
    insertMilestone({ id: "M001", title: "Project B milestone", status: "active" });
    const authorityB = getProjectAuthorityRow();
    assert.ok(authorityB, "project B authority should exist");
    assert.notEqual(authorityB.projectId, authorityA.projectId);

    openDatabase(resolveProjectRootDbPath(baseA));
    const before = getDbPath();
    assert.ok(before, "global DB should be open on project A");

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-8b",
      {},
      undefined,
      undefined,
      { cwd: baseB },
    );
    const nativeSnapshot = (nativeSnapshotResult as {
      details?: { snapshot?: { authority?: { projectId?: string } } };
    }).details?.snapshot;
    assert.equal(nativeSnapshot?.authority?.projectId, authorityB.projectId);
    assert.equal(getDbPath(), before, "native snapshot read must keep global DB path unchanged");

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: baseB });
    const mcpSnapshot = (mcpSnapshotResult as {
      structuredContent?: { snapshot?: { authority?: { projectId?: string } } };
    }).structuredContent?.snapshot;
    assert.equal(mcpSnapshot?.authority?.projectId, authorityB.projectId);
    assert.equal(getDbPath(), before, "MCP snapshot read must keep global DB path unchanged");
  } finally {
    cleanup([baseA, baseB]);
  }
});

test("canonical read parity: gsd_project_snapshot leaves no global DB open when none was open before", async () => {
  const base = makeProjectBase("gsd-canonical-snapshot-no-global");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    insertMilestone({ id: "M001", title: "Snapshot milestone", status: "active" });
    closeDatabase();
    assert.equal(getDbPath(), null, "fixture should start with no global DB handle");

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-8c",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    assert.equal(readError(nativeSnapshotResult), undefined);
    assert.equal(getDbPath(), null, "native snapshot read must not leave a global DB handle open");

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: base });
    assert.equal(readError(mcpSnapshotResult), undefined);
    assert.equal(getDbPath(), null, "MCP snapshot read must not leave a global DB handle open");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: gsd_project_snapshot missing DB returns db_unavailable for native and MCP without creating gsd.db", async () => {
  const base = makeProjectBase("gsd-canonical-snapshot-missing-db");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();
    const dbPath = resolveProjectRootDbPath(base);

    assert.equal(existsSync(dbPath), false, "fixture starts without gsd.db");

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-9",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeSnapshotResult as { details?: { error?: string } }).details;
    assert.equal(nativeDetails?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "native snapshot read should not create gsd.db as side effect");

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: base });
    const mcpDetails = (mcpSnapshotResult as { structuredContent?: { error?: string } }).structuredContent;
    assert.equal(mcpDetails?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "MCP snapshot read should not create gsd.db as side effect");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: dropped workflow_blockers table returns query_error for native and MCP snapshot reads", async () => {
  const base = makeProjectBase("gsd-canonical-snapshot-query-error");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    getDb().prepare("DROP TABLE workflow_blockers").run();

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-10",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeSnapshotResult as { details?: { error?: string } }).details;
    assert.equal(nativeDetails?.error, "query_error");

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: base });
    const mcpDetails = (mcpSnapshotResult as { structuredContent?: { error?: string } }).structuredContent;
    assert.equal(mcpDetails?.error, "query_error");

    const isolated = (await import("../db-workspace.ts")).openWorkflowDatabaseIsolated(
      resolveProjectRootDbPath(base),
    );
    assert.ok(isolated, "isolated open should still work after handled snapshot query_error");
    isolated?.close();
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: missing project_authority row classifies as db_unavailable for native and MCP snapshot reads", async () => {
  const base = makeProjectBase("gsd-canonical-snapshot-no-authority");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    getDb().prepare("DELETE FROM project_authority").run();
    closeDatabase();
    invalidateAllCaches();

    const nativeSnapshotResult = await nativeTool(native, "gsd_project_snapshot").execute(
      "call-11",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeSnapshotResult as { details?: { error?: string } }).details;
    assert.equal(nativeDetails?.error, "db_unavailable",
      "native must classify the missing authority row like mapCanonicalReadError");

    const mcpSnapshotResult = await mcpTool(mcp, "gsd_project_snapshot").handler({ projectDir: base });
    const mcpDetails = (mcpSnapshotResult as { structuredContent?: { error?: string } }).structuredContent;
    assert.equal(mcpDetails?.error, "db_unavailable");
  } finally {
    cleanup([base]);
  }
});
