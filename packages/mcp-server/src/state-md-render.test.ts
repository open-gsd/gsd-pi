// Project/App: gsd-pi
// File Purpose: STATE.md is the one DB render after every mutating tool (native and MCP) and command.
//
// Each step first overwrites STATE.md with stale bytes. After the call the file
// must equal renderStateContent(deriveState()). A mutation path that does not
// render STATE.md leaves the stale bytes and fails the check.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { clearPathCache } from "../../../src/resources/extensions/gsd/paths.ts";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase, updateTaskStatus } from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { claimTaskAttempt } from "../../../src/resources/extensions/gsd/task-execution-domain-operation.ts";
import { registerDbTools } from "../../../src/resources/extensions/gsd/bootstrap/db-tools.ts";
import { discardMilestone, parkMilestone, unparkMilestone } from "../../../src/resources/extensions/gsd/milestone-actions.ts";
import { handleUndo, handleUndoTask } from "../../../src/resources/extensions/gsd/undo.ts";
import { mergeCompletedMilestone } from "../../../src/resources/extensions/gsd/parallel-merge.ts";
import { seedMergeReadyMilestone } from "../../../src/resources/extensions/gsd/tests/merge-ready-fixture.ts";
import { handleEscalateCommand } from "../../../src/resources/extensions/gsd/commands/handlers/escalate.ts";
import { withCommandCwd } from "../../../src/resources/extensions/gsd/commands/context.ts";
import { buildEscalationArtifact, writeEscalationArtifact } from "../../../src/resources/extensions/gsd/escalation.ts";
import { deriveState, invalidateStateCache } from "../../../src/resources/extensions/gsd/state.ts";
import { renderStateContent } from "../../../src/resources/extensions/gsd/workflow-projections.ts";
import { rebuildMarkdownProjectionsFromDb } from "../../../src/resources/extensions/gsd/projection-worker.ts";
import { seedSliceCompletionAuthority } from "../../../src/resources/extensions/gsd/tests/slice-completion-fixture.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "../../../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts";
import { registerWorkflowTools } from "./workflow-tools.ts";

const workflowBridgeExtension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
process.env.GSD_WORKFLOW_EXECUTORS_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/tools/workflow-tool-executors.${workflowBridgeExtension}`,
  import.meta.url,
));
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/bootstrap/write-gate.${workflowBridgeExtension}`,
  import.meta.url,
));

const STALE = "# stale STATE.md\n";

type Transport = "native" | "mcp";

function statePath(base: string): string {
  return join(base, ".gsd", "STATE.md");
}

async function expectedState(base: string): Promise<string> {
  invalidateStateCache();
  return renderStateContent(await deriveState(base, { syncQueueOrder: false }));
}

/** Overwrite STATE.md with stale bytes, run the mutation, then require the one DB render. */
async function assertRendersState(base: string, label: string, mutate: () => Promise<unknown>): Promise<void> {
  writeFileSync(statePath(base), STALE);
  const result = await mutate();
  assert.ok(!(result as { isError?: boolean } | undefined)?.isError, `${label} must succeed: ${JSON.stringify(result)}`);
  assert.equal(readFileSync(statePath(base), "utf-8"), await expectedState(base), `${label}: STATE.md equals the DB render`);
}

async function runNativeTool(base: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  registerDbTools({ registerTool: (tool: (typeof tools)[number]) => tools.push(tool) } as Parameters<typeof registerDbTools>[0]);
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `native tool ${name} must be registered`);
  return tool.execute(`state-md-${name}`, args, undefined, undefined, { cwd: base });
}

async function runMcpTool(base: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tools: Array<{ name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> = [];
  registerWorkflowTools({
    tool: (toolName: string, _description: string, _params: unknown, handler: (typeof tools)[number]["handler"]) => {
      tools.push({ name: toolName, handler });
    },
  } as unknown as Parameters<typeof registerWorkflowTools>[0]);
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `MCP tool ${name} must be registered`);
  return tool.handler({ projectDir: base, ...args }, { _meta: { "io.opengsd/idempotency-key": `state-md:${name}` } });
}

function callTool(transport: Transport, base: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  return transport === "native" ? runNativeTool(base, name, args) : runMcpTool(base, name, args);
}

async function openFixture(t: TestContext): Promise<WorkflowAuthorityFixture> {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  return fixture;
}

/** Give M001/S02/T01 a running Attempt from a worker whose heartbeat is long stale. */
function claimRunningAttempt(base: string): void {
  const db = _getAdapter();
  assert.ok(db, "fixture database must be open");
  const at = "2026-07-12T00:00:00.000Z";
  db.prepare(`
    INSERT INTO workers (worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath)
    VALUES ('state-md-worker', 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(at, at, base);
  db.prepare(`
    INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, acquired_at, expires_at, status)
    VALUES ('M001', 'state-md-worker', 7, ?, '2099-07-12T00:00:00.000Z', 'held')
  `).run(at);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token, milestone_id, slice_id, task_id,
      unit_type, unit_id, status, attempt_n, started_at
    ) VALUES (
      'state-md-trace', 'state-md-turn', 'state-md-worker', 7, 'M001', 'S02', 'T01',
      'execute-task', 'M001/S02/T01', 'claimed', 1, ?
    )
  `).run(at);
  claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:state-md:claim:M001/S02/T01",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "state-md-worker",
    },
    task: { milestoneId: "M001", sliceId: "S02", taskId: "T01" },
    workerId: "state-md-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
}

