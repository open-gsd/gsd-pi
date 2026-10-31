import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcpHttpServer } from './http-server.js';
import { SessionManager } from './session-manager.js';

const MCP_PKG = '@modelcontextprotocol/sdk';
const question = { questions: [{
  id: 'choice', header: 'Transport', question: 'Which transport?',
  options: [{ label: 'HTTP', description: 'Shared process' }, { label: 'Stdio', description: 'Child process' }],
}] };

async function connect(url: string, answer: string, postOnly = false) {
  const { Client } = await import(`${MCP_PKG}/client/index.js`);
  const { StreamableHTTPClientTransport } = await import(`${MCP_PKG}/client/streamableHttp.js`);
  const { ElicitRequestSchema } = await import(`${MCP_PKG}/types.js`);
  const client = new Client({ name: 'http-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  const transport = new StreamableHTTPClientTransport(new URL(url), postOnly ? {
    fetch: (url: string | URL, init: RequestInit) => init?.method === 'GET'
      ? Promise.resolve(new Response('', { status: 405 })) : fetch(url, init),
  } : {});
  let calls = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request: { params: { requestedSchema: { properties: Record<string, unknown> } } }) => {
    calls++;
    const keys = Object.keys(request.params.requestedSchema.properties);
    return { action: 'accept', content: Object.fromEntries(keys.map(key => [key, answer])) };
  });
  await client.connect(transport);
  return { client, transport, calls: () => calls };
}

