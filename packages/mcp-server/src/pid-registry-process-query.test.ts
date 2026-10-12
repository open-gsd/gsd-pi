import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerMcpInstance, sweepProjectOrphanMcpServers } from './pid-registry.js';

// Bounded-timeout regression coverage for the process-introspection helpers
// (`ps`/`lsof`/`pwdx` on POSIX, `powershell.exe`/WMI-CIM on Windows) in
// pid-registry.ts. These helpers run synchronously via execFileSync and
// previously had no `timeout`, so a wedged shell / WMI query / AV-EDR
// interception could block the whole event loop indefinitely. This suite
// proves (a) every execFileSync invocation now passes a finite positive
// timeout plus a killSignal strong enough to actually terminate a wedged
// child, and (b) an ETIMEDOUT failure is treated exactly like any other
// introspection failure: fail-closed (null/[]), no foreign-PID kill, no
// overwrite of an existing registry entry, unknown stays unknown.

const PROCESS_QUERY_TIMEOUT_MS = 5_000;

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown> | undefined;
}

function withMockedExecFileSync<T>(
  platform: NodeJS.Platform,
  impl: (file: string, args: readonly string[], options: Record<string, unknown> | undefined) => string,
  run: (calls: RecordedCall[]) => T,
): T {
  const original = cp.execFileSync;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatform);
  const calls: RecordedCall[] = [];
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    // @ts-expect-error -- test seam: override the named ESM binding exactly
    // as pid-registry-rename.test.ts does for fs.renameSync. pid-registry.ts
    // imports execFileSync directly from 'node:child_process', so patching
    // the module's own export (then re-syncing builtin ESM bindings) is what
    // actually reaches the module under test — not a call-site mock.
    cp.execFileSync = (file: string, args: readonly string[], options?: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return impl(file, args, options);
    };
    syncBuiltinESMExports();
    return run(calls);
  } finally {
    cp.execFileSync = original;
    Object.defineProperty(process, 'platform', originalPlatform);
    syncBuiltinESMExports();
  }
}

function timedOut(): never {
  const err = Object.assign(new Error('simulated ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    signal: 'SIGKILL',
  });
  throw err;
}

function assertBoundedTimeout(call: RecordedCall): void {
  const timeout = call.options?.timeout;
  assert.equal(typeof timeout, 'number', `expected a numeric timeout for ${call.file} ${call.args.join(' ')}`);
  assert.ok(Number.isFinite(timeout as number) && (timeout as number) > 0, 'timeout must be a finite positive number');
  assert.equal(timeout, PROCESS_QUERY_TIMEOUT_MS);
  // A wedged WMI/CIM query or stuck kernel-wait inside powershell.exe may not
  // honor SIGTERM; killSignal must be strong enough to guarantee the bound.
  assert.equal(call.options?.killSignal, 'SIGKILL');
}

function freshTmpRegistry(): { root: string; project: string; registryPath: string } {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-process-query-'));
  const project = join(root, 'project');
  fs.mkdirSync(project);
  const registryPath = join(root, 'mcp-instances.json');
  return { root, project, registryPath };
}

