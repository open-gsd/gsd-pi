import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyExpectedArtifact } from "./auto-recovery.js";
import {
  formatCrashInfo,
  isLockProcessAlive,
  readCrashLock,
  type LockData,
} from "./crash-recovery.js";
import { gsdRoot } from "./paths.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  synthesizeCrashRecovery,
  type RecoveryBriefing,
} from "./session-forensics.js";
import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";
import { getRuntimeKv, deleteRuntimeKv } from "./db/runtime-kv.js";
import { isDispatchExecutionOpen } from "./db/unit-dispatches.js";
import { closeAutoPause, readOpenAutoPause } from "./db/writers/auto-pauses.js";
import type { AutoPauseBlockerKind } from "./recovery-policy.js";

export type InterruptedSessionClassification =
  | "none"
  | "running"
  | "recoverable"
  | "stale";

export interface PausedSessionMetadata {
  milestoneId?: string;
  worktreePath?: string | null;
  originalBasePath?: string;
  stepMode?: boolean;
  pausedAt?: string;
  sessionFile?: string | null;
  unitType?: string;
  unitId?: string;
  activeEngineId?: string;
  activeRunDir?: string | null;
  autoStartTime?: number;
  milestoneLock?: string | null;
  pauseReason?: string;
  /** Absent on a pause that an older build stored in runtime_kv. */
  blockerKind?: AutoPauseBlockerKind;
  /** The dispatch row of the unit that was active. Null when the pause had no unit with a dispatch row. */
  dispatchId?: number | null;
}

export interface InterruptedSessionAssessment {
  classification: InterruptedSessionClassification;
  lock: LockData | null;
  pausedSession: PausedSessionMetadata | null;
  state: GSDState | null;
  recovery: RecoveryBriefing | null;
  recoveryPrompt: string | null;
  recoveryToolCallCount: number;
  artifactSatisfied: boolean;
  hasResumableDiskState: boolean;
  isBootstrapCrash: boolean;
}

const LEGACY_DEEP_SETUP_UNITS = new Set([
  "workflow-preferences:WORKFLOW-PREFS",
  "discuss-project:PROJECT",
  "discuss-requirements:REQUIREMENTS",
  "research-decision:RESEARCH-DECISION",
  "research-project:RESEARCH-PROJECT",
]);

function isStalePseudoMilestonePause(meta: PausedSessionMetadata): boolean {
  if (meta.activeEngineId && meta.activeEngineId !== "dev") return false;
  if (
    meta.unitType === "discuss-milestone"
    && typeof meta.unitId === "string"
    && !MILESTONE_ID_RE.test(meta.unitId)
  ) {
    return true;
  }
  if (
    typeof meta.unitType === "string"
    && typeof meta.unitId === "string"
    && LEGACY_DEEP_SETUP_UNITS.has(`${meta.unitType}:${meta.unitId}`)
  ) {
    return true;
  }
  return typeof meta.milestoneId === "string"
    && !MILESTONE_ID_RE.test(meta.milestoneId)
    && typeof meta.unitType === "string"
    && typeof meta.unitId === "string"
    && LEGACY_DEEP_SETUP_UNITS.has(`${meta.unitType}:${meta.unitId}`);
}

/**
 * Retired runtime_kv key (global scope) of the paused-session metadata. The
 * pause is the open auto_pauses row of the worker scope now. Nothing writes
 * this key; it is read only for a pause that an older build stored.
 */
export const PAUSED_SESSION_KV_KEY = "paused_session";

/**
 * Return the current active milestone when a standard auto-mode pause points
 * at a different milestone. Such metadata is stale: replaying it would pin
 * auto-mode to work that has already been superseded in the project queue.
 */
export function getSupersedingActiveMilestoneId(
  meta: PausedSessionMetadata | null,
  state: GSDState | null,
): string | null {
  if (meta?.activeEngineId && meta.activeEngineId !== "dev") return null;
  const pausedMilestoneId = meta?.milestoneId;
  const activeMilestoneId = state?.activeMilestone?.id;
  return pausedMilestoneId && activeMilestoneId && pausedMilestoneId !== activeMilestoneId
    ? activeMilestoneId
    : null;
}

/**
 * The stored pause of this worker's scope: the open pause row, or the pause an
 * older build left in runtime_kv when no row is open.
 */
export function readStoredPausedSession(): PausedSessionMetadata | null {
  return readOpenAutoPause()
    ?? getRuntimeKv<PausedSessionMetadata>("global", "", PAUSED_SESSION_KV_KEY);
}

