// Project/App: gsd-pi
// File Purpose: Parity tests for GSD workflow task completion over native and MCP transports.
// ADR-008 validation criterion #3 — behavior-parity lock-in for gsd_task_complete.
//
// ADR-008 §1 ("One handler layer, multiple transports") is shipped: both
// native (`db-tools.ts`) and MCP (`workflow-tools.ts`) registrations wrap the
// same `executeTaskComplete` from `workflow-tool-executors.ts`. This test
// guards the equivalence so a future executor refactor cannot silently drift
// the two transports apart.
//
// Strategy: run the same completion against two equivalent fresh basePaths,
// one via the native path (direct call to the shared executor — which is
// faithfully what `db-tools.ts:670-674` does after `resolveCtxCwd`) and one
// via the MCP path (`registerWorkflowTools` + tool.handler). Snapshot DB row,
// summary file content, and journal events for each. Assert equivalence
// modulo expected diffs (timestamps).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  closeDatabase,
  getTask,
  openDatabase,
  _getAdapter,
} from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { registerDbTools } from "../../../src/resources/extensions/gsd/bootstrap/db-tools.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../../../src/resources/extensions/gsd/task-execution-domain-operation.ts";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
} from "../../../src/resources/extensions/gsd/task-recovery-domain-operation.ts";
import { seedSliceCompletionAuthority } from "../../../src/resources/extensions/gsd/tests/slice-completion-fixture.ts";
import { createWorkflowAuthorityFixture } from "../../../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts";
import {
  executeSummarySave,
  executeMilestoneStatus,
} from "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts";
import { registerWorkflowTools } from "./workflow-tools.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-mcp-parity-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function seedMilestoneAndSlice(base: string): void {
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
    "utf-8",
  );
}

