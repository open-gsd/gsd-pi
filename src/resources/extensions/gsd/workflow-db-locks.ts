// Project/App: gsd-pi
// File Purpose: Diagnose and safely terminate dormant GSD processes holding workflow SQLite files.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { processStartIdentity } from "./process-start-identity.js";

const DORMANT_HOLDER_SECONDS = 5 * 60;

export interface WorkflowDbLockHolder {
  pid: number;
  command: string;
  uid: number | null;
  state: string;
  elapsedSeconds: number;
  sameUser: boolean;
  gsdProcess: boolean;
  dormant: boolean;
  processStartIdentity: string | null;
  processStartedAtMs: number | null;
}

/**
 * What the workers registry says about the lock-holder PIDs (#3052).
 *
 * `staleStartedAtByPid` holds active/stopping rows whose last heartbeat is
 * older than the staleness cutoff; `livePids` holds PIDs whose row still has a
 * fresh heartbeat — treated as a live session. Terminal (`stopped`/`crashed`)
 * rows and processes that never registered appear in neither: a holder's
 * registry row is exactly the artifact an orphaned process can no longer
 * maintain, so its absence counts toward orphaned, not against it. That
 * absence is weak evidence — only auto-mode registers rows — and is accepted
 * as the orphan signal because the alternative is the permanent
 * doctor→auto guidance wedge (#3052).
 */
export interface WorkflowDbWorkerSnapshot {
  staleStartedAtByPid: ReadonlyMap<number, number>;
  livePids: ReadonlySet<number>;
}

export const NO_WORKER_ROWS: WorkflowDbWorkerSnapshot = {
  staleStartedAtByPid: new Map(),
  livePids: new Set(),
};

function commandOutput(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" && stdout.trim() ? stdout.trim() : null;
  }
}

export function parseLsofProcessFields(output: string): Array<{ pid: number; command: string; uid: number | null }> {
  const holders: Array<{ pid: number; command: string; uid: number | null }> = [];
  let current: { pid: number; command: string; uid: number | null } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (current) holders.push(current);
      current = { pid: Number(value), command: "unknown", uid: null };
    } else if (current && field === "c") {
      current.command = value;
    } else if (current && field === "u") {
      const uid = Number(value);
      current.uid = Number.isSafeInteger(uid) ? uid : null;
    }
  }
  if (current) holders.push(current);
  return holders.filter((holder) => Number.isSafeInteger(holder.pid) && holder.pid > 0);
}

export function parseElapsedSeconds(value: string): number {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

function inspectProcess(
  holder: { pid: number; command: string; uid: number | null },
): WorkflowDbLockHolder {
  const ps = commandOutput("ps", ["-o", "uid=,state=,etime=,command=", "-p", String(holder.pid)]);
  const match = ps?.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  const uid = match ? Number(match[1]) : holder.uid;
  const state = match?.[2] ?? "";
  const elapsedSeconds = parseElapsedSeconds(match?.[3] ?? "");
  const command = match?.[4] ?? holder.command;
  const currentUid = process.getuid?.();
  const sameUser = currentUid !== undefined && uid === currentUid;
  const gsdProcess = /^gsd(?:-|$)/i.test(holder.command)
    || /(?:^|[\s/])gsd(?:-pi)?(?:[\s/]|$)|@opengsd\/gsd-pi/i.test(command);
  const dormant = /^[SI]/.test(state) && elapsedSeconds >= DORMANT_HOLDER_SECONDS;
  return {
    pid: holder.pid,
    command,
    uid,
    state,
    elapsedSeconds,
    sameUser,
    gsdProcess,
    dormant,
    processStartIdentity: processStartIdentity(holder.pid),
    processStartedAtMs: elapsedSeconds > 0 ? Date.now() - elapsedSeconds * 1_000 : null,
  };
}

function findWorkflowDbLockHolders(
  databasePath: string,
): Array<{ pid: number; command: string; uid: number | null }> {
  if (process.platform === "win32") return [];
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync);
  if (paths.length === 0) return [];

  const lsof = commandOutput("lsof", ["-nP", "-l", "-Fpcu", ...paths]);
  let holders = lsof ? parseLsofProcessFields(lsof) : [];
  if (holders.length === 0 && process.platform === "linux") {
    const fuser = commandOutput("fuser", paths);
    holders = [...new Set(fuser?.match(/\d+/g) ?? [])].map((pid) => ({
      pid: Number(pid),
      command: "unknown",
      uid: null,
    }));
  }

  return holders.filter((holder) => holder.pid !== process.pid);
}

