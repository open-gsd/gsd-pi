/**
 * GSD Crash Recovery (Phase C pt 2 — DB-backed)
 *
 * Detects interrupted auto-mode sessions via the DB-backed workers +
 * unit_dispatches + runtime_kv tables. The `LockData` shape is preserved for
 * callers (auto.ts, doctor checks, interrupted-session.ts); for a crashed
 * session its contents are synthesized from:
 *
 *   - workers.pid / .started_at / .last_heartbeat_at  → liveness + age
 *   - unit_dispatches.unit_type / .unit_id / .started_at  → what was running
 *   - runtime_kv("worker", workerId, "session_file")  → pi session JSONL path
 *
 * "Crashed" is detected via workers.status='active' + heartbeat past TTL,
 * cross-checked with the OS PID via isLockProcessAlive(). When the DB is
 * unavailable (fresh project before init), no crash is reported and the lock
 * writers log a warning and skip their DB half.
 *
 * The session lock file (.gsd/auto.lock, see session-lock.ts) is still
 * written. It is never a crash record. readCrashLock reads it only to point
 * at a session whose process is alive now.
 *
 * emitCrashRecoveredUnitEnd is independent of the lock mechanism: it records
 * the unit-end outcome on the unit runtime row and emits the journal event.
 */

import {
  emitJournalEvent,
  queryJournal,
} from "./journal.js";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  findStaleWorkerForProject,
  getAllAutoWorkers,
  markWorkerStopping,
  markWorkerStoppingByPid,
  type AutoWorkerRow,
} from "./db/auto-workers.js";
import { forceReleaseLeasesForWorker } from "./db/milestone-leases.js";
import { markActiveForWorkerCanceled, type DispatchStatus } from "./db/unit-dispatches.js";
import { getRuntimeKv, setRuntimeKv, deleteRuntimeKv } from "./db/runtime-kv.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";
import { gsdRoot, normalizeRealPath } from "./paths.js";
import { crashResumeHint } from "./guidance.js";
import { atomicWriteSync } from "./atomic-write.js";
import { effectiveLockFile } from "./session-lock.js";
import {
  isInFlightRuntimePhase,
  listUnitRuntimeRecords,
  listUnitRuntimeWorkRoots,
  readUnitRuntimeRecord,
  recordUnitEnd,
  type AutoUnitRuntimeRecord,
} from "./unit-runtime.js";
import { settleRunningAttemptsForWorker } from "./task-execution-domain-operation.js";

export interface LockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  /** Path to the pi session JSONL file that was active when this unit started. */
  sessionFile?: string;
  /** The dispatch row of the unit, when the lock comes from one. */
  dispatchId?: number;
}

const SESSION_FILE_KV_KEY = "session_file";

function lockPath(basePath: string): string {
  return join(gsdRoot(basePath), effectiveLockFile());
}

function clearLegacyLockFile(basePath: string): void {
  try {
    const p = lockPath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // Best-effort.
  }
}

function readLegacyLock(basePath: string): LockData | null {
  try {
    const p = lockPath(basePath);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as LockData;
  } catch {
    return null;
  }
}

function findActiveWorkerForCurrentProcess(
  projectRootRealpath: string,
): AutoWorkerRow | null {
  if (!isDbAvailable()) return null;
  const workers = getAllAutoWorkers();
  for (const worker of workers) {
    if (
      worker.pid === process.pid
      && worker.project_root_realpath === projectRootRealpath
    ) {
      return worker;
    }
  }
  return null;
}

/**
 * Look up the most recent dispatch row for a worker, regardless of status.
 * Returns null if the worker has no dispatch history yet (e.g. crashed
 * during bootstrap before claiming the first unit).
 */
function getLatestDispatchForWorker(workerId: string):
  | { id: number; unit_type: string; unit_id: string; started_at: string; status: DispatchStatus }
  | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT id, unit_type, unit_id, started_at, status
     FROM unit_dispatches
     WHERE worker_id = :worker_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":worker_id": workerId }) as
    | { id: number; unit_type: string; unit_id: string; started_at: string; status: DispatchStatus }
    | undefined;
  return row ?? null;
}

