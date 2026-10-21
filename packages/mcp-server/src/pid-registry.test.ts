import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readMcpRegistry,
  registerMcpInstance,
  signalAutoLockPid,
  sweepProjectOrphanMcpServers,
  unregisterMcpInstance,
  type McpInstanceEntry,
} from './pid-registry.js';

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-pid-'));
  registryPath = join(tmp, 'mcp-instances.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// registerMcpInstance keys the registry by a normalized (forward-slash) project
// path, which on Windows differs from the raw `tmp` path (backslashes + drive).
// Match by the normalized projectDir so assertions are portable across OSes.
const normPath = (p: string): string => p.replace(/\\/g, '/');

function readOwnEntry(path: string, projectDir: string): McpInstanceEntry | undefined {
  const reg = readMcpRegistry(path);
  const want = normPath(projectDir);
  return Object.values(reg).find((entry) => normPath(entry.projectDir) === want);
}

function isPpidOneOrphan(proc: { ppid: number }): boolean {
  return proc.ppid === 1;
}

describe('readMcpRegistry', () => {
  test('returns empty object when file does not exist', () => {
    assert.deepEqual(readMcpRegistry(registryPath), {});
  });

  test('returns parsed content when file exists', () => {
    const entry = { pid: 123, projectDir: '/foo', startedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(registryPath, JSON.stringify({ '/foo': entry }));
    const reg = readMcpRegistry(registryPath);
    assert.deepEqual(reg['/foo'], entry);
  });

  test('returns empty object on corrupt JSON', () => {
    writeFileSync(registryPath, 'not json');
    assert.deepEqual(readMcpRegistry(registryPath), {});
  });

  test('preserves corrupt registry as a backup instead of dropping it silently', () => {
    writeFileSync(registryPath, 'not json');
    readMcpRegistry(registryPath);
    const backups = readdirSync(tmp).filter((f) => f.startsWith('mcp-instances.json.corrupt-'));
    assert.equal(backups.length, 1, 'expected a single .corrupt- backup');
    assert.equal(readFileSync(join(tmp, backups[0]), 'utf8'), 'not json');
  });

  test('returns empty object on a non-object JSON payload', () => {
    writeFileSync(registryPath, JSON.stringify([1, 2, 3]));
    assert.deepEqual(readMcpRegistry(registryPath), {});
  });
});

describe('registerMcpInstance', () => {
  test('creates registry and writes current PID', () => {
    registerMcpInstance(tmp, registryPath);
    const entry = readOwnEntry(registryPath, tmp);
    assert.ok(entry);
    assert.equal(entry.pid, process.pid);
    assert.equal(normPath(entry.projectDir), normPath(tmp));
    assert.ok(entry.startedAt);
  });

  test('overwrites stale entry for same project', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 999999, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));
    registerMcpInstance(tmp, registryPath);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });

  test('preserves entries for other projects', () => {
    const otherDir = '/other/project';
    const otherEntry = { pid: 42, projectDir: otherDir, startedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(registryPath, JSON.stringify({ [otherDir]: otherEntry }));
    registerMcpInstance(tmp, registryPath);
    const reg = readMcpRegistry(registryPath);
    assert.deepEqual(reg[otherDir], otherEntry);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });

  test('does not signal invalid saved PIDs', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 0, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
    });

    assert.deepEqual(signals, []);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });

  test('does not terminate an alive PID whose command is not the MCP server', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 4444, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return '/usr/bin/vim';
      },
    });

    assert.deepEqual(signals, [{ pid: 4444, signal: 0 }]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 4444);
  });

  test('terminates an alive PID whose command is the MCP server', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 5555, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      getProcessCwd() {
        return tmp;
      },
      // Pin the start time so the recycled-PID guard can't depend on a real
      // process lookup (which differs across platforms).
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 5555, signal: 0 },
      { pid: 5555, signal: 'SIGTERM' },
      { pid: 5555, signal: 0 },
      { pid: 5555, signal: 'SIGKILL' },
    ]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });

  // Regression for #1516: a daemon-spawned workflow server runs in non-exclusive
  // (client-managed) mode and never registers, so it is absent from the registry.
  // When an extension-owned server registers/restarts, exclusivity cleanup must
  // target ONLY the recorded registry entry — never a live, unregistered daemon
  // child — so the two owners do not kill each other over one registry slot.
  //
  // This is the registry-layer half of the invariant: exclusivity acts strictly
  // on what the registry records (here, PID 5555). The complementary CLI-layer
  // guarantee — that client-managed sessions skip sweep/register/unregister
  // entirely — is covered by cli-runner.test.ts
  // ('client-managed servers do not mutate the singleton PID registry').
  test('only signals the recorded registry PID, never an unregistered daemon-spawned child', () => {
    // Registry holds only the previous extension-owned server's entry. A
    // concurrently running client-managed daemon child is deliberately absent
    // from the registry, so it can never be a signal target here.
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 5555, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      getProcessCwd() {
        return tmp;
      },
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    // Exactly the recorded stale extension PID is signalled — nothing else.
    assert.deepEqual(new Set(signals.map((s) => s.pid)), new Set([5555]));
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });

  test('does not terminate a recycled PID that started after the entry was recorded', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 6666, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      // Same project (cwd matches) so the recycled-PID guard is what rejects it.
      getProcessCwd() {
        return tmp;
      },
      // Live process started 5 minutes after we recorded the entry => recycled PID.
      getProcessStartTime() {
        return Date.parse('2026-01-01T00:05:00.000Z');
      },
    });

    // Probe only (signal 0); no SIGTERM to the unrelated recycled PID.
    assert.deepEqual(signals, [{ pid: 6666, signal: 0 }]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 6666);
  });

  test('does not terminate a recycled MCP PID that belongs to another project', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 9997, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /usr/local/bin/gsd-mcp-server';
      },
      getProcessCwd() {
        return '/workspace/other';
      },
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [{ pid: 9997, signal: 0 }]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 9997);
  });

  test('terminates a matching PID whose start time aligns with the entry', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 7777, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      getProcessCwd() {
        return tmp;
      },
      // Live process started just before the recorded entry => same server.
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 7777, signal: 0 },
      { pid: 7777, signal: 'SIGTERM' },
      { pid: 7777, signal: 0 },
      { pid: 7777, signal: 'SIGKILL' },
    ]);
  });

  test('terminates a matching PID when the start time is unavailable', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 8888, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      getProcessCwd() {
        return tmp;
      },
      // Lookup unavailable (e.g. platform without a start-time probe): fall
      // back to the command-name check rather than leaving the stale server.
      getProcessStartTime() {
        return null;
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 8888, signal: 0 },
      { pid: 8888, signal: 'SIGTERM' },
      { pid: 8888, signal: 0 },
      { pid: 8888, signal: 'SIGKILL' },
    ]);
  });

  test('does not terminate a global-install MCP PID when cwd is unavailable and the command omits the project', () => {
    // Mirrors Windows: no process-cwd lookup, and a globally-installed
    // gsd-mcp-server whose command line omits the project root. Without a
    // project match we must not signal even if the start time aligns — another
    // project's server can look identical.
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 9100, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /usr/local/bin/gsd-mcp-server';
      },
      // cwd unavailable (Windows global install).
      getProcessCwd() {
        return null;
      },
      // Started ~1s before we recorded the entry.
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [{ pid: 9100, signal: 0 }]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 9100);
  });

  test('does not terminate a global-install MCP PID when cwd is unavailable and the start time does not align', () => {
    // Same shape, but the live process predates our registration by far longer
    // than the skew window — it cannot be the server we launched, so without a
    // project match we must not signal it.
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 9200, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node /usr/local/bin/gsd-mcp-server';
      },
      getProcessCwd() {
        return null;
      },
      // Started an hour before the recorded entry => not our process.
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:00:00.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [{ pid: 9200, signal: 0 }]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 9200);
  });

  test('terminates a matching Windows local MCP command path when cwd is unavailable', () => {
    const projectDir = 'C:\\workspace\\project';
    writeFileSync(registryPath, JSON.stringify({
      [projectDir]: { pid: 8890, projectDir, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(projectDir, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node C:\\workspace\\project\\packages\\mcp-server\\dist\\cli.js';
      },
      getProcessCwd() {
        return null;
      },
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 8890, signal: 0 },
      { pid: 8890, signal: 'SIGTERM' },
      { pid: 8890, signal: 0 },
      { pid: 8890, signal: 'SIGKILL' },
    ]);
  });

  test('terminates a global-install MCP PID when Windows cwd uses an extended path prefix', () => {
    const projectDir = 'C:\\workspace\\project';
    writeFileSync(registryPath, JSON.stringify({
      [projectDir]: { pid: 8891, projectDir, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(projectDir, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessCommand() {
        return 'node C:\\Users\\me\\AppData\\Roaming\\npm\\gsd-mcp-server.cmd';
      },
      getProcessCwd() {
        return '\\\\?\\C:\\workspace\\project';
      },
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 8891, signal: 0 },
      { pid: 8891, signal: 'SIGTERM' },
      { pid: 8891, signal: 0 },
      { pid: 8891, signal: 'SIGKILL' },
    ]);
  });

  test('force-kills a matching stale PID that survives SIGTERM before overwriting the registry', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 9998, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const alive = new Set([9998]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    registerMcpInstance(tmp, registryPath, {
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      getProcessCommand() {
        return 'node /workspace/packages/mcp-server/dist/cli.js';
      },
      getProcessCwd() {
        return tmp;
      },
      getProcessStartTime() {
        return Date.parse('2025-12-31T23:59:59.000Z');
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 9998, signal: 0 },
      { pid: 9998, signal: 'SIGTERM' },
      { pid: 9998, signal: 0 },
      { pid: 9998, signal: 'SIGKILL' },
    ]);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, process.pid);
  });
});

