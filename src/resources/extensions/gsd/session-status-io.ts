/**
 * GSD Session Status I/O
 *
 * Coordinator-worker communication in parallel milestone orchestration.
 * Each worker status is a file; the coordinator reads all status files to
 * monitor progress. Atomic writes (write to .tmp, then rename) prevent
 * partial reads.
 *
 * A pause/resume/stop/rebase signal is a command_queue row in the project
 * database, targeted at the worker's milestone. There is no signal file.
 * Stale detection combines PID liveness checks with heartbeat timeouts.
 */

import {
  unlinkSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull, writeJsonFileAtomic } from "./json-persistence.js";
import { dropPendingCommands, enqueueCommand, takeNextCommand } from "./db/command-queue.js";
import { logWarning } from "./workflow-logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionStatus {
  milestoneId: string;
  pid: number;
  state: "running" | "paused" | "stopped" | "error";
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: number;
  cost: number;
  lastHeartbeat: number;
  startedAt: number;
  worktreePath: string;
}

export type SessionSignal = "pause" | "resume" | "stop" | "rebase";

export interface SignalMessage {
  signal: SessionSignal;
  sentAt: number;
  from: "coordinator";
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PARALLEL_DIR = "parallel";
const STATUS_SUFFIX = ".status.json";
const DEFAULT_STALE_TIMEOUT_MS = 30_000;
// How long a paused worker waits for the coordinator to lift the pause before
// it degrades to in-process serialization (#1273). Kept below the stale
// timeout so the wait never races the coordinator's liveness detection.
const DEFAULT_RESUME_WAIT_MS = 10_000;
const DEFAULT_RESUME_POLL_MS = 250;

function isSessionStatus(data: unknown): data is SessionStatus {
  return data !== null && typeof data === "object" && "milestoneId" in data && "pid" in data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parallelDir(basePath: string): string {
  return join(gsdRoot(basePath), PARALLEL_DIR);
}

function statusPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${STATUS_SUFFIX}`);
}

function ensureParallelDir(basePath: string): void {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Status I/O ────────────────────────────────────────────────────────────

/** Write session status atomically (write to .tmp, then rename). */
export function writeSessionStatus(basePath: string, status: SessionStatus): void {
  ensureParallelDir(basePath);
  writeJsonFileAtomic(statusPath(basePath, status.milestoneId), status);
}

/** Read a specific milestone's session status. */
export function readSessionStatus(basePath: string, milestoneId: string): SessionStatus | null {
  return loadJsonFileOrNull(statusPath(basePath, milestoneId), isSessionStatus);
}

/** Read all session status files from .gsd/parallel/. */
export function readAllSessionStatuses(basePath: string): SessionStatus[] {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) return [];

  const results: SessionStatus[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(STATUS_SUFFIX)) continue;
      const status = loadJsonFileOrNull(join(dir, entry), isSessionStatus);
      if (status) results.push(status);
    }
  } catch { /* non-fatal */ }
  return results;
}

/**
 * Remove a milestone's session status file. The session is over, so a signal
 * its worker did not take is closed and does not reach the next worker.
 */
export function removeSessionStatus(basePath: string, milestoneId: string): void {
  try {
    const p = statusPath(basePath, milestoneId);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* non-fatal */ }
  try {
    dropPendingCommands(milestoneId);
  } catch (e) {
    logWarning("parallel", `pending signals for ${milestoneId} were not closed: ${(e as Error).message}`);
  }
}

// ─── Signal I/O ────────────────────────────────────────────────────────────

/** Queue a signal for the worker of a milestone. Throws when no database is open. */
export function sendSignal(milestoneId: string, signal: SessionSignal): void {
  enqueueCommand(milestoneId, signal);
}

/** Take the oldest pending signal for a milestone. Each signal is delivered one time. Returns null if none is pending. */
export function consumeSignal(milestoneId: string): SignalMessage | null {
  const taken = takeNextCommand(milestoneId, `pid-${process.pid}`);
  if (!taken) return null;
  return { signal: taken.command as SessionSignal, sentAt: Date.parse(taken.enqueuedAt), from: "coordinator" };
}

/**
 * Wait for a coordinator to lift a `pause` on a worker by sending `resume`
 * (or `stop`). Polls the command queue until one of those arrives or the timeout
 * elapses. Intervening `pause`/`rebase` signals are consumed and ignored so a
 * repeated pause doesn't reset the wait.
 *
 * A worker's `pause` is only ever lifted by the interactive/dashboard resumer;
 * unattended `gsd headless auto` owns no resumer, so callers use the `"timeout"`
 * result to degrade to in-process serialization instead of stranding the worker
 * at a terminal pause it cannot resume (#1273).
 */
export async function awaitWorkerResume(
  milestoneId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<"resume" | "stop" | "timeout"> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESUME_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_RESUME_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const msg = consumeSignal(milestoneId);
    if (msg?.signal === "resume") return "resume";
    if (msg?.signal === "stop") return "stop";
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ─── Stale Detection ───────────────────────────────────────────────────────

/** Check whether a session is stale (PID dead or heartbeat timed out). */
export function isSessionStale(
  status: SessionStatus,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): boolean {
  if (!isPidAlive(status.pid)) return true;
  const elapsed = Date.now() - status.lastHeartbeat;
  return elapsed > timeoutMs;
}

/** Find and remove stale sessions. Returns the milestone IDs that were cleaned up. */
export function cleanupStaleSessions(
  basePath: string,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): string[] {
  const removed: string[] = [];
  const statuses = readAllSessionStatuses(basePath);

  for (const status of statuses) {
    if (isSessionStale(status, timeoutMs)) {
      removeSessionStatus(basePath, status.milestoneId);
      removed.push(status.milestoneId);
    }
  }

  return removed;
}
