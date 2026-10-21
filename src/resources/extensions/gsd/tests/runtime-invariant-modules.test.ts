// Project/App: gsd-pi
// File Purpose: ADR-015 runtime invariant module contract tests.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyFailure } from "../recovery-classification.js";
import { reconcileBeforeDispatch } from "../state-reconciliation.js";
import {
  compileUnitContextContract,
  compileUnitToolContract,
  getUnitWorkflowDispatchReadinessError,
  getUnitWorkflowDispatchReadinessErrorForModel,
} from "../tool-contract.js";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.js";
import type { GSDState } from "../types.js";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
    ...overrides,
  };
}

test("State Reconciliation invalidates cache and returns reconciled state", async () => {
  const calls: string[] = [];
  const state = makeState();

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache() { calls.push("invalidate"); },
    async deriveState(basePath) {
      calls.push(`derive:${basePath}`);
      return state;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["invalidate", "derive:/project"]);
  assert.equal(result.ok && result.stateSnapshot, state);
});

test("State Reconciliation surfaces terminal blockers in result (ADR-017)", async () => {
  // Under ADR-017, blockers are terminal but do not throw — they ride along
  // in the result so the orchestrator adapter can map them to ok=false.
  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache() {},
    async deriveState() {
      return makeState({ phase: "blocked", blockers: ["slice lock missing"] });
    },
    registry: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, ["slice lock missing"]);
});

test("Tool Contract compiles known Unit prompt and tool policy", () => {
  const result = compileUnitToolContract("execute-task");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.contract.unitType, "execute-task");
  assert.deepEqual(result.ok && result.contract.requiredWorkflowTools, [
    "gsd_task_complete",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_capture_thought",
  ]);
  assert.deepEqual(result.ok && result.contract.forbiddenWorkflowTools, []);
  assert.equal(result.ok && result.contract.toolsPolicy.mode, "all");
  assert.ok(result.ok && result.contract.validationRules.includes("closeout-tool-present"));
  assert.ok(result.ok && result.contract.validationRules.includes("source-observation-contract-present"));
  assert.deepEqual(result.ok && result.contract.promptContext.artifacts.inline, [
    "task-plan",
    "slice-plan",
    "prior-task-summaries",
    "templates",
  ]);
  assert.deepEqual(result.ok && result.contract.promptContext.artifacts.onDemand, ["slice-research"]);
  assert.ok(result.ok && result.contract.promptObligations.includes("context-inline:task-plan,slice-plan,prior-task-summaries,templates"));
  assert.ok(result.ok && result.contract.promptObligations.includes("context-on-demand:slice-research"));
  assert.ok(result.ok && result.contract.promptObligations.includes("source-observations:whole-file-active-unit"));
  assert.deepEqual(result.ok && result.contract.sourceObservations, {
    mode: "whole-file-active-unit",
    seedFields: ["task.files", "task.inputs"],
    excludedFields: ["expectedOutput"],
    maxBytes: 50 * 1024,
    maxLines: 2000,
  });
});

test("Tool Contract compiles the replan-task recovery Unit", () => {
  const result = compileUnitToolContract("replan-task");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.contract.unitType, "replan-task");
  assert.deepEqual(result.ok && result.contract.requiredWorkflowTools, ["gsd_replan_task"]);
  assert.equal(result.ok && result.contract.contextMode, "planning");
  assert.equal(result.ok && result.contract.toolsPolicy.mode, "workflow-only");
  assert.deepEqual(result.ok && result.contract.promptContext.artifacts.inline, ["task-plan"]);
});

test("Tool Contract derives dispatch readiness from Unit workflow tools", () => {
  const error = getUnitWorkflowDispatchReadinessError({
    provider: "claude-code",
    unitType: "plan-slice",
    projectRoot: "/tmp/project",
    env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
    surface: "auto-mode",
    authMode: "externalCli",
    baseUrl: "local://claude-code",
  });

  assert.equal(error, null);
});

