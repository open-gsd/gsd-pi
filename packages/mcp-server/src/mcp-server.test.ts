/**
 * @opengsd/mcp-server — Integration and unit tests.
 *
 * Strategy: We cannot mock @opengsd/rpc-client at the module level without
 * --experimental-test-module-mocks. Instead we test by:
 *
 * 1. Subclassing SessionManager to inject a mock client factory
 * 2. Testing event handling, state transitions, and error paths
 * 3. Testing tool registration via createMcpServer
 * 4. Testing CLI path resolution via static method
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { SessionManager } from './session-manager.js';
import { installGlobalErrorHandlers } from './cli-errors.js';
import {
  askUserQuestionsHandler,
  buildAskUserQuestionsElicitRequest,
  createMcpServer,
  formatAskUserQuestionsElicitResult,
  isLocalElicitClientAbortError,
  isLocalElicitTimeoutError,
  withElicitTimeout,
} from './server.js';
import {
  createWorkflowMcpAdapterToolDefs,
  GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES,
} from './mcp-adapter-tools.js';
import { MAX_EVENTS } from './types.js';
import type { ManagedSession, CostAccumulator, PendingBlocker } from './types.js';
import { WORKFLOW_TOOL_ALIAS_NAMES } from '@opengsd/contracts';

interface WorkflowBridgeFixtureModule {
  closeDatabase(): void;
  insertMilestone(milestone: { id: string; title: string; status: string }): boolean;
  insertSlice(slice: {
    id: string;
    milestoneId: string;
    title: string;
    status: string;
    risk: string;
    depends: string[];
    sequence: number;
  }): void;
  openDatabase(path: string): boolean;
}

async function importWorkflowBridgeFixture(): Promise<WorkflowBridgeFixtureModule> {
  const candidates = [
    '../../../src/resources/extensions/gsd/mcp-bridge.js',
    '../../../src/resources/extensions/gsd/mcp-bridge.ts',
    '../../../dist/resources/extensions/gsd/mcp-bridge.js',
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await import(new URL(candidate, import.meta.url).href) as WorkflowBridgeFixtureModule;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('installGlobalErrorHandlers', () => {
  it('logs uncaught exceptions and unhandled rejections to stderr, then terminates (#783)', () => {
    const writes: string[] = [];
    const exits: number[] = [];
    const runtime = new EventEmitter() as EventEmitter & {
      stderr: { write(message: string): boolean };
      exit: (code: number) => never;
    };
    runtime.stderr = {
      write(message: string): boolean {
        writes.push(message);
        return true;
      },
    };
    runtime.exit = (code: number): never => {
      exits.push(code);
      // Throw to short-circuit the handler so assertions run, mirroring how
      // process.exit never returns in the real process.
      throw new Error(`exit:${code}`);
    };

    installGlobalErrorHandlers(runtime);
    assert.throws(() => runtime.emit('uncaughtException', new Error('boom')), /exit:1/);
    assert.throws(() => runtime.emit('unhandledRejection', 'bad rejection'), /exit:1/);

    const output = writes.join('');
    assert.match(output, /\[gsd-mcp-server\] Uncaught exception: Error: boom/);
    assert.match(output, /\[gsd-mcp-server\] Unhandled rejection: bad rejection/);
    // Each handler must terminate after logging — a repeating throw against a
    // dead stdio pipe would otherwise log-and-loop, pegging CPU (#783).
    assert.deepEqual(exits, [1, 1]);
  });
});

// ---------------------------------------------------------------------------
// Mock RpcClient (duck-typed to match RpcClient interface)
// ---------------------------------------------------------------------------

class MockRpcClient {
  started = false;
  stopped = false;
  aborted = false;
  prompted: string[] = [];
  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  uiResponses: Array<{ requestId: string; response: Record<string, unknown> }> = [];

  /** Control — set to make start() reject */
  startError: Error | null = null;
  /** Control — set to make init() reject */
  initError: Error | null = null;
  /** Control — override sessionId from init */
  initSessionId = 'mock-session-001';

  cwd: string;
  args: string[];

  constructor(options?: Record<string, unknown>) {
    this.cwd = (options?.cwd as string) ?? '';
    this.args = (options?.args as string[]) ?? [];
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async init(): Promise<{ sessionId: string; version: string }> {
    if (this.initError) throw this.initError;
    return { sessionId: this.initSessionId, version: '2.51.0' };
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  async prompt(message: string): Promise<void> {
    this.prompted.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  sendUIResponse(requestId: string, response: Record<string, unknown>): void {
    this.uiResponses.push({ requestId, response });
  }

  /** Test helper — emit an event to all listeners */
  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// TestableSessionManager — injects mock clients without module mocking
// ---------------------------------------------------------------------------

/**
 * Subclass that overrides startSession to use MockRpcClient instead of the
 * real RpcClient. We directly construct the session object, mirroring the
 * parent's logic but with our mock.
 */
class TestableSessionManager extends SessionManager {
  /** The last mock client created */
  lastClient: MockRpcClient | null = null;
  /** All mock clients */
  allClients: MockRpcClient[] = [];
  /** Counter for unique session IDs across multiple sessions */
  private sessionCounter = 0;
  /** Control: set to make startSession fail during init */
  nextInitError: Error | null = null;
  /** Control: set to make startSession fail during start */
  nextStartError: Error | null = null;

  override async startSession(projectDir: string, options: { cliPath?: string; command?: string; model?: string; bare?: boolean } = {}): Promise<string> {
    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);

    // Mirror the real SessionManager (#4476): only block when a genuinely
    // active session is running. Terminal states are evicted.
    const existing = this.getSessionByDir(resolvedDir);
    if (existing) {
      if (existing.status === 'starting' || existing.status === 'running' || existing.status === 'blocked') {
        throw new Error(
          `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
        );
      }
      existing.unsubscribe?.();
      void existing.client.stop().catch(() => { /* swallow */ });
      (this as any).sessions.delete(resolvedDir);
    }

    const client = new MockRpcClient({ cwd: resolvedDir, args: [] });
    if (this.nextStartError) {
      client.startError = this.nextStartError;
      this.nextStartError = null;
    }
    if (this.nextInitError) {
      client.initError = this.nextInitError;
      this.nextInitError = null;
    }

    this.sessionCounter++;
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    this.lastClient = client;
    this.allClients.push(client);

    // Create the session shell
    const session: ManagedSession = {
      sessionId: '',
      projectDir: resolvedDir,
      status: 'starting',
      client: client as any, // duck-typed mock
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };

    // Insert into internal sessions map — access via protected method
    this._putSession(resolvedDir, session);

    try {
      await client.start();

      const initResult = await client.init();
      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // Wire event tracking using the same handleEvent logic as parent
      session.unsubscribe = client.onEvent((event: Record<string, unknown>) => {
        this._handleEvent(session, event);
      });

      // Kick off auto-mode
      const command = options.command ?? '/gsd auto';
      await client.prompt(command);

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      try { await client.stop(); } catch { /* swallow */ }
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }

  /** Expose internal session map insertion for testing */
  _putSession(key: string, session: ManagedSession): void {
    // Access the private sessions map via any cast
    (this as any).sessions.set(key, session);
  }

  /** Expose handleEvent for testing */
  _handleEvent(session: ManagedSession, event: Record<string, unknown>): void {
    (this as any).handleEvent(session, event);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let allManagers: TestableSessionManager[] = [];

function createManager(): TestableSessionManager {
  const mgr = new TestableSessionManager();
  allManagers.push(mgr);
  return mgr;
}

// ---------------------------------------------------------------------------
// SessionManager unit tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let sm: TestableSessionManager;

  beforeEach(() => {
    sm = createManager();
  });

  afterEach(async () => {
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });

  it('startSession creates session and returns sessionId', async () => {
    const sessionId = await sm.startSession('/tmp/test-project', { cliPath: '/usr/bin/gsd' });
    assert.equal(sessionId, 'mock-session-001');

    const session = sm.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.projectDir, resolve('/tmp/test-project'));
  });

  it('startSession sends /gsd auto by default', async () => {
    await sm.startSession('/tmp/test-prompt', { cliPath: '/usr/bin/gsd' });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ['/gsd auto']);
  });

  it('startSession sends custom command when provided', async () => {
    await sm.startSession('/tmp/test-cmd', { cliPath: '/usr/bin/gsd', command: '/gsd auto --resume' });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ['/gsd auto --resume']);
  });

  it('startSession delegates rpc mode to RpcClient exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-session-argv-'));
    const argvPath = join(dir, 'argv.json');
    const scriptPath = join(dir, 'agent.cjs');
    writeFileSync(
      scriptPath,
      `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (msg.type === 'init') {
              process.stdout.write(JSON.stringify({
                type: 'response',
                id: msg.id,
                success: true,
                data: { protocolVersion: 2, sessionId: 'real-session', capabilities: {} },
              }) + '\\n');
            } else if (msg.id) {
              process.stdout.write(JSON.stringify({
                type: 'response',
                id: msg.id,
                success: true,
                data: {},
              }) + '\\n');
            }
          }
        });
        setInterval(() => {}, 1000);
      `,
    );
    const manager = new SessionManager();

    try {
      const sessionId = await manager.startSession(dir, {
        cliPath: scriptPath,
        model: 'claude-sonnet',
        bare: true,
      });

      assert.equal(sessionId, 'real-session');
      assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')), [
        '--mode',
        'rpc',
        '--model',
        'claude-sonnet',
        '--bare',
      ]);
    } finally {
      await manager.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startSession rejects duplicate projectDir', async () => {
    await sm.startSession('/tmp/dup-test', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.startSession('/tmp/dup-test', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Session already active'));
        return true;
      },
    );
  });

  // #4476: terminal-state sessions (paused/completed/error/cancelled) are evicted so
  // the same projectDir can host a fresh session — only starting/running/blocked
  // sessions block re-entry.
  for (const terminalStatus of ['paused', 'completed', 'error', 'cancelled'] as const) {
    it(`startSession evicts a prior '${terminalStatus}' session for the same projectDir`, async () => {
      const dir = `/tmp/evict-${terminalStatus}`;
      const firstSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      const first = sm.getSession(firstSessionId)!;
      const firstClient = sm.lastClient!;
      first.status = terminalStatus;

      // Should not throw — terminal session is evicted, fresh one starts.
      const secondSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      assert.notEqual(secondSessionId, firstSessionId);
      assert.ok(firstClient.stopped, `evicted '${terminalStatus}' session client should be stopped`);
      const second = sm.getSession(secondSessionId)!;
      assert.equal(second.status, 'running');
      assert.equal(sm.getSessionByDir(dir)!.sessionId, secondSessionId);
    });
  }

  for (const activeStatus of ['starting', 'running', 'blocked'] as const) {
    it(`startSession still rejects a prior '${activeStatus}' session`, async () => {
      const dir = `/tmp/keep-${activeStatus}`;
      const sid = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      sm.getSession(sid)!.status = activeStatus;
      await assert.rejects(
        () => sm.startSession(dir, { cliPath: '/usr/bin/gsd' }),
        /Session already active/,
      );
    });
  }

  it('startSession rejects empty projectDir', async () => {
    await assert.rejects(
      () => sm.startSession('', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('projectDir is required'));
        return true;
      },
    );
  });

  it('startSession sets error status on start() failure', async () => {
    sm.nextStartError = new Error('spawn failed');

    await assert.rejects(
      () => sm.startSession('/tmp/fail-start', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to start session'));
        assert.ok(err.message.includes('spawn failed'));
        return true;
      },
    );
  });

  it('startSession sets error status on init() failure', async () => {
    sm.nextInitError = new Error('handshake failed');

    await assert.rejects(
      () => sm.startSession('/tmp/fail-init', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to start session'));
        assert.ok(err.message.includes('handshake failed'));
        return true;
      },
    );
  });

  it('getSession returns undefined for unknown sessionId', () => {
    const result = sm.getSession('nonexistent-id');
    assert.equal(result, undefined);
  });

  it('getSessionByDir returns session for known dir', async () => {
    await sm.startSession('/tmp/by-dir', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSessionByDir('/tmp/by-dir');
    assert.ok(session);
    assert.equal(session.sessionId, 'mock-session-001');
  });

  it('resolveBlocker errors when no pending blocker', async () => {
    const sessionId = await sm.startSession('/tmp/no-blocker', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, 'some response'),
      (err: Error) => {
        assert.ok(err.message.includes('No pending blocker'));
        return true;
      },
    );
  });

  it('resolveBlocker errors for unknown session', async () => {
    await assert.rejects(
      () => sm.resolveBlocker('unknown-session', 'some response'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });

  it('resolveBlocker clears pendingBlocker and sends UI response', async () => {
    const sessionId = await sm.startSession('/tmp/blocker-resolve', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // Simulate a blocking UI request event
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-42',
      method: 'select',
      title: 'Pick an option',
    });

    const session = sm.getSession(sessionId)!;
    assert.ok(session.pendingBlocker);
    assert.equal(session.status, 'blocked');

    // Resolve the blocker
    await sm.resolveBlocker(sessionId, 'option-a');

    assert.equal(session.pendingBlocker, null);
    assert.equal(session.status, 'running');
    assert.equal(client.uiResponses.length, 1);
    assert.equal(client.uiResponses[0].requestId, 'req-42');
  });

  it('cancelSession calls abort + stop on client', async () => {
    const sessionId = await sm.startSession('/tmp/cancel-test', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    await sm.cancelSession(sessionId);

    assert.ok(client.aborted);
    assert.ok(client.stopped);

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'cancelled');
  });

  it('cancelSession errors for unknown session', async () => {
    await assert.rejects(
      () => sm.cancelSession('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });

  it('cleanup stops all active sessions', async () => {
    await sm.startSession('/tmp/cleanup-1', { cliPath: '/usr/bin/gsd' });
    await sm.startSession('/tmp/cleanup-2', { cliPath: '/usr/bin/gsd' });

    assert.equal(sm.allClients.length, 2);

    await sm.cleanup();

    for (const client of sm.allClients) {
      assert.ok(client.stopped, 'Client should be stopped after cleanup');
    }
  });

  it('event ring buffer caps at MAX_EVENTS', async () => {
    const sessionId = await sm.startSession('/tmp/ring-buffer', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      client.emitEvent({ type: 'tool_use', index: i });
    }

    const session = sm.getSession(sessionId)!;
    assert.equal(session.events.length, MAX_EVENTS);
    // Oldest events trimmed — first event index should be 20
    assert.equal((session.events[0] as Record<string, unknown>).index, 20);
  });

  it('blocker detection: non-fire-and-forget extension_ui_request sets pendingBlocker', async () => {
    const sessionId = await sm.startSession('/tmp/blocker-detect', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // 'select' is not in FIRE_AND_FORGET_METHODS
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-99',
      method: 'select',
      title: 'Choose wisely',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.id, 'req-99');
    assert.equal(session.pendingBlocker.method, 'select');
  });

  it('fire-and-forget methods do not set pendingBlocker', async () => {
    const sessionId = await sm.startSession('/tmp/fire-forget', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // 'notify' is fire-and-forget — on its own (no terminal prefix) should not block
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-100',
      method: 'notify',
      message: 'Just a notification',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'running');
    assert.equal(session.pendingBlocker, null);
  });

  it('terminal detection: auto-mode stopped sets status to completed', async () => {
    const sessionId = await sm.startSession('/tmp/terminal', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode stopped — all tasks complete',
      id: 'term-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'completed');
  });

  it('pause detection: auto-mode paused sets status to paused and allows restart', async () => {
    const dir = '/tmp/terminal-paused';
    const sessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.',
      id: 'pause-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'paused');
    assert.equal(session.pendingBlocker, null);

    const nextSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
    assert.notEqual(nextSessionId, sessionId);
    assert.ok(client.stopped);
    assert.equal(sm.getSessionByDir(dir)!.sessionId, nextSessionId);
    assert.equal(sm.getSession(nextSessionId)!.status, 'running');
  });

  it('pause detection keeps the event subscription for resumed output', async () => {
    const dir = '/tmp/terminal-paused-resume';
    const sessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.',
      id: 'pause-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'paused');

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode stopped: completed all tasks',
      id: 'term-1',
    });

    assert.equal(session.status, 'completed');
  });

  it('pause detection: structured orchestrator terminal pause sets status to paused', async () => {
    const dir = '/tmp/structured-terminal-paused';
    const sessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      eventType: 'orchestrator-terminal',
      data: {
        source: 'auto-orchestrator',
        name: 'stop',
        reason: 'pause',
      },
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'paused');
    assert.equal(session.pendingBlocker, null);

    const nextSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
    assert.notEqual(nextSessionId, sessionId);
    assert.equal(sm.getSessionByDir(dir)!.sessionId, nextSessionId);
  });

  it('terminal detection with blocked: message sets status to blocked', async () => {
    const sessionId = await sm.startSession('/tmp/terminal-blocked', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode stopped — blocked: needs user input',
      id: 'block-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
  });

  it('cost tracking: cumulative-max from cost_update events', async () => {
    const sessionId = await sm.startSession('/tmp/cost-track', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'cost_update',
      cumulativeCost: 0.05,
      tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
    });

    client.emitEvent({
      type: 'cost_update',
      cumulativeCost: 0.12,
      tokens: { input: 2500, output: 800, cacheRead: 150, cacheWrite: 300 },
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.cost.totalCost, 0.12);
    assert.equal(session.cost.tokens.input, 2500);
    assert.equal(session.cost.tokens.output, 800);
    assert.equal(session.cost.tokens.cacheRead, 200); // First was higher
    assert.equal(session.cost.tokens.cacheWrite, 300); // Second was higher
  });

  it('getResult returns HeadlessJsonResult-shaped object', async () => {
    const sessionId = await sm.startSession('/tmp/result-shape', { cliPath: '/usr/bin/gsd' });
    const result = sm.getResult(sessionId);

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.projectDir, resolve('/tmp/result-shape'));
    assert.equal(result.status, 'running');
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.cost);
    assert.ok(Array.isArray(result.recentEvents));
    assert.equal(result.pendingBlocker, null);
    assert.equal(result.error, null);
  });

  it('getResult errors for unknown session', () => {
    assert.throws(
      () => sm.getResult('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// CLI path resolution tests
// ---------------------------------------------------------------------------

describe('SessionManager.resolveCLIPath', () => {
  const originalGsdPath = process.env['GSD_CLI_PATH'];
  const originalPath = process.env['PATH'];
  const originalPathTitle = process.env['Path'];

  afterEach(() => {
    if (originalGsdPath !== undefined) {
      process.env['GSD_CLI_PATH'] = originalGsdPath;
    } else {
      delete process.env['GSD_CLI_PATH'];
    }
    if (originalPath !== undefined) {
      process.env['PATH'] = originalPath;
    } else {
      delete process.env['PATH'];
    }
    if (originalPathTitle !== undefined) {
      process.env['Path'] = originalPathTitle;
    } else {
      delete process.env['Path'];
    }
  });

  it('GSD_CLI_PATH env var takes precedence', () => {
    process.env['GSD_CLI_PATH'] = '/custom/path/to/gsd';
    const result = SessionManager.resolveCLIPath();
    assert.equal(result, resolve('/custom/path/to/gsd'));
  });

  it('finds gsd on PATH without shelling out to which', () => {
    delete process.env['GSD_CLI_PATH'];
    const tmp = mkdtempSync(join(tmpdir(), 'gsd-cli-path-'));
    try {
      const shimName = process.platform === 'win32' ? 'gsd.cmd' : 'gsd';
      const shimPath = join(tmp, shimName);
      writeFileSync(shimPath, '', 'utf8');
      process.env['PATH'] = [tmp, originalPath].filter(Boolean).join(delimiter);

      const resolvedPath = SessionManager.resolveCLIPath();
      if (process.platform === 'win32') {
        assert.equal(resolvedPath.toLowerCase(), resolve(shimPath).toLowerCase());
      } else {
        assert.equal(resolvedPath, resolve(shimPath));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds gsd when Windows exposes Path instead of PATH', () => {
    delete process.env['GSD_CLI_PATH'];
    delete process.env['PATH'];
    const tmp = mkdtempSync(join(tmpdir(), 'gsd-cli-path-title-'));
    try {
      const shimName = process.platform === 'win32' ? 'gsd.cmd' : 'gsd';
      const shimPath = join(tmp, shimName);
      writeFileSync(shimPath, '', 'utf8');
      process.env['Path'] = tmp;

      const resolvedPath = SessionManager.resolveCLIPath();
      if (process.platform === 'win32') {
        assert.equal(resolvedPath.toLowerCase(), resolve(shimPath).toLowerCase());
      } else {
        assert.equal(resolvedPath, resolve(shimPath));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when GSD_CLI_PATH not set and PATH lookup fails', () => {
    delete process.env['GSD_CLI_PATH'];
    delete process.env['Path'];
    process.env['PATH'] = '/nonexistent';
    assert.throws(
      () => SessionManager.resolveCLIPath(),
      (err: Error) => {
        assert.ok(err.message.includes('Cannot find GSD CLI'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Tool registration tests (via createMcpServer)
// ---------------------------------------------------------------------------

describe('createMcpServer tool registration', () => {
  let sm: TestableSessionManager;
  let previousExecutorsModule: string | undefined;
  let previousWriteGateModule: string | undefined;
  const workflowBridgeFixture = fileURLToPath(
    new URL('../test-fixtures/workflow-bridge.mjs', import.meta.url),
  );

  beforeEach(() => {
    sm = createManager();
    previousExecutorsModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    previousWriteGateModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    process.env.GSD_WORKFLOW_EXECUTORS_MODULE = workflowBridgeFixture;
    process.env.GSD_WORKFLOW_WRITE_GATE_MODULE = workflowBridgeFixture;
  });

  afterEach(async () => {
    if (previousExecutorsModule === undefined) delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    else process.env.GSD_WORKFLOW_EXECUTORS_MODULE = previousExecutorsModule;
    if (previousWriteGateModule === undefined) delete process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    else process.env.GSD_WORKFLOW_WRITE_GATE_MODULE = previousWriteGateModule;
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });

  it('creates server successfully with all required methods', async () => {
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    assert.ok(server);
    assert.ok(server.server);
    assert.equal(typeof server.server.elicitInput, 'function');
    assert.ok(typeof server.connect === 'function');
    assert.ok(typeof server.close === 'function');
  });

  it('gsd_progress returns validation failures in the MCP error envelope', async () => {
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const progressTool = (server as any)._registeredTools?.gsd_progress;
    assert.ok(progressTool, 'gsd_progress should be registered');

    const result = await progressTool.handler({ projectDir: 'relative/path' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /projectDir must be an absolute path/);
  });

  it('gsd_progress advertises readMetadata provenance', async () => {
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const progressTool = (server as any)._registeredTools?.gsd_progress;
    assert.ok(progressTool, 'gsd_progress should be registered');

    assert.match(progressTool.description, /readMetadata provenance/);
  });

  it('registered gsd_progress prefers the DB payload when the bridge is configured', async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-progress-handler-'));
    const bridge = await importWorkflowBridgeFixture();
    t.after(() => {
      bridge.closeDatabase();
      rmSync(projectDir, { recursive: true, force: true });
    });
    mkdirSync(join(projectDir, '.gsd'));
    writeFileSync(
      join(projectDir, '.gsd', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Active Milestone:** M999: Stale Projection',
        '**Phase:** planning',
      ].join('\n'),
    );
    assert.equal(bridge.openDatabase(join(projectDir, '.gsd', 'gsd.db')), true);
    assert.equal(
      bridge.insertMilestone({ id: 'M001', title: 'Database Authority', status: 'active' }),
      true,
    );
    bridge.insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Database Slice',
      status: 'pending',
      risk: 'low',
      depends: [],
      sequence: 1,
    });
    bridge.closeDatabase();

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const progressTool = (server as any)._registeredTools?.gsd_progress;
    assert.ok(progressTool, 'gsd_progress should be registered');

    const result = await progressTool.handler({ projectDir });
    const progress = JSON.parse(result.content[0].text);
    assert.deepEqual(progress.activeMilestone, { id: 'M001', title: 'Database Authority' });
    assert.equal(progress.milestones.total, 1);
    assert.deepEqual(progress.readMetadata, { source: 'database', authority: 'db-authoritative' });
  });

  it('registered gsd_progress uses projections without a workflow bridge', async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-progress-handler-'));
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));
    mkdirSync(join(projectDir, '.gsd'));
    writeFileSync(
      join(projectDir, '.gsd', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Active Milestone:** M999: Projection Only',
        '**Phase:** planning',
      ].join('\n'),
    );

    const previousExecutors = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const previousWriteGate = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    const previousBridgeDisable = process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE;
    delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    delete process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE = '1';
    t.after(() => {
      restoreEnvironmentValue('GSD_WORKFLOW_EXECUTORS_MODULE', previousExecutors);
      restoreEnvironmentValue('GSD_WORKFLOW_WRITE_GATE_MODULE', previousWriteGate);
      restoreEnvironmentValue('GSD_WORKFLOW_BRIDGE_TEST_DISABLE', previousBridgeDisable);
    });

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const progressTool = (server as any)._registeredTools?.gsd_progress;
    assert.ok(progressTool, 'gsd_progress should be registered');
    const result = await progressTool.handler({ projectDir });
    const progress = JSON.parse(result.content[0].text);
    assert.deepEqual(progress.activeMilestone, { id: 'M999', title: 'Projection Only' });
    assert.equal(progress.phase, 'plan');
    assert.deepEqual(progress.readMetadata, { source: 'projection', authority: 'projection-fallback' });
  });

  it('ask_user_questions passes the declared elicitation timeout and signal to the MCP SDK request', async () => {
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const askTool = (server as any)._registeredTools?.ask_user_questions;
    assert.ok(askTool, 'ask_user_questions should be registered');

    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    const signal = new AbortController().signal;
    let receivedParams: unknown;
    let receivedOptions: unknown;

    server.server.elicitInput = async (params, options) => {
      receivedParams = params;
      receivedOptions = options;
      return {
        action: 'accept',
        content: {
          depth_verification_M001: 'Yes, you got it (Recommended)',
        },
      };
    };

    const result = await askTool.handler({ questions }, { signal });

    assert.equal('isError' in result && result.isError, false);
    assert.deepEqual(receivedParams, buildAskUserQuestionsElicitRequest(questions));
    assert.deepEqual(receivedOptions, { timeout: 600000, signal });
  });

  it('hides workflow aliases by default for the model-facing surface', async () => {
    const previousAdvertise = process.env.GSD_MCP_ADVERTISE_ALIASES;
    const previousHide = process.env.GSD_MCP_HIDE_ALIASES;
    delete process.env.GSD_MCP_ADVERTISE_ALIASES;
    delete process.env.GSD_MCP_HIDE_ALIASES;
    try {
      const { server } = await createMcpServer(sm, { includeWorkflowTools: true });
      const registeredTools = (server as any)._registeredTools ?? {};
      for (const canonical of ['gsd_summary_save', 'gsd_plan_milestone', 'gsd_plan_slice']) {
        assert.ok(registeredTools[canonical], `${canonical} should be advertised by default`);
      }
      const registeredNames = new Set(Object.keys(registeredTools));
      const hiddenAliases = WORKFLOW_TOOL_ALIAS_NAMES.filter((name) => !registeredNames.has(name));
      assert.equal(
        hiddenAliases.length,
        WORKFLOW_TOOL_ALIAS_NAMES.length,
        'all alias tools should be hidden by default',
      );
    } finally {
      if (previousAdvertise === undefined) delete process.env.GSD_MCP_ADVERTISE_ALIASES;
      else process.env.GSD_MCP_ADVERTISE_ALIASES = previousAdvertise;
      if (previousHide === undefined) delete process.env.GSD_MCP_HIDE_ALIASES;
      else process.env.GSD_MCP_HIDE_ALIASES = previousHide;
    }
  });

  it('can restore workflow aliases when explicitly requested', async () => {
    const previous = process.env.GSD_MCP_ADVERTISE_ALIASES;
    process.env.GSD_MCP_ADVERTISE_ALIASES = '1';
    try {
      const { server } = await createMcpServer(sm, { includeWorkflowTools: true });
      const registeredTools = (server as any)._registeredTools ?? {};
      for (const alias of ['gsd_save_summary', 'gsd_milestone_plan', 'gsd_slice_plan']) {
        assert.ok(registeredTools[alias], `${alias} should be advertised when restored`);
      }
    } finally {
      if (previous === undefined) delete process.env.GSD_MCP_ADVERTISE_ALIASES;
      else process.env.GSD_MCP_ADVERTISE_ALIASES = previous;
    }
  });

  it('GSD_MCP_HIDE_ALIASES=1 force-hides aliases even if advertise is set', async () => {
    const previousAdvertise = process.env.GSD_MCP_ADVERTISE_ALIASES;
    const previousHide = process.env.GSD_MCP_HIDE_ALIASES;
    process.env.GSD_MCP_ADVERTISE_ALIASES = '1';
    process.env.GSD_MCP_HIDE_ALIASES = '1';
    try {
      const { server } = await createMcpServer(sm, { includeWorkflowTools: true });
      const registeredTools = (server as any)._registeredTools ?? {};
      assert.ok(registeredTools.gsd_summary_save, 'canonical tool should remain advertised');
      assert.equal(registeredTools.gsd_save_summary, undefined);
    } finally {
      if (previousAdvertise === undefined) delete process.env.GSD_MCP_ADVERTISE_ALIASES;
      else process.env.GSD_MCP_ADVERTISE_ALIASES = previousAdvertise;
      if (previousHide === undefined) delete process.env.GSD_MCP_HIDE_ALIASES;
      else process.env.GSD_MCP_HIDE_ALIASES = previousHide;
    }
  });

  it('gsd_execute flow returns sessionId on success', async () => {
    const sessionId = await sm.startSession('/tmp/tool-exec', { cliPath: '/usr/bin/gsd' });
    assert.equal(typeof sessionId, 'string');
    assert.ok(sessionId.length > 0);
  });

  it('gsd_status flow returns correct shape', async () => {
    const sessionId = await sm.startSession('/tmp/tool-status', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;

    assert.equal(typeof session.status, 'string');
    assert.ok(Array.isArray(session.events));
    assert.ok(session.cost);
    assert.equal(typeof session.startTime, 'number');
  });

  it('gsd_status accepts omitted sessionId when exactly one session is tracked', async () => {
    const sessionId = await sm.startSession('/tmp/tool-status-infer', { cliPath: '/usr/bin/gsd' });
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const statusTool = (server as any)._registeredTools?.gsd_status;

    assert.ok(statusTool, 'gsd_status should be registered');
    assert.equal(statusTool.inputSchema.safeParse({ sessionId: undefined }).success, true);

    const result = await statusTool.handler({});
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.projectDir, resolve('/tmp/tool-status-infer'));
    assert.equal(payload.status, 'running');
  });

  it('creates gsd --mode mcp workflow adapter tools from the workflow MCP surface', async () => {
    const tools = await createWorkflowMcpAdapterToolDefs(sm);
    const toolNames = new Set(tools.map((tool) => tool.name));

    for (const expected of GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES) {
      assert.ok(toolNames.has(expected), `adapter surface missing ${expected}`);
    }

    const statusTool = tools.find((tool) => tool.name === 'gsd_status');
    assert.ok(statusTool, 'gsd_status should be adapted');
    assert.equal(statusTool.parameters.type, 'object');

    const result = await statusTool.execute('mcp-mode-status-test', { projectDir: '/tmp/no-tracked-session' });
    assert.equal(result.isError, true);
    assert.match(
      result.content.map((block) => block.text ?? '').join('\n'),
      /No tracked GSD sessions/,
    );
  });

  it('gsd_resolve_blocker flow returns error when no blocker', async () => {
    const sessionId = await sm.startSession('/tmp/tool-resolve', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, 'fix'),
      (err: Error) => {
        assert.ok(err.message.includes('No pending blocker'));
        return true;
      },
    );
  });

  it('gsd_result flow returns HeadlessJsonResult shape', async () => {
    const sessionId = await sm.startSession('/tmp/tool-result', { cliPath: '/usr/bin/gsd' });
    const result = sm.getResult(sessionId);

    assert.ok('sessionId' in result);
    assert.ok('projectDir' in result);
    assert.ok('status' in result);
    assert.ok('durationMs' in result);
    assert.ok('cost' in result);
    assert.ok('recentEvents' in result);
    assert.ok('pendingBlocker' in result);
    assert.ok('error' in result);
  });

  it('gsd_cancel flow marks session as cancelled', async () => {
    const sessionId = await sm.startSession('/tmp/tool-cancel', { cliPath: '/usr/bin/gsd' });
    await sm.cancelSession(sessionId);
    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'cancelled');
  });

  it('gsd_cancel can cancel an interactive session (no sessionId) via projectDir fallback', async () => {
    // Simulate an interactive session: registered by projectDir but with an empty sessionId
    // (e.g. started via `/gsd auto` in terminal or from a restarted MCP server that lost its session registry)
    const projectDir = resolve('/tmp/interactive-session');
    const mockClient = new MockRpcClient({ cwd: projectDir, args: [] });
    const interactiveSession: ManagedSession = {
      sessionId: '', // no sessionId — interactive/restarted scenario
      projectDir,
      status: 'running',
      client: mockClient as any,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };
    sm._putSession(projectDir, interactiveSession);

    // cancelSession('') should fail — no session found by empty sessionId
    // cancelSessionByDir should succeed — finds session by projectDir
    await sm.cancelSessionByDir(projectDir);

    const session = sm.getSessionByDir(projectDir)!;
    assert.equal(session.status, 'cancelled');
    assert.ok(mockClient.aborted, 'client.abort() should have been called');
  });

  it('gsd_cancel via projectDir works even when sessionId lookup returns undefined', async () => {
    // Start a normal session to get its projectDir
    const sessionId = await sm.startSession('/tmp/cancel-by-dir', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;
    const { projectDir } = session;

    // cancelSessionByDir should find it by dir and cancel it
    await sm.cancelSessionByDir(projectDir);
    assert.equal(session.status, 'cancelled');
  });

  it('cancelSessionByDir supports Hermes gsd_cancel_by_project flow', async () => {
    const projectDir = resolve('/tmp/hermes-cancel-by-project');
    const mockClient = new MockRpcClient({ cwd: projectDir, args: [] });
    const managed: ManagedSession = {
      sessionId: 'hermes-sess',
      projectDir,
      status: 'running',
      client: mockClient as any,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };
    sm._putSession(projectDir, managed);
    await sm.cancelSessionByDir(projectDir);
    assert.equal(managed.status, 'cancelled');
    assert.ok(mockClient.aborted);
  });

  it('buildAskUserQuestionsElicitRequest adds None of the above note field for single-select questions', () => {
    const request = buildAskUserQuestionsElicitRequest([
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
      {
        id: 'focus_areas',
        header: 'Focus',
        question: 'Which areas matter most?',
        allowMultiple: true,
        options: [
          { label: 'Frontend', description: 'Prioritize the UI.' },
          { label: 'Backend', description: 'Prioritize server logic.' },
        ],
      },
    ]);

    assert.equal(request.mode, 'form');
    assert.deepEqual(request.requestedSchema.required, ['depth_verification_M001', 'focus_areas']);
    assert.ok(request.requestedSchema.properties['depth_verification_M001']);
    assert.ok(request.requestedSchema.properties['depth_verification_M001__note']);
    assert.ok(!request.requestedSchema.properties['focus_areas__note']);
  });

  it('formatAskUserQuestionsElicitResult preserves the existing answers JSON shape', () => {
    const result = formatAskUserQuestionsElicitResult(
      [
        {
          id: 'depth_verification_M001',
          header: 'Depth Check',
          question: 'Did I capture the depth right?',
          options: [
            { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
            { label: 'Not quite', description: 'I need to clarify the depth further.' },
          ],
        },
        {
          id: 'focus_areas',
          header: 'Focus',
          question: 'Which areas matter most?',
          allowMultiple: true,
          options: [
            { label: 'Frontend', description: 'Prioritize the UI.' },
            { label: 'Backend', description: 'Prioritize server logic.' },
          ],
        },
      ],
      {
        action: 'accept',
        content: {
          depth_verification_M001: 'None of the above',
          depth_verification_M001__note: 'Need more implementation detail.',
          focus_areas: ['Frontend', 'Backend'],
        },
      },
    );

    assert.equal(
      result,
      JSON.stringify({
        answers: {
          depth_verification_M001: {
            answers: ['None of the above', 'user_note: Need more implementation detail.'],
          },
          focus_areas: {
            answers: ['Frontend', 'Backend'],
          },
        },
      }),
    );
  });

  it('ask_user_questions returns local elicitation answers before trying remote', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    let remoteCalls = 0;

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        return {
          action: 'accept',
          content: {
            depth_verification_M001: 'Yes, you got it (Recommended)',
          },
        };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        remoteCalls++;
        return { content: [{ type: 'text', text: 'remote response' }] };
      },
    });

    assert.equal(remoteCalls, 0);
    assert.equal(
      result.content[0]?.text,
      JSON.stringify({
        answers: {
          depth_verification_M001: {
            answers: ['Yes, you got it (Recommended)'],
          },
        },
      }),
    );
  });

  it('ask_user_questions persists confirmed depth gates for local answers', async () => {
    const questions = [
      {
        id: 'depth_verification_M003_confirm',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    const calls: string[] = [];
    const writeGate = {
      isGateQuestionId(questionId: string) {
        return questionId.startsWith('depth_verification_');
      },
      isDepthConfirmationAnswer(selected: unknown, options?: Array<{ label?: string }>) {
        return selected === options?.[0]?.label;
      },
      setPendingGate(gateId: string, basePath: string) {
        calls.push(`pending:${gateId}:${basePath}`);
      },
      markApprovalGateVerified(gateId?: string | null, basePath?: string) {
        calls.push(`approval:${gateId}:${basePath}`);
      },
      markDepthVerified(milestoneId?: string | null, basePath?: string) {
        calls.push(`depth:${milestoneId}:${basePath}`);
      },
      clearPendingGate(basePath: string) {
        calls.push(`clear:${basePath}`);
      },
      extractDepthVerificationMilestoneId(questionId: string) {
        return questionId.match(/_(M\d+)_/)?.[1] ?? null;
      },
    };

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        return {
          action: 'accept',
          content: {
            depth_verification_M003_confirm: 'Yes, you got it (Recommended)',
          },
        };
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error('should not be called');
      },
      writeGate,
      writeGateBasePath: '/tmp/gsd-project',
    });

    assert.equal('isError' in result && result.isError, false);
    assert.deepEqual(calls, [
      'pending:depth_verification_M003_confirm:/tmp/gsd-project',
      'approval:depth_verification_M003_confirm:/tmp/gsd-project',
      'depth:M003:/tmp/gsd-project',
      'clear:/tmp/gsd-project',
    ]);
  });

  it('ask_user_questions persists confirmed depth gates for remote answers', async () => {
    const questions = [
      {
        id: 'depth_verification_M003_confirm',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    const calls: string[] = [];
    const writeGate = {
      isGateQuestionId(questionId: string) {
        return questionId.startsWith('depth_verification_');
      },
      isDepthConfirmationAnswer(selected: unknown, options?: Array<{ label?: string }>) {
        return selected === options?.[0]?.label;
      },
      setPendingGate(gateId: string, basePath: string) {
        calls.push(`pending:${gateId}:${basePath}`);
      },
      markApprovalGateVerified(gateId?: string | null, basePath?: string) {
        calls.push(`approval:${gateId}:${basePath}`);
      },
      markDepthVerified(milestoneId?: string | null, basePath?: string) {
        calls.push(`depth:${milestoneId}:${basePath}`);
      },
      clearPendingGate(basePath: string) {
        calls.push(`clear:${basePath}`);
      },
      extractDepthVerificationMilestoneId(questionId: string) {
        return questionId.match(/_(M\d+)_/)?.[1] ?? null;
      },
    };

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        return { action: 'cancel' };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: 'text', text: 'remote response' }],
          details: {
            response: {
              endInterview: false,
              answers: {
                depth_verification_M003_confirm: {
                  selected: 'Yes, you got it (Recommended)',
                  notes: '',
                },
              },
            },
          },
        };
      },
      writeGate,
      writeGateBasePath: '/tmp/gsd-project',
    });

    assert.equal('isError' in result && result.isError, false);
    assert.deepEqual(calls, [
      'pending:depth_verification_M003_confirm:/tmp/gsd-project',
      'approval:depth_verification_M003_confirm:/tmp/gsd-project',
      'depth:M003:/tmp/gsd-project',
      'clear:/tmp/gsd-project',
    ]);
  });

  it('ask_user_questions falls back to remote when local elicitation is cancelled', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    let remoteCalls = 0;
    const signal = new AbortController().signal;

    const result = await askUserQuestionsHandler(questions, { signal }, {
      async elicitInput() {
        return { action: 'cancel' };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions(remoteQuestions, receivedSignal) {
        remoteCalls++;
        assert.equal(remoteQuestions, questions);
        assert.equal(receivedSignal, signal);
        return { content: [{ type: 'text', text: 'remote response' }] };
      },
    });

    assert.equal(remoteCalls, 1);
    assert.equal(result.content[0]?.text, 'remote response');
  });

  it('ask_user_questions falls back to remote when local elicitation is unavailable', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    let remoteCalls = 0;

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new Error('MCP host does not support elicitation');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions(remoteQuestions) {
        remoteCalls++;
        assert.equal(remoteQuestions, questions);
        return { content: [{ type: 'text', text: 'remote response' }] };
      },
    });

    assert.equal(remoteCalls, 1);
    assert.equal(result.content[0]?.text, 'remote response');
  });

  it('ask_user_questions surfaces remote success answers as structuredContent (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new Error('MCP host does not support elicitation');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: 'text', text: '{"answers":{"depth_verification_M001":{"answers":["Yes, you got it (Recommended)"]}}}' }],
          details: {
            remote: true,
            channel: 'discord',
            timed_out: false,
            promptId: 'p1',
            threadUrl: null,
            questions,
            response: {
              endInterview: false,
              answers: {
                depth_verification_M001: { selected: 'Yes, you got it (Recommended)', notes: '' },
              },
            },
            status: 'answered',
          },
        };
      },
    });

    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      {
        questions,
        response: {
          // endInterview mirrors the local RoundResult shape so register-hooks
          // sees identical payloads on both code paths.
          endInterview: false,
          answers: {
            depth_verification_M001: { selected: 'Yes, you got it (Recommended)', notes: '' },
          },
        },
        cancelled: false,
      },
    );
  });

  it('ask_user_questions surfaces remote timeout as cancelled structuredContent (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new Error('MCP host does not support elicitation');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: 'text', text: '{"timed_out":true,"channel":"discord","message":"User did not respond within 5 minutes."}' }],
          details: { remote: true, channel: 'discord', timed_out: true, status: 'timed_out' },
        };
      },
    });

    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true },
    );
  });

  it('ask_user_questions reports a malformed remote response as cancelled, not silent success (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new Error('MCP host does not support elicitation');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        // Simulates a remote module returning a non-conforming `details.response`
        // (e.g. a stale build, a wire mismatch). The handler must not surface
        // this as `cancelled: false, response: null` — that would lie to any
        // consumer reading `structuredContent.cancelled`.
        return {
          content: [{ type: 'text', text: '{}' }],
          details: { remote: true, channel: 'discord', timed_out: false, response: 'not-an-object' },
        };
      },
    });

    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true },
    );
  });

  it('ask_user_questions returns cancelled structuredContent when remote is unconfigured and local declines (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        return { action: 'decline' };
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error('should not be called when remote is unconfigured');
      },
    });

    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true },
    );
    assert.equal(result.content[0]?.text, 'ask_user_questions was cancelled before receiving a response');
  });

  it('ask_user_questions returns cancelled structuredContent when configured remote returns null (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        return { action: 'cancel' };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return null;
      },
    });

    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true },
    );
  });

  it('ask_user_questions re-throws non-fallback local errors (regression #5267)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new TypeError('schema validation blew up');
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error('should not be called');
      },
    });

    // Non-fallback errors propagate to the outer try/catch and surface as an
    // MCP `isError` result — no `structuredContent` is attached because the
    // error path predates the structured success/cancel branches.
    assert.equal('isError' in result && result.isError, true);
    assert.match(result.content[0]?.text ?? '', /schema validation blew up/);
  });

  it('ask_user_questions returns a timeout result and does NOT fall through to remote on a local host timeout (#852)', async () => {
    // A host-side elicitation timeout means the user is at the host but didn't
    // answer. Falling through to remote would be wrong (no one is there to
    // answer it either) and would lose the timeout signal that the gate hook
    // needs to pause-and-wait. The handler returns a `timed_out` result instead.
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];
    let remoteCalls = 0;

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        // MCP SDK request deadline expiry surfaces as this error.
        throw new Error('MCP error -32001: Request timed out');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        remoteCalls++;
        return { content: [{ type: 'text', text: 'remote response' }] };
      },
    });

    assert.equal(remoteCalls, 0, 'host timeout must NOT fall through to remote');
    assert.equal('isError' in result && result.isError, false, 'timeout is not an error result');
    assert.match(result.content[0]?.text ?? '', /timed out/i);
    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true, timed_out: true },
    );
  });

  it('ask_user_questions recognizes the 10-minute withElicitTimeout error as a host timeout (#852)', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        throw new Error('ask_user_questions timed out after 10 minutes — no user response received');
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error('should not be called');
      },
    });

    assert.equal('isError' in result && result.isError, false);
    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true, timed_out: true },
    );
  });

  it('ask_user_questions reports both local and remote errors when both paths fail', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
    ];

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        // Non-timeout fallback error → falls through to remote, which also fails.
        throw new Error('MCP host does not support elicitation');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        throw new Error('remote transport failed');
      },
    });

    assert.equal('isError' in result && result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Local elicitation failed/);
    assert.match(result.content[0]?.text ?? '', /remote transport failed/);
  });

  it('ask_user_questions returns cancelled structuredContent (not isError) and does NOT fall through to remote when the client aborts', async () => {
    const questions = [
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue.' },
          { label: 'Not quite', description: 'Clarify.' },
        ],
      },
    ];
    let remoteCalls = 0;

    const result = await askUserQuestionsHandler(questions, undefined, {
      async elicitInput() {
        // withElicitTimeout rejects with this message when the tool-call
        // AbortSignal fires (client tore down the request).
        throw new Error('ask_user_questions cancelled by client');
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        remoteCalls++;
        throw new Error('remote must not be called on client abort');
      },
    });

    assert.equal(remoteCalls, 0, 'client abort must NOT fall through to remote');
    assert.equal('isError' in result && result.isError, false, 'client abort is not an error result');
    assert.deepEqual(
      (result as { structuredContent?: unknown }).structuredContent,
      { questions, response: null, cancelled: true },
    );
    assert.match(result.content[0]?.text ?? '', /cancelled by the client/i);
  });
});

// ---------------------------------------------------------------------------
// isLocalElicitTimeoutError (#852)
// ---------------------------------------------------------------------------

describe('isLocalElicitTimeoutError', () => {
  it('recognizes the MCP SDK -32001 timeout', () => {
    assert.equal(
      isLocalElicitTimeoutError(new Error('MCP error -32001: Request timed out')),
      true,
    );
    assert.equal(
      isLocalElicitTimeoutError(new Error('Request timed out')),
      true,
    );
  });

  it('recognizes the 10-minute withElicitTimeout error', () => {
    assert.equal(
      isLocalElicitTimeoutError(new Error('ask_user_questions timed out after 10 minutes — no user response received')),
      true,
    );
  });

  it('does not misclassify non-timeout elicitation errors', () => {
    assert.equal(isLocalElicitTimeoutError(new Error('MCP host does not support elicitation')), false);
    assert.equal(isLocalElicitTimeoutError(new Error('-32601 method not found')), false);
    assert.equal(isLocalElicitTimeoutError(new Error('schema validation blew up')), false);
  });

  it('does not misclassify non-Error values', () => {
    assert.equal(isLocalElicitTimeoutError('timed out'), false);
    assert.equal(isLocalElicitTimeoutError(undefined), false);
    assert.equal(isLocalElicitTimeoutError(null), false);
  });
});

// ---------------------------------------------------------------------------
// isLocalElicitClientAbortError
// ---------------------------------------------------------------------------

describe('isLocalElicitClientAbortError', () => {
  it('recognizes the withElicitTimeout client-abort rejection', () => {
    assert.equal(
      isLocalElicitClientAbortError(new Error('ask_user_questions cancelled by client')),
      true,
    );
  });

  it('does not misclassify timeouts or other elicitation errors', () => {
    assert.equal(isLocalElicitClientAbortError(new Error('ask_user_questions timed out after 10 minutes')), false);
    assert.equal(isLocalElicitClientAbortError(new Error('MCP host does not support elicitation')), false);
    assert.equal(isLocalElicitClientAbortError(new Error('MCP error -32001: Request timed out')), false);
  });

  it('does not misclassify non-Error values', () => {
    assert.equal(isLocalElicitClientAbortError('cancelled by client'), false);
    assert.equal(isLocalElicitClientAbortError(undefined), false);
    assert.equal(isLocalElicitClientAbortError(null), false);
  });
});

// ---------------------------------------------------------------------------
// withElicitTimeout
// ---------------------------------------------------------------------------

describe('withElicitTimeout', () => {
  it('resolves with the promise value when it settles before the timeout', async () => {
    const result = await withElicitTimeout(Promise.resolve(42), 'test', 5000);
    assert.equal(result, 42);
  });

  it('rejects with a timeout error when the promise does not settle in time', async () => {
    const never = new Promise<never>(() => {});
    await assert.rejects(
      () => withElicitTimeout(never, 'ask_user_questions', 1),
      (err: Error) => {
        assert.ok(err.message.includes('ask_user_questions'));
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
  });

  it('clears the timer when the promise resolves (no dangling timer)', async () => {
    // Spy on clearTimeout directly. `unhandledRejection` is not a reliable
    // proxy: Node does not flag losing-promise rejections from a settled
    // Promise.race as unhandled, so the absence of a stray rejection does
    // not actually prove clearTimeout ran. Asserting the spy was invoked
    // tests the cleanup contract directly.
    const originalClearTimeout = globalThis.clearTimeout;
    let clearCalls = 0;
    let lastClearedId: unknown = undefined;
    globalThis.clearTimeout = ((id: Parameters<typeof originalClearTimeout>[0]) => {
      clearCalls++;
      lastClearedId = id;
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const value = await withElicitTimeout(Promise.resolve('done'), 'test', 50_000);
      assert.equal(value, 'done');
      assert.ok(
        clearCalls >= 1,
        `clearTimeout should run on resolve path; calls=${clearCalls}`,
      );
      assert.ok(lastClearedId !== undefined, 'clearTimeout should be called with the timer id');
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
