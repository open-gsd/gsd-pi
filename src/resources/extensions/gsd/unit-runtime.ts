// Project/App: gsd-pi
// File Purpose: Unit runtime record — recovery budget, harness abort, unit-end
// outcome and progress for one unit run.
//
// The database row is the only record that is read. The JSON file under
// .gsd/runtime/units is a diagnostic copy written after each row change; nothing
// reads it back. With no database open there is no record: writes return the
// computed value without storing it and reads return null.

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";
import {
  gsdRoot,
  relTaskFile,
  resolveTaskFile,
} from "./paths.js";
import { loadFile, parseTaskPlanMustHaves, countMustHavesMentionedInSummary } from "./files.js";
import { parseUnitId } from "./unit-id.js";
import { getTask, isDbAvailable } from "./gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { isClosedStatus } from "./status-guards.js";
import {
  deleteUnitRuntimeRow,
  listUnitRuntimeRows,
  readUnitRuntimeRow,
  updateUnitRuntimeRow,
  type UnitRuntimeRow,
} from "./db/writers/runtime-control.js";

export type UnitRuntimePhase =
  | "dispatched"
  | "wrapup-warning-sent"
  | "timeout"
  | "finalize-timeout"
  | "crashed"
  | "recovered"
  | "finalized"
  | "paused"
  | "skipped";

export const IN_FLIGHT_RUNTIME_PHASES: ReadonlySet<UnitRuntimePhase> = new Set([
  "dispatched",
  "wrapup-warning-sent",
  "timeout",
  "finalize-timeout",
  "crashed",
  "paused",
]);

export function isInFlightRuntimePhase(phase: UnitRuntimePhase): boolean {
  return IN_FLIGHT_RUNTIME_PHASES.has(phase);
}

export interface ExecuteTaskRecoveryStatus {
  summaryPath: string;
  summaryExists: boolean;
  dbComplete: boolean;
  mustHaveCount: number;
  mustHavesMentionedInSummary: number;
}

export interface UnitHarnessAbortRecord {
  kind: "tool-loop-guard" | "tool-error" | "turn-abort";
  reason: string;
  toolName?: string;
  count?: number;
  recordedAt: number;
}

/** How the latest run of a unit ended. Written where the unit-end journal event is emitted. */
export interface UnitEndRecord {
  status: string;
  artifactVerified: boolean;
  error?: string;
}

export interface AutoUnitRuntimeRecord {
  version: 1;
  unitType: string;
  unitId: string;
  startedAt: number;
  updatedAt: number;
  phase: UnitRuntimePhase;
  wrapupWarningSent: boolean;
  continueHereFired: boolean;
  timeoutAt: number | null;
  lastProgressAt: number;
  progressCount: number;
  lastProgressKind: string;
  recovery?: ExecuteTaskRecoveryStatus;
  recoveryAttempts?: number;
  lastRecoveryReason?: "idle" | "hard";
  harnessAbort?: UnitHarnessAbortRecord;
  unitEnd?: UnitEndRecord;
}

/** File name of the diagnostic copy of one unit runtime record. */
export function unitRuntimeFileName(unitType: string, unitId: string): string {
  const sanitizedUnitType = unitType.replace(/[\/]/g, "-");
  const sanitizedUnitId = unitId.replace(/[\/]/g, "-");
  return `${sanitizedUnitType}-${sanitizedUnitId}.json`;
}

function diagnosticPath(basePath: string, unitType: string, unitId: string): string {
  return join(gsdRoot(basePath), "runtime", "units", unitRuntimeFileName(unitType, unitId));
}

