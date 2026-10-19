// Project/App: gsd-pi
// File Purpose: Dispatch readiness refuses units whose workflow tools cursor-agent cannot call.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _dispatchWorkflowForTest } from "../guided-flow.ts";
import { getUnitWorkflowDispatchReadinessErrorForModel } from "../tool-contract.ts";

const CURSOR_AGENT = { provider: "cursor-agent", baseUrl: "local://cursor-agent" };
const CLAUDE_CODE = { provider: "claude-code", baseUrl: "local://claude-code" };

function readinessError(model: { provider: string; baseUrl: string }, unitType: string): string | null {
  return getUnitWorkflowDispatchReadinessErrorForModel({
    model,
    getProviderAuthMode: () => "externalCli",
    projectRoot: "/tmp/gsd-cursor-readiness-project",
    env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
    surface: "auto-mode",
    unitType,
  });
}

test("cursor-agent is refused for planning units and the error names provider, unit, missing tools and fix", () => {
  const expectedMissing: Record<string, string[]> = {
    "discuss-milestone": ["ask_user_questions", "gsd_summary_save", "gsd_plan_milestone"],
    "plan-slice": ["gsd_plan_slice", "gsd_plan_task"],
  };

  for (const [unitType, missingTools] of Object.entries(expectedMissing)) {
    const error = readinessError(CURSOR_AGENT, unitType);
    assert.ok(error, `${unitType} must be refused under cursor-agent`);
    assert.match(error, /"cursor-agent"/);
    assert.ok(error.includes(unitType), `error must name the unit: ${error}`);
    for (const tool of missingTools) {
      assert.ok(error.includes(tool), `error must name missing tool ${tool}: ${error}`);
    }
    assert.match(error, /\/gsd model/);
  }
});

test("cursor-agent error names only the tools it cannot call", () => {
  // reactive-execute requires gsd_task_complete (bridged) and gsd_summary_save (not bridged).
  const error = readinessError(CURSOR_AGENT, "reactive-execute");
  assert.ok(error);
  const requiredClause = error.slice(error.indexOf("requires"), error.indexOf(", but"));
  assert.match(requiredClause, /gsd_summary_save/);
  assert.doesNotMatch(requiredClause, /gsd_task_complete/);
});

test("cursor-agent still dispatches execute-task", () => {
  assert.equal(readinessError(CURSOR_AGENT, "execute-task"), null);
});

test("claude-code keeps dispatching planning units and execute-task", () => {
  for (const unitType of ["discuss-milestone", "plan-slice", "execute-task"]) {
    assert.equal(readinessError(CLAUDE_CODE, unitType), null, unitType);
  }
});

test("guided discuss dispatch under cursor-agent stops before the model turn", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-guided-cursor-refusal-"));
  const workflowPath = join(projectRoot, "GSD-WORKFLOW.md");
  const saved = {
    workflowPath: process.env.GSD_WORKFLOW_PATH,
    mcpCommand: process.env.GSD_WORKFLOW_MCP_COMMAND,
    mcpBlocking: process.env.GSD_GUIDED_MCP_BLOCKING,
  };
  const notifications: Array<{ message: string; level: string }> = [];
  let sent = false;

  const ctx = {
    model: CURSOR_AGENT,
    modelRegistry: { getProviderAuthMode: () => "externalCli" },
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };
  const pi = {
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => [],
    setActiveTools: () => {},
    sendMessage: () => {
      sent = true;
    },
  };

  try {
    writeFileSync(workflowPath, "# Workflow\n", "utf-8");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    // A discoverable workflow MCP server and no readiness wait: nothing but
    // the provider's own tool surface can refuse this dispatch.
    process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
    process.env.GSD_GUIDED_MCP_BLOCKING = "0";

    await _dispatchWorkflowForTest(
      pi as any,
      "Discuss the milestone.",
      "gsd-discuss",
      ctx as any,
      "discuss-milestone",
      {
        basePath: projectRoot,
        deps: {
          loadPreferences: () => ({ preferences: {} }) as any,
          selectModel: async () => ({ routing: null, appliedModel: null }) as any,
        },
      },
    );

    assert.equal(sent, false, "no model turn may start");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");
    assert.match(notifications[0].message, /"cursor-agent" cannot run guided flow for discuss-milestone/);
    assert.match(notifications[0].message, /\/gsd model/);
  } finally {
    for (const [key, value] of [
      ["GSD_WORKFLOW_PATH", saved.workflowPath],
      ["GSD_WORKFLOW_MCP_COMMAND", saved.mcpCommand],
      ["GSD_GUIDED_MCP_BLOCKING", saved.mcpBlocking],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