const VALIDATE_ARGS = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] All pass",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "No issues",
  requirementCoverage: "All covered",
  verificationClasses: "- Contract: covered",
  verdictRationale: "Everything checks out",
};

for (const transport of ["native", "mcp"] as const) {
  describe(`STATE.md render after ${transport} workflow tools`, () => {
    it("decision, requirement, validate, gate, complete, reopen and skip each render STATE.md", async (t) => {
      const fixture = await openFixture(t);
      const base = fixture.root;
      const call = (label: string, name: string, args: Record<string, unknown>) =>
        assertRendersState(base, `${transport} ${label}`, () => callTool(transport, base, name, args));

      await call("decision", "gsd_decision_save", {
        scope: "architecture",
        decision: "Render STATE.md after every write",
        choice: "One renderer",
        rationale: "Readers see the DB state",
      });
      await call("requirement save", "gsd_requirement_save", {
        class: "core-capability",
        description: "STATE.md follows the DB",
        why: "Readers see current state",
        source: "state-md-render",
      });
      await call("requirement update", "gsd_requirement_update", { id: fixture.ids.requirement, status: "validated" });
      await call("validate", "gsd_validate_milestone", VALIDATE_ARGS);

      seedSliceCompletionAuthority({
        milestoneId: "M001",
        sliceId: "S02",
        completedTaskIds: ["T01"],
        runId: `${transport}-state-md`,
      });
      await call("gate", "gsd_save_gate_result", {
        milestoneId: "M001",
        sliceId: "S02",
        gateId: "Q8",
        verdict: "pass",
        rationale: "Operational readiness checked",
      });
      await call("complete", "gsd_slice_complete", {
        milestoneId: "M001",
        sliceId: "S02",
        sliceTitle: "Ready dependent slice",
        oneLiner: "Slice complete",
        narrative: "The slice is complete.",
        verification: "Focused test passed.",
        uatContent: "## UAT\n\nPASS",
      });
      await call("reopen", "gsd_slice_reopen", { milestoneId: "M001", sliceId: "S02", reason: "Reopen for the STATE.md check." });
      await call("skip", "gsd_skip_slice", { milestoneId: "M001", sliceId: "S02", reason: "Skip for the STATE.md check." });
    });

    it("settle renders STATE.md", async (t) => {
      const fixture = await openFixture(t);
      claimRunningAttempt(fixture.root);
      await assertRendersState(fixture.root, `${transport} settle`, () => callTool(transport, fixture.root, "gsd_task_settle", {
        milestoneId: "M001",
        sliceId: "S02",
        taskId: "T01",
        reason: "Settle for the STATE.md check.",
        apply: true,
      }));
    });

    it("plan renders STATE.md", async (t) => {
      const fixture = await openFixture(t);
      await assertRendersState(fixture.root, `${transport} plan`, () => callTool(transport, fixture.root, "gsd_plan_milestone", {
        milestoneId: "M002",
        title: "Planned milestone",
        vision: "Plan a milestone for the STATE.md check.",
        slices: [{
          sliceId: "S01",
          title: "Planned slice",
          risk: "low",
          depends: [],
          demo: "The plan is saved.",
          goal: "Save the plan.",
          successCriteria: "The roadmap renders from the DB.",
          proofLevel: "integration",
          integrationClosure: "None.",
          observabilityImpact: "None.",
        }],
      }));
    });

    it("UAT result renders STATE.md", async (t) => {
      const fixture = await openFixture(t);
      const evidenceId = `state-md-uat-${transport}`;
      mkdirSync(join(fixture.root, ".gsd", "exec"), { recursive: true });
      writeFileSync(join(fixture.root, ".gsd", "exec", `${evidenceId}.meta.json`), JSON.stringify({
        id: evidenceId,
        exit_code: 0,
        signal: null,
        timed_out: false,
        aborted: false,
        metadata: { kind: "uat_exec", milestoneId: "M001", sliceId: "S01", checkId: "UAT-01", intent: "uat-artifact-check" },
      }));
      await assertRendersState(fixture.root, `${transport} UAT`, () => callTool(transport, fixture.root, "gsd_uat_result_save", {
        milestoneId: "M001",
        sliceId: "S01",
        uatType: "artifact-driven",
        verdict: "PASS",
        checks: [{
          id: "UAT-01",
          description: "Artifact check passes",
          mode: "artifact",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
          notes: "Passed.",
        }],
        presentation: {
          surface: transport,
          presentedTools: ["gsd_uat_exec", "gsd_uat_result_save", "gsd_resume", "gsd_milestone_status", "gsd_journal_query"],
          blockedTools: ["gsd_exec", "gsd_summary_save", "gsd_save_gate_result"]
            .map((name) => ({ name, reason: "forbidden during run-uat" })),
        },
        notes: "UAT passed for the STATE.md check.",
      }));
    });
  });
}

