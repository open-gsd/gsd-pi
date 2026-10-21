import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable, Writable } from 'node:stream';

import { runMcpServerCli } from './cli-runner.js';

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

type ChildProcessWithReadableOutput = ChildProcessByStdio<null, Readable, Readable>;

function waitFor<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs)),
  ]);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for child pid=${child.pid ?? 'unknown'} exit`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function spawnMcpServer(projectDir: string, gsdHome: string): ChildProcessWithoutNullStreams {
  const runnerUrl = new URL('./cli-runner.js', import.meta.url).href;
  const code = `
    import { runMcpServerCli } from ${JSON.stringify(runnerUrl)};
    await runMcpServerCli({
      sweepProjectOrphanMcpServers() {},
      createMcpServer: async () => ({ server: { connect: async () => new Promise(() => {}), close: async () => {} } }),
      importStdioServerTransport: async () => ({ StdioServerTransport: class {} }),
      warmWorkflowToolBridges() {},
    });
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: projectDir,
    env: {
      ...process.env,
      GSD_HOME: gsdHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function spawnObservationMcpServer(
  projectDir: string,
  gsdHome: string,
  token: string,
): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  const runnerUrl = new URL('./cli-runner.js', import.meta.url).href;
  const code = `
    import { runMcpServerCli } from ${JSON.stringify(runnerUrl)};
    await runMcpServerCli({
      sweepProjectOrphanMcpServers() {},
      resolveMilestoneStatusObservationTokenState() { return 'active'; },
      createMcpServer: async () => ({ server: {
        connect: async () => { process.stderr.write('EPHEMERAL_READY\\n'); },
        close: async () => {},
      } }),
      importStdioServerTransport: async () => ({ StdioServerTransport: class {} }),
      warmWorkflowToolBridges() {},
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: projectDir,
    env: {
      ...process.env,
      GSD_HOME: gsdHome,
      GSD_MILESTONE_STATUS_OBSERVATION_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ephemeral pid=${child.pid}`)), 5_000);
    child.stderr.on('data', (chunk) => {
      if (!String(chunk).includes('EPHEMERAL_READY')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`ephemeral MCP exited before readiness: code=${code} signal=${signal}`));
    });
  });
  return { child, ready };
}

function spawnBusyLoopingMcpServerParent(projectDir: string, gsdHome: string): ChildProcessWithReadableOutput {
  const runnerUrl = new URL('./cli-runner.js', import.meta.url).href;
  const childCode = `
    import { runMcpServerCli } from ${JSON.stringify(runnerUrl)};
    await runMcpServerCli({
      sweepProjectOrphanMcpServers() {},
      stdinIdleTimeoutMs: 100,
      orphanParentLossCheckIntervalMs: 25,
      createMcpServer: async () => ({
        server: {
          connect: async () => {
            process.stderr.write('BUSY_READY\\n');
            while (true) {}
          },
          close: async () => {},
        },
      }),
      importStdioServerTransport: async () => ({ StdioServerTransport: class {} }),
      warmWorkflowToolBridges() {},
    });
  `;
  const parentCode = `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childCode)}], {
      cwd: ${JSON.stringify(projectDir)},
      env: { ...process.env, GSD_HOME: ${JSON.stringify(gsdHome)} },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (!child.pid) throw new Error('missing child pid');
    process.stdout.write(String(child.pid) + '\\n');
    let done = false;
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      if (!done && text.includes('BUSY_READY')) {
        done = true;
        process.exit(0);
      }
    });
    child.once('exit', (code, signal) => {
      if (done) return;
      done = true;
      process.stderr.write('busy child exited before parent loss: code=' + code + ' signal=' + signal + '\\n');
      process.exit(1);
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      process.stderr.write('timed out waiting for busy child readiness\\n');
      process.exit(2);
    }, 5000);
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', parentCode], {
    cwd: projectDir,
    env: {
      ...process.env,
      GSD_HOME: gsdHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForRegistryPid(gsdHome: string, pid: number | undefined, timeoutMs = 5_000): Promise<void> {
  assert.ok(pid, 'spawned child must have a pid');
  const registryPath = join(gsdHome, 'mcp-instances.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, { pid?: number }>;
      if (Object.values(registry).some((entry) => entry.pid === pid)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for registry pid=${pid}`);
}

