// Project/App: gsd-pi
// File Purpose: Tests for opt-in GSD tool surface reduction.

import assert from "node:assert/strict";
import test from "node:test";

import { registerToolCompatibility } from "@gsd/pi-coding-agent";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import { buildMinimalAutoGsdToolSet, buildMinimalGsdToolSet, buildMinimalGsdWorkflowToolSet, buildRequestScopedGsdToolSet, MINIMAL_AUTO_BASE_TOOL_NAMES, MINIMAL_GSD_TOOL_NAMES, requestHasGsdCustomType, restoreGsdWorkflowTools, scopeGsdWorkflowToolsForDispatch } from "../bootstrap/register-hooks.ts";
import { filterToolsForProvider } from "../model-router.ts";
import { applyUnitSkillVisibility } from "../skill-scope.ts";
import { drainLogs } from "../workflow-logger.ts";

test("buildMinimalGsdToolSet preserves non-GSD tools and replaces broad GSD surface", () => {
  const result = buildMinimalGsdToolSet([
    "bash",
    "read",
    "browser_open",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_task_complete",
    "gsd_task_recovery_resume",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "gsd_memory_query",
    "capture_thought",
    "gsd_capture_thought",
    "gsd_graph",
  ]);

  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_open"));
  for (const toolName of MINIMAL_GSD_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(!result.includes("gsd_task_complete"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdToolSet deduplicates preserved and minimal tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "bash", "memory_query"]);

  assert.deepEqual(result.filter((toolName) => toolName === "bash"), ["bash"]);
  assert.deepEqual(result.filter((toolName) => toolName === "memory_query"), ["memory_query"]);
});

test("buildMinimalGsdToolSet does not reintroduce provider-filtered GSD tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "read", "memory_query"]);

  assert.deepEqual(result, ["bash", "read", "memory_query", "ToolSearch"]);
  assert.ok(!result.includes("gsd_exec"));
});

test("buildMinimalGsdToolSet always preserves ToolSearch shim", () => {
  const result = buildMinimalGsdToolSet(["bash", "read"]);
  assert.ok(result.includes("ToolSearch"));
});

test("requestHasGsdCustomType detects GSD-driven requests (drives interactive default scoping)", () => {
  // Plain interactive chat → no gsd-* customType → scoped to the minimal set.
  assert.equal(requestHasGsdCustomType(undefined), false);
  assert.equal(requestHasGsdCustomType([]), false);
  assert.equal(requestHasGsdCustomType([{ customType: "user" }, {}]), false);
  // GSD workflow commands carry a gsd-* customType → keep their full surface.
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-quick-task" }]), true);
  assert.equal(requestHasGsdCustomType([{}, { customType: "gsd-workflow-template" }]), true);
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-run" }]), true);
});

