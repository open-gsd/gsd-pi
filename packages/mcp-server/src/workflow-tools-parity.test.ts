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
  insertGateRow,
  openDatabase,
  _getAdapter,
} from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { _setDomainOperationFaultForTest } from "../../../src/resources/extensions/gsd/db/domain-operation.ts";
import { recordExecRun } from "../../../src/resources/extensions/gsd/db/writers/exec-runs.ts";
import { registerDbTools } from "../../../src/resources/extensions/gsd/bootstrap/db-tools.ts";
import { importFileCaptures, loadAllCaptures, type CaptureEntry } from "../../../src/resources/extensions/gsd/captures.ts";
import { registerMemoryTools } from "../../../src/resources/extensions/gsd/bootstrap/memory-tools.ts";
import { registerQueryTools } from "../../../src/resources/extensions/gsd/bootstrap/query-tools.ts";
import { parkMilestone } from "../../../src/resources/extensions/gsd/milestone-actions.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../../../src/resources/extensions/gsd/task-execution-domain-operation.ts";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
} from "../../../src/resources/extensions/gsd/task-recovery-domain-operation.ts";
import {
  expectedFail,
  fenceWorkflowWrites,
  seedLifecycle,
  snapshotProjections,
} from "../../../src/resources/extensions/gsd/tests/db-authority-gate.ts";
import { seedSliceCompletionAuthority } from "../../../src/resources/extensions/gsd/tests/slice-completion-fixture.ts";
import {
  createWorkflowAuthorityFixture,
  seedPrerequisiteCompletionEvidence,
} from "../../../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts";
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
  type TestRequestExtra = { _meta?: Record<string, unknown>; sessionId?: string };
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
  toolCallId = "parity-call",
  sessionId?: string,
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
  const pi = {
    registerTool(tool: (typeof registrations)[number]) {
      registrations.push(tool);
    },
  } as Parameters<typeof registerDbTools>[0];
  registerDbTools(pi);
  registerMemoryTools(pi);
  registerQueryTools(pi);
  const tool = registrations.find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`native db tool ${toolName} not registered`);
  return tool.execute(toolCallId, args, undefined, undefined, {
    cwd: base,
    ...(sessionId ? { sessionManager: { getSessionId: () => sessionId } } : {}),
  });
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

/** The host record of a gsd_uat_exec run of M001/S01, bound to the run-uat attempt not saved yet. */
function recordUatRun(base: string, id: string): void {
  recordExecRun({
    kind: "uat_exec",
    milestoneId: "M001",
    sliceId: "S01",
    checkId: "UAT-01",
    id,
    runtime: "bash",
    command: "node check.js",
    cwd: base,
    exit_code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    started_at: new Date().toISOString(),
    duration_ms: 1,
    output_hash: "sha256:test",
  });
}