function readSpawnedPid(child: ChildProcessWithReadableOutput): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      settled = true;
      const pid = Number(buffer.slice(0, newline));
      if (Number.isSafeInteger(pid) && pid > 1) {
        resolve(pid);
      } else {
        reject(new Error(`invalid pid line: ${JSON.stringify(buffer.slice(0, newline))}`));
      }
    });
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`process exited before pid line: code=${code} signal=${signal}`));
    });
  });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for pid=${pid} to exit`);
}

describe('runMcpServerCli', () => {
  test('unregisters the instance when startup fails after registration', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: {},
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers(projectDir) {
          calls.push(`sweep:${projectDir}`);
        },
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('create failed');
        },
        async importStdioServerTransport() {
          throw new Error('should not import transport');
        },
        warmWorkflowToolBridges() {
          throw new Error('should not warm bridges');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, [
      'load-env',
      'sweep:/workspace/project',
      'register:/workspace/project',
      'create-session-manager',
      'create-server',
      'unregister:/workspace/project',
      'cleanup-session-manager',
    ]);
  });

  test('skips PID registry registration for probe-mode stdio sessions', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: { GSD_MCP_PROBE: '1' },
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers(projectDir) {
          calls.push(`sweep:${projectDir}`);
        },
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('create failed');
        },
        async importStdioServerTransport() {
          throw new Error('should not import transport');
        },
        warmWorkflowToolBridges() {
          throw new Error('should not warm bridges');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, [
      'load-env',
      'create-session-manager',
      'create-server',
      'cleanup-session-manager',
    ]);
  });

  test('only skips singleton PID registration for active observation turns', async () => {
    for (const tokenState of ['active', 'inactive'] as const) {
      const calls: string[] = [];
      const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

      await assert.rejects(
        runMcpServerCli({
          cwd: () => '/workspace/project',
          env: { GSD_MILESTONE_STATUS_OBSERVATION_TOKEN: 'opaque-pump-token' },
          exit(code) {
            throw new ExitError(code);
          },
          loadStoredCredentialEnvKeys() {
            calls.push('load-env');
          },
          resolveMilestoneStatusObservationTokenState(projectDir, token) {
            calls.push(`validate:${projectDir}:${token}`);
            return tokenState;
          },
          registerMcpInstance(projectDir) {
            calls.push(`register:${projectDir}`);
          },
          sweepProjectOrphanMcpServers(projectDir) {
            calls.push(`sweep:${projectDir}`);
          },
          unregisterMcpInstance(projectDir) {
            calls.push(`unregister:${projectDir}`);
          },
          createSessionManager() {
            calls.push('create-session-manager');
            return {
              async cleanup() {
                calls.push('cleanup-session-manager');
              },
            };
          },
          async createMcpServer() {
            calls.push('create-server');
            throw new Error('create failed');
          },
          async importStdioServerTransport() {
            throw new Error('should not import transport');
          },
          warmWorkflowToolBridges() {
            throw new Error('should not warm bridges');
          },
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr,
          onSignal() {},
          now: () => 0,
          setInterval() {
            throw new Error('should not start interval');
          },
          clearInterval() {},
          isOrphaned: () => false,
        }),
        (error) => error instanceof ExitError && error.code === 1,
      );

      const expected = [
        'load-env',
        'validate:/workspace/project:opaque-pump-token',
        ...(tokenState === 'active' ? [] : [
          'sweep:/workspace/project',
          'register:/workspace/project',
        ]),
        'create-session-manager',
        'create-server',
        ...(tokenState === 'inactive' ? ['unregister:/workspace/project'] : []),
        'cleanup-session-manager',
      ];
      assert.deepEqual(calls, expected);
    }
  });

  test('client-managed servers do not mutate the singleton PID registry', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: { GSD_MCP_CLIENT_MANAGED: '1' },
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance() {
          calls.push('register');
        },
        sweepProjectOrphanMcpServers() {
          calls.push('sweep');
        },
        unregisterMcpInstance() {
          calls.push('unregister');
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('create failed');
        },
        async importStdioServerTransport() {
          throw new Error('should not import transport');
        },
        warmWorkflowToolBridges() {
          throw new Error('should not warm bridges');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, [
      'load-env',
      'create-session-manager',
      'create-server',
      'cleanup-session-manager',
    ]);
  });

  test('extension-owned server starts and coexists with a concurrent client-managed daemon child (#1516)', async () => {
    // #1516 acceptance: an extension-owned server and a daemon-spawned
    // (client-managed) server for the same project must run concurrently
    // without either refusing to start or killing the other. The daemon child
    // is client-managed, so it never writes a registry entry (previous test).
    // This exercises the other owner: the extension-owned server still sweeps
    // orphans and registers, and must (a) register successfully rather than
    // refuse to start, and (b) not signal the live, non-orphan daemon child
    // during that sweep.
    const calls: string[] = [];
    const stdin = new PassThrough();
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {
        calls.push('load-env');
      },
      // The daemon child is client-managed and unregistered, so the registry
      // slot is free: registration is verified (returns true) and the server
      // proceeds instead of hitting the "refusing to start" path.
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
        return true;
      },
      // The live daemon child is not orphaned (its daemon parent is alive), so
      // the orphan sweep has nothing of its to signal.
      sweepProjectOrphanMcpServers(projectDir) {
        calls.push(`sweep:${projectDir}`);
      },
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        calls.push('create-session-manager');
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        calls.push('create-server');
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return { StdioServerTransport: class {} };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => 0,
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      isOrphaned: () => false,
    });

    // It swept, registered, and connected without refusing to start.
    assert.deepEqual(calls, [
      'load-env',
      'sweep:/workspace/project',
      'register:/workspace/project',
      'create-session-manager',
      'create-server',
      'connect',
    ]);

    // Closing stdin shuts it down and rolls back only its own registration.
    stdin.emit('close');
    assert.equal(await exited, 0);
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('close-server'));
  });

  test('fails before PID mutation when observation-token authority is unavailable', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: { GSD_MILESTONE_STATUS_OBSERVATION_TOKEN: 'opaque-pump-token' },
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        resolveMilestoneStatusObservationTokenState() {
          return 'unavailable';
        },
        registerMcpInstance() {
          calls.push('register');
        },
        sweepProjectOrphanMcpServers() {
          calls.push('sweep');
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return { async cleanup() {} };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('should not create server');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, ['load-env']);
  });

  test('does not start when stdin is already closed before token validation', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    stdin.destroy();
    await new Promise<void>((resolve) => stdin.once('close', resolve));

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: { GSD_MILESTONE_STATUS_OBSERVATION_TOKEN: 'opaque-pump-token' },
      exit(code) {
        calls.push(`exit:${code}`);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {
        calls.push('load-env');
      },
      resolveMilestoneStatusObservationTokenState() {
        calls.push('validate');
        return 'active';
      },
      registerMcpInstance() {
        calls.push('register');
      },
      sweepProjectOrphanMcpServers() {
        calls.push('sweep');
      },
      createSessionManager() {
        calls.push('create-session-manager');
        return { async cleanup() {} };
      },
      async createMcpServer() {
        calls.push('create-server');
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {},
          },
        };
      },
      async importStdioServerTransport() {
        return { StdioServerTransport: class {} };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      isOrphaned: () => false,
    });

    assert.deepEqual(calls, ['load-env', 'exit:0']);
  });

  test('honors stdin closure while token validation is pending', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    let validationStarted!: () => void;
    let releaseValidation!: (state: 'active') => void;
    let exitObserved!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const validation = new Promise<'active'>((resolve) => { releaseValidation = resolve; });
    const exited = new Promise<void>((resolve) => { exitObserved = resolve; });

    const run = runMcpServerCli({
      cwd: () => '/workspace/project',
      env: { GSD_MILESTONE_STATUS_OBSERVATION_TOKEN: 'opaque-pump-token' },
      exit(code) {
        calls.push(`exit:${code}`);
        exitObserved();
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {
        calls.push('load-env');
      },
      resolveMilestoneStatusObservationTokenState() {
        calls.push('validate');
        validationStarted();
        return validation;
      },
      registerMcpInstance() {
        calls.push('register');
      },
      sweepProjectOrphanMcpServers() {
        calls.push('sweep');
      },
      createSessionManager() {
        calls.push('create-session-manager');
        return { async cleanup() {} };
      },
      async createMcpServer() {
        calls.push('create-server');
        throw new Error('should not create server');
      },
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      setInterval() {
        throw new Error('should not start interval');
      },
      clearInterval() {},
      isOrphaned: () => false,
    });

    await started;
    const closed = new Promise<void>((resolve) => stdin.once('close', resolve));
    stdin.destroy();
    await closed;
    await exited;
    releaseValidation('active');
    await run;

    assert.deepEqual(calls, ['load-env', 'validate', 'exit:0']);
  });

  test('fails closed and never connects when workflow bridge warm-up fails', async () => {
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    const stdin = new PassThrough();
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(String(chunk));
        callback();
      },
    });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: {},
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers() {},
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          return {
            server: {
              async connect() {
                calls.push('connect');
              },
              async close() {
                calls.push('close-server');
              },
            },
          };
        },
        async importStdioServerTransport() {
          calls.push('import-transport');
          return {
            StdioServerTransport: class {
              constructor() {
                calls.push('create-transport');
              }
            },
          };
        },
        warmWorkflowToolBridges() {
          calls.push('warm-bridges');
          throw new Error('bridge unavailable');
        },
        stdin,
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          calls.push('set-interval');
          return { unref() {} } as ReturnType<typeof setInterval>;
        },
        clearInterval() {
          calls.push('clear-interval');
        },
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    // Bridge warm-up is attempted, but a broken bridge must abort startup
    // before the transport connects — the client never sees the tool surface.
    assert.ok(calls.includes('warm-bridges'), 'bridge warm-up should be attempted');
    assert.ok(!calls.includes('connect'), 'server must NOT connect when bridges fail');
    // Registration is rolled back and the server is torn down on the failure path.
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('close-server'));
    assert.match(stderrChunks.join(''), /Fatal: failed to start/);
    assert.match(stderrChunks.join(''), /bridge unavailable/);
  });

  test('keeps fatal startup failures on exit code 1 when stdin closes during cleanup', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    let cleanupCount = 0;

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            cleanupCount += 1;
            calls.push(`cleanup-session-manager:${cleanupCount}`);
            stdin.emit('close');
            await new Promise((resolve) => setImmediate(resolve));
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {
        throw new Error('bridge unavailable');
      },
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => 0,
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      isOrphaned: () => false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.filter((call) => call.startsWith('exit:')), ['exit:1']);
    assert.deepEqual(calls.filter((call) => call.startsWith('cleanup-session-manager')), [
      'cleanup-session-manager:1',
    ]);
    assert.ok(!calls.includes('connect'), 'server must NOT connect when bridges fail');
  });

  test('shuts down when stdio closes without waiting for the idle watchdog', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {
        calls.push('load-env');
      },
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => 0,
      setInterval() {
        calls.push('set-interval');
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => false,
    });

    stdin.emit('close');

    assert.equal(await waitFor(exitPromise), 0);
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('cleanup-session-manager'));
    assert.ok(calls.includes('close-server'));
    assert.ok(calls.includes('exit:0'));
  });

  test('stays alive when parent is gone but stdin is still active', async () => {
    const calls: string[] = [];
    const intervals: Array<() => void> = [];
    const stdin = new PassThrough();
    let now = 0;

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => now,
      setInterval(callback: Parameters<typeof setInterval>[0]) {
        intervals.push(callback as () => void);
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => true,
    });

    assert.equal(intervals.length, 2);
    stdin.write('{"jsonrpc":"2.0","method":"initialize"}\n');
    now = 1_000;
    for (const tick of intervals) tick();

    assert.ok(!calls.includes('exit:0'));
    assert.ok(!calls.includes('unregister:/workspace/project'));
  });

  test('self-terminates on parent loss once stdin goes idle (#783)', async () => {
    const calls: string[] = [];
    const intervals: Array<() => void> = [];
    const stdin = new PassThrough();
    let now = 0;
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => now,
      setInterval(callback: Parameters<typeof setInterval>[0]) {
        intervals.push(callback as () => void);
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => true,
    });

    // Two timers are scheduled: the idle watchdog and the orphan monitor.
    assert.equal(intervals.length, 2);

    // First, an active session must NOT exit even though the parent is gone.
    stdin.write('{"jsonrpc":"2.0","method":"initialize"}\n');
    now = 1_000;
    for (const tick of intervals) tick();
    assert.ok(!calls.includes('exit:0'), 'active session must survive parent loss');

    // Then, once stdin has been idle past the 5-minute gate, the orphan monitor
    // self-terminates the process — independent of the external sweep.
    now = 1_000 + 6 * 60 * 1000;
    for (const tick of intervals) tick();

    assert.equal(await waitFor(exitPromise), 0);
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('cleanup-session-manager'));
    assert.ok(calls.includes('close-server'));
    assert.ok(calls.includes('exit:0'));
  });

  test('worker monitor hard-kills a busy-looped orphaned server (#1384)', {
    skip: process.platform === 'win32'
      ? 'real orphan/reparent timing is covered on POSIX; Windows orphan detection is unit-tested in pid-registry'
      : false,
  }, async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'mcp-busy-orphan-project-'));
    const gsdHome = mkdtempSync(join(tmpdir(), 'mcp-busy-orphan-home-'));
    let parent: ChildProcessWithReadableOutput | undefined;
    let childPid: number | undefined;
    const stderrChunks: string[] = [];

    try {
      parent = spawnBusyLoopingMcpServerParent(projectDir, gsdHome);
      parent.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
      childPid = await readSpawnedPid(parent);

      const parentExit = await waitForChildExit(parent);
      assert.equal(
        parentExit.code,
        0,
        `parent should exit after child enters busy loop; stderr=${stderrChunks.join('')}`,
      );

      await waitForPidExit(childPid, 5_000);
    } finally {
      if (childPid && pidIsAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL'); } catch {}
      }
      if (parent && !parent.killed && parent.exitCode === null) parent.kill('SIGKILL');
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });

  test('exits shutdown when server close hangs', async () => {
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    let sigtermListener!: () => void;
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
              await new Promise(() => {});
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({
        write(chunk, _encoding, callback) {
          stderrChunks.push(String(chunk));
          callback();
        },
      }),
      onSignal(signal, listener) {
        if (signal === 'SIGTERM') sigtermListener = listener;
      },
      now: () => 0,
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => false,
      cleanupStepTimeoutMs: 10,
    });

    sigtermListener();

    assert.equal(await waitFor(exitPromise), 0);
    assert.ok(calls.includes('close-server'));
    assert.ok(calls.includes('exit:0'));
    assert.match(stderrChunks.join(''), /Cleanup step timed out: server close/);
  });

  // Real-subprocess integration test: spawns actual MCP servers with
  // cwd=projectDir and relies on POSIX process cwd introspection (lsof/pwdx) to
  // verify the stale same-project server before killing it. Windows has no
  // equivalent cwd lookup, and it locks a running process's working directory
  // (so the temp-dir cleanup throws EPERM). The kill/registry logic itself is
  // covered cross-platform by the injected-dependency unit tests above.
  test('second real CLI launch for same project stops the prior registered process', {
    skip: process.platform === 'win32'
      ? 'real-process cwd introspection and temp-dir cleanup are unavailable on Windows'
      : false,
  }, async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'mcp-restart-project-'));
    const gsdHome = mkdtempSync(join(tmpdir(), 'mcp-restart-home-'));
    let first: ChildProcessWithoutNullStreams | undefined;
    let second: ChildProcessWithoutNullStreams | undefined;

    try {
      first = spawnMcpServer(projectDir, gsdHome);
      await waitForRegistryPid(gsdHome, first.pid);

      const firstExit = waitForChildExit(first);
      second = spawnMcpServer(projectDir, gsdHome);
      await waitForRegistryPid(gsdHome, second.pid);

      const exited = await firstExit;
      assert.ok(
        exited.code === 0 || exited.signal === 'SIGTERM' || exited.signal === 'SIGKILL',
        `expected first process to stop after second launch, got code=${exited.code} signal=${exited.signal}`,
      );

      const secondExit = waitForChildExit(second);
      second.stdin.end();
      assert.equal((await secondExit).code, 0);
    } finally {
      for (const child of [first, second]) {
        if (child && !child.killed && child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });

  test('two real pump-scoped MCP sessions for one project remain alive together', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'mcp-observation-overlap-project-'));
    const gsdHome = mkdtempSync(join(tmpdir(), 'mcp-observation-overlap-home-'));
    let first: ReturnType<typeof spawnObservationMcpServer> | undefined;
    let second: ReturnType<typeof spawnObservationMcpServer> | undefined;

    try {
      first = spawnObservationMcpServer(projectDir, gsdHome, 'observation-token-a');
      await first.ready;
      second = spawnObservationMcpServer(projectDir, gsdHome, 'observation-token-b');
      await second.ready;

      assert.equal(first.child.exitCode, null, 'second pump must not replace the first pump');
      assert.equal(first.child.signalCode, null, 'first pump must remain unsignalled');
      assert.equal(second.child.exitCode, null, 'second pump must remain alive');

      const exits = [waitForChildExit(first.child), waitForChildExit(second.child)];
      first.child.stdin.end();
      second.child.stdin.end();
      assert.deepEqual((await Promise.all(exits)).map((entry) => entry.code), [0, 0]);
    } finally {
      for (const session of [first, second]) {
        const child = session?.child;
        if (child && !child.killed && child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });
});