test("buildMinimalAutoGsdToolSet keeps unit-specific completion tools without aliases", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "read",
    "lsp",
    "browser_click",
    "gsd_task_complete",
    "gsd_task_recovery_resume",
    "gsd_complete_task",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_slice_complete",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_task_recovery_resume"));
  assert.ok(result.includes("memory_query"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("browser_click"));
  assert.ok(!result.includes("gsd_complete_task"));
  assert.ok(!result.includes("gsd_slice_complete"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet warns when plan-milestone required tools are unresolved", () => {
  drainLogs();
  const result = buildMinimalAutoGsdToolSet(
    [
      "ask_user_questions",
      "bash",
      "read",
      "gsd_milestone_status",
      "gsd_plan_milestone",
    ],
    "plan-milestone",
    [
      "ask_user_questions",
      "bash",
      "read",
      "gsd_milestone_status",
      "gsd_plan_milestone",
    ],
  );

  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(!result.includes("gsd_plan_slice"));

  const logs = drainLogs();
  assert.ok(
    logs.some((entry) =>
      entry.component === "bootstrap" &&
      entry.message.includes("buildMinimalAutoGsdToolSet(plan-milestone)") &&
      entry.message.includes("gsd_plan_slice")
    ),
    `expected missing gsd_plan_slice bootstrap warning, got ${JSON.stringify(logs)}`,
  );
});

test("buildMinimalAutoGsdToolSet scopes run-uat to UAT-specific and read-only tools", () => {
  const active = ["ask_user_questions", "bash", "read", "edit", "write", "gsd_summary_save"];
  const registered = [
    ...active,
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "gsd_exec",
    "gsd_save_gate_result",
    "search-the-web",
    "browser_navigate",
    "browser_click",
    "browser_snapshot_refs",
  ];
  const result = buildMinimalAutoGsdToolSet(active, "run-uat", registered);
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("gsd_resume"));
  assert.ok(result.includes("gsd_milestone_status"));
  assert.ok(result.includes("gsd_journal_query"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_navigate"), "run-uat needs browser_navigate");
  assert.ok(result.includes("browser_click"), "run-uat needs browser_click");
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
  assert.ok(!result.includes("search-the-web"));
});

test("buildMinimalAutoGsdToolSet keeps only the auto base non-GSD tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "find",
    "glob",
    "grep",
    "fetch_page",
    "search-the-web",
    "lsp",
    "ls",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  for (const toolName of MINIMAL_AUTO_BASE_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
});

test("buildMinimalAutoGsdToolSet re-injects registered base tools filtered from the active set", () => {
  const registered = [
    "bash",
    "read",
    "grep",
    "find",
    "fetch_page",
    "search-the-web",
    "gsd_task_complete",
    "memory_query",
  ];
  const result = buildMinimalAutoGsdToolSet(
    ["bash", "read", "gsd_task_complete", "memory_query"],
    "execute-task",
    registered,
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("fetch_page"));
  assert.ok(result.includes("search-the-web"));
});

test("buildMinimalAutoGsdToolSet preserves compatible browser add-ons for run-uat", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "edit",
    "write",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_assert",
    "browser_screenshot",
    "browser_wait_for",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "subagent",
    "gsd_summary_save",
    "gsd_exec",
    "gsd_save_gate_result",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "run-uat");

  assert.ok(result.includes("browser_navigate"));
  assert.ok(result.includes("browser_click"));
  assert.ok(result.includes("browser_type"));
  assert.ok(result.includes("browser_assert"));
  assert.ok(result.includes("browser_screenshot"));
  assert.ok(result.includes("browser_wait_for"));
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("read"));
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet prefers MCP browser tools for run-uat when available", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "browser_navigate",
    "browser_click",
    "mcp__gsd-browser__browser_navigate",
    "mcp__gsd-browser__browser_click",
    "gsd_summary_save",
  ], "run-uat");

  assert.ok(result.includes("mcp__gsd-browser__browser_navigate"));
  assert.ok(result.includes("mcp__gsd-browser__browser_click"));
  assert.ok(!result.includes("browser_navigate"));
  assert.ok(!result.includes("browser_click"));
});

test("buildMinimalAutoGsdToolSet honors provider-compatible registered tools for run-uat", () => {
  registerToolCompatibility("browser_screenshot", { producesImages: true });
  const registered = [
    "bash",
    "read",
    "ToolSearch",
    "browser_navigate",
    "browser_click",
    "browser_screenshot",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "gsd_exec",
    "gsd_summary_save",
    "gsd_save_gate_result",
  ];
  const providerCompatible = filterToolsForProvider(registered, "openai-responses").compatible;
  const result = buildMinimalAutoGsdToolSet(["gsd_uat_exec"], "run-uat", providerCompatible);

  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_navigate"));
  assert.ok(result.includes("browser_click"));
  assert.ok(!result.includes("browser_screenshot"), "provider-filtered screenshot tool must stay filtered");
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
});