function recordFromRow(row: UnitRuntimeRow): AutoUnitRuntimeRecord {
  return {
    version: 1,
    unitType: row.unit_type,
    unitId: row.unit_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    phase: row.phase as UnitRuntimePhase,
    wrapupWarningSent: row.wrapup_warning_sent === 1,
    continueHereFired: row.continue_here_fired === 1,
    timeoutAt: row.timeout_at,
    lastProgressAt: row.last_progress_at,
    progressCount: row.progress_count,
    lastProgressKind: row.last_progress_kind,
    recovery: row.recovery_json ? JSON.parse(row.recovery_json) as ExecuteTaskRecoveryStatus : undefined,
    recoveryAttempts: row.recovery_attempts,
    lastRecoveryReason: (row.last_recovery_reason as "idle" | "hard" | null) ?? undefined,
    harnessAbort: row.harness_abort_kind !== null && row.harness_abort_recorded_at !== null
      ? {
          kind: row.harness_abort_kind as UnitHarnessAbortRecord["kind"],
          reason: row.harness_abort_reason ?? "",
          ...(row.harness_abort_tool_name !== null ? { toolName: row.harness_abort_tool_name } : {}),
          ...(row.harness_abort_count !== null ? { count: row.harness_abort_count } : {}),
          recordedAt: row.harness_abort_recorded_at,
        }
      : undefined,
    unitEnd: row.end_status !== null
      ? {
          status: row.end_status,
          artifactVerified: row.end_artifact_verified === 1,
          ...(row.end_error !== null ? { error: row.end_error } : {}),
        }
      : undefined,
  };
}

function rowFromRecord(record: AutoUnitRuntimeRecord): UnitRuntimeRow {
  return {
    unit_type: record.unitType,
    unit_id: record.unitId,
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    phase: record.phase,
    wrapup_warning_sent: record.wrapupWarningSent ? 1 : 0,
    continue_here_fired: record.continueHereFired ? 1 : 0,
    timeout_at: record.timeoutAt,
    last_progress_at: record.lastProgressAt,
    progress_count: record.progressCount,
    last_progress_kind: record.lastProgressKind,
    recovery_attempts: record.recoveryAttempts ?? 0,
    last_recovery_reason: record.lastRecoveryReason ?? null,
    harness_abort_kind: record.harnessAbort?.kind ?? null,
    harness_abort_reason: record.harnessAbort?.reason ?? null,
    harness_abort_tool_name: record.harnessAbort?.toolName ?? null,
    harness_abort_count: record.harnessAbort?.count ?? null,
    harness_abort_recorded_at: record.harnessAbort?.recordedAt ?? null,
    end_status: record.unitEnd?.status ?? null,
    end_artifact_verified: record.unitEnd ? (record.unitEnd.artifactVerified ? 1 : 0) : null,
    end_error: record.unitEnd?.error ?? null,
    recovery_json: record.recovery ? JSON.stringify(record.recovery) : null,
  };
}

/**
 * Read-modify-write one record in a single database write transaction, then
 * write the diagnostic copy. `build` receives the stored record and returns
 * the record to store.
 */
function storeRecord(
  basePath: string,
  unitType: string,
  unitId: string,
  build: (prev: AutoUnitRuntimeRecord | null) => AutoUnitRuntimeRecord,
): AutoUnitRuntimeRecord {
  if (!isDbAvailable()) return build(null);
  const record = recordFromRow(updateUnitRuntimeRow(
    unitType,
    unitId,
    (prev) => rowFromRecord(build(prev ? recordFromRow(prev) : null)),
  ));
  try {
    atomicWriteSync(diagnosticPath(basePath, unitType, unitId), JSON.stringify(record, null, 2) + "\n", "utf-8");
  } catch {
    // Diagnostic copy only — the database row is already stored.
  }
  return record;
}

