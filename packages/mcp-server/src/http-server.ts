/**
 * Opt-in, loopback-only Streamable HTTP host.
 *
 * The SessionManager and workflow module state belong to the process; each MCP
 * protocol session gets its own McpServer/transport so reverse requests, request
 * ids and cancellation never cross client boundaries.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMcpServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';
import { hasWorkflowToolBridgeConfiguration, warmWorkflowToolBridges } from './workflow-tools.js';

const MCP_PKG = '@modelcontextprotocol/sdk';
const MAX_BODY_BYTES = 1024 * 1024;

interface HttpTransport {
  sessionId?: string;
  onclose?: () => void;
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  close(): Promise<void>;
}
type Session = {
  transport: HttpTransport;
  server: Awaited<ReturnType<typeof createMcpServer>>['server'];
  lastActivity: number;
  calls: number;
  streams: number;
};

export interface McpHttpHost {
  address: AddressInfo;
  url: string;
  close(): Promise<void>;
}

function respond(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('aborted', () => reject(Object.assign(new Error('Request aborted'), { status: 400 })));
    req.once('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON request'), { status: 400 })); }
    });
  });
}

export function readHttpPort(env: NodeJS.ProcessEnv): number {
  const value = env.GSD_MCP_HTTP_PORT?.trim() || '8788';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('GSD_MCP_HTTP_PORT must be an integer between 1 and 65535');
  }
  return Number(value);
}

export async function startMcpHttpServer(
  sessionManager: SessionManager,
  options: {
    port?: number; includeWorkflowTools?: boolean;
    sessionIdleMs?: number; reapIntervalMs?: number;
    onToolEnd?: () => void;
  } = {},
): Promise<McpHttpHost> {
  const port = options.port ?? 8788;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
  const includeWorkflowTools = options.includeWorkflowTools ?? hasWorkflowToolBridgeConfiguration();
  const sessionIdleMs = options.sessionIdleMs ?? 600_000;
  const reapIntervalMs = options.reapIntervalMs ?? Math.min(sessionIdleMs, 60_000);
  if (![sessionIdleMs, reapIntervalMs].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('HTTP session idle and reap intervals must be positive integers');
  }
  // Fail before opening a listener rather than publishing a partially ready catalog.
  if (includeWorkflowTools) await warmWorkflowToolBridges();
  const { StreamableHTTPServerTransport } = await import(`${MCP_PKG}/server/streamableHttp.js`);
  const { isInitializeRequest } = await import(`${MCP_PKG}/types.js`);
  const sessions = new Map<string, Session>();
  const pending = new Set<Session>();
  let closing: Promise<void> | undefined;
  let stopping = false;

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status) : 500;
      respond(res, Number.isInteger(status) ? status : 500,
        status === 500 ? 'MCP request failed' : error instanceof Error ? error.message : 'Bad request');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (stopping) { respond(res, 503, 'MCP host is stopping'); return; }
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      respond(res, 403, 'Invalid Host header'); return;
    }
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      respond(res, 403, 'Invalid Origin header'); return;
    }
    if (req.url?.split('?')[0] !== '/mcp') { respond(res, 404, 'Not found'); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      res.setHeader('allow', 'GET, POST, DELETE');
      respond(res, 405, 'Method not allowed'); return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (Array.isArray(sessionId)) { respond(res, 400, 'Invalid session header'); return; }
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) { respond(res, 404, 'MCP session not found'); return; }
    if (session) trackResponse(session, res);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        respond(res, 400, 'Initialize an MCP session first'); return;
      }
      const { server } = await createMcpServer(sessionManager, {
        includeWorkflowTools, connectionLifetime: 'server',
        onToolStart: () => { if (session) session.calls++; },
        onToolEnd: () => {
          if (session) { session.calls--; session.lastActivity = Date.now(); }
          options.onToolEnd?.();
        },
      });
      if (stopping) { await server.close(); respond(res, 503, 'MCP host is stopping'); return; }
      const transport: HttpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          if (session && !stopping) sessions.set(id, session);
        },
      });
      session = { server, transport, lastActivity: Date.now(), calls: 0, streams: 0 };
      pending.add(session);
      try { await server.connect(transport); }
      catch (error) {
        pending.delete(session);
        await server.close().catch(() => {});
        throw error;
      }
      const connected = session;
      const onclose = transport.onclose;
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        pending.delete(connected);
        onclose?.();
      };
      try {
        trackResponse(session, res);
        await transport.handleRequest(req, res, body);
        if (!transport.sessionId) await server.close();
      } catch (error) {
        await server.close().catch(() => {});
        throw error;
      }
    } else {
      await session.transport.handleRequest(req, res, body);
    }
  }
  function trackResponse(session: Session, res: ServerResponse): void {
    session.lastActivity = Date.now();
    session.streams++;
    res.once('close', () => {
      session.streams--;
      session.lastActivity = Date.now();
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => {
      http.removeListener('error', reject);
      resolve();
    });
  });
  const address = http.address() as AddressInfo;
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.calls || session.streams || now - session.lastActivity < sessionIdleMs) continue;
      // Remove synchronously before closing: a new request cannot race retirement.
      sessions.delete(id);
      void session.server.close().catch(() => {});
    }
  }, reapIntervalMs);
  reaper.unref();
  return {
    address,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close() {
      if (!closing) {
        stopping = true;
        clearInterval(reaper);
        closing = (async () => {
          const closed = new Promise<void>((resolve, reject) => {
            http.close(error => error ? reject(error) : resolve());
          });
          await Promise.allSettled([...pending].map(session => session.server.close()));
          http.closeAllConnections();
          await closed;
          sessions.clear();
          pending.clear();
        })();
      }
      return closing;
    },
  };
}

/** Service lifetime is independent of stdin and of any individual HTTP client. */
export async function runMcpHttpServerCli(): Promise<void> {
  loadStoredCredentialEnvKeys();
  const manager = new SessionManager();
  const host = await startMcpHttpServer(manager, { port: readHttpPort(process.env) });
  let cleanup: Promise<void> | undefined;
  const stop = () => {
    cleanup ??= (async () => {
      await host.close();
      await manager.cleanup();
    })().catch(error => {
      process.stderr.write(`[gsd-mcp-server] HTTP shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stderr.write(`[gsd-mcp-server] MCP server started on ${host.url}\n`);
}