function claimCanonicalTaskAuthority(base: string): string {
  openDatabase(join(base, ".gsd", "gsd.db"));
  const db = _getAdapter();
  assert.ok(db, "DB should be open before claiming canonical task authority");
  const now = "2026-07-12T00:00:00.000Z";
  db.prepare(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Parity milestone', 'active', ?)
  `).run(now);
  db.prepare(`
    INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Parity slice', 'active', ?)
  `).run(now);
  db.prepare(`
    INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Demo', 'in_progress', 'npm test', 1)
  `).run();
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES ('parity-worker', 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(now, now, base);
  db.prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES ('M001', 'parity-worker', 7, ?, '2099-07-12T00:00:00.000Z', 'held')
  `).run(now);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'fixture-trace', 'fixture-turn', 'parity-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, ?
    )
  `).run(now);
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:mcp-parity:claim:M001/S01/T01",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "parity-worker",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "parity-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
  return claim.attemptId;
}

function executionInvocation(key: string) {
  return {
    idempotencyKey: `fixture:mcp-parity:${key}`,
    sourceTransport: "internal" as const,
    actorType: "agent" as const,
    traceId: key,
  };
}

function seedTaskRecoveryAbort(base: string): { attemptId: string; recoveryActionId: string } {
  seedMilestoneAndSlice(base);
  const attemptId = claimCanonicalTaskAuthority(base);
  const settled = settleTaskAttempt({
    invocation: executionInvocation("settle-fatal"),
    attemptId,
    outcome: "failed",
    failureClass: "fatal",
    summary: "The executor runtime is invalid.",
    output: {},
  });
  const abort = recordFailureAndSelectRecovery({
    invocation: executionInvocation("route-fatal"),
    attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "The executor runtime is invalid.",
    evidence: { source: "executor" },
    rationale: "Stop until the executor is repaired.",
  });
  assert.equal(abort.action, "abort");
  assert.equal(abort.resumeAuthorized, false);
  return { attemptId, recoveryActionId: abort.recoveryActionId };
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    // swallow
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

function makeMockServer() {
  type TestRequestExtra = { _meta?: Record<string, unknown> };
  const tools: Array<{
    name: string;
    handler: (args: Record<string, unknown>, extra?: TestRequestExtra) => Promise<unknown>;
  }> = [];
  return {
    tools,
    tool(
      name: string,
      _description: string,
      _params: Record<string, unknown>,
      handler: (args: Record<string, unknown>, extra?: TestRequestExtra) => Promise<unknown>,
    ) {
      tools.push({
        name,
        handler: (args, extra) => handler(args, extra ?? {
          _meta: { "io.opengsd/idempotency-key": `mcp-parity:${name}` },
        }),
      });
    },
  };
}

function seedMilestoneRow(base: string, milestoneId = "M001"): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, "Parity milestone", "active", new Date().toISOString());
}

async function runNativeDbTool(
  base: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const registrations: Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
  }> = [];
  registerDbTools({
    registerTool(tool: (typeof registrations)[number]) {
      registrations.push(tool);
    },
  } as Parameters<typeof registerDbTools>[0]);
  const tool = registrations.find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`native db tool ${toolName} not registered`);
  return tool.execute("parity-call", args, undefined, undefined, { cwd: base });
}

async function runNativeAndMcpParity(input: {
  toolName: string;
  args: Record<string, unknown>;
  seed: (base: string) => void;
  assertEquivalent: (ctx: {
    nativeBase: string;
    mcpBase: string;
    nativeResult: unknown;
    mcpResult: unknown;
  }) => void;
  nativeRun?: (base: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  let baseNative = "";
  let baseMcp = "";
  try {
    baseNative = makeTmpBase();
    input.seed(baseNative);
    const nativeResult = input.nativeRun
      ? await input.nativeRun(baseNative, input.args)
      : await runNativeDbTool(baseNative, input.toolName, input.args);
    assert.ok(!(nativeResult as { isError?: boolean }).isError, `native ${input.toolName} must succeed`);
    closeDatabase();

    baseMcp = makeTmpBase();
    input.seed(baseMcp);
    const server = makeMockServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const mcpTool = server.tools.find((entry) => entry.name === input.toolName);
    assert.ok(mcpTool, `${input.toolName} must be registered on MCP`);
    const mcpResult = await mcpTool.handler({ projectDir: baseMcp, ...input.args });
    assert.ok(!(mcpResult as { isError?: boolean }).isError, `mcp ${input.toolName} must succeed`);

    input.assertEquivalent({ nativeBase: baseNative, mcpBase: baseMcp, nativeResult, mcpResult });
  } finally {
    if (baseNative) cleanup(baseNative);
    if (baseMcp) cleanup(baseMcp);
  }
}


interface SnapshotShape {
  /** SUMMARY.md content, trimmed, with ISO timestamps replaced by a sentinel. */
  summary: string;
  /** Task row, with volatile fields (timestamps, derived ids) elided. */
  taskRow: Record<string, unknown>;
  /** Journal events for this completion, with timestamps and ids normalized. */
  journalEvents: Array<{ cmd: string; params: Record<string, unknown>; actor: string }>;
}

const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function normalizeTimestamps(text: string): string {
  return text.replace(ISO_TIMESTAMP_RE, "<NORMALIZED-TS>");
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  // Recursively replace ISO timestamps in any string value so the deep-equal
  // doesn't fail on `ts`/`completed_at` style fields nested in the payload.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      out[k] = normalizeTimestamps(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string"
          ? normalizeTimestamps(item)
          : item && typeof item === "object"
            ? normalizeParams(item as Record<string, unknown>)
            : item,
      );
    } else if (v !== null && typeof v === "object") {
      out[k] = normalizeParams(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function snapshotState(base: string, milestoneId: string, sliceId: string, taskId: string): SnapshotShape {
  const summaryPath = join(base, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks", `${taskId}-SUMMARY.md`);
  assert.ok(existsSync(summaryPath), `summary file must exist at ${summaryPath}`);
  const summary = normalizeTimestamps(readFileSync(summaryPath, "utf-8").trim());

  const row = getTask(milestoneId, sliceId, taskId);
  assert.ok(row, "task row must exist in DB after completion");
  // Recursively normalize ISO timestamps in the row (the SQLite row uses
  // snake_case `completed_at` and embeds another ISO timestamp inside the
  // string field `full_summary_md`). Recursive normalization is simpler and
  // more robust than maintaining an elision list.
  const taskRow = normalizeParams(row as Record<string, unknown>);
  assert.equal(taskRow.status, "in_progress", "staged Task must remain in progress until host verification");

  const journalPath = join(base, ".gsd", "event-log.jsonl");
  const journalEvents: SnapshotShape["journalEvents"] = [];
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as { cmd: string; params: Record<string, unknown>; actor: string };
        if (evt.cmd === "complete-task" || evt.cmd === "complete_task") {
          // Normalize cmd to canonical hyphen form, and elide ISO timestamps
          // in the payload so the wall-clock skew between the two runs doesn't
          // produce a spurious diff.
          journalEvents.push({
            cmd: "complete-task",
            params: normalizeParams(evt.params),
            actor: evt.actor,
          });
        }
      } catch {
        // Skip corrupted lines — non-fatal for parity comparison.
      }
    }
  }

  return { summary, taskRow, journalEvents };
}

const COMPLETION_ARGS = {
  taskId: "T01",
  sliceId: "S01",
  milestoneId: "M001",
  oneLiner: "Completed the demo task",
  narrative: "Did the work described in the plan. Verified by running the test suite.",
  verification: "npm test — all passing",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/demo.ts"],
  keyDecisions: ["Used Option A from the plan."],
};

const workflowBridgeExtension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
process.env.GSD_WORKFLOW_EXECUTORS_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/tools/workflow-tool-executors.${workflowBridgeExtension}`,
  import.meta.url,
));
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/bootstrap/write-gate.${workflowBridgeExtension}`,
  import.meta.url,
));

describe("ADR-008 parity: gsd_task_complete native vs MCP", () => {
  it("native and MCP produce equivalent staged DB row, summary, and journal event", async () => {
    let baseNative = "";
    let baseMcp = "";
    try {
      // ─── Native path ─────────────────────────────────────────────────
      baseNative = makeTmpBase();
      seedMilestoneAndSlice(baseNative);
      claimCanonicalTaskAuthority(baseNative);
      const nativeResult = await runNativeDbTool(baseNative, "gsd_task_complete", COMPLETION_ARGS);
      assert.ok(!nativeResult.isError, "native completion must succeed");

      const snapshotNative = snapshotState(baseNative, "M001", "S01", "T01");
      closeDatabase();

      // ─── MCP path ────────────────────────────────────────────────────
      baseMcp = makeTmpBase();
      seedMilestoneAndSlice(baseMcp);
      claimCanonicalTaskAuthority(baseMcp);

      const server = makeMockServer();
      registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "gsd_task_complete must be registered on the MCP surface");

      const mcpResult = await taskTool.handler({ projectDir: baseMcp, ...COMPLETION_ARGS });
      assert.ok(!mcpResult.isError, `mcp completion must succeed: ${JSON.stringify(mcpResult)}`);

      const snapshotMcp = snapshotState(baseMcp, "M001", "S01", "T01");

      // ─── Compare ─────────────────────────────────────────────────────
      assert.equal(
        snapshotNative.summary,
        snapshotMcp.summary,
        "SUMMARY.md content must be byte-equal between native and MCP completions",
      );

      assert.deepEqual(
        snapshotNative.taskRow,
        snapshotMcp.taskRow,
        "tasks DB row (modulo volatile timestamps and ids) must be equal",
      );

      // Journal event count must match (1 complete-task event per completion).
      assert.equal(
        snapshotNative.journalEvents.length,
        snapshotMcp.journalEvents.length,
        "both transports must emit the same number of complete-task journal events",
      );

      // Each journal event's params must match (these encode the completion
      // payload; cmd is normalized and actor must align).
      for (let i = 0; i < snapshotNative.journalEvents.length; i++) {
        assert.equal(
          snapshotNative.journalEvents[i].actor,
          snapshotMcp.journalEvents[i].actor,
          `journal event #${i} actor must match between native and MCP`,
        );
        assert.deepEqual(
          snapshotNative.journalEvents[i].params,
          snapshotMcp.journalEvents[i].params,
          `journal event #${i} params must match between native and MCP`,
        );
      }
    } finally {
      if (baseNative) cleanup(baseNative);
      if (baseMcp) cleanup(baseMcp);
    }
  });
});

