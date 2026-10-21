/**
 * MCP server PID registry — tracks running instances per project so new
 * launches can kill stale ones. Mirrors web-mode's web-instances.json pattern.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface McpInstanceEntry {
  pid: number;
  projectDir: string;
  startedAt: string;
}

export type McpInstanceRegistry = Record<string, McpInstanceEntry>;

export interface RegisterMcpInstanceOptions {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  getProcessCommand?: (pid: number) => string | null;
  getProcessCwd?: (pid: number) => string | null;
  getProcessStartTime?: (pid: number) => number | null;
  waitForExit?: () => void;
}

export interface McpProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
}

export interface SweepProjectOrphanMcpServersOptions {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  getProcessCwd?: (pid: number) => string | null;
  listProcesses?: () => McpProcessSnapshot[];
  isOrphaned?: (proc: McpProcessSnapshot) => boolean;
  waitForExit?: () => void;
}

export interface SweepProjectOrphanMcpServersResult {
  matched: number[];
  terminated: number[];
  forceKilled: number[];
  skipped: number[];
}

const REGISTRY_PATH = join(
  process.env.GSD_HOME || join(homedir(), '.gsd'),
  'mcp-instances.json',
);

// A live PID is only treated as "our" stale server if its OS start time is no
// later than the moment we recorded the registry entry (plus a small skew for
// clock granularity / start-vs-register delay). A PID that started materially
// later has been recycled by a different process and must not be signalled.
const STALE_PID_START_SKEW_MS = 60_000;

export function readMcpRegistry(registryPath = REGISTRY_PATH): McpInstanceRegistry {
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (err) {
    // A missing file is the normal first-run case — start with an empty
    // registry silently. Any other read error is worth surfacing.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[gsd-mcp-server] failed to read MCP registry ${registryPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as McpInstanceRegistry;
    }
    throw new Error('registry is not a JSON object');
  } catch (err) {
    // The file exists but is unparseable. Returning {} here means the next
    // registerMcpInstance would overwrite the file and silently drop every
    // other project's entry. The corrupt bytes can't be recovered, but we
    // preserve them for forensics and warn loudly instead of dropping them
    // without a trace.
    const backup = `${registryPath}.corrupt-${Date.now()}`;
    try {
      renameSync(registryPath, backup);
      process.stderr.write(
        `[gsd-mcp-server] MCP registry ${registryPath} was corrupt (${err instanceof Error ? err.message : String(err)}); preserved as ${backup}\n`,
      );
    } catch {
      process.stderr.write(
        `[gsd-mcp-server] MCP registry ${registryPath} was corrupt (${err instanceof Error ? err.message : String(err)}) and could not be preserved\n`,
      );
    }
    return {};
  }
}

function writeMcpRegistry(registry: McpInstanceRegistry, registryPath = REGISTRY_PATH): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
}

function defaultGetProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      // `ps` does not exist on Windows; query the process command line via CIM
      // so stale same-project cleanup is not silently disabled there.
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return out || null;
    }
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return command || null;
  } catch {
    return null;
  }
}

function defaultGetProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [int64](($p.CreationDate.ToUniversalTime() - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds) }`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const ms = Number(out);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    // `lstart` is supported by both Linux (procps) and macOS (BSD) ps. Force
    // the C locale so the timestamp is parseable regardless of the user's LANG.
    const lstart = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    if (!lstart) return null;
    const ms = new Date(lstart).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function normalizeProcessCwd(value: string): string {
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function defaultGetProcessCwd(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$pid=${pid};$t=@'
using System;using System.Runtime.InteropServices;using System.Text;
public static class GsdProcCwd{
 [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a,bool b,int p);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int l,out int r);
 [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h,int c,byte[] i,int l,out int o);
 public static string G(int pid){
  IntPtr h=OpenProcess(0x1010,false,pid);if(h==IntPtr.Zero)return null;
  try{bool x=IntPtr.Size==8;int n=IntPtr.Size*6;byte[] pbi=new byte[n];int o;
  if(NtQueryInformationProcess(h,0,pbi,n,out o)!=0)return null;
  IntPtr peb=x?(IntPtr)BitConverter.ToInt64(pbi,IntPtr.Size):(IntPtr)BitConverter.ToInt32(pbi,4);
  byte[] ptr=new byte[IntPtr.Size];int rd;
  if(!ReadProcessMemory(h,IntPtr.Add(peb,x?0x20:0x10),ptr,ptr.Length,out rd))return null;
  IntPtr pp=x?(IntPtr)BitConverter.ToInt64(ptr,0):(IntPtr)BitConverter.ToInt32(ptr,0);
  byte[] us=new byte[16];
  if(!ReadProcessMemory(h,IntPtr.Add(pp,x?0x38:0x24),us,us.Length,out rd))return null;
  int len=BitConverter.ToUInt16(us,0);if(len<=0||len>32766)return null;
  IntPtr buf=x?(IntPtr)BitConverter.ToInt64(us,8):(IntPtr)BitConverter.ToInt32(us,4);
  byte[] ch=new byte[len];
  if(!ReadProcessMemory(h,buf,ch,ch.Length,out rd))return null;
  return Encoding.Unicode.GetString(ch,0,len);}finally{CloseHandle(h);}}
}
'@;Add-Type -TypeDefinition $t -ErrorAction Stop;[GsdProcCwd]::G($pid)`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (!out) return null;
      return normalizeProcessCwd(out);
    } catch {
      return null;
    }
  }

  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const cwd = out.split('\n').find((line) => line.startsWith('n'))?.slice(1).trim();
    if (cwd) return cwd;
  } catch {
  }

  try {
    const out = execFileSync('pwdx', [String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const match = /^\d+:\s+(.+)$/.exec(out);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function isSafePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;
}

function isMcpServerCommand(command: string | null): boolean {
  if (!command) return false;
  const normalized = command.replace(/\\/g, '/');
  return (
    command.includes('gsd-mcp-server') ||
    command.includes('@opengsd/mcp-server') ||
    normalized.includes('/packages/mcp-server/')
  );
}

function defaultListProcesses(): McpProcessSnapshot[] {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (!out) return [];
      const parsed = JSON.parse(out) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const record = row as Record<string, unknown>;
        const pid = Number(record.ProcessId);
        const ppid = Number(record.ParentProcessId);
        const command = typeof record.CommandLine === 'string' ? record.CommandLine : '';
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return [];
        return [{ pid, ppid, command }];
      });
    } catch {
      return [];
    }
  }

  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    return out.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      return [{
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      }];
    });
  } catch {
    return [];
  }
}

function defaultWaitForExit(): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, 250);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCommandPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveComparableProjectPath(projectDir: string): string {
  if (
    /^[A-Za-z]:[\\/]/.test(projectDir) ||
    projectDir.startsWith('\\\\') ||
    projectDir.startsWith('/')
  ) {
    // Already an absolute path (Windows drive-letter, UNC, or POSIX). Do NOT
    // call path.resolve(), which would prepend the current drive letter on
    // Windows and turn a POSIX path like /workspace/project into
    // C:/workspace/project, breaking command-path matching when the process
    // command still contains the raw POSIX prefix.
    return normalizeCommandPath(projectDir);
  }
  return normalizeCommandPath(resolve(projectDir));
}

function projectRegistryKeys(projectDir: string): string[] {
  return [...new Set([
    resolveComparableProjectPath(projectDir),
    resolve(projectDir),
    projectDir,
  ])];
}

function commandContainsProjectPath(command: string, projectDir: string): boolean {
  const normalizedProject = resolveComparableProjectPath(projectDir);
  const normalizedCommand = normalizeCommandPath(command);
  const pattern = new RegExp(`(^|[\\s"'])${escapeRegExp(normalizedProject)}(?=$|[/\\s"'])`);
  return pattern.test(normalizedCommand);
}

function isSameProjectMcpProcess(command: string, cwd: string | null, projectDir: string): boolean {
  if (!isMcpServerCommand(command)) return false;
  if (cwd && resolveComparableProjectPath(normalizeProcessCwd(cwd)) === resolveComparableProjectPath(projectDir)) return true;
  return commandContainsProjectPath(command, projectDir);
}

function isPidAlive(
  pid: number,
  sendSignal: (pid: number, signal?: NodeJS.Signals | 0) => void,
): boolean {
  try {
    sendSignal(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function isOrphanedMcpProcess(
  proc: McpProcessSnapshot,
  sendSignal: (pid: number, signal?: NodeJS.Signals | 0) => void,
): boolean {
  if (process.platform === 'win32') {
    // Windows does not reparent orphans to PID 1; the PPID usually still
    // points at the dead parent, so treat a missing parent as orphaned.
    if (!isSafePid(proc.ppid)) return false;
    return !isPidAlive(proc.ppid, sendSignal);
  }
  return proc.ppid === 1;
}

export function sweepProjectOrphanMcpServers(
  projectDir: string,
  options: SweepProjectOrphanMcpServersOptions = {},
): SweepProjectOrphanMcpServersResult {
  const sendSignal = options.kill ?? ((targetPid, signal) => process.kill(targetPid, signal));
  const getProcessCwd = options.getProcessCwd ?? defaultGetProcessCwd;
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const isOrphaned = options.isOrphaned ?? ((proc: McpProcessSnapshot) => isOrphanedMcpProcess(proc, sendSignal));
  const waitForExit = options.waitForExit ?? defaultWaitForExit;

  const result: SweepProjectOrphanMcpServersResult = {
    matched: [],
    terminated: [],
    forceKilled: [],
    skipped: [],
  };

  for (const proc of listProcesses()) {
    if (!isSafePid(proc.pid) || proc.pid === process.pid) continue;
    if (!isOrphaned(proc)) continue;
    if (!isMcpServerCommand(proc.command)) continue;
    const cwd = commandContainsProjectPath(proc.command, projectDir) ? null : getProcessCwd(proc.pid);
    if (!isSameProjectMcpProcess(proc.command, cwd, projectDir)) continue;
    result.matched.push(proc.pid);

    if (!isPidAlive(proc.pid, sendSignal)) {
      result.skipped.push(proc.pid);
      continue;
    }

    try {
      sendSignal(proc.pid, 'SIGTERM');
      result.terminated.push(proc.pid);
    } catch {
      result.skipped.push(proc.pid);
    }
  }

  if (result.terminated.length > 0) waitForExit();

  for (const pid of result.terminated) {
    if (!isPidAlive(pid, sendSignal)) continue;
    try {
      sendSignal(pid, 'SIGKILL');
      result.forceKilled.push(pid);
    } catch {
      result.skipped.push(pid);
    }
  }

  return result;
}

function killPid(
  pid: unknown,
  projectDir: string,
  startedAt: string | undefined,
  options: RegisterMcpInstanceOptions = {},
): 'killed' | 'force-killed' | 'already-dead' | 'invalid' | 'unverified' | { error: string } {
  if (!isSafePid(pid)) return 'invalid';

  const sendSignal = options.kill ?? ((targetPid, signal) => process.kill(targetPid, signal));
  const getProcessCommand = options.getProcessCommand ?? defaultGetProcessCommand;
  const getProcessCwd = options.getProcessCwd ?? defaultGetProcessCwd;
  const getProcessStartTime = options.getProcessStartTime ?? defaultGetProcessStartTime;
  const waitForExit = options.waitForExit ?? defaultWaitForExit;

  try {
    sendSignal(pid, 0);
  } catch (error) {
    const isAlreadyDead =
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
    if (isAlreadyDead) return 'already-dead';
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const command = getProcessCommand(pid);
  if (!command || !isMcpServerCommand(command)) return 'unverified';

  const cwd = getProcessCwd(pid);
  const recordedMs = startedAt ? Date.parse(startedAt) : NaN;
  const actualStartMs = getProcessStartTime(pid);

  // Guard against PID reuse: a recycled PID can belong to a *different* live
  // MCP server (even for another project). If we can determine when the live
  // process actually started and it began materially after we recorded this
  // entry, the original server is gone and this PID is not ours — refuse to
  // signal it.
  if (
    Number.isFinite(recordedMs) &&
    actualStartMs !== null &&
    actualStartMs > recordedMs + STALE_PID_START_SKEW_MS
  ) {
    return 'unverified';
  }

  // Confirm the live MCP server is the one we registered for this project via
  // the process cwd or an embedded project path. Start time alone is not enough
  // to authorize a signal when cwd is unavailable — another project's global
  // install can share the same command line and a coincidentally aligned start.
  const sameProject = isSameProjectMcpProcess(command, cwd, projectDir);
  if (!sameProject) return 'unverified';

  try {
    sendSignal(pid, 'SIGTERM');
    waitForExit();
    if (!isPidAlive(pid, sendSignal)) return 'killed';
    sendSignal(pid, 'SIGKILL');
    return 'force-killed';
  } catch (error) {
    const isAlreadyDead =
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
    if (isAlreadyDead) return 'already-dead';
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type SignalAutoLockPidOptions = {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  getProcessCwd?: (pid: number) => string | null;
  getProcessStartTime?: (pid: number) => number | null;
};

export type SignalAutoLockPidResult =
  | 'signaled'
  | 'already-dead'
  | 'stale-lock'
  | 'foreign-cwd'
  | 'invalid-lock'
  | { error: string };

/**
 * Verify and signal the PID recorded in a project's `.gsd/auto.lock`.
 *
 * The lock only records `pid` + `startedAt`; between write and read that PID
 * can be recycled by an unrelated process. Mirrors the killPid() policy above:
 * refuse to signal unless the live process's start time is no later than the
 * recorded one (within STALE_PID_START_SKEW_MS) and its cwd is rooted in the
 * project directory. An unknown cwd is tolerated (start time is the primary
 * identity); an unparseable `startedAt` invalidates the lock — a foreign or
 * corrupt lock must not authorize a signal.
 */
