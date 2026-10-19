// Project/App: gsd-pi
// File Purpose: Every WORKFLOW_TOOL_CONTRACTS executorId names an exported function of the gsd extension.

import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_TOOL_CONTRACTS } from "@opengsd/contracts";
import * as contextStore from "../context-store.ts";
import * as dbWriter from "../db-writer.ts";
import * as gsdDb from "../gsd-db.ts";
import * as journal from "../journal.ts";
import * as projectSnapshot from "../state/project-snapshot.ts";
import * as execSearchTool from "../tools/exec-search-tool.ts";
import * as execTool from "../tools/exec-tool.ts";
import * as memoryTools from "../tools/memory-tools.ts";
import * as milestoneHierarchy from "../tools/milestone-hierarchy.ts";
import * as planTask from "../tools/plan-task.ts";
import * as researchDecision from "../tools/research-decision.ts";
import * as resumeTool from "../tools/resume-tool.ts";
import * as workflowToolExecutors from "../tools/workflow-tool-executors.ts";

// The modules that hold the functions both transports (native tools and the
// workflow MCP server) call to run a workflow tool.
const EXECUTOR_MODULES: ReadonlyArray<Record<string, unknown>> = [
  workflowToolExecutors,
  milestoneHierarchy,
  planTask,
  researchDecision,
  execTool,
  execSearchTool,
  resumeTool,
  memoryTools,
  dbWriter,
  contextStore,
  journal,
  projectSnapshot,
  gsdDb,
];

test("every workflow tool contract executorId resolves to an exported executor", () => {
  const unresolved = WORKFLOW_TOOL_CONTRACTS
    .filter((contract) => !EXECUTOR_MODULES.some((module) => typeof module[contract.executorId] === "function"))
    .map((contract) => `${contract.canonicalName} -> ${contract.executorId}`);

  assert.deepEqual(unresolved, []);
});