const SUMMARY_SAVE_ARGS = {
  milestone_id: "M001",
  slice_id: "S01",
  artifact_type: "SUMMARY",
  content: "# Summary\n\nparity matrix artifact",
};

const DECISION_SAVE_ARGS = {
  scope: "global",
  decision: "Use matrix parity tests",
  choice: "Extend workflow-tools-parity.test.ts",
  rationale: "Lock native/MCP DB write equivalence",
  revisable: "yes",
};

describe("ADR-008 parity: shared workflow write tools native vs MCP", () => {
  it("gsd_summary_save writes identical artifact files", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_summary_save",
      args: SUMMARY_SAVE_ARGS,
      seed: (base) => {
        mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      },
      nativeRun: (base, args) => executeSummarySave(args as Parameters<typeof executeSummarySave>[0], base),
      assertEquivalent: ({ nativeBase, mcpBase }) => {
        const rel = "milestones/M001/slices/S01/S01-SUMMARY.md";
        const nativePath = join(nativeBase, ".gsd", rel);
        const mcpPath = join(mcpBase, ".gsd", rel);
        assert.ok(existsSync(nativePath), "native summary artifact must exist");
        assert.ok(existsSync(mcpPath), "mcp summary artifact must exist");
        assert.equal(
          normalizeTimestamps(readFileSync(nativePath, "utf-8").trim()),
          normalizeTimestamps(readFileSync(mcpPath, "utf-8").trim()),
          "summary artifact content must match between transports",
        );
      },
    });
  });

  it("gsd_milestone_status returns equivalent milestone metadata", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_milestone_status",
      args: { milestoneId: "M001" },
      seed: seedMilestoneRow,
      nativeRun: (base, args) =>
        executeMilestoneStatus(args as Parameters<typeof executeMilestoneStatus>[0], base),
      assertEquivalent: ({ nativeResult, mcpResult }) => {
        const nativeDetails = normalizeParams(
          ((nativeResult as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>,
        );
        const mcpDetails = normalizeParams(
          ((mcpResult as { structuredContent?: Record<string, unknown> }).structuredContent
            ?? (mcpResult as { details?: Record<string, unknown> }).details
            ?? {}) as Record<string, unknown>,
        );
        assert.deepEqual(nativeDetails, mcpDetails, "milestone status details must match between transports");
        const observation = _getAdapter()!.prepare(`
          SELECT payload_json FROM audit_events
          WHERE type = 'lifecycle-shadow-observed'
        `).get();
        assert.ok(observation, "MCP status reads must persist an observation");
        const payload = JSON.parse(String(observation["payload_json"]));
        assert.equal(payload.transport, "workflow_mcp");
        assert.equal(payload.mode, "legacy");
      },
    });
  });

  it("gsd_decision_save persists equivalent decision rows", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_decision_save",
      args: {
        ...DECISION_SAVE_ARGS,
        when_context: "parity matrix",
        made_by: "agent",
      },
      seed: (base) => {
        openDatabase(join(base, ".gsd", "gsd.db"));
        closeDatabase();
      },
      assertEquivalent: ({ nativeBase, mcpBase }) => {
        const nativeDecisions = join(nativeBase, ".gsd", "DECISIONS.md");
        const mcpDecisions = join(mcpBase, ".gsd", "DECISIONS.md");
        assert.ok(existsSync(nativeDecisions), "native DECISIONS.md must exist");
        assert.ok(existsSync(mcpDecisions), "mcp DECISIONS.md must exist");
        assert.equal(
          normalizeTimestamps(readFileSync(nativeDecisions, "utf-8").trim()),
          normalizeTimestamps(readFileSync(mcpDecisions, "utf-8").trim()),
          "DECISIONS.md must match between transports",
        );
      },
    });
  });
});