const UAT_RESULT_SAVE_ARGS = {
  milestoneId: "M001",
  sliceId: "S01",
  uatType: "artifact-driven",
  verdict: "PASS",
  checks: [{
    id: "UAT-01",
    description: "Artifact check passes",
    mode: "artifact",
    result: "PASS",
    evidence: [{ kind: "gsd_uat_exec", ref: "operation-only-uat" }],
    notes: "Passed.",
  }],
  presentation: {
    surface: "mcp",
    presentedTools: ["gsd_uat_exec", "gsd_uat_result_save", "gsd_resume", "gsd_milestone_status", "gsd_journal_query"],
    blockedTools: ["gsd_exec", "gsd_summary_save", "gsd_save_gate_result"]
      .map((name) => ({ name, reason: "forbidden during run-uat" })),
  },
  notes: "UAT passed for the operation-only gate.",
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
        // Milestone content without gsd.db is authority-missing; give the project its authority.
        openDatabase(join(base, ".gsd", "gsd.db"));
        closeDatabase();
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

  it("gsd_decision_save is one decision.save operation per call and a replay writes nothing on both transports", async () => {
    const counts = () => {
      const db = _getAdapter();
      assert.ok(db);
      return {
        operations: Number(db.prepare(
          "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'decision.save'",
        ).get()?.["count"]),
        decisions: Number(db.prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE structured_fields LIKE '%\"sourceDecisionId\":\"D%'",
        ).get()?.["count"]),
        projectionWork: Number(db.prepare(
          "SELECT COUNT(*) AS count FROM workflow_projection_work WHERE projection_key = 'decisions'",
        ).get()?.["count"]),
      };
    };
    const outputText = (result: unknown) =>
      ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "");

    const nativeBase = makeTmpBase();
    try {
      const first = await runNativeDbTool(nativeBase, "gsd_decision_save", DECISION_SAVE_ARGS);
      const replay = await runNativeDbTool(nativeBase, "gsd_decision_save", DECISION_SAVE_ARGS);
      assert.equal(outputText(first), "Saved decision D001");
      assert.equal(outputText(replay), "Saved decision D001", "native replay must return the original id");
      assert.deepEqual(counts(), { operations: 1, decisions: 1, projectionWork: 1 });
    } finally {
      cleanup(nativeBase);
    }

    const mcpBase = makeTmpBase();
    try {
      openDatabase(join(mcpBase, ".gsd", "gsd.db"));
      closeDatabase();
      const server = makeMockServer();
      registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
      const tool = server.tools.find((entry) => entry.name === "gsd_decision_save");
      assert.ok(tool);
      const args = { projectDir: mcpBase, ...DECISION_SAVE_ARGS };
      const keyed = { _meta: { "io.opengsd/idempotency-key": "decision-replay" } };
      const first = await tool.handler(args, keyed);
      const replay = await tool.handler(args, keyed);
      assert.equal(outputText(first), "Saved decision D001");
      assert.equal(outputText(replay), "Saved decision D001", "MCP replay must return the original id");
      const unkeyed = await tool.handler(args, {});
      assert.equal((unkeyed as { isError?: boolean }).isError, true, "an MCP mutation without a stable key must be refused");
      assert.match(outputText(unkeyed), /requires replay-stable private request metadata/);
      assert.deepEqual(counts(), { operations: 1, decisions: 1, projectionWork: 1 });
    } finally {
      cleanup(mcpBase);
    }
  });

  const SUPERSEDING_DECISION_ARGS = { ...DECISION_SAVE_ARGS, choice: "Replace the first choice", supersedes: "D001" };
  const decisionSupersededBy = () => Object.fromEntries(_getAdapter()!.prepare(`
    SELECT json_extract(structured_fields, '$.sourceDecisionId') AS id,
           json_extract(structured_fields, '$.superseded_by') AS superseded_by
    FROM memories
    WHERE json_extract(structured_fields, '$.sourceDecisionId') IS NOT NULL
  `).all().map((row) => [row["id"], row["superseded_by"]]));

  it("native gsd_decision_save supersedes the active decision", async (t) => {
    const base = makeTmpBase();
    t.after(() => cleanup(base));
    await runNativeDbTool(base, "gsd_decision_save", DECISION_SAVE_ARGS, "supersede-first");
    await runNativeDbTool(base, "gsd_decision_save", SUPERSEDING_DECISION_ARGS, "supersede-second");
    assert.deepEqual(decisionSupersededBy(), { D001: "D002", D002: null });
  });

  it("MCP gsd_decision_save supersedes the active decision", async (t) => {
    const base = makeTmpBase();
    t.after(() => cleanup(base));
    openDatabase(join(base, ".gsd", "gsd.db"));
    closeDatabase();
    const server = makeMockServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const tool = server.tools.find((entry) => entry.name === "gsd_decision_save");
    assert.ok(tool);
    await tool.handler(
      { projectDir: base, ...DECISION_SAVE_ARGS },
      { _meta: { "io.opengsd/idempotency-key": "supersede-first" } },
    );
    await tool.handler(
      { projectDir: base, ...SUPERSEDING_DECISION_ARGS },
      { _meta: { "io.opengsd/idempotency-key": "supersede-second" } },
    );
    assert.deepEqual(decisionSupersededBy(), { D001: "D002", D002: null });
  });

  it("a pending discussion gate blocks gsd_requirement_save on native and MCP; the answer unblocks both", async (t) => {
    const REQUIREMENTS_GATE = "depth_verification_requirements_confirm";
    const requirementArgs = (description: string) => ({
      class: "core-capability",
      description,
      why: "Lock one requirements gate for both transports",
      source: "M001",
    });
    const resultText = (result: unknown) =>
      (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const requirementCount = () =>
      Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM requirements").get()?.["count"]);

    const base = makeTmpBase();
    t.after(() => cleanup(base));
    // Another process asked the requirements approval question: the pending
    // gate is a row of the project database, and no process has it open.
    openDatabase(join(base, ".gsd", "gsd.db"));
    _getAdapter()!.prepare(
      "INSERT INTO write_gate_state (gate_kind, gate_id, writer, updated_at) VALUES ('pending', ?, 'child', ?)",
    ).run(REQUIREMENTS_GATE, new Date().toISOString());
    closeDatabase();

    const server = makeMockServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const mcpTool = server.tools.find((entry) => entry.name === "gsd_requirement_save");
    assert.ok(mcpTool);
    const saveNative = (description: string, toolCallId: string) =>
      runNativeDbTool(base, "gsd_requirement_save", requirementArgs(description), toolCallId);
    const saveMcp = (description: string, key: string) => mcpTool.handler(
      { projectDir: base, ...requirementArgs(description) },
      { _meta: { "io.opengsd/idempotency-key": key } },
    );

    assert.match(resultText(await saveNative("Saved over native", "gated-native")), /has not been confirmed by the user/);
    const mcpBlocked = await saveMcp("Saved over MCP", "gated-mcp");
    assert.equal((mcpBlocked as { isError?: boolean }).isError, true);
    assert.match(resultText(mcpBlocked), /has not been confirmed by the user/);
    assert.equal(requirementCount(), 0, "neither transport wrote a requirement while the gate was pending");

    // The user confirms. The other process records the answer in the same rows.
    _getAdapter()!.prepare(
      "UPDATE write_gate_state SET gate_kind = 'approval_verified' WHERE gate_kind = 'pending'",
    ).run();

    assert.match(resultText(await saveNative("Saved over native", "confirmed-native")), /^Saved requirement R001$/);
    assert.match(resultText(await saveMcp("Saved over MCP", "confirmed-mcp")), /^Saved requirement R002$/);
    assert.equal(requirementCount(), 2);
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
  sessionId?: string,
): Promise<unknown> {
  const server = makeMockServer();
  registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
  const tool = server.tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} must be registered on a fresh MCP server`);
  return tool.handler({ projectDir: base, ...args }, {
    _meta: { "io.opengsd/idempotency-key": stableKey },
    ...(sessionId ? { sessionId } : {}),
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
    seedPrerequisiteCompletionEvidence();
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

// ADR-046 gate G4, and the projection-ownership leg of G5. `passesWith` names
// the cutover package that routes the tool through one Domain Operation. The
// headless transport registers the same native tools in an RPC child and has
// no leg here. `prepare` puts the fixture in the state the tool needs. The
// milestone tools run in an order that each one can follow: discard is last.
// `piTool` is the native name when it differs from the MCP name. `seed` runs
// before the write fence is set. `renderPassesWith` names the package that
// stops the tool's inline render from writing a workflow table. `variant`
// names the write path of a tool that has more than one.
const OPERATION_ONLY_CASES: ReadonlyArray<{
  tool: string;
  piTool?: string;
  variant?: string;
  args: Record<string, unknown>;
  passesWith: string | null;
  renderPassesWith?: string;
  seed?: (base: string) => void;
  prepare?: (base: string) => Promise<unknown>;
}> = [
  { tool: "gsd_slice_complete", args: SLICE_LIFECYCLE_CASES[0].args, passesWith: null },
  {
    tool: "gsd_decision_save",
    args: { ...DECISION_SAVE_ARGS, when_context: "parity matrix", made_by: "agent" },
    passesWith: null,
  },
  { tool: "gsd_summary_save", variant: "slice artifact", args: SUMMARY_SAVE_ARGS, passesWith: null },
  {
    tool: "gsd_summary_save",
    variant: "UAT carrier",
    args: { milestone_id: "M001", slice_id: "S02", artifact_type: "UAT", content: "# UAT\n\nparity matrix UAT" },
    passesWith: null,
  },
  {
    tool: "gsd_summary_save",
    variant: "PROJECT",
    args: {
      artifact_type: "PROJECT",
      content: "# Project\n\n## Milestone Sequence\n\n- [ ] M001: Authority Fixture - The fixture milestone.\n",
    },
    passesWith: null,
  },
  {
    // The projection write stores the artifacts row of a task SUMMARY.
    tool: "gsd_summary_save",
    variant: "task SUMMARY",
    args: { ...SUMMARY_SAVE_ARGS, slice_id: "S02", task_id: "T01" },
    passesWith: "P12",
  },
  {
    tool: "gsd_uat_result_save",
    args: UAT_RESULT_SAVE_ARGS,
    passesWith: null,
    seed: (base) => recordUatRun(base, "operation-only-uat"),
  },
  {
    tool: "gsd_requirement_save",
    args: {
      class: "core-capability",
      description: "Operation-only requirement",
      why: "Lock one Domain Operation per requirement save",
      source: "M001",
    },
    passesWith: null,
  },
  {
    tool: "gsd_requirement_update",
    args: { id: "R001", status: "validated", validation: "G4 gate" },
    passesWith: null,
  },
  {
    tool: "gsd_save_gate_result",
    args: { milestoneId: "M001", sliceId: "S02", gateId: "Q3", verdict: "pass", rationale: "No auth surface." },
    passesWith: null,
    // The inline plan render stores an artifacts row after the operation commits.
    renderPassesWith: "P12",
    seed: () => insertGateRow({ milestoneId: "M001", sliceId: "S02", gateId: "Q3", scope: "slice" }),
  },
  {
    tool: "gsd_rework_brief_save",
    args: {
      milestoneId: "M001",
      sliceId: "S02",
      taskId: "T01",
      findings: [{
        findingId: "F1",
        severity: "advisory",
        description: "Name is unclear",
        requiredFix: "Rename the helper",
        verificationCommands: ["npm test"],
      }],
    },
    passesWith: null,
  },
  {
    tool: "gsd_checkpoint_save",
    args: {
      milestoneId: "M001",
      sliceId: "S02",
      kind: "handoff",
      confirmedContext: "Parity checkpoint context",
      nextAction: "Run the parity suite",
    },
    passesWith: null,
  },
  {
    tool: "gsd_capture_thought",
    piTool: "capture_thought",
    args: { category: "pattern", content: "Route every record write through one Domain Operation." },
    passesWith: null,
  },
  {
    tool: "gsd_capture_thought",
    piTool: "capture_thought",
    args: { category: "environment", content: "The gate fixture runs on a temporary project root." },
    passesWith: null,
  },
  { tool: "gsd_milestone_generate_id", args: {}, passesWith: null },
  { tool: "gsd_milestone_park", args: { milestoneId: "M001", reason: "Parity park" }, passesWith: null },
  {
    tool: "gsd_milestone_unpark",
    args: { milestoneId: "M001" },
    passesWith: null,
    prepare: (base) => parkMilestone(base, "M001", "Parity park"),
  },
  { tool: "gsd_milestone_reorder", args: { order: ["M001"] }, passesWith: null },
  { tool: "gsd_milestone_set_dependencies", args: { milestoneId: "M001", dependsOn: [] }, passesWith: null },
  { tool: "gsd_milestone_discard", args: { milestoneId: "M001", reason: "Parity discard" }, passesWith: null },
  { tool: "gsd_research_decision_save", args: { decision: "research" }, passesWith: null },
  {
    tool: "gsd_capture_resolve",
    args: { captureId: "CAP-parity01", classification: "note", resolution: "acknowledged", rationale: "Parity triage" },
    passesWith: null,
    prepare: async (base) => seedCapture(base, { id: "CAP-parity01", status: "pending" }),
  },
  {
    tool: "gsd_capture_complete",
    args: { captureId: "CAP-parity02", outcome: "Parity quick task done" },
    passesWith: null,
    prepare: async (base) => seedCapture(base, { id: "CAP-parity02", status: "resolved", classification: "quick-task" }),
  },
];

/** Put one capture in the database, once per fixture. */
function seedCapture(base: string, capture: Pick<CaptureEntry, "id" | "status" | "classification">): void {
  if (loadAllCaptures(base).some((entry) => entry.id === capture.id)) return;
  importFileCaptures(base, [{ ...capture, text: "Parity capture", timestamp: "2026-01-01T00:00:00.000Z" }]);
}

function operationCount(): number {
  return Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.count);
}

async function withOperationOnlyFixture(
  transport: "pi" | "mcp",
  run: (call: (gateCase: (typeof OPERATION_ONLY_CASES)[number]) => Promise<unknown>, base: string) => Promise<void>,
): Promise<void> {
  const fixture = await createWorkflowAuthorityFixture();
  try {
    seedPrerequisiteCompletionEvidence();
    seedSliceCompletionAuthority({
      milestoneId: "M001",
      sliceId: "S02",
      completedTaskIds: ["T01"],
      runId: `${transport}-operation-only`,
    });
    await run((gateCase) => {
      const key = `operation-only-${OPERATION_ONLY_CASES.indexOf(gateCase)}`;
      return transport === "pi"
        ? runNativeDbTool(fixture.root, gateCase.piTool ?? gateCase.tool, gateCase.args, key)
        : callMcpLifecycleTool(fixture.root, gateCase.tool, gateCase.args, key);
    }, fixture.root);
  } finally {
    fixture.cleanup();
  }
}

describe("G4: workflow tables are written only inside a Domain Operation", () => {
  for (const transport of ["pi", "mcp"] as const) {
    for (const gateCase of OPERATION_ONLY_CASES) {
      const variant = gateCase.variant ?? gateCase.args.category;
      const label = `${gateCase.tool}${variant ? ` (${variant})` : ""}`;
      it(`${transport} ${label}: one operation per call, none on replay, no write outside it`, async () => {
        await withOperationOnlyFixture(transport, async (call, base) => {
          gateCase.seed?.(base);
          await gateCase.prepare?.(base);
          const before = operationCount();
          const fence = fenceWorkflowWrites();
          const first = await call(gateCase);
          const afterFirstCall = operationCount();
          const replay = await call(gateCase);
          fence.restore();

          const fenceGate = () =>
            assert.deepEqual(fence.violations, [], "no workflow-table write outside a Domain Operation");
          const gate = () => {
            if (gateCase.renderPassesWith) expectedFail(gateCase.renderPassesWith, fenceGate);
            else fenceGate();
            assert.equal(afterFirstCall - before, 1, "one call commits one operation");
            assert.equal(operationCount() - afterFirstCall, 0, "a replay commits no operation");
            assert.ok(!(first as { isError?: boolean }).isError, "the call succeeds");
            assert.deepEqual(
              (replay as { content: unknown }).content,
              (first as { content: unknown }).content,
              "a replay returns the result of the first call",
            );
          };
          if (gateCase.passesWith) expectedFail(gateCase.passesWith, gate);
          else gate();
        });
      });
    }

    it(`${transport}: a tool handler returns before any projection file is written`, async () => {
      await withOperationOnlyFixture(transport, async (call, base) => {
        const wroteProjections: string[] = [];
        for (const gateCase of OPERATION_ONLY_CASES) {
          gateCase.seed?.(base);
          await gateCase.prepare?.(base);
          const before = snapshotProjections(base);
          const result = await call(gateCase);
          assert.ok(!(result as { isError?: boolean }).isError, `${gateCase.tool} must succeed`);
          try {
            assert.deepEqual(snapshotProjections(base), before);
          } catch {
            wroteProjections.push(gateCase.tool);
          }
        }

        // Only the Projection Worker drain may write a projection file.
        expectedFail("P12", () => assert.deepEqual(wroteProjections, []));
      });
    });
  }
});

describe("slice SUMMARY and UAT carriers commit inside the operation that writes them", () => {
  const carriers = () => ({ ..._getAdapter()!.prepare(
    "SELECT full_summary_md AS summary, full_uat_md AS uat FROM slices WHERE milestone_id = 'M001' AND id = 'S02'",
  ).get() }) as { summary: string; uat: string };

  it("a replay of gsd_slice_complete keeps a later UAT correction", async () => {
    await withOperationOnlyFixture("pi", async (_call, base) => {
      const complete = () => runNativeDbTool(base, "gsd_slice_complete", SLICE_LIFECYCLE_CASES[0].args, "carrier-complete");
      const fence = fenceWorkflowWrites();
      const first = await complete();
      fence.restore();
      assert.ok(!(first as { isError?: boolean }).isError, "the completion succeeds");
      assert.ok(!fence.violations.includes("slices"), "the carriers are written inside slice.complete");
      const completed = carriers();
      assert.match(completed.summary, /Persistent lifecycle parity is complete/);

      const correction = "# UAT\n\nCorrected after completion.\n";
      const saved = await runNativeDbTool(base, "gsd_summary_save", {
        milestone_id: "M001",
        slice_id: "S02",
        artifact_type: "UAT",
        content: correction,
      }, "carrier-correction");
      assert.ok(!(saved as { isError?: boolean }).isError, "the correction is saved");

      await complete();

      assert.deepEqual(carriers(), { summary: completed.summary, uat: correction });
      assert.equal(
        readFileSync(join(base, ".gsd", String(executorDetails(saved).path)), "utf-8"),
        correction,
        "the UAT file follows the carrier",
      );
    });
  });
});

describe("gsd_uat_result_save commits its rows in one Domain Operation", () => {
  const uatCase = OPERATION_ONLY_CASES.find((entry) => entry.tool === "gsd_uat_result_save")!;
  const count = (sql: string) => Number(_getAdapter()!.prepare(sql).get()?.count);
  const uatRows = () => ({
    artifacts: count("SELECT COUNT(*) AS count FROM artifacts WHERE artifact_type = 'ASSESSMENT' AND slice_id = 'S01'"),
    assessments: count("SELECT COUNT(*) AS count FROM assessments WHERE scope = 'run-uat'"),
    verdicts: count("SELECT COUNT(*) AS count FROM quality_gates WHERE gate_id = 'UAT' AND status = 'complete'"),
    gateRuns: count("SELECT COUNT(*) AS count FROM gate_runs WHERE gate_id = 'UAT'"),
  });
  const attemptFile = (base: string, attempt: number) =>
    join(base, ".gsd", "uat", "M001", "S01", `attempt-${attempt}.json`);

  async function openUatFixture(t: { after: (fn: () => void) => void }): Promise<string> {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    seedPrerequisiteCompletionEvidence();
    uatCase.seed?.(fixture.root);
    return fixture.root;
  }

  it("a replay returns the first attempt and records no second attempt", async (t) => {
    const base = await openUatFixture(t);

    const first = await runNativeDbTool(base, uatCase.tool, uatCase.args, "uat-replay");
    const replay = await runNativeDbTool(base, uatCase.tool, uatCase.args, "uat-replay");

    assert.equal(executorDetails(first).attempt, 1);
    assert.deepEqual(executorDetails(replay), executorDetails(first));
    assert.deepEqual(uatRows(), { artifacts: 1, assessments: 1, verdicts: 1, gateRuns: 1 });
    assert.ok(existsSync(attemptFile(base, 1)), "the first call records attempt 1");
    assert.ok(!existsSync(attemptFile(base, 2)), "the replay records no attempt 2");
  });

  it("a replay writes the attempt file that the first call did not write, and the next attempt number comes from the database", async (t) => {
    const base = await openUatFixture(t);
    const blocker = join(base, ".gsd", "uat");
    writeFileSync(blocker, "not a directory");

    const first = await runNativeDbTool(base, uatCase.tool, uatCase.args, "uat-lost-file");
    assert.equal((first as { isError?: boolean }).isError, true, "the attempt file write fails");
    assert.deepEqual(uatRows(), { artifacts: 1, assessments: 1, verdicts: 1, gateRuns: 1 }, "the operation is committed");

    rmSync(blocker);
    const replay = await runNativeDbTool(base, uatCase.tool, uatCase.args, "uat-lost-file");
    assert.equal(executorDetails(replay).attempt, 1);
    assert.equal(
      JSON.parse(readFileSync(join(base, ".gsd", String(executorDetails(replay).attemptPath)), "utf-8")).runId,
      executorDetails(replay).runId,
      "the returned attemptPath holds the record of the stored run",
    );
    assert.deepEqual(uatRows(), { artifacts: 1, assessments: 1, verdicts: 1, gateRuns: 1 }, "the replay writes no row");

    rmSync(attemptFile(base, 1));
    // A new attempt is a new run: it cites evidence the host recorded after attempt 1.
    recordUatRun(base, "operation-only-uat-2");
    const next = await runNativeDbTool(base, uatCase.tool, {
      ...uatCase.args,
      checks: [{ ...UAT_RESULT_SAVE_ARGS.checks[0], evidence: [{ kind: "gsd_uat_exec", ref: "operation-only-uat-2" }] }],
      attempt: "auto",
    }, "uat-next");
    assert.equal(executorDetails(next).attempt, 2, "attempt files on disk do not set the attempt number");
    assert.ok(existsSync(attemptFile(base, 2)));
  });

  it("a failed operation saves no row and no attempt file", async (t) => {
    const base = await openUatFixture(t);
    _setDomainOperationFaultForTest("after-mutation", "uat-result.save");
    t.after(() => _setDomainOperationFaultForTest(null));

    const result = await runNativeDbTool(base, uatCase.tool, uatCase.args, "uat-fault");

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.deepEqual(uatRows(), { artifacts: 0, assessments: 0, verdicts: 0, gateRuns: 0 });
    assert.ok(!existsSync(attemptFile(base, 1)), "no attempt is recorded for a write that rolled back");
  });
});

describe("revision fencing: a mutation is checked against the session's last read", () => {
  const requirementArgs = (description: string) => ({
    class: "core-capability",
    description,
    why: "Lock the stale view rejection",
    source: "M001",
  });
  const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const requirementCount = () =>
    Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM requirements").get()?.count);
  /** Another session commits one Domain Operation. */
  const moveRevision = (key: string) => seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    key,
    "slice-lifecycle",
  );

  for (const transport of ["pi", "mcp"] as const) {
    for (const readTool of ["gsd_milestone_status", "gsd_project_snapshot"]) {
      it(`${transport}: a write after a stale ${readTool} read is rejected until the session reads again`, async () => {
        const fixture = await createWorkflowAuthorityFixture();
        try {
          let calls = 0;
          const call = (tool: string, args: Record<string, unknown>) => {
            const key = `revision-fence-${calls++}`;
            return transport === "pi"
              ? runNativeDbTool(fixture.root, tool, args, key)
              : callMcpLifecycleTool(fixture.root, tool, args, key);
          };
          const read = () => call(readTool, readTool === "gsd_milestone_status" ? { milestoneId: "M001" } : {});
          const before = requirementCount();

          await read();
          moveRevision(`${transport}-${readTool}-first`);
          const stale = await call("gsd_requirement_save", requirementArgs("Written on a stale view"));
          assert.match(text(stale), /stale view: the project changed after this session last read it/);
          const stillStale = await call("gsd_requirement_save", requirementArgs("Retried without a read"));
          assert.match(text(stillStale), /stale view/, "a retry without a new read is rejected too");
          assert.equal(requirementCount(), before, "a rejected write saves nothing");

          await read();
          const fresh = await call("gsd_requirement_save", requirementArgs("Written on a fresh view"));
          assert.match(text(fresh), /^Saved requirement R\d+$/);

          moveRevision(`${transport}-${readTool}-second`);
          const unread = await call("gsd_requirement_save", requirementArgs("Written with no read since the last write"));
          assert.match(text(unread), /^Saved requirement R\d+$/, "a write with no read uses the current revision");
          assert.equal(requirementCount(), before + 2);
        } finally {
          fixture.cleanup();
        }
      });
    }

    it(`${transport}: a stale read in one session does not block another session`, async () => {
      const fixture = await createWorkflowAuthorityFixture();
      try {
        let calls = 0;
        const call = (sessionId: string, tool: string, args: Record<string, unknown>) => {
          const key = `revision-fence-session-${calls++}`;
          return transport === "pi"
            ? runNativeDbTool(fixture.root, tool, args, key, sessionId)
            : callMcpLifecycleTool(fixture.root, tool, args, key, sessionId);
        };
        const before = requirementCount();

        await call("session-a", "gsd_milestone_status", { milestoneId: "M001" });
        moveRevision(`${transport}-two-sessions`);
        const other = await call("session-b", "gsd_requirement_save", requirementArgs("Written by a session with no read"));
        assert.match(text(other), /^Saved requirement R\d+$/, "the read of session A does not fence session B");
        const stale = await call("session-a", "gsd_requirement_save", requirementArgs("Written on the stale view of session A"));
        assert.match(text(stale), /stale view/, "session A is still held to its own read");
        assert.equal(requirementCount(), before + 1);
      } finally {
        fixture.cleanup();
      }
    });

    for (const gateCase of OPERATION_ONLY_CASES.filter((entry) =>
      entry.tool === "gsd_uat_result_save" || entry.variant === "slice artifact")) {
      it(`${transport}: ${gateCase.tool} after a stale read is rejected and saves no row`, async (t) => {
        const fixture = await createWorkflowAuthorityFixture();
        t.after(() => fixture.cleanup());
        seedPrerequisiteCompletionEvidence();
        gateCase.seed?.(fixture.root);
        const call = (tool: string, args: Record<string, unknown>, key: string) => transport === "pi"
          ? runNativeDbTool(fixture.root, tool, args, key)
          : callMcpLifecycleTool(fixture.root, tool, args, key);
        const rows = () => _getAdapter()!.prepare("SELECT path FROM artifacts ORDER BY path").all();

        await call("gsd_milestone_status", { milestoneId: "M001" }, "stale-artifact-read");
        moveRevision(`${transport}-${gateCase.tool}-stale`);
        const before = rows();
        const operationsBefore = operationCount();
        const stale = await call(gateCase.tool, gateCase.args, "stale-artifact-write");

        assert.match(text(stale), /stale view: the project changed after this session last read it/);
        assert.deepEqual(rows(), before, "a rejected write saves no artifact row");
        assert.equal(operationCount(), operationsBefore, "a rejected write commits no operation");
      });
    }
  }
});
