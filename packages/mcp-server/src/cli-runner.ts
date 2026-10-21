import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';
import {
  hasWorkflowToolBridgeConfiguration,
  resolveMilestoneStatusObservationTokenState,
  type MilestoneStatusObservationTokenState,
  warmWorkflowToolBridges,
} from './workflow-tools.js';
import { isMcpProbeSession } from './probe-mode.js';
import {
  registerMcpInstance,
  sweepProjectOrphanMcpServers,
  unregisterMcpInstance,
} from './pid-registry.js';
import { createActivityTrackingInput, type ActivityTrackingInput } from './stdio-watchdog.js';

const MCP_PKG = '@modelcontextprotocol/sdk';

const STDIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const STDIN_IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const CLEANUP_STEP_TIMEOUT_MS = 2 * 1000;

/**
 * Cadence for the worker-thread parent-liveness monitor.
 *
 * Separate from the main-thread idle watchdog: a process pegged at ~100% CPU
 * can starve the JS event loop, preventing timers and signal handlers from
 * dispatching. The worker has its own event loop and hard-kills this process
 * when the parent is gone and stdin has been idle long enough. See #1384.
 */
const ORPHAN_PARENT_LOSS_CHECK_INTERVAL_MS = 10 * 1000;

const ORPHAN_MONITOR_WORKER_SOURCE = `
import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const lastActivityMs = new BigInt64Array(workerData.lastActivityMsBuffer);
let stopped = false;

function parentGone() {
  if (process.ppid !== workerData.initialParentPid) return true;
  try {
    process.kill(workerData.initialParentPid, 0);
    return false;
  } catch (err) {
    return err && err.code === 'ESRCH';
  }
}

function check() {
  if (stopped) return;
  const last = Number(Atomics.load(lastActivityMs, 0));
  if (Date.now() - last <= workerData.idleTimeoutMs) return;
  if (!parentGone()) return;
  try {
    writeSync(2, '[gsd-mcp-server] Parent process is gone and stdin is idle; hard-killing orphaned server\\n');
  } catch {}
  try {
    process.kill(workerData.targetPid, 'SIGKILL');
  } catch {
    process.exit(0);
  }
}

const timer = setInterval(check, workerData.checkIntervalMs);
parentPort?.on('message', (message) => {
  if (message && message.type === 'stop') {
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  }
});
check();
`;

interface SessionManagerLike {
  cleanup(): Promise<void>;
}

interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface StdioTransportConstructor {
  new(input?: Readable, output?: Writable): unknown;
}

interface OrphanMonitorHandle {
  stop(): void;
}

export interface RunMcpServerCliOptions {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => never;
  loadStoredCredentialEnvKeys?: () => void;
  registerMcpInstance?: (projectDir: string) => boolean | void;
  sweepProjectOrphanMcpServers?: (projectDir: string) => void;
  unregisterMcpInstance?: (projectDir: string) => void;
  createSessionManager?: () => SessionManagerLike;
  createMcpServer?: (
    sessionManager: SessionManagerLike,
    options: { includeWorkflowTools: boolean },
  ) => Promise<{ server: McpServerLike }>;
  importStdioServerTransport?: () => Promise<{ StdioServerTransport: StdioTransportConstructor }>;
  warmWorkflowToolBridges?: () => Promise<unknown> | unknown;
  hasWorkflowToolBridgeConfiguration?: (env: NodeJS.ProcessEnv) => boolean;
  resolveMilestoneStatusObservationTokenState?: (
    projectDir: string,
    token: string,
  ) => Promise<MilestoneStatusObservationTokenState> | MilestoneStatusObservationTokenState;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  isOrphaned?: () => boolean;
  cleanupStepTimeoutMs?: number;
  stdinIdleTimeoutMs?: number;
  stdinIdleCheckIntervalMs?: number;
  orphanParentLossCheckIntervalMs?: number;
}

