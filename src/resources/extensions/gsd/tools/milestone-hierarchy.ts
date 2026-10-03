// Project/App: gsd-pi
// File Purpose: Executors for the milestone hierarchy tools: park, unpark, discard, reorder and set dependencies.

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { invalidateAllCaches } from "../cache.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { getMilestone } from "../gsd-db.js";
import { discardMilestone, parkMilestone, unparkMilestone } from "../milestone-actions.js";
import { reorderMilestones, setMilestoneDependencies } from "../queue-order.js";
import { logError } from "../workflow-logger.js";
import type { ToolExecutionResult } from "./context-mode-tool-result.js";

export interface MilestoneParkExecutorParams {
  milestoneId: string;
  reason: string;
}

export interface MilestoneUnparkExecutorParams {
  milestoneId: string;
}

export interface MilestoneDiscardExecutorParams {
  milestoneId: string;
  reason: string;
}

export interface MilestoneReorderExecutorParams {
  order: string[];
}

export interface MilestoneSetDependenciesExecutorParams {
  milestoneId: string;
  dependsOn: string[];
}

function failure(operation: string, error: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Error: ${error}` }],
    details: { operation, error },
    isError: true,
  };
}

/**
 * Open the database, run one hierarchy Domain Operation and report it. The
 * action returns the success text, or throws with the reason it was refused.
 */
async function runHierarchyTool(
  operation: string,
  basePath: string,
  details: Record<string, unknown>,
  action: () => string | Promise<string>,
): Promise<ToolExecutionResult> {
  if (!(await ensureDbOpen(basePath))) {
    return failure(operation, "GSD database is not available.");
  }
  try {
    const text = await action();
    invalidateAllCaches();
    return { content: [{ type: "text", text }], details: { operation, ...details } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("tool", `${operation} tool failed: ${message}`, { tool: `gsd_${operation}` });
    return failure(operation, message);
  }
}

/** Why a park or unpark changed nothing, from the milestone row. */
function refusal(milestoneId: string, verb: string): Error {
  const status = getMilestone(milestoneId)?.status;
  return new Error(status === undefined
    ? `milestone ${milestoneId} does not exist`
    : `milestone ${milestoneId} cannot be ${verb} (status: ${status})`);
}

export function executeMilestonePark(
  params: MilestoneParkExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { milestoneId, reason } = params;
  return runHierarchyTool("milestone_park", basePath, { milestoneId, reason }, async () => {
    if (!(await parkMilestone(basePath, milestoneId, reason, { invocation }))) throw refusal(milestoneId, "parked");
    return `Parked milestone ${milestoneId}. Reason: ${reason}`;
  });
}

export function executeMilestoneUnpark(
  params: MilestoneUnparkExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { milestoneId } = params;
  return runHierarchyTool("milestone_unpark", basePath, { milestoneId }, async () => {
    if (!(await unparkMilestone(basePath, milestoneId, invocation))) throw refusal(milestoneId, "unparked");
    return `Unparked milestone ${milestoneId}.`;
  });
}

export function executeMilestoneDiscard(
  params: MilestoneDiscardExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { milestoneId, reason } = params;
  return runHierarchyTool("milestone_discard", basePath, { milestoneId, reason }, async () => {
    if (!(await discardMilestone(basePath, milestoneId, { reason, invocation }))) throw refusal(milestoneId, "discarded");
    return `Discarded milestone ${milestoneId}. Its open work is cancelled and its files are removed. Reason: ${reason}`;
  });
}

export function executeMilestoneReorder(
  params: MilestoneReorderExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { order } = params;
  return runHierarchyTool("milestone_reorder", basePath, { order }, () => {
    reorderMilestones(basePath, order, [], invocation);
    return `Queue order is now: ${order.join(" → ")}`;
  });
}

export function executeMilestoneSetDependencies(
  params: MilestoneSetDependenciesExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { milestoneId, dependsOn } = params;
  return runHierarchyTool("milestone_set_dependencies", basePath, { milestoneId, dependsOn }, () => {
    setMilestoneDependencies(milestoneId, dependsOn, invocation);
    return dependsOn.length > 0
      ? `Milestone ${milestoneId} now depends on: ${dependsOn.join(", ")}`
      : `Milestone ${milestoneId} now has no dependencies.`;
  });
}