function latestInFlightRuntimeRecord(basePath: string): AutoUnitRuntimeRecord | null {
  const records = listUnitRuntimeRecords(basePath).filter((record) =>
    isInFlightRuntimePhase(record.phase),
  );
  if (records.length === 0) return null;
  return records.sort((a, b) => {
    const bTime = b.updatedAt || b.startedAt || 0;
    const aTime = a.updatedAt || a.startedAt || 0;
    return bTime - aTime;
  })[0] ?? null;
}

function runtimeRecordToLockData(worker: AutoWorkerRow, record: AutoUnitRuntimeRecord, sessionFile?: string): LockData {
  const startedAt = Number.isFinite(record.startedAt)
    ? new Date(record.startedAt).toISOString()
    : worker.started_at;
  return {
    pid: worker.pid,
    startedAt: worker.started_at,
    unitType: record.unitType,
    unitId: record.unitId,
    unitStartedAt: startedAt,
    sessionFile,
  };
}

function workerToLockData(basePath: string, worker: AutoWorkerRow): LockData {
  const dispatch = getLatestDispatchForWorker(worker.worker_id);
  const sessionFile =
    getRuntimeKv<string>("worker", worker.worker_id, SESSION_FILE_KV_KEY) ?? undefined;
  if (!dispatch) {
    const runtimeRecord = latestInFlightRuntimeRecord(basePath);
    if (runtimeRecord) return runtimeRecordToLockData(worker, runtimeRecord, sessionFile);
  }
  return {
    pid: worker.pid,
    startedAt: worker.started_at,
    // Pre-Phase-C-pt-2 default: when no dispatch row exists yet (bootstrap
    // crash), report unitType="starting", unitId="bootstrap" — same shape
    // the file-based writer used to produce.
    unitType: dispatch?.unit_type ?? "starting",
    unitId: dispatch?.unit_id ?? "bootstrap",
    unitStartedAt: dispatch?.started_at ?? worker.started_at,
    sessionFile,
    ...(dispatch ? { dispatchId: dispatch.id } : {}),
  };
}

/**
 * Write or update the lock state for the current auto-mode session.
 *
 * The only database state this function adds beyond what the workers +
 * unit_dispatches tables already track is the pi session JSONL path, which
 * lands in runtime_kv (worker scope, key "session_file"). The
 * pid/startedAt/unitType/unitId/unitStartedAt are recorded by
 * registerAutoWorker / heartbeatAutoWorker / recordDispatchClaim already.
 *
 * It also refreshes the session lock file with the current unit, so another
 * terminal and the external readers see what the live session runs.
 */
export function writeLock(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  try {
    const data: LockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      sessionFile,
    };
    atomicWriteSync(lockPath(basePath), JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — never throw from the lock writer.
  }

  if (!isDbAvailable()) {
    logWarning("recovery", "session file pointer not recorded: workflow DB is unavailable");
    return;
  }
  try {
    const projectRoot = normalizeRealPath(basePath);
    const worker = findActiveWorkerForCurrentProcess(projectRoot);
    if (!worker) return;
    if (sessionFile) {
      setRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY, sessionFile);
    } else {
      // Preliminary unit locks (before runUnit/newSession settles) must clear
      // any prior pointer so crash recovery cannot ingest stale cross-unit context.
      deleteRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY);
    }
  } catch {
    // Best-effort — never throw from the lock writer.
  }
}

/**
 * Release the lock state of this project: remove the session lock file,
 * retire a dead holder's worker row and its leases, and drop the
 * session_file runtime_kv row so a follow-up crash detection doesn't pick up
 * a stale session-file pointer.
 */