export function writeUnitRuntimeRecord(
  basePath: string,
  unitType: string,
  unitId: string,
  startedAt: number,
  updates: Partial<AutoUnitRuntimeRecord> = {},
): AutoUnitRuntimeRecord {
  return storeRecord(basePath, unitType, unitId, (prev) => {
    const sameRun = prev?.startedAt === startedAt;
    const updatesHarnessAbort = Object.prototype.hasOwnProperty.call(updates, "harnessAbort");
    return {
      version: 1,
      unitType,
      unitId,
      startedAt,
      updatedAt: Date.now(),
      phase: updates.phase ?? prev?.phase ?? "dispatched",
      wrapupWarningSent: updates.wrapupWarningSent ?? prev?.wrapupWarningSent ?? false,
      continueHereFired: updates.continueHereFired ?? prev?.continueHereFired ?? false,
      timeoutAt: updates.timeoutAt ?? prev?.timeoutAt ?? null,
      lastProgressAt: updates.lastProgressAt ?? prev?.lastProgressAt ?? Date.now(),
      progressCount: updates.progressCount ?? prev?.progressCount ?? 0,
      lastProgressKind: updates.lastProgressKind ?? prev?.lastProgressKind ?? "dispatch",
      recovery: updates.recovery ?? prev?.recovery,
      recoveryAttempts: updates.recoveryAttempts ?? prev?.recoveryAttempts ?? 0,
      lastRecoveryReason: updates.lastRecoveryReason ?? prev?.lastRecoveryReason,
      harnessAbort: updatesHarnessAbort
        ? updates.harnessAbort
        : (sameRun ? prev?.harnessAbort : undefined),
      // A new run starts with no outcome; the outcome of the same run is kept.
      unitEnd: updates.unitEnd ?? (sameRun ? prev?.unitEnd : undefined),
    };
  });
}

/**
 * Record how the latest run of a unit ended. The post-unit hook engine reads
 * this row to decide whether a hook unit succeeded.
 */
export function recordUnitEnd(
  basePath: string,
  unitType: string,
  unitId: string,
  unitEnd: UnitEndRecord,
): AutoUnitRuntimeRecord {
  return storeRecord(basePath, unitType, unitId, (prev) => {
    const now = Date.now();
    return {
      version: 1,
      unitType,
      unitId,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      // A unit that ended before it was dispatched was never in flight.
      phase: prev?.phase ?? "skipped",
      wrapupWarningSent: prev?.wrapupWarningSent ?? false,
      continueHereFired: prev?.continueHereFired ?? false,
      timeoutAt: prev?.timeoutAt ?? null,
      lastProgressAt: prev?.lastProgressAt ?? now,
      progressCount: prev?.progressCount ?? 0,
      lastProgressKind: prev?.lastProgressKind ?? "unit-end",
      recovery: prev?.recovery,
      recoveryAttempts: prev?.recoveryAttempts ?? 0,
      lastRecoveryReason: prev?.lastRecoveryReason,
      harnessAbort: prev?.harnessAbort,
      unitEnd,
    };
  });
}

export function recordUnitHarnessAbort(
  basePath: string,
  unitType: string,
  unitId: string,
  startedAt: number,
  abort: Omit<UnitHarnessAbortRecord, "recordedAt"> & { recordedAt?: number },
): AutoUnitRuntimeRecord {
  return storeRecord(basePath, unitType, unitId, (prev) => {
    const sameRun = prev?.startedAt === startedAt;
    if (sameRun && prev?.harnessAbort?.kind === "turn-abort" && abort.kind === "tool-error") {
      return prev;
    }
    return {
      version: 1,
      unitType,
      unitId,
      startedAt,
      updatedAt: Date.now(),
      phase: prev?.phase ?? "dispatched",
      wrapupWarningSent: prev?.wrapupWarningSent ?? false,
      continueHereFired: prev?.continueHereFired ?? false,
      timeoutAt: prev?.timeoutAt ?? null,
      lastProgressAt: Date.now(),
      progressCount: prev?.progressCount ?? 0,
      lastProgressKind: `harness-abort:${abort.kind}`,
      recovery: prev?.recovery,
      recoveryAttempts: prev?.recoveryAttempts ?? 0,
      lastRecoveryReason: prev?.lastRecoveryReason,
      harnessAbort: {
        ...abort,
        recordedAt: abort.recordedAt ?? Date.now(),
      },
      unitEnd: sameRun ? prev?.unitEnd : undefined,
    };
  });
}

