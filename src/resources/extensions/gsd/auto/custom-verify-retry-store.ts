// Project/App: gsd-pi
// File Purpose: Persistence adapter for verification retry counts. A step of a
// custom workflow run keeps its count on the step row. The dev path keeps its
// counts and exhausted units in custom-verify-retries.json.

import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "../atomic-write.js";
import { stepIdOfUnit } from "../custom-workflow-engine.js";
import {
  customWorkflowRunId,
  getCustomWorkflowStepVerifyRetries,
} from "../db/custom-workflow-runs.js";
import { setCustomWorkflowStepVerifyRetries } from "../db/writers/custom-workflow-runs.js";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.js";
import { gsdRoot } from "../paths.js";
import type { AutoSession } from "./session.js";

type RetrySession = Pick<AutoSession, "activeRunDir" | "basePath" | "verificationRetryCount">;

interface RetryStoreLogDeps {
  logFailure: (err: unknown) => void;
}

export function customVerifyRetryStateDir(s: Pick<AutoSession, "activeRunDir" | "basePath">): string {
  return s.activeRunDir ? join(s.activeRunDir, "runtime") : join(gsdRoot(s.basePath), "runtime");
}

export function customVerifyRetryStatePath(s: Pick<AutoSession, "activeRunDir" | "basePath">): string {
  return join(customVerifyRetryStateDir(s), "custom-verify-retries.json");
}

export function hydrateCustomVerifyRetryCounts(
  s: RetrySession,
  deps: RetryStoreLogDeps,
): Map<string, number> {
  if (s.verificationRetryCount.size > 0) {
    return s.verificationRetryCount;
  }

  try {
    const raw = JSON.parse(readFileSync(customVerifyRetryStatePath(s), "utf-8"));
    const counts = raw && typeof raw === "object" && raw.counts && typeof raw.counts === "object"
      ? raw.counts as Record<string, unknown>
      : {};
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        s.verificationRetryCount.set(key, Math.floor(value));
      }
    }
  } catch (err) {
    deps.logFailure(err);
  }

  return s.verificationRetryCount;
}

export function saveCustomVerifyRetryCounts(
  s: RetrySession,
  deps: RetryStoreLogDeps,
): void {
  const retryCounts = s.verificationRetryCount;
  const filePath = customVerifyRetryStatePath(s);

  try {
    if (!retryCounts || retryCounts.size === 0) {
      unlinkSync(filePath);
      return;
    }
    mkdirSync(customVerifyRetryStateDir(s), { recursive: true });
    atomicWriteSync(filePath, JSON.stringify({
      counts: Object.fromEntries(retryCounts),
      updatedAt: new Date().toISOString(),
    }) + "\n");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    if (code !== "ENOENT") {
      deps.logFailure(err);
    }
  }
}

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