const SLICE_LIFECYCLE_CASES = [
  {
    canonicalName: "gsd_slice_complete",
    retryName: "gsd_complete_slice",
    operationType: "slice.complete",
    eventType: "slice.completed",
    stableKey: "slice-lifecycle-complete",
    args: {
      milestoneId: "M001",
      sliceId: "S02",
      sliceTitle: "Ready dependent slice",
      oneLiner: "Persistent lifecycle parity is complete",
      narrative: "Pi and MCP preserve one canonical Slice completion across a restart.",
      verification: "Focused persistent-database parity test passed.",
      uatContent: "## UAT\n\nPASS",
    },
  },
  {
    canonicalName: "gsd_slice_reopen",
    retryName: "gsd_reopen_slice",
    operationType: "slice.reopen",
    eventType: "slice.reopened",
    stableKey: "slice-lifecycle-reopen",
    args: {
      milestoneId: "M001",
      sliceId: "S02",
      reason: "Reopen the completed Slice for retry parity.",
    },
  },
  {
    canonicalName: "gsd_skip_slice",
    retryName: "gsd_skip_slice",
    operationType: "slice.cancel",
    eventType: "slice.cancelled",
    stableKey: "slice-lifecycle-cancel",
    args: {
      milestoneId: "M001",
      sliceId: "S02",
      reason: "Cancel the reopened Slice for retry parity.",
    },
  },
] as const;

