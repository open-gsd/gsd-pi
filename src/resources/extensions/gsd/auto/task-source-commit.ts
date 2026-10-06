// Project/App: gsd-pi
// File Purpose: The source commit of an adopted Task as Closeout Effect
// ordinal 1 of its Task Closeout Plan (ADR-050): prepare the plan, run the
// commit, record the Settlement Receipt — before the verified publication.

import { isInAutoWorktree } from "../auto-worktree-entry.js";
import { runTurnGitAction } from "../git-service.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "../preferences.js";
import { readCommittedHeadSha } from "../safety/file-change-validator.js";
import {
  readLatestTaskAttempt,
} from "../task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import {
  TASK_SOURCE_COMMIT_EFFECT,
  prepareTaskCloseout,
  recordTaskSourceCommitReceipt,
  settledTaskSourceCommitReceipt,
} from "../task-closeout.js";
import { resolveUokFlags } from "../uok/flags.js";
import { writeTurnGitTransaction } from "../uok/gitops.js";
import { getSlice, getTask, isDbAvailable } from "../gsd-db.js";
import { parseUnitId } from "../unit-id.js";
import { debugLog } from "../debug-logger.js";

/** A deterministic commit failure the stored git-commit repair retry owns. */
export class TaskSourceCommitRefusedError extends Error {
  readonly failureClass: string;

  constructor(message: string, failureClass: string) {
    super(message);
    this.name = "TaskSourceCommitRefusedError";
    this.failureClass = failureClass;
  }
}

export interface TaskSourceCommitInput {
  basePath: string;
  unitType: string;
  unitId: string;
  traceId: string;
  turnId: string;
}

/**
 * True when the Task's Closeout Plan source commit already carries its
 * Settlement Receipt. The post-verification git action of the legacy order
 * skips such a Task: its commit settled before publication.
 */
export function isTaskSourceCommitSettled(basePath: string, unitId: string): boolean {
  if (!isDbAvailable()) return false;
  const { milestone: milestoneId, slice: sliceId, task: taskId } = parseUnitId(unitId);
  if (!milestoneId || !sliceId || !taskId) return false;
  try {
    return settledTaskSourceCommitReceipt({ milestoneId, sliceId, taskId }) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether GSD owns the Task's source commit here. `git.auto_commit: false`
 * (or a snapshot/status-only turn action) and isolation `none` on the user's
 * own working tree leave the effect out of the plan: publication does not
 * wait for it (ADR-050).
 */
function taskSourceCommitOwned(basePath: string): boolean {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  if (!uokFlags.gitops || uokFlags.gitopsTurnAction !== "commit") return false;
  if (getIsolationMode(basePath) === "none" && !isInAutoWorktree(basePath)) return false;
  return true;
}

/**
 * Settle the source commit of an adopted Task: prepare the Task Closeout
 * Plan for its settled succeeded Attempt, run the commit, and record the
 * effect's Settlement Receipt — `performed` when this run created the commit,
 * `recognized` when the working tree had nothing to commit and the current
 * commit already carries the work (the recognized-merge rule; a restart
 * between commit and receipt lands here and never commits twice). A refused
 * commit records no receipt and raises `TaskSourceCommitRefusedError`; the
 * Task stays unpublished with its Attempt settled and the stored git-commit
 * repair retry (#2618) repairs it. A Task without a canonical lifecycle, and
 * a Task whose commit GSD does not own, skip the effect entirely — the
 * legacy order keeps serving them until P35 deletes it.
 */
export async function settleTaskSourceCommitEffect(
  input: TaskSourceCommitInput,
): Promise<{ settled: boolean }> {
  if (input.unitType !== "execute-task" || !isDbAvailable()) return { settled: false };
  const { milestone: milestoneId, slice: sliceId, task: taskId } = parseUnitId(input.unitId);
  if (!milestoneId || !sliceId || !taskId) return { settled: false };
  const task = { milestoneId, sliceId, taskId };

  const attempt = readLatestTaskAttempt(task);
  if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") return { settled: false };

  const verdict = readTaskTechnicalVerdict(attempt.attemptId);
  if (!verdict || verdict.verdict !== "pass") return { settled: false };

  if (!taskSourceCommitOwned(input.basePath)) return { settled: false };

  const plan = prepareTaskCloseout({
    invocation: {
      idempotencyKey: `internal:auto:task.closeout.prepare:${attempt.attemptId}`,
      sourceTransport: "internal",
      actorType: "agent",
    },
    task,
    attemptId: attempt.attemptId,
    testedSourceRevision: verdict.testedSourceRevision,
  });
  const effect = plan.effects.find((candidate) => candidate.effectKind === TASK_SOURCE_COMMIT_EFFECT);
  if (!effect) return { settled: false };
  if (effect.receipt) return { settled: true };

  const taskRow = getTask(milestoneId, sliceId, taskId);
  const targetRepositories = taskRow?.target_repositories;
  const { buildTaskCommitContextForUnit } = await import("../auto-post-unit.js");
  const taskContext = await buildTaskCommitContextForUnit(input.basePath, input.unitId);

  // The native has-changes cache must not hide staged work from the commit.
  const { _resetHasChangesCache } = await import("../native-git-bridge.js");
  _resetHasChangesCache();

  const gitResult = runTurnGitAction({
    basePath: input.basePath,
    action: "commit",
    unitType: input.unitType,
    unitId: input.unitId,
    taskContext,
    ...(targetRepositories && targetRepositories.length > 0
      ? { targetRepositories }
      : {}),
  });

  const preferences = loadEffectiveGSDPreferences(input.basePath)?.preferences;
  if (resolveUokFlags(preferences).gitops) {
    writeTurnGitTransaction({
      basePath: input.basePath,
      traceId: input.traceId,
      turnId: input.turnId,
      unitType: input.unitType,
      unitId: input.unitId,
      stage: "publish",
      action: "commit",
      push: resolveUokFlags(preferences).gitopsTurnPush,
      status: gitResult.status,
      error: gitResult.error,
      metadata: {
        basePath: input.basePath,
        dirty: gitResult.dirty,
        dirtyRepositories: gitResult.dirtyRepositories,
        commitMessage: gitResult.commitMessage,
        commitMessages: gitResult.commitMessages,
        commitErrors: gitResult.commitErrors,
        failureClass: gitResult.failureClass,
        skippedRepositories: gitResult.skippedRepositories,
      },
    });
  }

  if (gitResult.status === "failed") {
    const detail = gitResult.error ?? "unknown error";
    debugLog("autoLoop", {
      phase: "task-source-commit-refused",
      unitId: input.unitId,
      failureClass: gitResult.failureClass,
      error: detail,
    });
    throw new TaskSourceCommitRefusedError(detail, gitResult.failureClass ?? "commit-failed");
  }

  const performed = Object.keys(gitResult.commitMessages ?? {}).length > 0;
  const commitSha = readCommittedHeadSha(input.basePath) ?? "unknown";
  const receipt = recordTaskSourceCommitReceipt({
    task,
    outcome: performed ? "performed" : "recognized",
    externalRef: commitSha,
    proof: {
      commitSha,
      performed,
      commitMessages: gitResult.commitMessages ?? {},
      dirty: gitResult.dirty === true,
      dirtyRepositories: gitResult.dirtyRepositories ?? {},
    },
  });
  debugLog("autoLoop", {
    phase: "task-source-commit-settled",
    unitId: input.unitId,
    outcome: receipt.outcome,
    commitSha,
  });
  return { settled: true };
}