export function clearLock(basePath: string): void {
  const legacyLock = readLegacyLock(basePath);
  clearLegacyLockFile(basePath);

  if (!isDbAvailable()) {
    logWarning("recovery", "worker row not released: workflow DB is unavailable");
    return;
  }
  try {
    const projectRoot = normalizeRealPath(basePath);
    const staleWorker = findStaleWorkerForProject(projectRoot);
    if (staleWorker) {
      markWorkerStopping(staleWorker.worker_id);
      forceReleaseLeasesForWorker(staleWorker.worker_id);
      deleteRuntimeKv("worker", staleWorker.worker_id, SESSION_FILE_KV_KEY);
      return;
    }
    // #2532: only a dead holder may be marked stopping here. The legacy lock
    // is frequently this process's own unit lock (step-mode exit path), and
    // marking our own live worker row 'stopping' kills the heartbeat and
    // status-gated paths for the rest of the process. isLockProcessAlive
    // treats our own pid as alive (#2470), matching the !isPidAlive guards
    // on the markWorkerStoppingByPid call sites in session-lock.ts.
    if (legacyLock?.pid && !isLockProcessAlive(legacyLock)) {
      markWorkerStoppingByPid(projectRoot, legacyLock.pid);
      const workerByLegacyPid = getAllAutoWorkers().find(
        (w) =>
          w.pid === legacyLock.pid
          && normalizeRealPath(w.project_root_realpath) === projectRoot,
      );
      if (workerByLegacyPid) forceReleaseLeasesForWorker(workerByLegacyPid.worker_id);
    }
    const worker = findActiveWorkerForCurrentProcess(projectRoot);
    if (worker) deleteRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY);

    const stale = findStaleWorkerForProject(projectRoot);
    if (stale) {
      markWorkerStopping(stale.worker_id);
      deleteRuntimeKv("worker", stale.worker_id, SESSION_FILE_KV_KEY);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Clear a stale DB-backed worker lock after readCrashLock/findStaleWorkerForProject
 * has identified a dead worker. Unlike clearLock(), this targets the stale
 * worker row instead of the current process's active worker. It does not
 * touch the session lock file: a live session may own that file.
 */
export function clearStaleWorkerLock(basePath: string): void {
  if (!isDbAvailable()) {
    logWarning("recovery", "stale worker row not cleared: workflow DB is unavailable");
    return;
  }
  try {
    const projectRoot = normalizeRealPath(basePath);
    const worker = findStaleWorkerForProject(projectRoot);
    if (!worker) return;
    markActiveForWorkerCanceled(worker.worker_id, "crash-recovered");
    markWorkerStopping(worker.worker_id);
    try {
      settleRunningAttemptsForWorker(worker.worker_id);
    } finally {
      forceReleaseLeasesForWorker(worker.worker_id);
      deleteRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Detect a previous crashed auto-mode session, or a session that runs now.
 *
 * A crash is synthesized from workers (status='active' + lapsed heartbeat) +
 * unit_dispatches (most recent for that worker) + runtime_kv (session_file).
 * The database alone decides a crash: a lock file whose process is dead is
 * not a crash record, with or without an open database.
 *
 * With no crashed worker, the session lock file is returned when its process
 * is alive, so the callers can see and stop a session in another terminal.
 */
export function readCrashLock(basePath: string): LockData | null {
  if (isDbAvailable()) {
    try {
      const projectRoot = normalizeRealPath(basePath);
      const stale = findStaleWorkerForProject(projectRoot);
      if (stale) return workerToLockData(basePath, stale);
    } catch {
      // No crash record can be read. Only a live session is reported below.
    }
  }
  const sessionLock = readLegacyLock(basePath);
  return sessionLock && isLockProcessAlive(sessionLock) ? sessionLock : null;
}

/**
 * Check whether the process that wrote the lock is still running.
 * Uses `process.kill(pid, 0)` which sends no signal but checks liveness.
 * Returns true if the PID matches our own — we are the lock holder (#2470).
 *
 * Unchanged from the file-based era — pure stateless OS check.
 */
export function isLockProcessAlive(lock: LockData): boolean {
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/** Format crash info for display or injection into a prompt. */
export function formatCrashInfo(lock: LockData): string {
  const lines = [
    `Previous auto-mode session was interrupted.`,
    `  Was executing: ${lock.unitType} (${lock.unitId})`,
    `  Started at: ${lock.unitStartedAt}`,
    `  PID: ${lock.pid}`,
  ];

  const hint = crashResumeHint(lock.unitType, lock.unitId);
  if (hint) lines.push(hint);

  return lines.join("\n");
}

/**
 * Record and emit a synthetic unit-end for a unit that crashed without its own,
 * in every work root that holds a runtime record for the unit.
 */
export function emitCrashRecoveredUnitEnd(basePath: string, lock: LockData): void {
  if (!lock.unitType || !lock.unitId || lock.unitType === "starting") return;
  // The crashed session may have run the unit in a worktree; its record is there.
  for (const root of new Set([basePath, ...listUnitRuntimeWorkRoots(lock.unitType, lock.unitId)])) {
    emitOpenUnitEndForUnit(root, lock.unitType, lock.unitId, "crash-recovered");
  }
}

/**
 * Emit a synthetic unit-end journal event for a unit whose unit-start has
 * no matching unit-end. Also records the outcome on the unit runtime row when
 * the row has none. Returns true if an event was emitted, false if the
 * unit was already closed or no open start was found.
 *
 * Used by emitCrashRecoveredUnitEnd and the dispatch loop crash closeout
 * path. Never throws — journal failure must not block recovery.
 */
export function emitOpenUnitEndForUnit(
  basePath: string,
  unitType: string,
  unitId: string,
  status: string,
  errorContext?: { message: string; category: string; stopReason?: string; isTransient?: boolean; retryAfterMs?: number },
): boolean {
  try {
    // The database row is the outcome that workflow decisions read. Record it
    // for a run that has no outcome yet, whatever the journal holds.
    const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
    if (runtime && !runtime.unitEnd) {
      recordUnitEnd(basePath, unitType, unitId, {
        status,
        artifactVerified: false,
        ...(errorContext ? { error: errorContext.message } : {}),
      });
    }

    const all = queryJournal(basePath);

    const starts = all.filter(
      (e) =>
        e.eventType === "unit-start" &&
        e.data?.unitType === unitType &&
        e.data?.unitId === unitId,
    );
    if (starts.length === 0) return false;

    const lastStart = [...starts].reverse().find((start) => {
      return !all.some(
        (e) =>
          e.eventType === "unit-end" &&
          e.data?.unitType === unitType &&
          e.data?.unitId === unitId &&
          e.causedBy?.flowId === start.flowId &&
          e.causedBy?.seq === start.seq,
      );
    });
    if (!lastStart) return false;

    const alreadyClosed = all.some(
      (e) =>
        e.eventType === "unit-end" &&
        e.data?.unitType === unitType &&
        e.data?.unitId === unitId &&
        e.causedBy?.flowId === lastStart.flowId &&
        e.causedBy?.seq === lastStart.seq,
    );
    if (alreadyClosed) return false;

    const maxSeq = all
      .filter((e) => e.flowId === lastStart.flowId)
      .reduce((max, e) => Math.max(max, e.seq), lastStart.seq);

    emitJournalEvent(basePath, {
      ts: new Date().toISOString(),
      flowId: lastStart.flowId,
      seq: maxSeq + 1,
      eventType: "unit-end",
      data: {
        unitType,
        unitId,
        status,
        artifactVerified: false,
        ...(errorContext ? { errorContext } : {}),
      },
      causedBy: { flowId: lastStart.flowId, seq: lastStart.seq },
    });
    return true;
  } catch {
    // Never throw from crash recovery path.
    return false;
  }
}

/**
 * Used by the doctor checks (doctor-runtime-checks.ts, doctor-proactive.ts)
 * to enumerate stale workers across all projects this DB knows about.
 * Phase C pt 2 export — surface for the same diagnostics that previously
 * iterated `auto.lock` files.
 */
export function findStaleAutoWorker(basePath: string): LockData | null {
  return readCrashLock(basePath);
}
