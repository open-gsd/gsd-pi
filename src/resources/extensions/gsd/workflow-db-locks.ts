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
  staleWorkerStartedAtByPid: ReadonlyMap<number, number>,
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
    if (!isDormantWorkflowDbLockHolderSafeToTerminate(holder, staleWorkerStartedAtByPid)) continue;
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

export function isDormantWorkflowDbLockHolderSafeToTerminate(
  holder: WorkflowDbLockHolder,
  staleWorkerStartedAtByPid: ReadonlyMap<number, number>,
): boolean {
  const workerStartedAtMs = staleWorkerStartedAtByPid.get(holder.pid);
  return holder.sameUser
    && holder.gsdProcess
    && holder.dormant
    && holder.processStartedAtMs !== null
    && workerStartedAtMs !== undefined
    // A worker registers after its containing process starts. If the current
    // process started later, the stale row belongs to an earlier PID instance.
    && holder.processStartedAtMs <= workerStartedAtMs + 60_000;
}

export function formatLockedWorkflowDatabaseNotice(holderPids: readonly number[]): string {
  const pidDetail = holderPids.length === 1
    ? ` (PID ${holderPids[0]!})`
    : holderPids.length > 1
      ? ` (PIDs ${holderPids.join(", ")})`
      : "";
  return (
    `Auto-mode blocked — liveness backstop unavailable: workflow database is locked by another GSD process${pidDetail}. ` +
    "Run `/gsd doctor --fix` to clean orphaned holders or stop that process."
  );
}