test("Tool Contract derives dispatch readiness from selected model context", () => {
  const authLookups: string[] = [];
  const error = getUnitWorkflowDispatchReadinessErrorForModel({
    model: { provider: "claude-code" },
    fallbackModel: { provider: "openai-codex", baseUrl: "local://claude-code" },
    getProviderAuthMode(provider) {
      authLookups.push(provider);
      return provider === "claude-code" ? "externalCli" : "oauth";
    },
    unitType: "plan-slice",
    projectRoot: "/tmp/project",
    env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
    surface: "auto-mode",
  });

  assert.equal(error, null);
  assert.deepEqual(authLookups, ["claude-code"]);
});

test("Unit Context Contract exposes prompt context without workflow tool surface", () => {
  const result = compileUnitContextContract("execute-task");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.contract.unitType, "execute-task");
  assert.equal(result.ok && result.contract.contextMode, "execution");
  assert.equal(result.ok && result.contract.toolsPolicy.mode, "all");
  assert.deepEqual(result.ok && result.contract.artifacts.excerpt, []);
  assert.deepEqual(result.ok && result.contract.artifacts.computed, []);
  assert.deepEqual(result.ok && result.contract.artifacts.prepend, []);
  assert.equal(result.ok && result.contract.maxSystemPromptChars, 1_500_000);
  assert.equal(result.ok && result.contract.sourceObservations.mode, "whole-file-active-unit");
});

test("Tool Contract records high-risk cross-phase tool boundaries without single-owning every tool", () => {
  const completeSlice = compileUnitToolContract("complete-slice");
  const runUat = compileUnitToolContract("run-uat");

  assert.equal(completeSlice.ok, true);
  assert.ok(
    completeSlice.ok &&
      completeSlice.contract.forbiddenWorkflowTools.some((tool) => tool.name === "gsd_uat_result_save"),
    "complete-slice should explicitly forbid saving UAT Assessments",
  );

  assert.equal(runUat.ok, true);
  assert.ok(
    runUat.ok &&
      runUat.contract.requiredWorkflowTools.includes("gsd_uat_result_save"),
    "run-uat should own the UAT result-save tool",
  );
  assert.ok(
    runUat.ok &&
      runUat.contract.forbiddenWorkflowTools.some((tool) => tool.name === "gsd_exec"),
    "run-uat should prefer typed UAT execution over generic gsd_exec",
  );
});

test("Tool Contract fails closed for unknown Units", () => {
  const result = compileUnitToolContract("custom-step");

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unknown-unit-type");
});

test("auto Unit tool scope blocks complete-slice from saving UAT Assessment", () => {
  const result = shouldBlockAutoUnitToolCall("complete-slice", "gsd_uat_result_save");

  assert.equal(result.block, true);
  assert.match(result.reason ?? "", /Tool Contract failure/);
  assert.match(result.reason ?? "", /Run UAT owns persisted UAT Assessment/);
});

test("auto Unit tool scope HARD BLOCK explains why and what to do (#2877)", () => {
  // A contract-forbidden tool is a deterministic rejection: the reason must
  // tell the model that retries return the same block, that it should stop
  // calling the tool this turn, and what to do instead — a bare mechanical
  // gate message is what turned a one-off mistake into a 425-retry loop.
  const result = shouldBlockAutoUnitToolCall("execute-task", "gsd_complete_milestone");

  assert.equal(result.block, true);
  assert.match(result.reason ?? "", /HARD BLOCK: Tool Contract failure for unit "execute-task"/);
  assert.match(result.reason ?? "", /is not part of this unit's Tool Contract/,
    "the reason must name the contract violation");
  assert.match(result.reason ?? "", /every retry of it returns this\s+same deterministic block/,
    "the reason must warn that retries are futile");
  assert.match(result.reason ?? "", /Stop calling that tool for the rest of this turn/,
    "the reason must say what to do");
  assert.match(result.reason ?? "", /describe the blocker in your response text/,
    "the reason must offer the text-response alternative");
});

