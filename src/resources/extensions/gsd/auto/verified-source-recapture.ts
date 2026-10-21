// Project/App: gsd-pi
// File Purpose: Recapture host-verification source after deferred execute-task closeout git.

import { getSlice, getTask } from "../gsd-db.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
} from "../task-verification-domain-operation.js";
import { parseUnitId } from "../unit-id.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
} from "../verification-source-integrity.js";

export type VerifiedSourceRecaptureResult = "unchanged" | "retry";

/**
 * After deferred execute-task commit/hooks rewrite files, recapture the
 * verification source. A passing verdict at R1 must not be published against R2.
 * Invalidate the pass so the next iteration re-verifies at the coherent revision.
 */
export function recaptureVerifiedSourceAfterDeferredCloseout(input: {
  unitType: string;
  unitId: string;
  basePath: string;
}): VerifiedSourceRecaptureResult {
  if (input.unitType !== "execute-task") return "unchanged";
  const { milestone: milestoneId, slice: sliceId, task: taskId } = parseUnitId(input.unitId);
  if (!milestoneId || !sliceId || !taskId) return "unchanged";

  const attempt = readLatestTaskAttempt({ milestoneId, sliceId, taskId });
  if (!attempt) return "unchanged";
  const verdict = readTaskTechnicalVerdict(attempt.attemptId);
  if (!verdict || verdict.verdict !== "pass") return "unchanged";

  const preferences = loadEffectiveGSDPreferences(input.basePath)?.preferences;
  const task = getTask(milestoneId, sliceId, taskId);
  const slice = getSlice(milestoneId, sliceId);
  const resolved = resolveVerificationRepositoryTargets(input.basePath, preferences, task, slice);
  const targets = resolved.repositories.length > 0
    ? resolved.repositories.map((repository) => ({ id: repository.id, cwd: repository.root }))
    : [{ id: "root", cwd: input.basePath }];
  const source = captureVerificationSourceSnapshot(targets);
  const currentRevision = source.ok ? source.snapshot.aggregateRevision : "unavailable";
  if (source.ok && currentRevision === verdict.testedSourceRevision) return "unchanged";

  const now = new Date().toISOString();
  invalidateTaskTechnicalPass({
    invocation: internalExecutionInvocation(`internal:auto:attempt.verify-drift:${verdict.verdictId}`),
    attemptId: attempt.attemptId,
    supersedesVerdictId: verdict.verdictId,
    rationale: `Stored passing host verdict no longer matches the current verification source (${currentRevision}).`,
    evidence: {
      evidenceClass: "command",
      commandOrTool: "gsd-source-integrity",
      workingDirectory: input.basePath,
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      observation: "inconclusive",
      durableOutputRef: `db://host-verification/${attempt.attemptId}/source-drift`,
      environment: {
        node: process.version,
        platform: process.platform,
        sourceRevisionBefore: verdict.testedSourceRevision,
        sourceRevisionAfter: currentRevision,
      },
    },
  });
  return "retry";
}