export function readPausedSessionMetadata(
  basePath: string,
): PausedSessionMetadata | null {
  // basePath is unused now (the DB is workspace-scoped via the connection
  // openDatabase opened on it) but kept in the signature for callers.
  void basePath;
  const meta = readStoredPausedSession();
  if (!meta) return null;
  if (isStalePseudoMilestonePause(meta)) {
    clearPausedSession();
    return null;
  }
  return meta;
}

/**
 * Close the pause of this worker's scope and delete the retired runtime_kv
 * key. Throws when no database is open.
 */
export function clearPausedSession(): void {
  closeAutoPause();
  deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
}

export function isBootstrapCrashLock(lock: LockData | null): boolean {
  return !!(
    lock &&
    lock.unitType === "starting" &&
    lock.unitId === "bootstrap"
  );
}

export function hasResumableDerivedState(state: GSDState | null): boolean {
  return !!(state?.activeMilestone && state.phase !== "complete");
}

export async function assessInterruptedSession(
  basePath: string,
): Promise<InterruptedSessionAssessment> {
  const pausedSession = readPausedSessionMetadata(basePath);
  const worktreeExists = pausedSession?.worktreePath
    ? existsSync(pausedSession.worktreePath)
    : false;
  const assessmentBasePath = worktreeExists ? pausedSession!.worktreePath! : basePath;
  const lock = readCrashLock(basePath);

  if (!lock && !pausedSession) {
    return {
      classification: "none",
      lock: null,
      pausedSession: null,
      state: null,
      recovery: null,
      recoveryPrompt: null,
      recoveryToolCallCount: 0,
      artifactSatisfied: false,
      hasResumableDiskState: false,
      isBootstrapCrash: false,
    };
  }

  if (lock && lock.pid !== process.pid && isLockProcessAlive(lock)) {
    return {
      classification: "running",
      lock,
      pausedSession,
      state: null,
      recovery: null,
      recoveryPrompt: null,
      recoveryToolCallCount: 0,
      artifactSatisfied: false,
      hasResumableDiskState: false,
      isBootstrapCrash: false,
    };
  }

  const isBootstrapCrash = isBootstrapCrashLock(lock);
  const state = await deriveState(assessmentBasePath);
  const hasResumableDiskState = hasResumableDerivedState(state);
  // The dispatch row decides first: a unit that left the execute stage has no
  // agent session to continue, so its session file is not replayed.
  const executionEnded = lock?.dispatchId != null && !isDispatchExecutionOpen(lock.dispatchId);
  const artifactSatisfied = !!(
    lock &&
    !isBootstrapCrash &&
    (executionEnded || verifyExpectedArtifact(lock.unitType, lock.unitId, assessmentBasePath))
  );

  let recovery: RecoveryBriefing | null = null;
  if (lock && !isBootstrapCrash && !artifactSatisfied) {
    recovery = synthesizeCrashRecovery(
      assessmentBasePath,
      lock.unitType,
      lock.unitId,
      lock.sessionFile,
      join(gsdRoot(assessmentBasePath), "activity"),
    );
  }

  const recoveryToolCallCount = recovery?.trace.toolCallCount ?? 0;
  const recoveryPrompt = recoveryToolCallCount > 0 ? recovery!.prompt : null;

  if (isBootstrapCrash) {
    return {
      classification: pausedSession ? "recoverable" : "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: true,
    };
  }

  if (!hasResumableDiskState && pausedSession && !lock && recoveryToolCallCount === 0) {
    return {
      classification: "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: false,
    };
  }

  if (lock && artifactSatisfied && !hasResumableDiskState && recoveryToolCallCount === 0) {
    return {
      classification: "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: false,
    };
  }

  const hasStrongRecoverySignal =
    hasResumableDiskState || recoveryToolCallCount > 0;

  return {
    classification: hasStrongRecoverySignal ? "recoverable" : "stale",
    lock,
    pausedSession,
    state,
    recovery,
    recoveryPrompt,
    recoveryToolCallCount,
    artifactSatisfied,
    hasResumableDiskState,
    isBootstrapCrash: false,
  };
}

export function formatInterruptedSessionSummary(
  assessment: InterruptedSessionAssessment,
): string[] {
  if (assessment.lock) return [formatCrashInfo(assessment.lock)];

  if (assessment.pausedSession?.milestoneId) {
    return [
      `Paused auto-mode session detected for ${assessment.pausedSession.milestoneId}.`,
    ];
  }

  return ["Paused auto-mode session detected."];
}

export function formatInterruptedSessionRunningMessage(
  assessment: InterruptedSessionAssessment,
): string {
  const pid = assessment.lock?.pid;
  return pid
    ? `Another auto-mode session (PID ${pid}) appears to be running.\nStop it with \`kill ${pid}\` before starting a new session.`
    : "Another auto-mode session appears to be running.";
}
