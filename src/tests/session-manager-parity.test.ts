/**
 * SessionManager parity tests — daemon vs mcp-server (issue #2047).
 *
 * packages/daemon/src/session-manager.ts and packages/mcp-server/src/session-manager.ts
 * are maintained as two copies of the same headless-session core (EventEmitter +
 * logger on the daemon side, plain class on the mcp side). Every historical drift
 * between them shipped a user-visible bug (resolveCLIPath `which` on Windows,
 * empty-sessionId lookup, detached-process kill policy), so this suite imports
 * BOTH implementations and runs the same scenarios against each, asserting the
 * shared behavioral contract. A divergence in that contract now fails CI instead
 * of surfacing as a bug report.
 *
 * Scope: the union of behavior both hosts are expected to provide, per their
 * consumers (daemon: daemon.ts/event-bridge.ts; mcp: server.ts/cli-runner.ts):
 * session lookup, CLI resolution, terminal/paused/blocker notification detection,
 * cost accumulation (K004), ring-buffer trimming, blocker resolution, cancel,
 * results, cleanup, lifecycle restart rules (including from cancelled), and
 * failure-path parity: start()/prompt()/init() rejections and the deterministic
 * start/init timeout races must wrap, record, and reclaim identically on both.
 *
 * Known INTENTIONAL divergences (asserted only as documented below, never forced
 * equal — these are host-specific plumbing):
 * - Daemon extends EventEmitter and emits session:* lifecycle events for its
 *   EventBridge (Discord); the mcp copy emits nothing.
 * - Daemon wires a Logger; the mcp copy does not log.
 * - Ring buffer size: daemon MAX_EVENTS=100 (events are forwarded to Discord),
 *   mcp MAX_EVENTS=50. Each side is asserted against its own package constant.
 * - Daemon carries projectName (basename of projectDir) on ManagedSession and
 *   in getResult(); mcp does not.
 * - Daemon retains terminal sessions in a bounded ring (MAX_TERMINAL_SESSIONS=50)
 *   with eviction events; mcp evicts terminal sessions inline on duplicate start
 *   and never bounds its map. Shared observable rule (terminal sessions do not
 *   block a fresh start for the same dir) IS asserted on both.
 * - mcp-only: getOnlySession()/listSessions() (single-server diagnostics) and the
 *   detached-process kill fallback in cancelSessionByDir (.gsd/auto.lock +
 *   pid-registry with PID-reuse guard). The daemon owns its children via
 *   RpcClient and has no detached-process equivalent — porting that is option A
 *   (shared core) territory, out of scope for parity tests. MCP cleanup also
 *   retains cancelled sessions for inspection, while daemon cleanup clears its
 *   session map. Both host-specific outcomes are asserted below.
 * - startSession signatures differ by host shape: daemon takes an options object,
 *   mcp takes (projectDir, options). The harness below normalizes them.
 *
 * Injection: both copies construct `new RpcClient(...)` internally with no seam,
 * so this suite patches RpcClient.prototype methods with recording fakes (the
 * real constructor is inert — it only stores options and spawns on start()).
 * The REAL SessionManager code paths (startSession, handleEvent, resolveBlocker,
 * cancel, cleanup) execute unmodified.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, it, beforeEach, afterEach, after, type TestContext } from 'node:test';

import { RpcClient } from '@opengsd/rpc-client';

import { SessionManager as DaemonSessionManager } from '../../packages/daemon/src/session-manager.js';
import { MAX_EVENTS as DAEMON_MAX_EVENTS, INIT_TIMEOUT_MS as DAEMON_INIT_TIMEOUT_MS } from '../../packages/daemon/src/types.js';
import { Logger as DaemonLogger } from '../../packages/daemon/src/logger.js';
import { SessionManager as McpSessionManager } from '../../packages/mcp-server/src/session-manager.js';
import { MAX_EVENTS as MCP_MAX_EVENTS, INIT_TIMEOUT_MS as MCP_INIT_TIMEOUT_MS } from '../../packages/mcp-server/src/types.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');

// ---------------------------------------------------------------------------
// RpcClient prototype patch — recording fakes, real SessionManager code runs
// ---------------------------------------------------------------------------

interface ClientRecorder {
  ctorOptions: Record<string, unknown>;
  started: boolean;
  stopped: boolean;
  aborted: boolean;
  prompted: string[];
  uiResponses: Array<{ requestId: string; response: unknown }>;
  listeners: Array<(event: Record<string, unknown>) => void>;
  sessionId: string;
  /** Set by gateNextSessionStart: resolved to release a frozen start(). */
  releaseStart?: () => void;
}

const recorders = new WeakMap<object, ClientRecorder>();
let sessionCounter = 0;

function recorderFor(instance: object): ClientRecorder {
  let rec = recorders.get(instance);
  if (!rec) {
    rec = {
      ctorOptions: {},
      started: false,
      stopped: false,
      aborted: false,
      prompted: [],
      uiResponses: [],
      listeners: [],
      sessionId: '',
    };
    recorders.set(instance, rec);
  }
  return rec;
}

const ORIGINAL_PROTOTYPE_METHODS = new Map<string, PropertyDescriptor | undefined>();