export function signalAutoLockPid(
  lock: unknown,
  projectDir: string,
  options: SignalAutoLockPidOptions = {},
): SignalAutoLockPidResult {
  if (!lock || typeof lock !== 'object') return 'invalid-lock';
  const { pid, startedAt } = lock as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'invalid-lock';
  const recordedMs = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(recordedMs)) return 'invalid-lock';

  const sendSignal = options.kill ?? ((target: number, signal?: NodeJS.Signals | 0) => process.kill(target, signal));
  const getProcessCwd = options.getProcessCwd ?? defaultGetProcessCwd;
  const getProcessStartTime = options.getProcessStartTime ?? defaultGetProcessStartTime;

  try {
    sendSignal(pid, 0);
  } catch (error) {
    const isAlreadyDead =
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
    if (isAlreadyDead) return 'already-dead';
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const actualStartMs = getProcessStartTime(pid);
  if (actualStartMs !== null && actualStartMs > recordedMs + STALE_PID_START_SKEW_MS) {
    return 'stale-lock';
  }

  const cwd = getProcessCwd(pid);
  if (cwd !== null) {
    const cwdKey = resolveComparableProjectPath(normalizeProcessCwd(cwd));
    const projectKeys = [resolveComparableProjectPath(projectDir)];
    try {
      projectKeys.push(resolveComparableProjectPath(realpathSync(projectDir)));
    } catch {
      // projectDir vanished between the lock read and now — the raw key above still applies
    }
    if (!projectKeys.includes(cwdKey)) return 'foreign-cwd';
  }

  try {
    sendSignal(pid, 'SIGTERM');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return 'signaled';
}

/**
 * Kill any existing MCP server for this project, then register our PID.
 */
export function registerMcpInstance(
  projectDir: string,
  registryPath = REGISTRY_PATH,
  options: RegisterMcpInstanceOptions = {},
): boolean {
  const registry = readMcpRegistry(registryPath);
  const keys = projectRegistryKeys(projectDir);
  const key = keys[0];
  const existingKey = keys.find((candidate) => candidate in registry);

  const existing = existingKey ? registry[existingKey] : undefined;
  if (existing && existing.pid !== process.pid) {
    const result = killPid(existing.pid, key, existing.startedAt, options);
    const label = result === 'killed'
      ? `killed stale pid=${existing.pid}`
      : result === 'force-killed'
        ? `force-killed stale pid=${existing.pid}`
      : result === 'already-dead'
        ? `stale pid=${existing.pid} already dead`
        : result === 'invalid'
          ? `ignored invalid stale pid=${String(existing.pid)}`
          : result === 'unverified'
            ? `ignored unverified stale pid=${existing.pid}`
            : `failed to kill pid=${existing.pid}: ${result.error}`;
    process.stderr.write(`[gsd-mcp-server] ${label} for ${key}\n`);
    if (result === 'unverified') return false;
  }
  if (existingKey && existingKey !== key) delete registry[existingKey];

  registry[key] = {
    pid: process.pid,
    projectDir: key,
    startedAt: new Date().toISOString(),
  };
  writeMcpRegistry(registry, registryPath);
  return true;
}

/**
 * Remove our PID from the registry on shutdown.
 */
export function unregisterMcpInstance(projectDir: string, registryPath = REGISTRY_PATH): void {
  const keys = projectRegistryKeys(projectDir);
  const registry = readMcpRegistry(registryPath);
  let changed = false;
  for (const key of keys) {
    if (registry[key]?.pid === process.pid) {
      delete registry[key];
      changed = true;
    }
  }
  if (changed) {
    writeMcpRegistry(registry, registryPath);
  }
}