test("task-scope HARD BLOCK tells the model to fix the arguments, not stop calling (#2877)", () => {
  // gsd_task_complete IS in the execute-task contract: the block fires on
  // wrong task ids, so the guidance must point at correcting them and
  // re-issuing — "stop calling that tool" would be wrong here.
  const result = shouldBlockAutoUnitToolCall(
    "execute-task",
    "gsd_task_complete",
    { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    "M001/S01/T01",
  );

  assert.equal(result.block, true);
  assert.match(result.reason ?? "", /HARD BLOCK: Tool Contract failure for unit "execute-task"/);
  assert.match(result.reason ?? "", /the arguments are what failed/);
  assert.match(result.reason ?? "", /Re-issue the call with the active task ids named above/);
  assert.doesNotMatch(result.reason ?? "", /Stop calling that tool for the rest of this turn/);
});

test("auto Unit tool scope allows repaired-abort authorization in execute-task", () => {
  for (const toolName of [
    "gsd_task_recovery_resume",
    "mcp__gsd-workflow__gsd_task_recovery_resume",
  ]) {
    const result = shouldBlockAutoUnitToolCall("execute-task", toolName);
    assert.equal(result.block, false, `${toolName} must be available to execute-task recovery`);
  }
});

test("auto Unit tool scope allows plan-slice to reassess invalid roadmap assumptions", () => {
  const result = shouldBlockAutoUnitToolCall("plan-slice", "gsd_reassess_roadmap");

  assert.equal(result.block, false);
});

test("auto Unit tool scope allows status/read helpers named by closeout prompts", () => {
  for (const unitType of ["plan-milestone", "validate-milestone", "complete-milestone", "reassess-roadmap"]) {
    const result = shouldBlockAutoUnitToolCall(unitType, "gsd_milestone_status");
    assert.equal(result.block, false, `${unitType} should be able to call gsd_milestone_status`);
  }
});

test("auto Unit tool scope allows reactive-execute status and diagnostic tools", () => {
  for (const toolName of ["gsd_milestone_status", "gsd_exec"]) {
    const result = shouldBlockAutoUnitToolCall("reactive-execute", toolName);
    assert.equal(result.block, false, `reactive-execute should be able to call ${toolName}`);
  }
});

test("auto Unit tool scope allows incremental task planning during plan-slice", () => {
  const result = shouldBlockAutoUnitToolCall("plan-slice", "gsd_plan_task");
  assert.equal(result.block, false, "plan-slice should be able to call gsd_plan_task incrementally");
});

test("auto Unit tool scope still blocks per-task planner outside plan-slice", () => {
  for (const unitType of ["refine-slice", "replan-slice"]) {
    const result = shouldBlockAutoUnitToolCall(unitType, "gsd_plan_task");
    assert.equal(result.block, true, `${unitType} should not call gsd_plan_task`);
  }
});

test("Recovery Classification covers ADR-015 failure families", () => {
  const cases = [
    ["invalid tool schema enum", "tool-schema", "stop"],
    ["Tool Contract failure: complete-slice cannot use gsd_uat_result_save", "tool-contract", "stop"],
    ["No such tool available: mcp__gsd-workflow__gsd_uat_exec", "tool-unavailable", "retry"],
    ["deterministic policy rejection", "deterministic-policy", "stop"],
    ["cannot legally advance because required UAT Assessment artifact is missing", "lifecycle-progression", "stop"],
    ["stale worker lease", "stale-worker", "stop"],
    ["worktree root missing .git", "worktree-invalid", "stop"],
    ["verification drift in state snapshot", "verification-drift", "escalate"],
    ["projection root operation failed: C:\\repo\\.gsd\\worktrees\\M001: The process cannot access the file because it is being used by another process. (os error 32)", "projection-lock-transient", "retry"],
    ["rate limit 429", "provider", "retry"],
    ["unexpected invariant", "runtime-unknown", "escalate"],
  ] as const;

  for (const [message, failureKind, action] of cases) {
    const result = classifyFailure({ error: new Error(message), unitType: "execute-task", unitId: "T01" });

    assert.equal(result.failureKind, failureKind);
    assert.equal(result.action, action);
  }
});