function installFakeRpcClient(): void {
  const proto = RpcClient.prototype as unknown as Record<string, unknown>;
  for (const method of ['start', 'stop', 'init', 'onEvent', 'prompt', 'abort', 'sendUIResponse']) {
    ORIGINAL_PROTOTYPE_METHODS.set(method, Object.getOwnPropertyDescriptor(RpcClient.prototype, method));
  }

  proto['start'] = function () {
    const rec = recorderFor(this);
    rec.started = true;
    rec.ctorOptions = { ...((this as unknown as { options: Record<string, unknown> }).options ?? {}) };
    const startError = queuedStartError;
    queuedStartError = null;
    if (startError) return Promise.reject(startError);
    if (gateNextStart) {
      gateNextStart = false;
      return new Promise<void>((release) => {
        rec.releaseStart = release;
      });
    }
    return Promise.resolve();
  };

  proto['stop'] = function () {
    recorderFor(this).stopped = true;
    return Promise.resolve();
  };

  proto['init'] = function () {
    const rec = recorderFor(this);
    if (hangNextInit) {
      hangNextInit = false;
      return new Promise<never>(() => {});
    }
    const initError = queuedInitError;
    queuedInitError = null;
    if (initError) {
      return Promise.reject(initError);
    }
    sessionCounter += 1;
    rec.sessionId = `parity-sess-${String(sessionCounter).padStart(3, '0')}`;
    return Promise.resolve({ sessionId: rec.sessionId, version: 'parity' });
  };

  proto['onEvent'] = function (listener: (event: Record<string, unknown>) => void) {
    const rec = recorderFor(this);
    rec.listeners.push(listener);
    return () => {
      const idx = rec.listeners.indexOf(listener);
      if (idx >= 0) rec.listeners.splice(idx, 1);
    };
  };

  proto['prompt'] = function (message: string) {
    const rec = recorderFor(this);
    rec.prompted.push(message);
    const promptError = queuedPromptError;
    queuedPromptError = null;
    if (promptError) return Promise.reject(promptError);
    return Promise.resolve();
  };

  proto['abort'] = function () {
    recorderFor(this).aborted = true;
    return Promise.resolve();
  };

  proto['sendUIResponse'] = function (requestId: string, response: unknown) {
    recorderFor(this).uiResponses.push({ requestId, response });
  };
}

/** Queue failures for the next RpcClient method call (each consumed once). */
let queuedInitError: Error | null = null;
let queuedStartError: Error | null = null;
let queuedPromptError: Error | null = null;
/** Freeze the next RpcClient.start() so a session stays in-flight ('' sessionId). */
let gateNextStart = false;
/** Make the next RpcClient.init() hang forever (drives the init timeout race). */
let hangNextInit = false;

function failNextSessionInit(message: string): void {
  queuedInitError = new Error(message);
}

function failNextSessionStart(message: string): void {
  queuedStartError = new Error(message);
}

function failNextSessionPrompt(message: string): void {
  queuedPromptError = new Error(message);
}

function gateNextSessionStart(): void {
  gateNextStart = true;
}

function hangNextSessionInit(): void {
  hangNextInit = true;
}

installFakeRpcClient();
after(() => {
  const proto = RpcClient.prototype as unknown as Record<string, unknown>;
  for (const [method, descriptor] of ORIGINAL_PROTOTYPE_METHODS) {
    if (descriptor) Object.defineProperty(RpcClient.prototype, method, descriptor);
    else delete proto[method];
  }
  for (const timer of longTimers) clearTimeout(timer);
  longTimers.length = 0;
  globalThis.setTimeout = originalSetTimeout;
});

// ---------------------------------------------------------------------------
// Shared scenario types + harnesses
// ---------------------------------------------------------------------------