export function listWorkflowDbLockHolderPids(databasePath: string): number[] {
  return findWorkflowDbLockHolders(databasePath).map((holder) => holder.pid);
}

export function inspectWorkflowDbLockHolders(databasePath: string): WorkflowDbLockHolder[] {
  return findWorkflowDbLockHolders(databasePath).map(inspectProcess);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function terminateDormantWorkflowDbLockHolders(
  holders: WorkflowDbLockHolder[],
  workerSnapshot: WorkflowDbWorkerSnapshot,
  dependencies?: {
    signal?: (pid: number) => void;
    isAlive?: (pid: number) => boolean;
    wait?: () => Promise<void>;
    processIdentity?: (pid: number) => string | null;
  },
): Promise<{ signaled: number[]; terminated: number[]; remaining: number[] }> {
  const signaled: number[] = [];
  const signal = dependencies?.signal ?? ((pid: number) => { process.kill(pid, "SIGTERM"); });
  const isAlive = dependencies?.isAlive ?? processIsAlive;
  const identity = dependencies?.processIdentity ?? processStartIdentity;
  for (const holder of holders) {
    if (!isDormantWorkflowDbLockHolderSafeToTerminate(holder, workerSnapshot)) continue;
    if (holder.processStartIdentity === null || identity(holder.pid) !== holder.processStartIdentity) continue;
    try {
      signal(holder.pid);
      signaled.push(holder.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      signaled.push(holder.pid);
    }
  }

  if (signaled.length > 0) {
    await (dependencies?.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 500)));
  }
  const remaining = signaled.filter(isAlive);
  return {
    signaled,
    terminated: signaled.filter((pid) => !remaining.includes(pid)),
    remaining,
  };
}

/**
 * Why this holder must not be signaled, or null when every safety gate passes.
 *
 * #3052 inverted the registry-row trust model: a missing or terminal workers
 * row is evidence of orphaning (the holder can no longer maintain its row),
 * so only a row with a fresh heartbeat — a genuinely live session — refuses
 * termination. The OS-level gates (same user, gsd-looking command, dormant
 * for at least DORMANT_HOLDER_SECONDS, known start time/identity) are
 * unchanged and still apply to every holder.
 */
export function describeDormantWorkflowDbLockHolderSkip(
  holder: WorkflowDbLockHolder,
  workerSnapshot: WorkflowDbWorkerSnapshot,
): string | null {
  if (!holder.sameUser) return `PID ${holder.pid}: owned by a different user`;
  if (!holder.gsdProcess) return `PID ${holder.pid}: command does not look like a GSD process`;
  if (!holder.dormant) {
    return `PID ${holder.pid}: not dormant (state ${holder.state || "unknown"}, up ${Math.round(holder.elapsedSeconds / 60)}m)`;
  }
  if (holder.processStartedAtMs === null) return `PID ${holder.pid}: process start time unavailable`;
  if (holder.processStartIdentity === null) return `PID ${holder.pid}: process start identity unavailable`;
  if (workerSnapshot.livePids.has(holder.pid)) {
    return `PID ${holder.pid}: workers row is active/stopping with a fresh heartbeat`;
  }
  const workerStartedAtMs = workerSnapshot.staleStartedAtByPid.get(holder.pid);
  if (workerStartedAtMs !== undefined && holder.processStartedAtMs > workerStartedAtMs + 60_000) {
    return `PID ${holder.pid}: stale workers row started after this process (PID reuse)`;
  }
  return null;
}

export function isDormantWorkflowDbLockHolderSafeToTerminate(
  holder: WorkflowDbLockHolder,
  workerSnapshot: WorkflowDbWorkerSnapshot,
): boolean {
  return describeDormantWorkflowDbLockHolderSkip(holder, workerSnapshot) === null;
}

export function formatLockedWorkflowDatabaseNotice(
  holderPids: readonly number[],
  // The auto-mode backstop wording is the default subject; other seams
  // (status, #2712) pass their own so the prefix never lies about the mode.
  subject = "Auto-mode blocked — liveness backstop unavailable",
): string {
  const pidDetail = holderPids.length === 1
    ? ` (PID ${holderPids[0]!})`
    : holderPids.length > 1
      ? ` (PIDs ${holderPids.join(", ")})`
      : "";
  return (
    `${subject}: workflow database is locked by another GSD process${pidDetail}. ` +
    "Run `/gsd doctor --fix` to release orphaned holders (it reports any holder it cannot safely stop) " +
    "or stop that process yourself."
  );
}