function normalizeLifecycleToolResult(result: unknown, base: string): Record<string, unknown> {
  const serialized = JSON.stringify(result);
  // On Windows, JSON.stringify escapes path separators ("\\"), so the raw `base`
  // (single backslashes) never matches the serialized paths and the workspace
  // prefix survives, breaking the cross-transport comparison. Replace the
  // JSON-escaped form of the base exactly as it appears in the serialized string;
  // JSON.stringify(base) sans quotes yields that form and equals `base` verbatim
  // on POSIX, so this stays correct on both platforms.
  const escapedBase = JSON.stringify(base).slice(1, -1);
  const record = JSON.parse(serialized.replaceAll(escapedBase, "<PROJECT>")) as Record<string, unknown>;
  const details = record.structuredContent ?? record.details;
  return {
    content: record.content,
    details,
    isError: record.isError ?? false,
  };
}

function assertSingleSliceLifecycleLineage(
  operationType: string,
  eventType: string,
  expectedIdempotencyKey: string,
  expectedTransport: "pi-tool" | "workflow-mcp",
): void {
  const db = _getAdapter();
  assert.ok(db, "persistent Slice lifecycle database must be open");
  const operations = db.prepare(`
    SELECT idempotency_key, source_transport
    FROM workflow_operations
    WHERE operation_type = ?
  `).all(operationType);
  assert.deepEqual(operations, [{
    idempotency_key: expectedIdempotencyKey,
    source_transport: expectedTransport,
  }]);
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_domain_events
    WHERE event_type = ?
  `).get(eventType)?.count), 1, `${eventType} must have one durable event`);
}

async function callMcpLifecycleTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
  stableKey: string,
): Promise<unknown> {
  const server = makeMockServer();
  registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
  const tool = server.tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} must be registered on a fresh MCP server`);
  return tool.handler({ projectDir: base, ...args }, {
    _meta: { "io.opengsd/idempotency-key": stableKey },
  });
}

const TASK_RECOVERY_RESUME_ARGS = {
  repairSummary: "The executor runtime was rebuilt and verified.",
  evidence: { pullRequest: 1457, check: "focused recovery tests passed" },
};

function executorDetails(result: unknown): Record<string, unknown> {
  const record = result as { details?: unknown; structuredContent?: unknown };
  const details = record.structuredContent ?? record.details;
  assert.ok(details && typeof details === "object" && !Array.isArray(details), "executor result must expose details");
  return details as Record<string, unknown>;
}

