// Project/App: gsd-pi
// File Purpose: Executors for gsd_capture_resolve (triage classification) and gsd_capture_complete (quick-task outcome).

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import {
  loadAllCaptures,
  markCaptureExecuted,
  markCaptureResolved,
  VALID_CLASSIFICATIONS,
  type Classification,
} from "../captures.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { deriveState } from "../state.js";
import { logError } from "../workflow-logger.js";
import type { ToolExecutionResult } from "./context-mode-tool-result.js";

export interface CaptureResolveExecutorParams {
  captureId: string;
  classification: string;
  resolution: string;
  rationale: string;
}

export interface CaptureCompleteExecutorParams {
  captureId: string;
  outcome: string;
}

/** Open the database, run one capture Domain Operation and report it. The action returns the success text, or throws with the reason it was refused. */
async function runCaptureTool(
  operation: string,
  basePath: string,
  details: Record<string, unknown>,
  action: () => string | Promise<string>,
): Promise<ToolExecutionResult> {
  try {
    if (!(await ensureDbOpen(basePath))) throw new Error("GSD database is not available.");
    const text = await action();
    return { content: [{ type: "text", text }], details: { operation, ...details } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError("tool", `${operation} tool failed: ${error}`, { tool: `gsd_${operation}` });
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
      details: { operation, error },
      isError: true,
    };
  }
}

/** Classify one capture. The host stamps the active milestone, so a later milestone does not run a stale resolution. */
export function executeCaptureResolve(
  params: CaptureResolveExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { captureId, classification, resolution, rationale } = params;
  return runCaptureTool("capture_resolve", basePath, { captureId, classification }, async () => {
    if (!VALID_CLASSIFICATIONS.includes(classification)) {
      throw new Error(`classification must be one of ${VALID_CLASSIFICATIONS.join(", ")}, got "${classification}"`);
    }
    const milestoneId = (await deriveState(basePath)).activeMilestone?.id;
    markCaptureResolved(basePath, captureId, classification as Classification, resolution, rationale, milestoneId, invocation);
    return `Capture ${captureId} classified as ${classification}.`;
  });
}

/** Record the outcome of a quick-task capture. This row is the only evidence that the quick task ran. */
export function executeCaptureComplete(
  params: CaptureCompleteExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const { captureId, outcome } = params;
  return runCaptureTool("capture_complete", basePath, { captureId }, () => {
    const capture = loadAllCaptures(basePath).find((entry) => entry.id === captureId);
    if (!capture) throw new Error(`capture ${captureId} is not in the GSD database`);
    if (capture.classification !== "quick-task") {
      throw new Error(`capture ${captureId} is not a quick-task (classification: ${capture.classification ?? "none"})`);
    }
    // A retry of the same call, or a second report, writes nothing and gives the same answer.
    if (!capture.executed) markCaptureExecuted(basePath, captureId, { outcome }, invocation);
    return `Capture ${captureId} is recorded as executed.`;
  });
}