describe('shared loopback streamable HTTP', () => {
  test('one listener serves isolated elicitation sessions and survives either client closing', async () => {
    const manager = new SessionManager();
    let cleanups = 0;
    manager.cleanup = async () => { cleanups++; };
    const host = await startMcpHttpServer(manager, { port: 0, includeWorkflowTools: false });
    assert.equal(host.address.address, '127.0.0.1');
    const a = await connect(host.url, 'HTTP');
    const b = await connect(host.url, 'Stdio');
    try {
      assert.notEqual(a.transport.sessionId, b.transport.sessionId);
      const catalogs = await Promise.all([a.client.listTools(), b.client.listTools()]);
      assert.deepEqual(catalogs[0], catalogs[1]);
      const [ra, rb] = await Promise.all([
        a.client.callTool({ name: 'ask_user_questions', arguments: question }),
        b.client.callTool({ name: 'ask_user_questions', arguments: question }),
      ]);
      assert.equal(a.calls(), 1);
      assert.equal(b.calls(), 1);
      assert.match(JSON.stringify(ra), /HTTP/);
      assert.match(JSON.stringify(rb), /Stdio/);
      await a.transport.terminateSession();
      await a.client.close();
      assert.equal(cleanups, 0, 'disconnect must not clean shared managed runs');
      assert.ok((await b.client.listTools()).tools.length > 0);
    } finally {
      await Promise.allSettled([a.client.close(), b.transport.terminateSession(), b.client.close()]);
      await host.close();
    }
    assert.equal(cleanups, 0, 'the CLI owns manager cleanup, not HTTP sessions');
  });

  test('both interactive tools route the reverse request on the originating POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gsd-http-env-'));
    const host = await startMcpHttpServer(new SessionManager(), { port: 0, includeWorkflowTools: false });
    const { Client } = await import(`${MCP_PKG}/client/index.js`);
    const { StreamableHTTPClientTransport } = await import(`${MCP_PKG}/client/streamableHttp.js`);
    const { ElicitRequestSchema } = await import(`${MCP_PKG}/types.js`);
    // Disallow GET: reverse requests must be related to the tool's POST stream.
    const transport = new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: (url: string | URL, init: RequestInit) => init?.method === 'GET'
        ? Promise.resolve(new Response('', { status: 405 }))
        : fetch(url, init),
    });
    const client = new Client({ name: 'post-only', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let calls = 0;
    client.setRequestHandler(ElicitRequestSchema, async (request: { params: { requestedSchema: { properties: Record<string, unknown> } } }) => {
      calls++;
      return { action: 'accept', content: Object.fromEntries(Object.keys(request.params.requestedSchema.properties).map(key => [key, key === 'choice' ? 'HTTP' : 'synthetic-not-a-secret'])) };
    });
    try {
      await client.connect(transport);
      const ask = await client.callTool({ name: 'ask_user_questions', arguments: question });
      assert.notEqual(ask.isError, true);
      const env = await client.callTool({ name: 'secure_env_collect', arguments: {
        projectDir: root, keys: [{ key: 'GSD_HTTP_TEST_VALUE' }], destination: 'dotenv',
      } });
      assert.notEqual(env.isError, true);
      assert.equal(calls, 2);
      assert.match(readFileSync(join(root, '.env'), 'utf8'), /synthetic-not-a-secret/);
      assert.doesNotMatch(JSON.stringify(env), /synthetic-not-a-secret/);
      assert.equal(process.env.GSD_HTTP_TEST_VALUE, undefined, 'HTTP must not hydrate shared process.env');
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancelled held elicitation settles, and closing that session leaves a second usable', async () => {
    const host = await startMcpHttpServer(new SessionManager(), { port: 0, includeWorkflowTools: false });
    const a = await connect(host.url, 'HTTP');
    const b = await connect(host.url, 'HTTP');
    const { ElicitRequestSchema } = await import(`${MCP_PKG}/types.js`);
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    a.client.setRequestHandler(ElicitRequestSchema, async (_request: unknown, extra: { signal: AbortSignal }) => {
      ready();
      await new Promise<void>(resolve => {
        if (extra.signal.aborted) resolve();
        else extra.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { action: 'cancel' };
    });
    const controller = new AbortController();
    try {
      const pending = a.client.callTool({ name: 'ask_user_questions', arguments: question }, undefined, { signal: controller.signal });
      const settled = pending.then(() => true, () => true);
      await held;
      controller.abort();
      assert.equal(await settled, true);
      await a.transport.terminateSession();
      assert.ok((await b.client.listTools()).tools.length > 0);
    } finally {
      await Promise.allSettled([a.client.close(), b.transport.terminateSession(), b.client.close()]);
      await host.close();
    }
  });

  test('rejects invalid sessions, non-loopback host headers, oversized bodies and unknown paths', async () => {
    const host = await startMcpHttpServer(new SessionManager(), { port: 0, includeWorkflowTools: false });
    try {
      assert.equal((await fetch(host.url, { method: 'GET', headers: { 'mcp-session-id': 'missing' } })).status, 404);
      assert.equal((await fetch(host.url + '/bad')).status, 404);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(host.url, { method: 'POST', headers: { host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject); req.end('{}');
      });
      assert.equal(status, 403);
      assert.equal((await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
      assert.equal((await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(1024 * 1024 + 1) })).status, 413);
    } finally { await host.close(); }
  });
  test('reaps abandoned idle sessions but preserves open streams and held calls', async () => {
    const host = await startMcpHttpServer(new SessionManager(), {
      port: 0, includeWorkflowTools: false, sessionIdleMs: 50, reapIntervalMs: 10,
    });
    const idle = await connect(host.url, 'HTTP', true);
    const streaming = await connect(host.url, 'HTTP');
    const held = await connect(host.url, 'HTTP', true);
    const { ElicitRequestSchema } = await import(`${MCP_PKG}/types.js`);
    let announce!: () => void;
    const started = new Promise<void>(resolve => { announce = resolve; });
    let answer!: () => void;
    const wait = new Promise<void>(resolve => { answer = resolve; });
    held.client.setRequestHandler(ElicitRequestSchema, async () => {
      announce(); await wait; return { action: 'cancel' };
    });
    try {
      const pending = held.client.callTool({ name: 'ask_user_questions', arguments: question });
      await started;
      const id = idle.transport.sessionId;
      // close() drops sockets without issuing MCP DELETE, as a crash would.
      await idle.client.close();
      await delay(150);
      assert.equal((await fetch(host.url, { headers: { 'mcp-session-id': id } })).status, 404);
      assert.ok((await streaming.client.listTools()).tools.length > 0);
      answer(); await pending;
      assert.ok((await held.client.listTools()).tools.length > 0);
    } finally {
      answer();
      await Promise.allSettled([idle.client.close(), streaming.client.close(), held.client.close()]);
      await host.close();
    }
  });
  test('does not reap a running handler after its client drops the response stream', async () => {
    const manager = new SessionManager();
    let announce!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    manager.startSession = async () => { announce(); await blocked; return 'synthetic-run'; };
    const host = await startMcpHttpServer(manager, {
      port: 0, includeWorkflowTools: false, sessionIdleMs: 50, reapIntervalMs: 10,
    });
    const a = await connect(host.url, 'HTTP', true);
    const id = a.transport.sessionId;
    const pending = a.client.callTool({ name: 'gsd_execute', arguments: { projectDir: '/synthetic-project' } }).catch(() => undefined);
    try {
      await entered;
      await a.client.close(); // no DELETE, and no open GET or POST stream remains
      await delay(150);
      const response = await fetch(host.url, {
        method: 'POST',
        headers: { 'mcp-session-id': id, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
      });
      assert.equal(response.status, 200, 'running handler must retain its protocol session');
      await response.text();
    } finally {
      finish(); await pending;
      await a.client.close(); await host.close();
    }
  });
});