/** The ManagedSession fields both copies share (daemon adds projectName). */
interface ParitySession {
  sessionId: string;
  projectDir: string;
  status: string;
  events: Array<Record<string, unknown>>;
  pendingBlocker: { id: string; method: string; message: string; event: unknown } | null;
  cost: {
    totalCost: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  error?: string;
  client: unknown;
}

interface StartOptions {
  command?: string;
  model?: string;
  bare?: boolean;
  cliPath?: string;
}

interface Harness {
  label: string;
  maxEvents: number;
  manager: DaemonSessionManager | McpSessionManager;
  start(projectDir: string, options?: StartOptions): Promise<string>;
  sessionByDir(projectDir: string): ParitySession | undefined;
  sessionById(sessionId: string): ParitySession | undefined;
  recorderOf(client: unknown): ClientRecorder;
  /** Emit an agent event into the session's (real) handleEvent pipeline. */
  emit(session: ParitySession, event: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

const FAKE_CLI = '/parity-fake-cli';
const EXPECTED_INIT_TIMEOUT_MS = 30_000;

function restoreEnvAfter(t: TestContext, names: readonly string[]): void {
  const originalValues = new Map<string, string | undefined>();
  for (const name of names) originalValues.set(name, process.env[name]);
  t.after(() => {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function trackSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  return () => settled;
}

// Both startSession implementations race client.start()/init() against a module-
// private timeout(INIT_TIMEOUT_MS=30_000) whose setTimeout keeps the test process
// alive long after the tests finish. Track those long timers and clear them at
// teardown so the suite exits promptly; nothing else in this file uses ≥20s timers.
const longTimers: Array<NodeJS.Timeout> = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: never, ms?: number, ...rest: unknown[]) => {
  const timer = originalSetTimeout(fn, ms, ...rest);
  if ((ms ?? 0) >= 20_000) longTimers.push(timer);
  return timer;
}) as typeof setTimeout;

async function createDaemonHarness(workDir: string): Promise<Harness> {
  const logger = new DaemonLogger({ filePath: join(workDir, 'daemon.log'), level: 'error' });
  const manager = new DaemonSessionManager(logger);
  return {
    label: 'daemon',
    maxEvents: DAEMON_MAX_EVENTS,
    manager,
    start: (dir, options = {}) => manager.startSession({ projectDir: dir, cliPath: FAKE_CLI, ...options }),
    sessionByDir: (dir) => manager.getSessionByDir(dir) as unknown as ParitySession | undefined,
    sessionById: (id) => manager.getSession(id) as unknown as ParitySession | undefined,
    recorderOf: (client) => recorderFor(client as object),
    emit: (session, event) => {
      for (const listener of recorderFor(session.client as object).listeners) listener(event);
    },
    dispose: async () => {
      await manager.cleanup();
      await logger.close();
    },
  };
}

async function createMcpHarness(workDir: string): Promise<Harness> {
  void workDir;
  const manager = new McpSessionManager();
  return {
    label: 'mcp-server',
    maxEvents: MCP_MAX_EVENTS,
    manager,
    start: (dir, options = {}) => manager.startSession(dir, { cliPath: FAKE_CLI, ...options }),
    sessionByDir: (dir) => manager.getSessionByDir(dir) as unknown as ParitySession | undefined,
    sessionById: (id) => manager.getSession(id) as unknown as ParitySession | undefined,
    recorderOf: (client) => recorderFor(client as object),
    emit: (session, event) => {
      for (const listener of recorderFor(session.client as object).listeners) listener(event);
    },
    dispose: async () => {
      await manager.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared parity scenarios — run verbatim against both implementations
// ---------------------------------------------------------------------------

function registerSharedScenarios(create: (workDir: string) => Promise<Harness>): void {
  let h: Harness;
  let workDir: string;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sm-parity-scenario-'));
    h = await create(workDir);
  });

  afterEach(async () => {
    await h.dispose();
    rmSync(workDir, { recursive: true, force: true });
  });

  // ---- Lifecycle: start → running ----

  it('starts a session: init handshake, default /gsd auto command, cwd-scoped client', async () => {
    const dir = join(workDir, 'proj-a');
    const sessionId = await h.start(dir);

    const session = h.sessionById(sessionId);
    assert.ok(session, 'session should be tracked after start');
    assert.equal(session.status, 'running');
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.projectDir, resolve(dir));

    const rec = h.recorderOf(session.client);
    assert.ok(rec.started);
    assert.deepEqual(rec.prompted, ['/gsd auto']);
    assert.equal(rec.ctorOptions['cwd'], resolve(dir));
    assert.equal(rec.ctorOptions['cliPath'], FAKE_CLI);
  });

  it('forwards model/bare as client args and sends a custom command when given', async () => {
    const dir = join(workDir, 'proj-opts');
    await h.start(dir, { model: 'test-model', bare: true, command: '/gsd quick fix-typo' });

    const session = h.sessionByDir(dir)!;
    const rec = h.recorderOf(session.client);
    assert.deepEqual(rec.ctorOptions['args'], ['--model', 'test-model', '--bare']);
    assert.deepEqual(rec.prompted, ['/gsd quick fix-typo']);
  });

  it('rejects an empty or whitespace projectDir', async () => {
    const expected = 'projectDir is required and cannot be empty';
    await assert.rejects(() => h.start(''), (err: Error) => err.message === expected);
    await assert.rejects(() => h.start('   '), (err: Error) => err.message === expected);
  });

  it('rejects a duplicate start while a session is active for the same dir', async () => {
    const dir = join(workDir, 'proj-dup');
    const firstId = await h.start(dir);

    await assert.rejects(
      () => h.start(dir),
      (err: Error) => err.message ===
        `Session already active for ${resolve(dir)} (sessionId: ${firstId}, status: running)`
    );
  });

  it('reports a wrapped error, error status, and a stopped client when init fails', async () => {
    const dir = join(workDir, 'proj-init-fail');
    failNextSessionInit('Connection refused');

    await assert.rejects(
      () => h.start(dir),
      (err: Error) => err.message === `Failed to start session for ${resolve(dir)}: Connection refused`
    );

    const session = h.sessionByDir(dir);
    assert.ok(session, 'failed session is kept for inspection');
    assert.equal(session.status, 'error');
    assert.equal(session.error, 'Connection refused');
    assert.ok(h.recorderOf(session.client).stopped, 'client is reclaimed after failed start');

    // A failed start must not brick the dir: a fresh start is allowed on both sides.
    const retryId = await h.start(dir);
    assert.notEqual(retryId, session.sessionId);
    assert.equal(h.sessionByDir(dir)?.status, 'running');
  });

  it('wraps start() failures identically without reaching init', async () => {
    const dir = join(workDir, 'start-fail');
    failNextSessionStart('spawn failed');

    await assert.rejects(
      () => h.start(dir),
      (err: Error) => err.message === `Failed to start session for ${resolve(dir)}: spawn failed`
    );

    const session = h.sessionByDir(dir)!;
    const rec = h.recorderOf(session.client);
    assert.equal(session.status, 'error');
    assert.equal(session.error, 'spawn failed');
    assert.ok(rec.started, 'start was attempted');
    assert.equal(rec.sessionId, '', 'init must not run after a failed start');
    assert.ok(rec.stopped, 'client is reclaimed after failed start');
  });

  it('wraps prompt() failures identically; the event stream stays live after the error', async () => {
    const dir = join(workDir, 'prompt-fail');
    failNextSessionPrompt('agent went away');

    await assert.rejects(
      () => h.start(dir),
      (err: Error) => err.message === `Failed to start session for ${resolve(dir)}: agent went away`
    );

    const session = h.sessionByDir(dir)!;
    const rec = h.recorderOf(session.client);
    assert.equal(session.status, 'error');
    assert.equal(session.error, 'agent went away');
    assert.ok(rec.stopped);
    // The failure happened at the prompt stage: init had already succeeded.
    assert.ok(rec.sessionId !== '');
    assert.deepEqual(rec.prompted, ['/gsd auto']);
    // The subscription wired before the prompt stage is NOT unwound by the catch
    // on either copy — a later terminal notification still transitions the
    // session (which restart/eviction semantics then key off).
    h.emit(session, { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Auto-mode stopped: done' });
    assert.equal(session.status, 'completed');
  });

  it('wraps the deterministic start() timeout identically (mock timers)', async (t) => {
    const dir = join(workDir, 'start-timeout');
    gateNextSessionStart(); // start() never settles — the timeout must win
    // Per-test mock clock: restored automatically even if an assertion throws.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const startPromise = h.start(dir);
    const isSettled = trackSettlement(startPromise);
    // Let startSession reach its start() race before advancing the mock clock.
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(EXPECTED_INIT_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(isSettled(), false);
    t.mock.timers.tick(1);

    await assert.rejects(
      () => startPromise,
      (err: Error) => err.message ===
        `Failed to start session for ${resolve(dir)}: RpcClient.start() timed out after ${EXPECTED_INIT_TIMEOUT_MS}ms`
    );

    const session = h.sessionByDir(dir)!;
    assert.equal(session.status, 'error');
    assert.ok(h.recorderOf(session.client).stopped);
    assert.equal(h.recorderOf(session.client).sessionId, '', 'init must not run after a start timeout');
  });

  it('wraps the deterministic init() timeout identically (mock timers)', async (t) => {
    const dir = join(workDir, 'init-timeout');
    hangNextSessionInit(); // init() never settles — the timeout must win
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const startPromise = h.start(dir);
    const isSettled = trackSettlement(startPromise);
    // Let startSession reach the init() race before advancing the mock clock.
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(EXPECTED_INIT_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(isSettled(), false);
    t.mock.timers.tick(1);

    await assert.rejects(
      () => startPromise,
      (err: Error) => err.message ===
        `Failed to start session for ${resolve(dir)}: RpcClient.init() timed out after ${EXPECTED_INIT_TIMEOUT_MS}ms`
    );

    const session = h.sessionByDir(dir)!;
    assert.equal(session.status, 'error');
    assert.ok(h.recorderOf(session.client).stopped);
  });

  it('surfaces CLI-resolution failure unwrapped from startSession and tracks nothing', async (t) => {
    const dir = join(workDir, 'cli-resolution-fail');
    restoreEnvAfter(t, ['GSD_CLI_PATH', 'PATH']);
    delete process.env['GSD_CLI_PATH'];
    process.env['PATH'] = join(workDir, 'no-such-bin');

    // Bypass the harness's FAKE_CLI default: resolution must run exactly as
    // production invokes it (no cliPath option).
    const startPromise = h.label === 'daemon'
      ? (h.manager as DaemonSessionManager).startSession({ projectDir: dir })
      : (h.manager as McpSessionManager).startSession(dir);
    await assert.rejects(
      () => startPromise,
      (err: Error) =>
        err.message === 'Cannot find GSD CLI. Set GSD_CLI_PATH environment variable or ensure `gsd` is in PATH.'
    );
    assert.equal(h.sessionByDir(dir), undefined, 'nothing is tracked when CLI resolution fails');

    // With resolution out of the way (harness injects the fake CLI), the dir starts fine.
    const retryId = await h.start(dir);
    assert.equal(h.sessionByDir(dir)?.sessionId, retryId);
  });

  // ---- Session lookup ----

  it('looks up sessions by id and by dir, rejecting empty/unknown lookups', async () => {
    const dirA = join(workDir, 'lookup-a');
    const dirB = join(workDir, 'lookup-b');
    const idA = await h.start(dirA);
    const idB = await h.start(dirB);

    assert.equal(h.sessionById(idA)?.projectDir, resolve(dirA));
    assert.equal(h.sessionById(idB)?.projectDir, resolve(dirB));
    assert.equal(h.sessionById('no-such-id'), undefined);

    assert.equal(h.sessionByDir(dirA)?.sessionId, idA);
    // Dir lookup normalizes the path (resolve()) on both sides.
    assert.equal(h.sessionByDir(join(dirB, 'nested', '..'))?.sessionId, idB);
    assert.equal(h.sessionByDir(join(workDir, 'never-started')), undefined);
  });

  it("getSession('') must not match an in-flight session (issue drift #2)", async () => {
    // An in-flight session sits in the map with sessionId '' between insertion
    // and init(); without the empty-id guard an empty lookup silently targets it.
    gateNextSessionStart();
    const dir = join(workDir, 'in-flight');
    const startPromise = h.start(dir);

    // startSession's synchronous prefix has inserted the in-flight session.
    const inFlight = h.sessionByDir(dir);
    assert.ok(inFlight, 'in-flight session is tracked by dir before init() resolves');
    assert.equal(inFlight.sessionId, '');
    assert.equal(h.sessionById(''), undefined, 'empty lookup must not match the in-flight session');
    assert.equal(h.sessionById('no-such-id'), undefined);

    h.recorderOf(inFlight.client).releaseStart?.();
    const sessionId = await startPromise;
    assert.ok(sessionId);
    assert.equal(h.sessionById('') , undefined, 'empty lookup stays undefined once ids are set');
  });

  // ---- CLI resolution (issue drift #1) ----

  it('resolveCLIPath: GSD_CLI_PATH env wins over PATH', (t) => {
    const fakeCli = join(workDir, 'cli-from-env');
    writeFileSync(fakeCli, '#!/bin/sh\n');
    chmodSync(fakeCli, 0o755);
    const binDir = join(workDir, 'bin');
    const pathCli = join(binDir, 'gsd');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(pathCli, '#!/bin/sh\n');
    chmodSync(pathCli, 0o755);

    restoreEnvAfter(t, ['GSD_CLI_PATH', 'PATH']);
    process.env['GSD_CLI_PATH'] = fakeCli;
    process.env['PATH'] = binDir;

    assert.equal(resolve(DaemonSessionManager.resolveCLIPath()), resolve(fakeCli));
    assert.equal(resolve(McpSessionManager.resolveCLIPath()), resolve(fakeCli));
  });

  it('resolveCLIPath: PATHEXT-aware PATH scan without relying on `which`', (t) => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeCli = join(binDir, 'gsd.EXE');
    writeFileSync(fakeCli, '@echo off\r\n');
    chmodSync(fakeCli, 0o755);

    restoreEnvAfter(t, ['GSD_CLI_PATH', 'PATH', 'PATHEXT']);
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(platformDescriptor);
    t.after(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
    });
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    delete process.env['GSD_CLI_PATH'];
    process.env['PATH'] = binDir;
    process.env['PATHEXT'] = '.EXE';

    assert.equal(resolve(DaemonSessionManager.resolveCLIPath()), resolve(fakeCli));
    assert.equal(resolve(McpSessionManager.resolveCLIPath()), resolve(fakeCli));
  });

  it('resolveCLIPath: identical error when nothing is found', (t) => {
    restoreEnvAfter(t, ['GSD_CLI_PATH', 'PATH']);
    delete process.env['GSD_CLI_PATH'];
    process.env['PATH'] = join(workDir, 'empty-nonexistent-bin');
    const expected =
      'Cannot find GSD CLI. Set GSD_CLI_PATH environment variable or ensure `gsd` is in PATH.';

    assert.throws(() => DaemonSessionManager.resolveCLIPath(), (err: Error) => err.message === expected);
    assert.throws(() => McpSessionManager.resolveCLIPath(), (err: Error) => err.message === expected);
  });

  // ---- Terminal / paused / blocker notification detection ----

  it('marks the session completed for every terminal stop notification prefix', async () => {
    const terminalMessages = [
      'Auto-mode stopped: completed all tasks',
      'Step-mode stopped: user requested',
      'auto-mode complete: milestone closed',
      'No active milestone: nothing to do',
      'AUTO-MODE IDLE: waiting for work', // case-insensitive matching
    ];
    let i = 0;
    for (const message of terminalMessages) {
      const dir = join(workDir, `terminal-${i++}`);
      const sessionId = await h.start(dir);
      const session = h.sessionById(sessionId)!;
      assert.equal(session.status, 'running');

      h.emit(session, { type: 'extension_ui_request', id: `n-${i}`, method: 'notify', message });
      assert.equal(session.status, 'completed', `expected completed for: ${message}`);
      assert.equal(session.pendingBlocker, null);
      // Terminal sessions stay inspectable (getSession still resolves).
      assert.equal(h.sessionById(sessionId)?.status, 'completed');
      // The event subscription is torn down on completion: later events are inert.
      const eventCount = session.events.length;
      h.emit(session, { type: 'extension_ui_request', id: 'late', method: 'notify', message: 'Auto-mode paused (Escape).' });
      assert.equal(session.status, 'completed', 'post-completion events must not change status');
      assert.equal(session.events.length, eventCount, 'post-completion events must not be buffered');
    }
  });

  it('routes a blocked stop notification to the blocker path, not completion', async () => {
    const dir = join(workDir, 'blocked-stop');
    const session = h.sessionById(await h.start(dir))!;

    h.emit(session, {
      type: 'extension_ui_request',
      id: 'bn-1',
      method: 'notify',
      message: 'Auto-mode stopped: Blocked: waiting for approval',
    });

    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.id, 'bn-1');
    assert.equal(session.pendingBlocker.method, 'notify');
    assert.equal(session.pendingBlocker.message, 'Auto-mode stopped: Blocked: waiting for approval');
  });

  it('treats the non-blocking pause notice as terminal, not paused', async () => {
    const dir = join(workDir, 'pause-notice');
    const session = h.sessionById(await h.start(dir))!;

    h.emit(session, {
      type: 'extension_ui_request',
      id: 'pn-1',
      method: 'notify',
      message: 'Auto-mode paused: idempotent advance: unit already active',
    });

    // "paused" messages that are actually non-blocking notices are terminal on
    // both sides — treating them as paused would deadlock duplicate-start.
    assert.equal(session.status, 'completed');
  });

  it('marks the session paused on a pause notification and keeps the subscription live', async () => {
    const dir = join(workDir, 'paused');
    const session = h.sessionById(await h.start(dir))!;

    h.emit(session, {
      type: 'extension_ui_request',
      id: 'p-1',
      method: 'notify',
      message: 'Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.',
    });

    assert.equal(session.status, 'paused');
    assert.equal(session.pendingBlocker, null);

    // A paused session stays interactive; resumed output must still transition it.
    h.emit(session, {
      type: 'extension_ui_request',
      id: 'n-late',
      method: 'notify',
      message: 'Auto-mode stopped: resumed then finished',
    });
    assert.equal(session.status, 'completed');
  });

  it('marks the session paused on structured orchestrator pause events', async () => {
    const cases: Array<Record<string, unknown>> = [
      { eventType: 'orchestrator-guard-block', data: { name: 'advance-paused', reason: 'gate' } },
      { eventType: 'orchestrator-terminal', data: { name: 'stop', reason: 'pause' } },
    ];
    let i = 0;
    for (const event of cases) {
      const dir = join(workDir, `orchestrator-pause-${i++}`);
      const session = h.sessionById(await h.start(dir))!;
      h.emit(session, event);
      assert.equal(session.status, 'paused', `expected paused for ${JSON.stringify(event)}`);
      assert.equal(session.pendingBlocker, null);
    }
  });

  it('never blocks on fire-and-forget UI methods', async () => {
    const fireAndForget = ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'];
    let i = 0;
    for (const method of fireAndForget) {
      const dir = join(workDir, `faf-${i++}`);
      const session = h.sessionById(await h.start(dir))!;
      h.emit(session, { type: 'extension_ui_request', id: `faf-${i}`, method, message: 'progress: 50%' });
      assert.equal(session.status, 'running', `${method} must not block`);
      assert.equal(session.pendingBlocker, null, `${method} must not set a pendingBlocker`);
    }
  });

  it('blocks on non-fire-and-forget UI requests and extracts the blocker', async () => {
    const blocking = ['confirm', 'select', 'input', 'totally-new-method'];
    let i = 0;
    for (const method of blocking) {
      const dir = join(workDir, `blocking-${i++}`);
      const session = h.sessionById(await h.start(dir))!;
      h.emit(session, { type: 'extension_ui_request', id: `b-${i}`, method, title: 'Pick one', message: 'choose' });
      assert.equal(session.status, 'blocked', `${method} must block`);
      assert.ok(session.pendingBlocker);
      assert.equal(session.pendingBlocker.id, `b-${i}`);
      assert.equal(session.pendingBlocker.method, method);
      // extractBlocker prefers title over message — identical on both sides.
      assert.equal(session.pendingBlocker.message, 'Pick one');
      assert.deepEqual(session.pendingBlocker.event, { type: 'extension_ui_request', id: `b-${i}`, method, title: 'Pick one', message: 'choose' });
    }
  });

  // ---- Cost accumulation (K004 cumulative-max) ----

  it('accumulates cost with the cumulative-max pattern across all token kinds', async () => {
    const dir = join(workDir, 'cost');
    const session = h.sessionById(await h.start(dir))!;

    h.emit(session, {
      type: 'cost_update', cumulativeCost: 0.5,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
    h.emit(session, {
      type: 'cost_update', cumulativeCost: 1.25,
      tokens: { input: 250, output: 120, cacheRead: 40, cacheWrite: 20 },
    });
    // Lower values must not replace the running maximum.
    h.emit(session, {
      type: 'cost_update', cumulativeCost: 0.75,
      tokens: { input: 50, output: 30, cacheRead: 5, cacheWrite: 2 },
    });
    // Missing tokens block must not clobber token maxima.
    h.emit(session, { type: 'cost_update', cumulativeCost: 2 });

    assert.deepEqual(session.cost, {
      totalCost: 2,
      tokens: { input: 250, output: 120, cacheRead: 40, cacheWrite: 20 },
    });
  });

  // ---- Ring buffer ----

  it('trims the event ring buffer to its own MAX_EVENTS, dropping the oldest', async () => {
    const dir = join(workDir, 'ring-buffer');
    const session = h.sessionById(await h.start(dir))!;
    const max = h.maxEvents;

    for (let i = 0; i < max + 7; i++) {
      h.emit(session, { type: 'assistant_message', id: `evt-${i}` });
    }

    assert.equal(session.events.length, max);
    assert.equal((session.events[0] as { id: string }).id, 'evt-7', 'oldest events are dropped first');
    assert.equal((session.events[session.events.length - 1] as { id: string }).id, `evt-${max + 6}`);
  });

  // ---- Blocker resolution ----

  it('resolves a pending blocker: UI response, blocker cleared, blocked → running', async () => {
    const dir = join(workDir, 'resolve-blocker');
    const session = h.sessionById(await h.start(dir))!;

    h.emit(session, { type: 'extension_ui_request', id: 'blocker-1', method: 'confirm', title: 'Merge PR?' });
    assert.equal(session.status, 'blocked');

    await h.manager.resolveBlocker(session.sessionId, 'yes');

    const rec = h.recorderOf(session.client);
    assert.deepEqual(rec.uiResponses, [{ requestId: 'blocker-1', response: { value: 'yes' } }]);
    assert.equal(session.pendingBlocker, null);
    assert.equal(session.status, 'running');
  });

  it('resolveBlocker: identical errors for unknown session and no pending blocker', async () => {
    await assert.rejects(
      () => h.manager.resolveBlocker('no-such-session', 'x'),
      (err: Error) => err.message === 'Session not found: no-such-session'
    );

    const dir = join(workDir, 'no-blocker');
    const sessionId = await h.start(dir);
    await assert.rejects(
      () => h.manager.resolveBlocker(sessionId, 'x'),
      (err: Error) => err.message === `No pending blocker for session ${sessionId}`
    );
  });

  // ---- Cancellation ----

  it('cancels a session: abort + stop, cancelled status, subscription unwired', async () => {
    const dir = join(workDir, 'cancel');
    const sessionId = await h.start(dir);
    const session = h.sessionById(sessionId)!;
    const rec = h.recorderOf(session.client);

    await h.manager.cancelSession(sessionId);

    assert.ok(rec.aborted);
    assert.ok(rec.stopped);
    assert.equal(session.status, 'cancelled');

    // Post-cancel events must be inert (subscription removed on both sides).
    h.emit(session, { type: 'extension_ui_request', id: 'late', method: 'notify', message: 'Auto-mode stopped: done' });
    assert.equal(session.status, 'cancelled');
  });

  it('cancelSession: identical error for unknown sessionId', async () => {
    await assert.rejects(
      () => h.manager.cancelSession('no-such-session'),
      (err: Error) => err.message === 'Session not found: no-such-session'
    );
  });

  it('cancelSessionByDir works by dir; unknown dir yields the identical error', async () => {
    const dir = join(workDir, 'cancel-by-dir');
    const sessionId = await h.start(dir);
    const session = h.sessionById(sessionId)!;

    await h.manager.cancelSessionByDir(dir);
    assert.equal(session.status, 'cancelled');
    assert.ok(h.recorderOf(session.client).stopped);

    // No tracked session and no .gsd/auto.lock in a fresh dir → the same error on
    // both sides. (mcp additionally has a detached-process auto.lock fallback
    // here by design; the daemon has no detached-process equivalent — see the
    // intentional-divergence notes in the file header.)
    const unknownDir = join(workDir, 'never-started-cancel');
    await assert.rejects(
      () => h.manager.cancelSessionByDir(unknownDir),
      (err: Error) => err.message === `Session not found for projectDir: ${unknownDir}`
    );
  });

  // ---- Terminal-state restart rules ----

  it('allows a fresh start over a terminal session for the same dir', async () => {
    // paused
    const pausedDir = join(workDir, 'restart-paused');
    const pausedId = await h.start(pausedDir);
    const pausedSession = h.sessionById(pausedId)!;
    h.emit(pausedSession, {
      type: 'extension_ui_request', id: 'p', method: 'notify',
      message: 'Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.',
    });
    assert.equal(pausedSession.status, 'paused');

    const pausedRestartId = await h.start(pausedDir);
    assert.notEqual(pausedRestartId, pausedId);
    assert.equal(h.sessionByDir(pausedDir)?.sessionId, pausedRestartId);
    assert.ok(h.recorderOf(pausedSession.client).stopped, 'evicted session client is reclaimed');

    // completed
    const doneDir = join(workDir, 'restart-completed');
    const doneId = await h.start(doneDir);
    const doneSession = h.sessionById(doneId)!;
    h.emit(doneSession, { type: 'extension_ui_request', id: 'n', method: 'notify', message: 'Auto-mode stopped: done' });
    assert.equal(doneSession.status, 'completed');

    const doneRestartId = await h.start(doneDir);
    assert.notEqual(doneRestartId, doneId);
    assert.equal(h.sessionByDir(doneDir)?.sessionId, doneRestartId);

    // cancelled
    const cancelledDir = join(workDir, 'restart-cancelled');
    const cancelledId = await h.start(cancelledDir);
    const cancelledSession = h.sessionById(cancelledId)!;
    await h.manager.cancelSession(cancelledId);
    assert.equal(cancelledSession.status, 'cancelled');

    const cancelledRestartId = await h.start(cancelledDir);
    assert.notEqual(cancelledRestartId, cancelledId);
    assert.equal(h.sessionByDir(cancelledDir)?.sessionId, cancelledRestartId);
    assert.ok(h.recorderOf(cancelledSession.client).stopped);
  });

  // ---- getResult ----

  it('getResult: identical shared shape for a running session', async () => {
    const dir = join(workDir, 'result');
    const sessionId = await h.start(dir);

    const result = h.manager.getResult(sessionId) as Record<string, unknown>;
    assert.equal(result['sessionId'], sessionId);
    assert.equal(result['projectDir'], resolve(dir));
    assert.equal(result['status'], 'running');
    assert.equal(result['error'], null);
    assert.equal(result['pendingBlocker'], null);
    assert.ok(typeof result['durationMs'] === 'number');
    assert.deepEqual(result['cost'], {
      totalCost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    assert.deepEqual(result['recentEvents'], []);

    // pendingBlocker is projected to {id, method, message} (no raw event echo).
    const session = h.sessionById(sessionId)!;
    h.emit(session, { type: 'extension_ui_request', id: 'b-9', method: 'select', title: 'Target?' });
    const blockedResult = h.manager.getResult(sessionId) as Record<string, unknown>;
    assert.deepEqual(blockedResult['pendingBlocker'], { id: 'b-9', method: 'select', message: 'Target?' });

    // recentEvents is capped at the last 10 events.
    for (let i = 0; i < 12; i++) h.emit(session, { type: 'assistant_message', id: `r-${i}` });
    const recent = (h.manager.getResult(sessionId) as Record<string, unknown>)['recentEvents'] as Array<{ id: string }>;
    assert.equal(recent.length, 10);
    assert.equal(recent[0].id, 'r-2');
    assert.equal(recent[9].id, 'r-11');
  });

  it('getResult: identical error for unknown sessionId', () => {
    assert.throws(
      () => h.manager.getResult('no-such-session'),
      (err: Error) => err.message === 'Session not found: no-such-session'
    );
  });

  // ---- Cleanup ----

  it('cleanup stops and cancels running, blocked, and paused sessions', async () => {
    const running = h.sessionById(await h.start(join(workDir, 'cleanup-running')))!;
    const blocked = h.sessionById(await h.start(join(workDir, 'cleanup-blocked')))!;
    h.emit(blocked, { type: 'extension_ui_request', id: 'cb', method: 'input', title: 'Key?' });
    const paused = h.sessionById(await h.start(join(workDir, 'cleanup-paused')))!;
    h.emit(paused, {
      type: 'extension_ui_request', id: 'cp', method: 'notify',
      message: 'Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.',
    });

    await h.manager.cleanup();

    for (const session of [running, blocked, paused]) {
      assert.equal(session.status, 'cancelled');
      assert.ok(h.recorderOf(session.client).stopped);
    }

    // Intentional host divergence: daemon cleanup drops its map, while MCP
    // keeps cancelled sessions addressable for post-cleanup inspection.
    if (h.label === 'daemon') {
      assert.equal(h.sessionById(running.sessionId), undefined);
    } else {
      assert.equal(h.sessionById(running.sessionId), running);
    }
  });
}

// ---------------------------------------------------------------------------
// Suite wiring — one describe per implementation, identical scenario list
// ---------------------------------------------------------------------------

describe('SessionManager parity — daemon copy', () => {
  registerSharedScenarios(createDaemonHarness);
});

describe('SessionManager parity — mcp-server copy', () => {
  registerSharedScenarios(createMcpHarness);
});

async function createDocumentedHarnesses(t: TestContext): Promise<{
  workDir: string;
  daemon: Harness;
  mcp: Harness;
}> {
  const workDir = mkdtempSync(join(tmpdir(), 'sm-parity-documented-'));
  const daemon = await createDaemonHarness(workDir);
  const mcp = await createMcpHarness(workDir);
  t.after(async () => {
    await daemon.dispose();
    await mcp.dispose();
    rmSync(workDir, { recursive: true, force: true });
  });
  return { workDir, daemon, mcp };
}

describe('SessionManager parity — documented surface', () => {
  it('both copies expose the same shared API surface', () => {
    const sharedMethods = [
      'startSession',
      'getSession',
      'getSessionByDir',
      'resolveBlocker',
      'cancelSession',
      'cancelSessionByDir',
      'getResult',
      'cleanup',
    ];
    for (const copy of [DaemonSessionManager, McpSessionManager]) {
      for (const method of sharedMethods) {
        assert.equal(typeof copy.prototype[method], 'function', `${copy.name}.${method} must exist`);
      }
      assert.equal(typeof copy.resolveCLIPath, 'function', `${copy.name}.resolveCLIPath (static) must exist`);
    }
  });

  it('ring-buffer sizes are the documented intentional divergence (daemon 100, mcp 50)', () => {
    // These values are host-by-design (see file header). Asserting them keeps the
    // divergence deliberate: changing one requires updating this test consciously.
    assert.equal(DAEMON_MAX_EVENTS, 100);
    assert.equal(MCP_MAX_EVENTS, 50);
  });

  it('both copies retain the shared 30000ms initialization timeout', () => {
    assert.equal(DAEMON_INIT_TIMEOUT_MS, EXPECTED_INIT_TIMEOUT_MS);
    assert.equal(MCP_INIT_TIMEOUT_MS, EXPECTED_INIT_TIMEOUT_MS);
  });

  it('daemon alone exposes lifecycle events and projectName', async (t) => {
    const { workDir, daemon, mcp } = await createDocumentedHarnesses(t);
    const daemonManager = daemon.manager as DaemonSessionManager;
    const mcpManager = mcp.manager as McpSessionManager;
    const lifecycle: Array<{ type: string; payload: Record<string, unknown> }> = [];
    daemonManager.on('session:started', (payload) => lifecycle.push({ type: 'started', payload }));
    daemonManager.on('session:cancelled', (payload) => lifecycle.push({ type: 'cancelled', payload }));

    assert.equal(daemonManager instanceof EventEmitter, true);
    assert.equal(mcpManager instanceof EventEmitter, false);

    const projectDir = join(workDir, 'named-project');
    const projectName = basename(projectDir);
    const daemonId = await daemon.start(projectDir);
    const daemonSession = daemon.sessionById(daemonId) as ParitySession & { projectName: string };
    assert.equal(daemonSession.projectName, projectName);
    assert.equal(daemonManager.getResult(daemonId)['projectName'], projectName);

    const mcpId = await mcp.start(projectDir);
    assert.equal(Object.hasOwn(mcp.sessionById(mcpId)!, 'projectName'), false);
    assert.equal(Object.hasOwn(mcpManager.getResult(mcpId), 'projectName'), false);

    await daemonManager.cancelSession(daemonId);
    assert.deepEqual(lifecycle, [
      {
        type: 'started',
        payload: {
          sessionId: daemonId,
          projectDir: resolve(projectDir),
          projectName,
        },
      },
      {
        type: 'cancelled',
        payload: {
          sessionId: daemonId,
          projectDir: resolve(projectDir),
          projectName,
        },
      },
    ]);
  });

  it('pins each host-specific session collection API', async (t) => {
    const { workDir, daemon, mcp } = await createDocumentedHarnesses(t);
    const daemonManager = daemon.manager as DaemonSessionManager;
    const mcpManager = mcp.manager as McpSessionManager;

    assert.equal('getOnlySession' in daemonManager, false);
    assert.equal('listSessions' in daemonManager, false);
    assert.equal('getAllSessions' in mcpManager, false);
    assert.deepEqual(daemonManager.getAllSessions(), []);
    assert.equal(mcpManager.getOnlySession(), undefined);
    assert.deepEqual(mcpManager.listSessions(), []);

    const daemonId = await daemon.start(join(workDir, 'daemon-collection'));
    const firstMcpId = await mcp.start(join(workDir, 'mcp-collection-a'));
    assert.deepEqual(daemonManager.getAllSessions().map((session) => session.sessionId), [daemonId]);
    assert.equal(mcpManager.getOnlySession()?.sessionId, firstMcpId);
    assert.deepEqual(mcpManager.listSessions().map((session) => session.sessionId), [firstMcpId]);

    const secondMcpId = await mcp.start(join(workDir, 'mcp-collection-b'));
    assert.equal(mcpManager.getOnlySession(), undefined);
    assert.deepEqual(mcpManager.listSessions().map((session) => session.sessionId), [firstMcpId, secondMcpId]);
  });

  it('pins daemon terminal retention and mcp inline replacement', async (t) => {
    const { workDir, daemon, mcp } = await createDocumentedHarnesses(t);
    const daemonManager = daemon.manager as DaemonSessionManager;
    const mcpManager = mcp.manager as McpSessionManager;
    const daemonIds: string[] = [];
    const mcpIds: string[] = [];

    for (let index = 0; index < 51; index += 1) {
      const daemonId = await daemon.start(join(workDir, `daemon-terminal-${index}`));
      const daemonSession = daemon.sessionById(daemonId)!;
      daemon.emit(daemonSession, {
        type: 'extension_ui_request',
        id: `daemon-done-${index}`,
        method: 'notify',
        message: 'Auto-mode stopped: done',
      });
      daemonIds.push(daemonId);

      const mcpId = await mcp.start(join(workDir, `mcp-terminal-${index}`));
      const mcpSession = mcp.sessionById(mcpId)!;
      mcp.emit(mcpSession, {
        type: 'extension_ui_request',
        id: `mcp-done-${index}`,
        method: 'notify',
        message: 'Auto-mode stopped: done',
      });
      mcpIds.push(mcpId);
    }

    assert.equal(daemonManager.getAllSessions().length, 50);
    assert.equal(daemon.sessionById(daemonIds[0]), undefined);
    assert.equal(daemon.sessionById(daemonIds[50])?.sessionId, daemonIds[50]);
    assert.equal(mcpManager.listSessions().length, 51);
    assert.equal(mcp.sessionById(mcpIds[0])?.sessionId, mcpIds[0]);

    const firstMcpDir = join(workDir, 'mcp-terminal-0');
    const replacementId = await mcp.start(firstMcpDir);
    assert.equal(mcpManager.listSessions().length, 51);
    assert.equal(mcp.sessionById(mcpIds[0]), undefined);
    assert.equal(mcp.sessionByDir(firstMcpDir)?.sessionId, replacementId);
  });

  it('mcp signals a guarded detached auto.lock PID while daemon has no fallback', async (t) => {
    const { workDir: projectDir, daemon, mcp } = await createDocumentedHarnesses(t);
    mkdirSync(join(projectDir, '.gsd'), { recursive: true });
    const lockPath = join(projectDir, '.gsd', 'auto.lock');
    const recordedMs = Date.parse('2026-01-01T00:00:00.000Z');
    const startedAt = new Date(recordedMs).toISOString();
    const stalePid = 7101;
    const foreignPid = 7102;
    const detachedPid = 7103;
    const snapshots = new Map([
      [stalePid, { startMs: Date.parse('2027-01-01T00:00:00.000Z'), cwd: projectDir }],
      [foreignPid, { startMs: recordedMs, cwd: join(projectDir, '..', 'foreign-project') }],
      [detachedPid, { startMs: recordedMs, cwd: projectDir }],
    ]);
    function writeLock(pid: number): void {
      writeFileSync(lockPath, JSON.stringify({ pid, startedAt }));
    }

    const mutableChildProcess = childProcess as typeof childProcess & {
      execFileSync: typeof childProcess.execFileSync;
    };
    const originalExecFileSync = mutableChildProcess.execFileSync;
    mutableChildProcess.execFileSync = ((command: string, args: string[]) => {
      const invocation = args.join(' ');
      const pid = Number(/(?:-p\s+|ProcessId=|\$pid=)(\d+)/.exec(invocation)?.[1]);
      const snapshot = snapshots.get(pid);
      if (!snapshot) throw new Error(`Unexpected process probe: ${command} ${invocation}`);
      if (command === 'ps' || invocation.includes('CreationDate')) {
        return command === 'ps' ? new Date(snapshot.startMs).toISOString() : String(snapshot.startMs);
      }
      if (command === 'lsof') return `p${pid}\nn${snapshot.cwd}\n`;
      if (command === 'pwdx') return `${pid}: ${snapshot.cwd}`;
      if (command === 'powershell.exe') return snapshot.cwd;
      throw new Error(`Unexpected process probe: ${command} ${invocation}`);
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    t.after(() => {
      mutableChildProcess.execFileSync = originalExecFileSync;
      syncBuiltinESMExports();
    });

    const signals: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      signals.push({ pid, signal });
      return true;
    });

    writeLock(stalePid);

    await assert.rejects(
      () => daemon.manager.cancelSessionByDir(projectDir),
      (err: Error) => err.message === `Session not found for projectDir: ${projectDir}`
    );
    assert.deepEqual(signals, []);

    await assert.rejects(
      () => mcp.manager.cancelSessionByDir(projectDir),
      (err: Error) => err.message === `Session not found for projectDir: ${projectDir}`
    );
    assert.deepEqual(signals, [{ pid: stalePid, signal: 0 }]);

    writeLock(foreignPid);
    await assert.rejects(
      () => mcp.manager.cancelSessionByDir(projectDir),
      (err: Error) => err.message === `Session not found for projectDir: ${projectDir}`
    );
    assert.deepEqual(signals, [
      { pid: stalePid, signal: 0 },
      { pid: foreignPid, signal: 0 },
    ]);

    writeLock(detachedPid);
    await mcp.manager.cancelSessionByDir(projectDir);
    assert.deepEqual(signals, [
      { pid: stalePid, signal: 0 },
      { pid: foreignPid, signal: 0 },
      { pid: detachedPid, signal: 0 },
      { pid: detachedPid, signal: 'SIGTERM' },
    ]);
  });
});
