// Project/App: gsd-pi
// File Purpose: Executor for gsd_research_decision_save: record the project research decision in the database.

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { invalidateAllCaches } from "../cache.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { recordResearchDecision } from "../project-setup-facts.js";
import { logError } from "../workflow-logger.js";
import type { ToolExecutionResult } from "./context-mode-tool-result.js";

export interface ResearchDecisionSaveExecutorParams {
  decision: string;
}

function failure(error: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Error: ${error}` }],
    details: { operation: "research_decision_save", error },
    isError: true,
  };
}

/** Record the decision in one project.setup.record Domain Operation keyed by the tool call. */
export async function executeResearchDecisionSave(
  params: ResearchDecisionSaveExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { decision } = params;
  if (decision !== "research" && decision !== "skip") {
    return failure(`decision must be "research" or "skip", got "${decision}"`);
  }
  if (!(await ensureDbOpen(basePath))) {
    return failure("GSD database is not available.");
  }
  try {
    recordResearchDecision(decision, invocation);
    invalidateAllCaches();
    return {
      content: [{ type: "text", text: `Research decision recorded: ${decision}` }],
      details: { operation: "research_decision_save", decision },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("tool", `research_decision_save tool failed: ${message}`, { tool: "gsd_research_decision_save" });
    return failure(message);
  }
}