test('POSIX: getProcessCommand (ps) and getProcessCwd (lsof) pass a bounded timeout + SIGKILL killSignal', () => {
  const { root, project, registryPath } = freshTmpRegistry();
  try {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ [project]: { pid: 999_999, projectDir: project, startedAt: new Date().toISOString() } }),
    );
    withMockedExecFileSync(
      'darwin',
      (file) => {
        if (file === 'ps') return '/usr/bin/node /packages/mcp-server/dist/index.js';
        if (file === 'lsof') return `n${project}\n`;
        return '';
      },
      (calls) => {
        registerMcpInstance(project, registryPath, {
          // Only override kill/waitForExit — getProcessCommand/getProcessCwd/
          // getProcessStartTime are left as the real defaults under test.
          kill: () => {
            /* pid 999999 reported alive on signal 0, no-op on SIGTERM/SIGKILL */
          },
          waitForExit: () => {},
        });
        const psCalls = calls.filter((c) => c.file === 'ps');
        const lsofCalls = calls.filter((c) => c.file === 'lsof');
        assert.ok(psCalls.length >= 1, 'expected at least one `ps` invocation');
        assert.ok(lsofCalls.length >= 1, 'expected at least one `lsof` invocation');
        for (const call of [...psCalls, ...lsofCalls]) assertBoundedTimeout(call);
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX: sweepProjectOrphanMcpServers default ps-based process listing passes a bounded timeout + SIGKILL killSignal', () => {
  const { root, project } = freshTmpRegistry();
  try {
    withMockedExecFileSync(
      'darwin',
      (file) => {
        if (file === 'ps') return '';
        return '';
      },
      (calls) => {
        sweepProjectOrphanMcpServers(project, {
          kill: () => {},
          isOrphaned: () => false,
        });
        const psCalls = calls.filter((c) => c.file === 'ps');
        assert.ok(psCalls.length >= 1, 'expected the default process listing to invoke `ps`');
        for (const call of psCalls) assertBoundedTimeout(call);
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('win32: CIM-based getProcessCommand/getProcessStartTime/getProcessCwd/listProcesses all pass a bounded timeout + SIGKILL killSignal', () => {
  const { root, project, registryPath } = freshTmpRegistry();
  try {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ [project]: { pid: 999_999, projectDir: project, startedAt: new Date().toISOString() } }),
    );
    withMockedExecFileSync(
      'win32',
      () => '',
      (calls) => {
        registerMcpInstance(project, registryPath, {
          kill: () => {},
          waitForExit: () => {},
        });
        sweepProjectOrphanMcpServers(project, { kill: () => {}, isOrphaned: () => false });
        const powershellCalls = calls.filter((c) => c.file === 'powershell.exe');
        assert.ok(powershellCalls.length >= 3, 'expected multiple powershell.exe introspection calls');
        for (const call of powershellCalls) assertBoundedTimeout(call);
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ETIMEDOUT from getProcessCommand is fail-closed: unverified PID is refused, never killed, registry entry left untouched', () => {
  const { root, project, registryPath } = freshTmpRegistry();
  try {
    const originalSnapshot = JSON.stringify({
      [project]: { pid: 999_999, projectDir: project, startedAt: new Date().toISOString() },
    });
    fs.writeFileSync(registryPath, originalSnapshot);
    const killSignalsSent: Array<NodeJS.Signals | 0 | undefined> = [];
    withMockedExecFileSync(
      'darwin',
      (file) => {
        if (file === 'ps') timedOut();
        return '';
      },
      () => {
        const result = registerMcpInstance(project, registryPath, {
          kill: (_pid, signal) => {
            killSignalsSent.push(signal);
            // Report alive on the liveness probe (signal 0); any subsequent
            // TERM/KILL call here would itself be evidence of a bug, since a
            // command-introspection timeout must refuse before ever signaling.
          },
          waitForExit: () => {},
        });
        assert.equal(typeof result, 'object');
        assert.equal((result as { refused?: boolean }).refused, true);
        assert.match((result as { detail: string }).detail, /still running/);
      },
    );
    // Only the liveness probe (signal 0) may have been sent — no TERM/KILL.
    assert.deepEqual(killSignalsSent.filter((s) => s === 'SIGTERM' || s === 'SIGKILL'), []);
    // The registry file on disk must be byte-identical to what was there
    // before: a timed-out introspection call must never overwrite or drop
    // the existing (unverified, foreign-from-our-perspective) entry.
    assert.equal(fs.readFileSync(registryPath, 'utf8'), originalSnapshot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ETIMEDOUT from the default process lister yields an empty list: sweep matches nothing, kills nothing', () => {
  const { root, project } = freshTmpRegistry();
  try {
    let killCalls = 0;
    withMockedExecFileSync(
      'darwin',
      (file) => {
        if (file === 'ps') timedOut();
        return '';
      },
      () => {
        const result = sweepProjectOrphanMcpServers(project, {
          kill: () => {
            killCalls++;
          },
        });
        assert.deepEqual(result, { matched: [], terminated: [], forceKilled: [], skipped: [] });
      },
    );
    assert.equal(killCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ETIMEDOUT from getProcessCwd does not promote an unknown cwd to a false project match (lsof + pwdx both time out)', () => {
  const { root, project, registryPath } = freshTmpRegistry();
  try {
    const originalSnapshot = JSON.stringify({
      [project]: { pid: 999_999, projectDir: project, startedAt: new Date().toISOString() },
    });
    fs.writeFileSync(registryPath, originalSnapshot);
    withMockedExecFileSync(
      'darwin',
      (file) => {
        // Command introspection succeeds and looks like our own server, so
        // the cwd check becomes the deciding factor; lsof/pwdx both time out.
        if (file === 'ps') {
          return '/usr/bin/node /packages/mcp-server/dist/index.js';
        }
        if (file === 'lsof' || file === 'pwdx') timedOut();
        return '';
      },
      () => {
        const result = registerMcpInstance(project, registryPath, {
          kill: () => {},
          waitForExit: () => {},
        });
        // Command matches "mcp-server" but carries no project path segment and
        // cwd resolution timed out (null) — isSameProjectMcpProcess must fall
        // through to the command-path substring check and refuse, not assume
        // a match just because cwd introspection failed.
        assert.equal(typeof result, 'object');
        assert.equal((result as { refused?: boolean }).refused, true);
      },
    );
    assert.equal(fs.readFileSync(registryPath, 'utf8'), originalSnapshot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
