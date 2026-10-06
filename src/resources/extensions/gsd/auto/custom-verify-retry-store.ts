// Project/App: gsd-pi
// File Purpose: Persistence adapter for verification retry counts. A step of a
// custom workflow run keeps its count on its custom_workflow_steps row
// (verify_retries); the session map serves the close-out that is in progress.
// There is no JSON file: custom-verify-retries.json is gone.

import { stepIdOfUnit } from "../custom-workflow-engine.js";
import {
  customWorkflowRunId,
  getCustomWorkflowStepVerifyRetries,
} from "../db/custom-workflow-runs.js";
import { setCustomWorkflowStepVerifyRetries } from "../db/writers/custom-workflow-runs.js";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.js";
import type { AutoSession } from "./session.js";

type RetrySession = Pick<AutoSession, "activeRunDir" | "verificationRetryCount">;

/** The step row key of a custom workflow unit. */
function stepRowOf(
  s: Pick<AutoSession, "activeRunDir">,
  unitId: string,
): { runId: string; stepId: string } {
  if (!s.activeRunDir) throw new Error(`Custom workflow unit ${unitId} has no active run directory`);
  return { runId: customWorkflowRunId(s.activeRunDir), stepId: stepIdOfUnit(unitId) };
}

/**
 * Load the retry count of a custom workflow step from its step row, so a
 * restart continues the count.
 */
export function hydrateCustomStepVerifyRetryCount(
  s: Pick<AutoSession, "activeRunDir" | "verificationRetryCount">,
  unitType: string,
  unitId: string,
): Map<string, number> {
  const step = stepRowOf(s, unitId);
  s.verificationRetryCount.set(
    `${unitType}/${unitId}`,
    getCustomWorkflowStepVerifyRetries(step.runId, step.stepId),
  );
  return s.verificationRetryCount;
}

/**
 * Store the retry count of a custom workflow step on its step row with a
 * Domain Operation. A unit with no count stores 0. A count that is already
 * stored writes nothing.
 */
export function saveCustomStepVerifyRetryCount(
  s: Pick<AutoSession, "activeRunDir" | "verificationRetryCount">,
  unitType: string,
  unitId: string,
): void {
  const step = stepRowOf(s, unitId);
  const fence = readDomainOperationFence();
  const used = s.verificationRetryCount.get(`${unitType}/${unitId}`) ?? 0;
  if (getCustomWorkflowStepVerifyRetries(step.runId, step.stepId) === used) return;
  setCustomWorkflowStepVerifyRetries({ fence, ...step, used });
}