function assertTaskRecoveryResumeDurability(input: {
  attemptId: string;
  recoveryActionId: string;
  firstResult: unknown;
  replayResult: unknown;
  expectedIdempotencyKey: string;
  expectedTransport: "pi-tool" | "workflow-mcp";
}): Record<string, unknown> {
  const firstDetails = executorDetails(input.firstResult);
  const replayDetails = executorDetails(input.replayResult);
  assert.equal(firstDetails.status, "committed");
  assert.equal(replayDetails.status, "replayed");
  assert.equal(replayDetails.operationId, firstDetails.operationId);
  assert.equal(firstDetails.recoveryActionId, input.recoveryActionId);
  assert.equal(readTaskRecoveryRoute(input.attemptId)?.resumeAuthorized, true);

  const db = _getAdapter();
  assert.ok(db, "database must be open after resume replay");
  assert.deepEqual(db.prepare(`
    SELECT idempotency_key, source_transport
    FROM workflow_operations
    WHERE operation_type = 'task.recovery.resume'
  `).all(), [{
    idempotency_key: input.expectedIdempotencyKey,
    source_transport: input.expectedTransport,
  }]);
  const events = db.prepare(`
    SELECT payload_json
    FROM workflow_domain_events
    WHERE event_type = 'task.recovery.resumed'
  `).all() as Array<{ payload_json: string }>;
  assert.equal(events.length, 1, "resume replay must not duplicate the durable event");
  const payload = JSON.parse(events[0].payload_json) as Record<string, unknown>;
  assert.equal(payload.recoveryActionId, input.recoveryActionId);
  assert.equal(payload.attemptId, input.attemptId);
  assert.equal(payload.repairSummary, TASK_RECOVERY_RESUME_ARGS.repairSummary);
  assert.deepEqual(payload.evidence, TASK_RECOVERY_RESUME_ARGS.evidence);

  return {
    firstStatus: firstDetails.status,
    replayStatus: replayDetails.status,
    operation: "task.recovery.resume",
    eventType: "task.recovery.resumed",
    eventCount: events.length,
    repairSummary: payload.repairSummary,
    evidence: payload.evidence,
    resumeAuthorized: true,
  };
}

describe("Task recovery resume persistent retry parity", () => {
  it("Pi and MCP authorize one repaired retry and replay after DB restart", async () => {
    let baseNative = "";
    let baseMcp = "";
    try {
      baseNative = makeTmpBase();
      const nativeAbort = seedTaskRecoveryAbort(baseNative);
      const nativeArgs = {
        recoveryActionId: nativeAbort.recoveryActionId,
        ...TASK_RECOVERY_RESUME_ARGS,
      };
      const nativeFirst = await runNativeDbTool(baseNative, "gsd_task_recovery_resume", nativeArgs);
      assert.ok(!(nativeFirst as { isError?: boolean }).isError, "native resume must succeed");
      closeDatabase();
      const nativeReplay = await runNativeDbTool(baseNative, "gsd_task_recovery_resume", nativeArgs);
      assert.ok(!(nativeReplay as { isError?: boolean }).isError, "native resume replay must succeed");
      const nativeSnapshot = assertTaskRecoveryResumeDurability({
        ...nativeAbort,
        firstResult: nativeFirst,
        replayResult: nativeReplay,
        expectedIdempotencyKey: "pi:gsd_task_recovery_resume:parity-call",
        expectedTransport: "pi-tool",
      });
      closeDatabase();

      baseMcp = makeTmpBase();
      const mcpAbort = seedTaskRecoveryAbort(baseMcp);
      const mcpArgs = {
        recoveryActionId: mcpAbort.recoveryActionId,
        ...TASK_RECOVERY_RESUME_ARGS,
      };
      const mcpFirst = await callMcpLifecycleTool(
        baseMcp,
        "gsd_task_recovery_resume",
        mcpArgs,
        "task-recovery-resume",
      );
      assert.ok(!(mcpFirst as { isError?: boolean }).isError, "MCP resume must succeed");
      closeDatabase();
      const mcpReplay = await callMcpLifecycleTool(
        baseMcp,
        "gsd_task_recovery_resume",
        mcpArgs,
        "task-recovery-resume",
      );
      assert.ok(!(mcpReplay as { isError?: boolean }).isError, "MCP resume replay must succeed");
      const mcpSnapshot = assertTaskRecoveryResumeDurability({
        ...mcpAbort,
        firstResult: mcpFirst,
        replayResult: mcpReplay,
        expectedIdempotencyKey: "mcp:gsd_task_recovery_resume:task-recovery-resume",
        expectedTransport: "workflow-mcp",
      });

      assert.deepEqual(mcpSnapshot, nativeSnapshot, "Pi and MCP resume behavior must match");
    } finally {
      if (baseNative) cleanup(baseNative);
      if (baseMcp) cleanup(baseMcp);
    }
  });
});