describe('sweepProjectOrphanMcpServers', () => {
  test('does not inspect cwd when an orphan command already contains the project path', () => {
    const projectDir = '/workspace/project';
    const alive = new Set([1101]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 1101, ppid: 1, command: `node ${projectDir}/packages/mcp-server/dist/cli.js` },
        ];
      },
      getProcessCwd() {
        throw new Error('cwd lookup should not run for project-qualified MCP commands');
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGTERM') alive.delete(pid);
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 1101, signal: 0 },
      { pid: 1101, signal: 'SIGTERM' },
      { pid: 1101, signal: 0 },
    ]);
    assert.deepEqual(result, {
      matched: [1101],
      terminated: [1101],
      forceKilled: [],
      skipped: [],
    });
  });

  test('terminates only orphaned MCP servers for the same project and force-kills TERM-resistant processes', () => {
    const projectDir = '/workspace/project';
    const otherDir = '/workspace/other';
    const alive = new Set([1111, 2222, 3333, 4444]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 1111, ppid: 1, command: `node ${projectDir}/packages/mcp-server/dist/cli.js` },
          { pid: 2222, ppid: 999, command: `node ${projectDir}/packages/mcp-server/dist/cli.js` },
          { pid: 3333, ppid: 1, command: `node ${otherDir}/packages/mcp-server/dist/cli.js` },
          { pid: 4444, ppid: 1, command: 'node /workspace/project/scripts/dev.js' },
        ];
      },
      // Match by cwd so the assertion is portable: a bare POSIX projectDir is
      // rewritten with a drive letter by path.resolve() on Windows, which would
      // otherwise break command-path matching.
      getProcessCwd(pid) {
        return pid === 3333 ? otherDir : projectDir;
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 1111, signal: 0 },
      { pid: 1111, signal: 'SIGTERM' },
      { pid: 1111, signal: 0 },
      { pid: 1111, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(result, {
      matched: [1111],
      terminated: [1111],
      forceKilled: [1111],
      skipped: [],
    });
  });

  test('does not force-kill an orphan that exits after SIGTERM', () => {
    const projectDir = '/workspace/project';
    const alive = new Set([5555]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 5555, ppid: 1, command: `node ${projectDir}/packages/mcp-server/dist/cli.js` },
        ];
      },
      getProcessCwd() {
        return projectDir;
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGTERM') alive.delete(pid);
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 5555, signal: 0 },
      { pid: 5555, signal: 'SIGTERM' },
      { pid: 5555, signal: 0 },
    ]);
    assert.deepEqual(result, {
      matched: [5555],
      terminated: [5555],
      forceKilled: [],
      skipped: [],
    });
  });

  test('does not match a sibling project whose path merely shares a prefix', () => {
    const projectDir = '/workspace/project';
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 6661, ppid: 1, command: 'node /workspace/project-old/packages/mcp-server/dist/cli.js' },
        ];
      },
      getProcessCwd() {
        return '/workspace/project-old';
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, []);
    assert.deepEqual(result, {
      matched: [],
      terminated: [],
      forceKilled: [],
      skipped: [],
    });
  });

  test('terminates an orphan with a Windows local MCP command path', () => {
    const projectDir = 'C:\\workspace\\project';
    const alive = new Set([6663]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 6663, ppid: 1, command: 'node C:\\workspace\\project\\packages\\mcp-server\\dist\\cli.js' },
        ];
      },
      getProcessCwd() {
        return null;
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 6663, signal: 0 },
      { pid: 6663, signal: 'SIGTERM' },
      { pid: 6663, signal: 0 },
      { pid: 6663, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(result, {
      matched: [6663],
      terminated: [6663],
      forceKilled: [6663],
      skipped: [],
    });
  });

  test('terminates a global gsd-mcp-server orphan when its cwd is the project', () => {
    const projectDir = '/workspace/project';
    const alive = new Set([6662]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

    const result = sweepProjectOrphanMcpServers(projectDir, {
      isOrphaned: isPpidOneOrphan,
      listProcesses() {
        return [
          { pid: 6662, ppid: 1, command: 'node /usr/local/bin/gsd-mcp-server' },
        ];
      },
      getProcessCwd() {
        return projectDir;
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (!alive.has(pid)) {
          const err = new Error('dead') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      waitForExit() {},
    });

    assert.deepEqual(signals, [
      { pid: 6662, signal: 0 },
      { pid: 6662, signal: 'SIGTERM' },
      { pid: 6662, signal: 0 },
      { pid: 6662, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(result, {
      matched: [6662],
      terminated: [6662],
      forceKilled: [6662],
      skipped: [],
    });
  });

  test('treats a Windows MCP process with a dead parent as orphaned', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const projectDir = 'C:\\workspace\\project';
      const alive = new Set([7771]);
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

      const result = sweepProjectOrphanMcpServers(projectDir, {
        listProcesses() {
          return [
            { pid: 7771, ppid: 7770, command: 'node C:\\workspace\\project\\packages\\mcp-server\\dist\\cli.js' },
          ];
        },
        getProcessCwd() {
          return projectDir;
        },
        kill(pid, signal) {
          signals.push({ pid, signal });
          if (!alive.has(pid)) {
            const err = new Error('dead') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
          if (signal === 'SIGKILL') alive.delete(pid);
        },
        waitForExit() {},
      });

      assert.deepEqual(signals, [
        { pid: 7770, signal: 0 },
        { pid: 7771, signal: 0 },
        { pid: 7771, signal: 'SIGTERM' },
        { pid: 7771, signal: 0 },
        { pid: 7771, signal: 'SIGKILL' },
      ]);
      assert.deepEqual(result, {
        matched: [7771],
        terminated: [7771],
        forceKilled: [7771],
        skipped: [],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});

describe('unregisterMcpInstance', () => {
  test('removes own PID entry', () => {
    registerMcpInstance(tmp, registryPath);
    unregisterMcpInstance(tmp, registryPath);
    assert.equal(readOwnEntry(registryPath, tmp), undefined);
  });

  test('does not remove entry belonging to another PID', () => {
    writeFileSync(registryPath, JSON.stringify({
      [tmp]: { pid: 999999, projectDir: tmp, startedAt: '2026-01-01T00:00:00.000Z' },
    }));
    unregisterMcpInstance(tmp, registryPath);
    assert.equal(readOwnEntry(registryPath, tmp)?.pid, 999999);
  });

  test('no-ops on missing registry', () => {
    assert.doesNotThrow(() => unregisterMcpInstance(tmp, registryPath));
  });
});

describe('signalAutoLockPid', () => {
  const lock = (pid: number, startedAt: string) => ({ pid, startedAt });

  const probes = (overrides: {
    alive?: boolean;
    startMs?: number | null;
    cwd?: string | null;
  } = {}) => {
    const signals: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    return {
      signals,
      opts: {
        kill: (pid: number, signal?: NodeJS.Signals | 0) => {
          if (overrides.alive === false && signal === 0) {
            const err = new Error('ESRCH') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
          signals.push({ pid, signal });
        },
        getProcessStartTime: () => overrides.startMs ?? null,
        getProcessCwd: () => overrides.cwd ?? null,
      } as const,
    };
  };

  test('rejects locks without a usable pid or startedAt', () => {
    for (const bad of [null, undefined, 'x', {}, { pid: 1 }, { pid: -3, startedAt: new Date().toISOString() }, { pid: 1.5, startedAt: new Date().toISOString() }, { pid: 1, startedAt: 'not-a-date' }]) {
      assert.equal(signalAutoLockPid(bad, '/tmp/project', probes().opts), 'invalid-lock');
    }
  });

  test('reports already-dead when the recorded pid is gone', () => {
    const { opts } = probes({ alive: false });
    assert.equal(signalAutoLockPid(lock(1, new Date().toISOString()), '/tmp/project', opts), 'already-dead');
  });

  test('refuses to signal a recycled pid whose start time is after the lock', () => {
    const recorded = Date.now() - 1_000;
    const { opts, signals } = probes({ startMs: recorded + 120_000 });
    const res = signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts);
    assert.equal(res, 'stale-lock');
    // only the liveness probe (signal 0) may have been sent, never SIGTERM
    assert.ok(signals.every((s) => s.signal === 0));
  });

  test('accepts a pid whose start time is within the skew window', () => {
    const recorded = Date.now() - 1_000;
    const { opts, signals } = probes({ startMs: recorded + 30_000 });
    assert.equal(signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts), 'signaled');
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'));
  });

  test('refuses a live process rooted outside the project directory', () => {
    const recorded = Date.now() - 1_000;
    const { opts, signals } = probes({ startMs: recorded, cwd: '/tmp/other-project' });
    const res = signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts);
    assert.equal(res, 'foreign-cwd');
    assert.ok(signals.every((s) => s.signal === 0));
  });

  test('accepts a live process rooted inside the project directory', () => {
    const recorded = Date.now() - 1_000;
    const { opts, signals } = probes({ startMs: recorded, cwd: '/tmp/project' });
    assert.equal(signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts), 'signaled');
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'));
  });

  test('tolerates unknown cwd when the start time matches', () => {
    const recorded = Date.now() - 1_000;
    const { opts, signals } = probes({ startMs: recorded, cwd: null });
    assert.equal(signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts), 'signaled');
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'));
  });

  test('surfaces SIGTERM failures as errors', () => {
    const recorded = Date.now() - 1_000;
    const signals: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const opts = {
      kill: (pid: number, signal?: NodeJS.Signals | 0) => {
        if (signal === 'SIGTERM') throw new Error('EPERM');
        signals.push({ pid, signal });
      },
      getProcessStartTime: () => recorded,
      getProcessCwd: () => null,
    };
    const res = signalAutoLockPid(lock(7, new Date(recorded).toISOString()), '/tmp/project', opts);
    assert.deepEqual(res, { error: 'EPERM' });
  });
});