function createDefaultIsOrphaned(initialParentPid: number): () => boolean {
  return () => {
    if (process.ppid !== initialParentPid) return true;
    try {
      process.kill(initialParentPid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
}

function startWorkerOrphanMonitor(options: {
  initialParentPid: number;
  targetPid: number;
  lastActivityMsBuffer: SharedArrayBuffer;
  idleTimeoutMs: number;
  checkIntervalMs: number;
  stderr: Writable;
}): OrphanMonitorHandle {
  const worker = new Worker(ORPHAN_MONITOR_WORKER_SOURCE, {
    eval: true,
    workerData: {
      initialParentPid: options.initialParentPid,
      targetPid: options.targetPid,
      lastActivityMsBuffer: options.lastActivityMsBuffer,
      idleTimeoutMs: options.idleTimeoutMs,
      checkIntervalMs: options.checkIntervalMs,
    },
  });
  worker.unref();
  worker.on('error', (err) => {
    options.stderr.write(
      `[gsd-mcp-server] Orphan monitor failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  return {
    stop() {
      worker.postMessage({ type: 'stop' });
      void worker.terminate();
    },
  };
}

function startMainThreadOrphanMonitor(options: {
  startInterval: typeof setInterval;
  stopInterval: typeof clearInterval;
  isOrphaned: () => boolean;
  idleMs: () => number;
  idleTimeoutMs: number;
  checkIntervalMs: number;
  stderr: Writable;
  cleanup: () => void;
}): OrphanMonitorHandle {
  const interval = options.startInterval(() => {
    if (!options.isOrphaned()) return;
    if (options.idleMs() <= options.idleTimeoutMs) return;
    options.stderr.write(
      `[gsd-mcp-server] Parent process is gone; shutting down to avoid orphan spin\n`,
    );
    options.cleanup();
  }, options.checkIntervalMs);

  return {
    stop() {
      options.stopInterval(interval);
    },
  };
}

async function importDefaultStdioServerTransport(): Promise<{ StdioServerTransport: StdioTransportConstructor }> {
  return import(`${MCP_PKG}/server/stdio.js`) as Promise<{ StdioServerTransport: StdioTransportConstructor }>;
}

export async function runMcpServerCli(options: RunMcpServerCliOptions = {}): Promise<void> {
  const cwd = options.cwd ?? (() => process.cwd());
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const onSignal = options.onSignal ?? ((signal, listener) => process.on(signal, listener));
  const now = options.now ?? (() => Date.now());
  const startInterval = options.setInterval ?? setInterval;
  const stopInterval = options.clearInterval ?? clearInterval;
  const initialParentPid = process.ppid;
  const isOrphaned = options.isOrphaned ?? createDefaultIsOrphaned(initialParentPid);
  const cleanupStepTimeoutMs = options.cleanupStepTimeoutMs ?? CLEANUP_STEP_TIMEOUT_MS;
  const stdinIdleTimeoutMs = options.stdinIdleTimeoutMs ?? STDIN_IDLE_TIMEOUT_MS;
  const stdinIdleCheckIntervalMs = options.stdinIdleCheckIntervalMs ?? STDIN_IDLE_CHECK_INTERVAL_MS;
  const orphanParentLossCheckIntervalMs = options.orphanParentLossCheckIntervalMs ?? ORPHAN_PARENT_LOSS_CHECK_INTERVAL_MS;
  const loadEnv = options.loadStoredCredentialEnvKeys ?? loadStoredCredentialEnvKeys;
  const registerInstance = options.registerMcpInstance ?? registerMcpInstance;
  const sweepOrphans = options.sweepProjectOrphanMcpServers ?? sweepProjectOrphanMcpServers;
  const unregisterInstance = options.unregisterMcpInstance ?? unregisterMcpInstance;
  const createSessionManager = options.createSessionManager ?? (() => new SessionManager());
  const createServer = options.createMcpServer ?? (
    async (manager: SessionManagerLike, serverOptions: { includeWorkflowTools: boolean }) =>
      createMcpServer(manager as SessionManager, serverOptions)
  );
  const importTransport = options.importStdioServerTransport ?? importDefaultStdioServerTransport;
  const warmBridges = options.warmWorkflowToolBridges ?? warmWorkflowToolBridges;
  const hasBridgeConfiguration = options.hasWorkflowToolBridgeConfiguration
    ?? hasWorkflowToolBridgeConfiguration;
  const resolveObservationTokenState = options.resolveMilestoneStatusObservationTokenState
    ?? resolveMilestoneStatusObservationTokenState;

  loadEnv();

  const projectDir = env.GSD_WORKFLOW_PROJECT_ROOT || cwd();
  const probeSession = isMcpProbeSession(env);
  // A parent MCP client owns these children's lifetimes and may intentionally
  // run more than one for the same project. Keep them out of the singleton PID
  // registry so one child cannot sweep or unregister another.
  const clientManagedSession = env.GSD_MCP_CLIENT_MANAGED?.trim() === '1';
  const observationToken = env.GSD_MILESTONE_STATUS_OBSERVATION_TOKEN?.trim();
  let pumpScopedObservationSession = false;
  let registered = false;
  let cleaningUp = false;
  let idleWatchdog: ReturnType<typeof setInterval> | undefined;
  let orphanMonitor: OrphanMonitorHandle | undefined;
  const lastActivityMs = new BigInt64Array(new SharedArrayBuffer(8));
  let trackedStdin: ActivityTrackingInput | undefined;
  let sessionManager: SessionManagerLike | undefined;
  let server: McpServerLike | undefined;

  async function runCleanupStep(label: string, step: () => Promise<void> | void): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(step),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            stderr.write(`[gsd-mcp-server] Cleanup step timed out: ${label}\n`);
            resolve();
          }, cleanupStepTimeoutMs);
          timeout.unref();
        }),
      ]);
    } catch {
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function stopRuntime(): Promise<void> {
    if (idleWatchdog) stopInterval(idleWatchdog);
    orphanMonitor?.stop();
    trackedStdin?.close();
    if (registered) unregisterInstance(projectDir);
    await runCleanupStep('session manager cleanup', () => sessionManager?.cleanup());
    await runCleanupStep('server close', () => server?.close());
  }

  async function cleanup(code = 0): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    stderr.write('[gsd-mcp-server] Shutting down...\n');
    await stopRuntime();
    exit(code);
  }

  onSignal('SIGTERM', () => void cleanup());
  onSignal('SIGINT', () => void cleanup());
  stdin.once('end', () => void cleanup());
  stdin.once('close', () => void cleanup());
  stdin.once('error', () => void cleanup(1));

  try {
    if (stdin.destroyed || stdin.readableEnded || stdin.closed) {
      await cleanup();
      return;
    }
    if (observationToken) {
      const tokenState = await resolveObservationTokenState(projectDir, observationToken);
      if (tokenState === 'unavailable') {
        throw new Error('refusing to start: milestone-status observation token authority is unavailable');
      }
      pumpScopedObservationSession = tokenState === 'active';
    }
    if (cleaningUp) return;

    const includeWorkflowTools = hasBridgeConfiguration(env);

    if (!probeSession && !pumpScopedObservationSession && !clientManagedSession) {
      sweepOrphans(projectDir);
      if (registerInstance(projectDir) === false) {
        throw new Error('refusing to start: existing MCP server PID could not be verified');
      }
      registered = true;
    }

    sessionManager = createSessionManager();
    ({ server } = await createServer(sessionManager, { includeWorkflowTools }));

    const { StdioServerTransport } = await importTransport();
    trackedStdin = createActivityTrackingInput(stdin, () => {
      const current = now();
      Atomics.store(lastActivityMs, 0, BigInt(Math.trunc(current)));
      return current;
    });
    const transport = new StdioServerTransport(trackedStdin.input, stdout);

    idleWatchdog = startInterval(() => {
      if (trackedStdin && now() - trackedStdin.lastActivityAt() > stdinIdleTimeoutMs && isOrphaned()) {
        stderr.write(
          `[gsd-mcp-server] Idle stdin watchdog: no activity for ${stdinIdleTimeoutMs / 1000}s and parent process is gone, shutting down\n`,
        );
        void cleanup();
      }
    }, stdinIdleCheckIntervalMs);
    idleWatchdog.unref();

    orphanMonitor = options.isOrphaned === undefined
      ? startWorkerOrphanMonitor({
        initialParentPid,
        targetPid: process.pid,
        lastActivityMsBuffer: lastActivityMs.buffer as SharedArrayBuffer,
        idleTimeoutMs: stdinIdleTimeoutMs,
        checkIntervalMs: orphanParentLossCheckIntervalMs,
        stderr,
      })
      : startMainThreadOrphanMonitor({
        startInterval,
        stopInterval,
        isOrphaned,
        idleMs: () => trackedStdin ? now() - trackedStdin.lastActivityAt() : 0,
        idleTimeoutMs: stdinIdleTimeoutMs,
        checkIntervalMs: orphanParentLossCheckIntervalMs,
        stderr,
        cleanup: () => void cleanup(),
      });

    // Fail closed (ADR-036): when workflow tools are enabled, warm their bridges
    // BEFORE connecting the transport. A standalone install without bridges
    // omits that tool surface instead of advertising handlers that cannot run.
    if (includeWorkflowTools) {
      await warmBridges();
      stderr.write('[gsd-mcp-server] workflow bridges ready\n');
    } else {
      stderr.write('[gsd-mcp-server] workflow bridges not configured; workflow tools disabled\n');
    }

    await server.connect(transport);
    stderr.write('[gsd-mcp-server] MCP server started on stdio\n');
  } catch (err) {
    stderr.write(
      `[gsd-mcp-server] Fatal: failed to start — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await cleanup(1);
  }
}