async function runPersistentSliceLifecycleMatrix(
  transport: "pi" | "mcp",
): Promise<Record<string, Record<string, unknown>>> {
  const fixture = await createWorkflowAuthorityFixture();
  const responses: Record<string, Record<string, unknown>> = {};
  try {
    seedSliceCompletionAuthority({
      milestoneId: "M001",
      sliceId: "S02",
      completedTaskIds: ["T01"],
      runId: `${transport}-persistent-parity`,
    });

    for (const lifecycleCase of SLICE_LIFECYCLE_CASES) {
      const first = transport === "pi"
        ? await runNativeDbTool(fixture.root, lifecycleCase.canonicalName, lifecycleCase.args)
        : await callMcpLifecycleTool(
            fixture.root,
            lifecycleCase.canonicalName,
            lifecycleCase.args,
            lifecycleCase.stableKey,
          );
      assert.ok(!(first as { isError?: boolean }).isError, `${transport} canonical call must succeed`);

      closeDatabase();

      const retry = transport === "pi"
        ? await runNativeDbTool(fixture.root, lifecycleCase.retryName, lifecycleCase.args)
        : await callMcpLifecycleTool(
            fixture.root,
            lifecycleCase.retryName,
            lifecycleCase.args,
            lifecycleCase.stableKey,
          );
      assert.ok(!(retry as { isError?: boolean }).isError, `${transport} retry must succeed after DB reopen`);

      const firstContract = normalizeLifecycleToolResult(first, fixture.root);
      const retryContract = normalizeLifecycleToolResult(retry, fixture.root);
      const retryDetails = retryContract.details as Record<string, unknown>;
      assert.equal(retryDetails.duplicate, true, "an exact retry must identify its durable replay");
      delete retryDetails.duplicate;
      assert.deepEqual(
        retryContract,
        firstContract,
        `${transport} ${lifecycleCase.retryName} retry must preserve canonical response semantics`,
      );
      responses[lifecycleCase.operationType] = firstContract;

      const canonicalName = lifecycleCase.canonicalName;
      const expectedIdempotencyKey = transport === "pi"
        ? `pi:${canonicalName}:parity-call`
        : `mcp:${canonicalName}:${lifecycleCase.stableKey}`;
      assertSingleSliceLifecycleLineage(
        lifecycleCase.operationType,
        lifecycleCase.eventType,
        expectedIdempotencyKey,
        transport === "pi" ? "pi-tool" : "workflow-mcp",
      );
    }

    const db = _getAdapter();
    assert.ok(db);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_item_lifecycles
      WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S02'
    `).get()?.count), 1, "retries must not duplicate the canonical Slice lifecycle row");
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S02' AND task_id = 'T01'
    `).get()?.count), 1, "retries must not duplicate the canonical Task lifecycle row");
    return responses;
  } finally {
    fixture.cleanup();
  }
}

describe("Slice lifecycle persistent retry parity", () => {
  it("Pi and MCP preserve canonical-first complete, reopen, and cancel across fresh retry registrations", async (t) => {
    const previousAliasSetting = process.env.GSD_ADVERTISE_TOOL_ALIASES;
    t.after(() => {
      if (previousAliasSetting === undefined) {
        delete process.env.GSD_ADVERTISE_TOOL_ALIASES;
      } else {
        process.env.GSD_ADVERTISE_TOOL_ALIASES = previousAliasSetting;
      }
    });
    process.env.GSD_ADVERTISE_TOOL_ALIASES = "1";
    const piResponses = await runPersistentSliceLifecycleMatrix("pi");
    const mcpResponses = await runPersistentSliceLifecycleMatrix("mcp");
    assert.deepEqual(mcpResponses, piResponses, "Pi and MCP lifecycle response contracts must match");
  });
});