test("buildMinimalAutoGsdToolSet includes discuss-slice persistence tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_plan_slice",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "discuss-slice");

  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_slice"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet includes closeout tool for complete-slice", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "subagent",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_task_complete",
    "gsd_task_reopen",
    "gsd_replan_slice",
    "gsd_slice_complete",
    "gsd_slice_reopen",
    "gsd_journal_query",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
    "gsd_capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("gsd_slice_complete"));
  assert.ok(result.includes("gsd_slice_reopen"));
  assert.ok(result.includes("gsd_task_reopen"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_journal_query"));
  assert.ok(result.includes("gsd_replan_slice"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("gsd_capture_thought"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet preserves workflow MCP-namespaced closeout tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_task_reopen",
    "mcp__gsd-workflow__gsd_task_complete",
    "mcp__gsd-workflow__gsd_replan_slice",
    "mcp__gsd-workflow__gsd_slice_complete",
    "mcp__gsd-workflow__gsd_slice_reopen",
    "mcp__gsd-workflow__gsd_journal_query",
    "mcp__gsd-workflow__gsd_complete_slice",
    "mcp__gsd-workflow__gsd_exec",
    "mcp__gsd-workflow__memory_query",
    "mcp__gsd-workflow__capture_thought",
    "mcp__gsd-workflow__gsd_capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("mcp__gsd-workflow__gsd_task_reopen"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_task_complete"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_replan_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_slice_complete"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_slice_reopen"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_journal_query"));
  assert.ok(!result.includes("mcp__gsd-workflow__gsd_complete_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_exec"));
  assert.ok(result.includes("mcp__gsd-workflow__memory_query"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_capture_thought"));
});

test("buildMinimalAutoGsdToolSet covers execute-task-simple", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_task_complete",
    "gsd_decision_save",
    "gsd_plan_task",
    "memory_query",
    "capture_thought",
  ], "execute-task-simple");

  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_task"));
});

test("buildMinimalGsdWorkflowToolSet keeps workflow GSD tools but drops broad non-GSD tools", () => {
  const result = buildMinimalGsdWorkflowToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "lsp",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_summary_save",
    "memory_query",
    "capture_thought",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_graph",
  ]);

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("bg_shell"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdWorkflowToolSet pulls investigation tools from registered names", () => {
  const result = buildMinimalGsdWorkflowToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save"],
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("ls"));
});

test("buildRequestScopedGsdToolSet keeps grep for guided discuss-milestone requests", () => {
  const result = buildRequestScopedGsdToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    [{ customType: "gsd-discuss" }],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save", "gsd_requirement_update"],
    "discuss-milestone",
  );

  assert.ok(result?.includes("grep"));
  assert.ok(result?.includes("gsd_requirement_update"));
  assert.ok(!result?.includes("gsd_task_complete"));
});

test("buildRequestScopedGsdToolSet scopes queued workflow custom-message requests", () => {
  const result = buildRequestScopedGsdToolSet([
    "ask_user_questions",
    "bash",
    "browser_wait_for",
    "lsp",
    "read",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_graph",
    "memory_query",
    "capture_thought",
  ], [{ customType: "gsd-run" }, { customType: "gsd-memory" }]);

  assert.ok(result);
  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildRequestScopedGsdToolSet ignores stale workflow messages outside the current request tail", () => {
  assert.equal(buildRequestScopedGsdToolSet(["bash", "gsd_plan_milestone"], []), undefined);
});

test("discuss-milestone dispatch keeps required headless milestone tools after two-stage scoping", () => {
  let activeTools = [
    "ask_user_questions",
    "bash",
    "read",
    "write",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
    "gsd_complete_milestone",
    "gsd_task_complete",
  ];

  activeTools = activeTools.filter((toolName) =>
    !toolName.startsWith("gsd_") ||
    DISCUSS_TOOLS_ALLOWLIST.includes(toolName)
  );

  scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
  }, "discuss-milestone");

  assert.ok(activeTools.includes("ask_user_questions"));
  assert.ok(activeTools.includes("gsd_summary_save"));
  assert.ok(activeTools.includes("gsd_requirement_save"));
  assert.ok(activeTools.includes("gsd_requirement_update"));
  assert.ok(activeTools.includes("gsd_plan_milestone"));
  assert.ok(activeTools.includes("gsd_milestone_generate_id"));
  assert.ok(!activeTools.includes("gsd_task_complete"));
  assert.ok(!activeTools.includes("gsd_complete_milestone"));
});