describe("STATE.md render after workflow commands and rebuild", () => {
  it("park, unpark, discard and undo-task each render STATE.md", async (t) => {
    const fixture = await openFixture(t);
    const base = fixture.root;
    mkdirSync(join(base, ".gsd", "phases", "01-m001"), { recursive: true });
    clearPathCache();
    const ctx = { ui: { notify: () => {} } } as unknown as Parameters<typeof handleUndoTask>[1];

    await assertRendersState(base, "park", async () => assert.equal(await parkMilestone(base, "M001", "hold"), true));
    await assertRendersState(base, "unpark", async () => assert.equal(await unparkMilestone(base, "M001"), true));
    insertMilestone({ id: "M002", title: "Discarded milestone", status: "queued" });
    await assertRendersState(base, "discard", async () => assert.equal(await discardMilestone(base, "M002"), true));
    updateTaskStatus("M001", "S02", "T01", "complete");
    await assertRendersState(base, "undo-task", () => handleUndoTask("M001/S02/T01 --force", ctx, {} as Parameters<typeof handleUndoTask>[2], base));
  });

  it("/gsd undo --force renders STATE.md", async (t) => {
    const fixture = await openFixture(t);
    const base = fixture.root;
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(join(base, ".gsd", "activity", "001-execute-task-M001-S02-T01.jsonl"), "");
    updateTaskStatus("M001", "S02", "T01", "complete");
    const notes: string[] = [];
    const ctx = { ui: { notify: (message: string) => notes.push(message) } } as unknown as Parameters<typeof handleUndo>[1];

    await assertRendersState(base, "undo", () => handleUndo("--force", ctx, {} as Parameters<typeof handleUndo>[2], base));
    assert.ok(notes.some((note) => note.startsWith("Undone: execute-task (M001/S02/T01)")), notes.join("\n"));
  });

  it("/gsd escalate resolve renders STATE.md", async (t) => {
    const fixture = await openFixture(t);
    const base = fixture.root;
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nphases:\n  mid_execution_escalation: true\n---\n");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
    clearPathCache();
    writeEscalationArtifact(base, buildEscalationArtifact({
      taskId: "T01",
      sliceId: "S02",
      milestoneId: "M001",
      question: "Which store?",
      options: [
        { id: "A", label: "Table", tradeoffs: "Flexible" },
        { id: "B", label: "JSON", tradeoffs: "Simple" },
      ],
      recommendation: "B",
      recommendationRationale: "Simple",
      continueWithDefault: false,
    }));
    const notes: string[] = [];
    const ctx = { ui: { notify: (message: string) => notes.push(message) } } as unknown as Parameters<typeof handleEscalateCommand>[1];
    // Escalation preferences are read from the working directory.
    const previousCwd = process.cwd();
    process.chdir(base);
    t.after(() => process.chdir(previousCwd));

    await assertRendersState(base, "escalate resolve", () =>
      withCommandCwd(base, () => handleEscalateCommand("resolve S02/T01 reject-blocker none fit", ctx, {} as Parameters<typeof handleEscalateCommand>[2])));
    assert.ok(!notes.some((note) => /No escalation|Escalation is off|Usage/.test(note)), notes.join("\n"));
  });

  it("/gsd rebuild markdown renders STATE.md", async (t) => {
    const fixture = await openFixture(t);
    await assertRendersState(fixture.root, "rebuild markdown", async () => {
      assert.deepEqual((await rebuildMarkdownProjectionsFromDb(fixture.root)).errors, []);
    });
  });
});

describe("STATE.md render after a parallel merge", () => {
  it("mergeCompletedMilestone renders STATE.md on a real merge", async (t) => {
    const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "state-md-merge-")));
    const previousCwd = process.cwd();
    t.after(() => {
      process.chdir(previousCwd);
      closeDatabase();
      invalidateStateCache();
      rmSync(repo, { recursive: true, force: true });
    });
    run("git init -b main", repo);
    run("git config user.email test@test.com", repo);
    run("git config user.name Test", repo);
    mkdirSync(join(repo, ".gsd", "milestones", "M010"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".gsd/worktrees/\n.gsd/gsd.db*\n.gsd/STATE.md\n");
    writeFileSync(join(repo, ".gsd", "preferences.md"), "## Git\n- isolation: branch\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M010", "M010-ROADMAP.md"), "# M010: Merge\n\n## Slices\n- [x] **S01: Test Slice**\n");
    run("git add .", repo);
    run("git commit -m init", repo);
    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "merged.ts"), "export const merged = true;\n");
    run("git add .", repo);
    run("git commit -m feat", repo);
    run("git checkout main", repo);
    seedMergeReadyMilestone(repo, "M010");
    assert.ok(openDatabase(join(repo, ".gsd", "gsd.db")), "merge test database must open");
    process.chdir(repo);

    await assertRendersState(repo, "merge", async () => {
      const result = await mergeCompletedMilestone(repo, "M010");
      assert.equal(result.success, true, result.error);
    });
  });
});