export function clearUnitHarnessAbort(
  basePath: string,
  unitType: string,
  unitId: string,
  startedAt: number,
  expectedKind?: UnitHarnessAbortRecord["kind"],
): AutoUnitRuntimeRecord {
  return storeRecord(basePath, unitType, unitId, (prev) => {
    if (!prev) {
      return {
        version: 1,
        unitType,
        unitId,
        startedAt,
        updatedAt: Date.now(),
        phase: "dispatched",
        wrapupWarningSent: false,
        continueHereFired: false,
        timeoutAt: null,
        lastProgressAt: Date.now(),
        progressCount: 0,
        lastProgressKind: "dispatch",
        recoveryAttempts: 0,
      };
    }
    if (prev.startedAt !== startedAt) return prev;
    if (expectedKind && prev.harnessAbort?.kind !== expectedKind) return prev;
    return {
      ...prev,
      updatedAt: Date.now(),
      lastProgressAt: Date.now(),
      lastProgressKind: "harness-abort-cleared",
      harnessAbort: undefined,
    };
  });
}

export function readUnitRuntimeRecord(_basePath: string, unitType: string, unitId: string): AutoUnitRuntimeRecord | null {
  const row = readUnitRuntimeRow(unitType, unitId);
  return row ? recordFromRow(row) : null;
}

export function readUnitHarnessAbort(
  basePath: string,
  unitType: string,
  unitId: string,
  startedAt: number,
): UnitHarnessAbortRecord | null {
  const record = readUnitRuntimeRecord(basePath, unitType, unitId);
  if (!record || record.startedAt !== startedAt) return null;
  return record.harnessAbort ?? null;
}

export function clearUnitRuntimeRecord(basePath: string, unitType: string, unitId: string): void {
  deleteUnitRuntimeRow(unitType, unitId);
  const path = diagnosticPath(basePath, unitType, unitId);
  if (existsSync(path)) unlinkSync(path);
}

/** Return every unit runtime record in the database. */
export function listUnitRuntimeRecords(_basePath: string): AutoUnitRuntimeRecord[] {
  return listUnitRuntimeRows().map(recordFromRow);
}

export async function inspectExecuteTaskDurability(
  basePath: string,
  unitId: string,
): Promise<ExecuteTaskRecoveryStatus | null> {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) return null;

  const summaryAbs = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  const summaryPath = relTaskFile(basePath, mid, sid, tid, "SUMMARY");
  const summaryExists = !!(summaryAbs && existsSync(summaryAbs));

  // Task status comes from the database. The PLAN checkbox and the STATE.md
  // next action are projections that can lag it, so they are not read.
  let dbComplete = false;
  if (isDbAvailable()) {
    refreshWorkflowDatabaseFromDisk();
    const task = getTask(mid, sid, tid);
    dbComplete = !!task && isClosedStatus(task.status);
  }

  // Must-have coverage: load task plan and count mentions in summary
  let mustHaveCount = 0;
  let mustHavesMentionedInSummary = 0;

  const taskPlanAbs = resolveTaskFile(basePath, mid, sid, tid, "PLAN");
  if (taskPlanAbs) {
    const taskPlanContent = await loadFile(taskPlanAbs);
    if (taskPlanContent) {
      const mustHaves = parseTaskPlanMustHaves(taskPlanContent);
      mustHaveCount = mustHaves.length;
      if (mustHaveCount > 0 && summaryExists && summaryAbs) {
        const summaryContent = await loadFile(summaryAbs);
        if (summaryContent) {
          mustHavesMentionedInSummary = countMustHavesMentionedInSummary(mustHaves, summaryContent);
        }
      }
    }
  }

  return {
    summaryPath,
    summaryExists,
    dbComplete,
    mustHaveCount,
    mustHavesMentionedInSummary,
  };
}

export function formatExecuteTaskRecoveryStatus(status: ExecuteTaskRecoveryStatus): string {
  if (status.dbComplete) return "DB task status is closed";
  const missing = ["DB task status is not closed"];
  if (!status.summaryExists) missing.push(`summary missing (${status.summaryPath})`);
  if (status.mustHaveCount > 0 && status.mustHavesMentionedInSummary < status.mustHaveCount) {
    missing.push(`must-have gap: ${status.mustHavesMentionedInSummary} of ${status.mustHaveCount} must-haves addressed in summary`);
  }
  return missing.join("; ");
}