test("#1157: validate-milestone dispatch surface removes generic write and bash tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "edit",
    "find",
    "glob",
    "grep",
    "ls",
    "read",
    "subagent",
    "write",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_validate_milestone",
    "gsd_reassess_roadmap",
  ], "validate-milestone");

  assert.ok(result.includes("read"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("gsd_validate_milestone"));
  assert.ok(result.includes("gsd_milestone_status"));
  assert.ok(result.includes("gsd_exec"));
  assert.ok(result.includes("gsd_reassess_roadmap"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("bg_shell"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("ask_user_questions"));
});

test("scopeGsdWorkflowToolsForDispatch applies and restores per-unit skill visibility", () => {
  const calls: Array<{ kind: "tools" | "skills"; value: string[] | undefined }> = [];
  let activeTools = [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ];
  let visibleSkills: string[] | undefined = ["previous-skill"];

  const state = scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    getVisibleSkills: () => visibleSkills,
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, "plan-milestone");

  assert.ok(state);
  assert.deepEqual(visibleSkills, [
    "write-milestone-brief",
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ]);
  assert.ok(!activeTools.includes("lsp"));

  restoreGsdWorkflowTools({
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, state);

  assert.deepEqual(activeTools, [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ]);
  assert.deepEqual(visibleSkills, ["previous-skill"]);
  assert.equal(calls.filter((call) => call.kind === "skills").length, 2);
});

// ── Regression #534: auto-mode subprocess cannot call gsd_memory_query / gsd_capture_thought ──
// MCP-workflow subprocesses register the gsd_-prefixed variants, not the pi-native names.
// MINIMAL_GSD_TOOL_NAMES must include both so resolveScopedToolNames exposes them.

test("MINIMAL_GSD_TOOL_NAMES includes gsd_memory_query and gsd_capture_thought (regression #534)", () => {
  assert.ok(
    (MINIMAL_GSD_TOOL_NAMES as readonly string[]).includes("gsd_memory_query"),
    "MINIMAL_GSD_TOOL_NAMES must include gsd_memory_query for MCP-workflow surface parity",
  );
  assert.ok(
    (MINIMAL_GSD_TOOL_NAMES as readonly string[]).includes("gsd_capture_thought"),
    "MINIMAL_GSD_TOOL_NAMES must include gsd_capture_thought for MCP-workflow surface parity",
  );
});

test("buildMinimalAutoGsdToolSet resolves MCP-scoped gsd_memory_query and gsd_capture_thought when subprocess only registers gsd_-prefixed variants (regression #534)", () => {
  // Simulate a subprocess that only exposes gsd_-prefixed MCP tool names,
  // not the pi-native memory_query / capture_thought variants.
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_exec",
    "mcp__gsd-workflow__gsd_memory_query",
    "mcp__gsd-workflow__gsd_capture_thought",
  ], "execute-task");

  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_memory_query"),
    "mcp__gsd-workflow__gsd_memory_query must be included when only the gsd_-prefixed variant is available",
  );
  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_capture_thought"),
    "mcp__gsd-workflow__gsd_capture_thought must be included when only the gsd_-prefixed variant is available",
  );
});

// ── Regression #627: auto-mode cannot run plan-milestone because gsd_plan_slice is missing ──
// gsd_plan_slice is in AUTO_UNIT_SCOPED_TOOLS["plan-milestone"] (via unit-tool-contracts).
// buildMinimalAutoGsdToolSet must expose it when unitType is "plan-milestone".

test("buildMinimalAutoGsdToolSet includes gsd_plan_slice for plan-milestone (regression #627)", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
  ], "plan-milestone");

  assert.ok(
    result.includes("gsd_plan_slice"),
    "gsd_plan_slice must be included in plan-milestone auto-mode tool set",
  );
});

test("buildMinimalAutoGsdToolSet resolves MCP-scoped gsd_plan_slice for plan-milestone when subprocess only registers prefixed variant (regression #627)", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_plan_milestone",
    "mcp__gsd-workflow__gsd_plan_slice",
    "mcp__gsd-workflow__gsd_milestone_status",
    "mcp__gsd-workflow__gsd_checkpoint_db",
    "mcp__gsd-workflow__memory_query",
    "mcp__gsd-workflow__capture_thought",
  ], "plan-milestone");

  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_plan_slice"),
    "mcp__gsd-workflow__gsd_plan_slice must be included when only the MCP-scoped variant is available",
  );
});

test("applyUnitSkillVisibility sets manifest or clears for wildcard", () => {
  const calls: Array<string[] | undefined> = [];
  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "plan-milestone");
  assert.ok(Array.isArray(calls[0]));
  assert.ok(calls[0]!.includes("tdd"));

  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "execute-task");
  assert.equal(calls[1], undefined);
});
