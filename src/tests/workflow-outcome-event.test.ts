// Project/App: gsd-pi
// File Purpose: Behavior tests for the typed workflow outcome event (ADR-046):
// the extension emits it on the session stream, the exit codes keep their
// meaning (0/1/10/11), and the hosts parse it from both the v2 event and the
// raw custom message.

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkflowOutcomeCustomMessage,
  WORKFLOW_OUTCOME_CUSTOM_TYPE,
} from "../../packages/contracts/src/index.ts";
import {
  buildWorkflowOutcomeEvent,
  parseWorkflowOutcomeEvent,
} from "../resources/extensions/gsd/workflow-outcome-event.ts";

test("the outcome exit codes keep their meaning: 0/1/10/11", () => {
  assert.deepEqual(buildWorkflowOutcomeEvent({ status: "completed" }), {
    type: "workflow_outcome", status: "completed", exitCode: 0,
  });
  assert.deepEqual(buildWorkflowOutcomeEvent({ status: "error" }), {
    type: "workflow_outcome", status: "error", exitCode: 1,
  });
  assert.deepEqual(buildWorkflowOutcomeEvent({ status: "timeout" }), {
    type: "workflow_outcome", status: "timeout", exitCode: 1,
  });
  assert.deepEqual(buildWorkflowOutcomeEvent({ status: "blocked" }), {
    type: "workflow_outcome", status: "blocked", exitCode: 10,
  });
  assert.deepEqual(buildWorkflowOutcomeEvent({ status: "cancelled" }), {
    type: "workflow_outcome", status: "cancelled", exitCode: 11,
  });
  const withContext = buildWorkflowOutcomeEvent({
    status: "blocked",
    reason: "Validation failed for milestone M001",
    unitType: "validate-milestone",
    unitId: "M001",
  });
  assert.equal(withContext.reason, "Validation failed for milestone M001");
  assert.equal(withContext.unitType, "validate-milestone");
  assert.equal(withContext.unitId, "M001");
});

test("the hosts read the outcome from the v2 event and from the raw custom message", () => {
  const blocked = buildWorkflowOutcomeEvent({ status: "blocked", reason: "needs a decision" });

  // v2 stream: the RPC host synthesizes the contract event.
  assert.deepEqual(parseWorkflowOutcomeEvent({ type: "workflow_outcome", ...blocked }), blocked);

  // v1 stream: the raw custom message carries the same payload.
  const customMessage = {
    type: "message_end",
    message: {
      customType: WORKFLOW_OUTCOME_CUSTOM_TYPE,
      content: JSON.stringify(blocked),
    },
  };
  assert.deepEqual(parseWorkflowOutcomeEvent(customMessage), blocked);
  assert.deepEqual(parseWorkflowOutcomeCustomMessage(customMessage), blocked);
});

test("the typed outcome decides blocked without any text marker", () => {
  // The demotion of isBlockedNoticeMessage: a blocked outcome whose reason
  // carries no "blocked:" marker and none of the notice prefixes still
  // resolves as blocked from the event alone.
  const outcome = buildWorkflowOutcomeEvent({ status: "blocked", reason: "Validation failed for milestone M001" });
  const parsed = parseWorkflowOutcomeEvent({
    type: "message_end",
    message: { customType: WORKFLOW_OUTCOME_CUSTOM_TYPE, content: JSON.stringify(outcome) },
  });
  assert.equal(parsed?.status, "blocked");
  assert.equal(parsed?.exitCode, 10);
});

test("events without an outcome parse as null", () => {
  assert.equal(parseWorkflowOutcomeEvent({ type: "message_end", message: { role: "assistant" } }), null);
  assert.equal(parseWorkflowOutcomeEvent({ type: "agent_end" }), null);
  assert.equal(
    parseWorkflowOutcomeEvent({
      type: "message_end",
      message: { customType: WORKFLOW_OUTCOME_CUSTOM_TYPE, content: "not json" },
    }),
    null,
  );
  assert.equal(
    parseWorkflowOutcomeEvent({
      type: "message_end",
      message: { customType: WORKFLOW_OUTCOME_CUSTOM_TYPE, content: JSON.stringify({ type: "workflow_outcome", status: "blocked", exitCode: 3 }) },
    }),
    null,
    "an exit code outside 0/1/10/11 is not an outcome",
  );
  assert.equal(
    parseWorkflowOutcomeEvent({
      type: "message_end",
      message: { customType: "gsd-command-block", content: "Auto-mode blocked — milestone M001" },
    }),
    null,
    "the command-block channel carries no outcome",
  );
});
