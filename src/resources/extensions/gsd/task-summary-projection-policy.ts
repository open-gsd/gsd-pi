// Project/App: gsd-pi
// File Purpose: Shared eligibility policy for staged Task SUMMARY projections.

import {
  isTaskExecutionAttemptOrphaned,
  readLatestSettledTaskAttempt,
  readLatestTaskAttempt,
} from "./task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";

export function isCanonicalStagedTaskSummaryState(input: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}): boolean {
  const latest = readLatestTaskAttempt(input);
  // #2855: a kill between staging (gsd_task_complete) and publication leaves
  // the re-dispatch Attempt orphaned `running` — its coordination dispatch row
  // is already terminal, so no live runner can settle it — on top of the
  // settled+succeeded attempt that legitimately staged the SUMMARY. Read
  // through the orphan to that predecessor so the staged state stays
  // canonical and the sanctioned re-entry routes (re-dispatch → publication,
  // or a bounded clean abort) stay reachable instead of tripping the ADR-047
  // liveness backstop at 2. A running Attempt whose dispatch row can still
  // act stays fail-closed.
  const attempt = isTaskExecutionAttemptOrphaned(latest)
    ? readLatestSettledTaskAttempt(input) ?? latest
    : latest;
  if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") {
    return false;
  }
  if (attempt.nextStage === "verify") return true;
  if (attempt.nextStage !== "route") return false;

  const verdict = readTaskTechnicalVerdict(attempt.attemptId);
  return verdict !== null && verdict.verdict !== "pass";
}
