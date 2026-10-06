// Project/App: gsd-pi
// File Purpose: The typed workflow outcome event (ADR-046). When auto-mode
// stops or pauses, the extension emits a `workflow_outcome` event on the
// session stream so the hosts derive the run's terminal state from the typed
// event; the notification-text classifiers stay as a fallback for runs of an
// older extension. Exit codes keep their meaning: completed → 0, error and
// timeout → 1, blocked → 10, cancelled → 11.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import {
  parseWorkflowOutcomeCustomMessage,
  WORKFLOW_OUTCOME_CUSTOM_TYPE,
  type RpcWorkflowOutcomeEvent,
  type WorkflowOutcomeStatus,
} from "@opengsd/contracts";

export { parseWorkflowOutcomeCustomMessage, WORKFLOW_OUTCOME_CUSTOM_TYPE };
export type { RpcWorkflowOutcomeEvent, WorkflowOutcomeStatus };

export function workflowOutcomeExitCode(status: WorkflowOutcomeStatus): 0 | 1 | 10 | 11 {
  switch (status) {
    case "completed":
      return 0;
    case "error":
    case "timeout":
      return 1;
    case "blocked":
      return 10;
    case "cancelled":
      return 11;
  }
}

export interface WorkflowOutcomeInput {
  status: WorkflowOutcomeStatus;
  reason?: string;
  unitType?: string;
  unitId?: string;
}

/** Build the contract event. Separated from the send so tests assert on it. */
export function buildWorkflowOutcomeEvent(input: WorkflowOutcomeInput): RpcWorkflowOutcomeEvent {
  const event: RpcWorkflowOutcomeEvent = {
    type: "workflow_outcome",
    status: input.status,
    exitCode: workflowOutcomeExitCode(input.status),
  };
  if (input.reason) event.reason = input.reason;
  if (input.unitType) event.unitType = input.unitType;
  if (input.unitId) event.unitId = input.unitId;
  return event;
}

/**
 * Emit the typed outcome of the run. Best-effort: a session without
 * `sendMessage` (some embedded contexts) silently emits nothing, and the
 * hosts fall back to the notification text.
 */
export function emitWorkflowOutcomeEvent(
  pi: ExtensionAPI | undefined | null,
  input: WorkflowOutcomeInput,
): void {
  if (!pi || typeof pi.sendMessage !== "function") return;
  const event = buildWorkflowOutcomeEvent(input);
  try {
    void pi.sendMessage({
      customType: WORKFLOW_OUTCOME_CUSTOM_TYPE,
      content: JSON.stringify(event),
      display: false,
    });
  } catch {
    // The hosts' text classification still decides the run's outcome.
  }
}

/**
 * Read the typed outcome from a stream event: either the v2 `workflow_outcome`
 * event the RPC host synthesizes from the custom message, or the raw custom
 * message itself on a v1 stream. Null when the event carries no outcome.
 */
export function parseWorkflowOutcomeEvent(event: Record<string, unknown>): RpcWorkflowOutcomeEvent | null {
  if (event["type"] === "workflow_outcome") {
    const status = event["status"];
    const exitCode = event["exitCode"];
    if (typeof status !== "string") return null;
    if (exitCode !== 0 && exitCode !== 1 && exitCode !== 10 && exitCode !== 11) return null;
    return event as unknown as RpcWorkflowOutcomeEvent;
  }
  return parseWorkflowOutcomeCustomMessage(event as Parameters<typeof parseWorkflowOutcomeCustomMessage>[0]);
}
