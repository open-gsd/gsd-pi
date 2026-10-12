// Project/App: gsd-pi
// File Purpose: Recapture host-verification source after deferred execute-task closeout git.

import { getSlice, getTask } from "../gsd-db.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
} from "../task-verification-domain-operation.js";
import { logWarning } from "../workflow-logger.js";
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
 *
 * Invalidation is only legal while the Attempt still waits at the verify/route
 * stage. Once publication has advanced the checkpoint chain past that
 * (closeout/settled), the pass can no longer be invalidated — and must not be:
 * the task is already verified and published. That drift is logged as
 * informational and the unit keeps its completed state instead of failing
 * post-unit finalize (#2647).
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

  // The publication pipeline advanced the Attempt past the stages where a
  // passing verdict may be invalidated (#2647). Throwing out of here failed
  // post-unit finalize and abandoned a fully verified, published task.
  if (
    attempt.state === "settled"
    && attempt.outcome === "succeeded"
    && attempt.nextStage !== "verify"
    && attempt.nextStage !== "route"
  ) {
    logWarning("safety", `post-closeout source drift on ${input.unitId} keeps the published verdict: ` +
      `the Attempt is settled at stage ${attempt.nextStage}, so the pass at revision ` +
      `${verdict.testedSourceRevision} can no longer be invalidated or re-verified ` +
      `(current source ${currentRevision}).`, { unitId: input.unitId });
    return "unchanged";
  }

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
