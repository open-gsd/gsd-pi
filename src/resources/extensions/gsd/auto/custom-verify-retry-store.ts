// Project/App: gsd-pi
// File Purpose: Persistence adapter for verification retry counts. A step of a
// custom workflow run with database rows keeps its count on the step row. Every
// other unit keeps it in custom-verify-retries.json.

import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "../atomic-write.js";
import {
  customWorkflowRunId,
  getCustomWorkflowRun,
  getCustomWorkflowStepVerifyRetries,
} from "../db/custom-workflow-runs.js";
import { setCustomWorkflowStepVerifyRetries } from "../db/writers/custom-workflow-runs.js";
import { gsdRoot } from "../paths.js";
import { parseUnitId } from "../unit-id.js";
import type { AutoSession } from "./session.js";

type RetrySession = Pick<AutoSession, "activeRunDir" | "basePath" | "verificationRetryCount"> & {
  exhaustedVerificationUnits?: Set<string>;
};

interface RetryStoreLogDeps {
  logFailure: (err: unknown) => void;
}

function ensureExhaustedVerificationUnits(s: RetrySession): Set<string> {
  if (!s.exhaustedVerificationUnits) {
    s.exhaustedVerificationUnits = new Set<string>();
  }
  return s.exhaustedVerificationUnits;
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
  const exhaustedUnits = ensureExhaustedVerificationUnits(s);
  if (s.verificationRetryCount.size > 0 || exhaustedUnits.size > 0) {
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
    const exhausted = raw && typeof raw === "object" && Array.isArray(raw.exhausted) ? raw.exhausted : [];
    for (const key of exhausted) {
      if (typeof key === "string" && key.length > 0) {
        exhaustedUnits.add(key);
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
  const exhaustedUnits = ensureExhaustedVerificationUnits(s);
  const filePath = customVerifyRetryStatePath(s);

  try {
    if ((!retryCounts || retryCounts.size === 0) && (!exhaustedUnits || exhaustedUnits.size === 0)) {
      unlinkSync(filePath);
      return;
    }
    mkdirSync(customVerifyRetryStateDir(s), { recursive: true });
    atomicWriteSync(filePath, JSON.stringify({
      counts: Object.fromEntries(retryCounts),
      exhausted: [...exhaustedUnits],
      updatedAt: new Date().toISOString(),
    }) + "\n");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    if (code !== "ENOENT") {
      deps.logFailure(err);
    }
  }
}

/** The step row of a unit, or null when the session runs no custom workflow run that has rows. */
function stepRowOf(
  s: Pick<AutoSession, "activeRunDir">,
  unitId: string,
): { runId: string; stepId: string } | null {
  if (!s.activeRunDir) return null;
  const runId = customWorkflowRunId(s.activeRunDir);
  if (!getCustomWorkflowRun(runId)) return null;
  const { milestone, slice, task } = parseUnitId(unitId);
  return { runId, stepId: task ?? slice ?? milestone };
}

/**
 * Load the retry count of a custom workflow step from its step row, so a
 * restart continues the count. Returns null when the unit has no step row.
 */
export function hydrateCustomStepVerifyRetryCount(
  s: Pick<AutoSession, "activeRunDir" | "verificationRetryCount">,
  unitType: string,
  unitId: string,
): Map<string, number> | null {
  const step = stepRowOf(s, unitId);
  if (!step) return null;
  s.verificationRetryCount.set(
    `${unitType}/${unitId}`,
    getCustomWorkflowStepVerifyRetries(step.runId, step.stepId),
  );
  return s.verificationRetryCount;
}

/**
 * Store the retry count of a custom workflow step on its step row. A unit with
 * no count stores 0. Returns false when the unit has no step row.
 */
export function saveCustomStepVerifyRetryCount(
  s: Pick<AutoSession, "activeRunDir" | "verificationRetryCount">,
  unitType: string,
  unitId: string,
): boolean {
  const step = stepRowOf(s, unitId);
  if (!step) return false;
  setCustomWorkflowStepVerifyRetries(
    step.runId,
    step.stepId,
    s.verificationRetryCount.get(`${unitType}/${unitId}`) ?? 0,
  );
  return true;
}
