import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native GSD transport retains HTTPS proxy/CA, output contract, delayed SSE and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gsd-offline-transport-'));
  const sockets = new Set();
  const requests = [];
  const tunnels = [];
  let provider, proxy;
  try {
    // Ephemeral test-only certificate: no real store, credential or network origin.
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=provider.invalid', '-addext', 'subjectAltName=DNS:provider.invalid',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
    provider = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ payload, authorization: req.headers.authorization, url: req.url });
      const prompt = payload.messages.at(-1).content;
      if (['delayed', 'timeout', 'abort'].includes(prompt)) await delay(100);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = delta => `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
      res.write(event({ role: 'assistant', content: 'o' }));
      if (prompt === 'delayed') await delay(100);
      if (res.destroyed) return;
      res.write(event({ content: 'k' }));
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await listen(provider);
    proxy = createProxy((_req, res) => { res.writeHead(502).end(); });
    proxy.on('connect', (req, socket, head) => {
      tunnels.push(req.url);
      assert.equal(req.url, 'provider.invalid:443');
      assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('openclaw:offline-fixture').toString('base64')}`);
      const upstream = connect(provider.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    for (const server of [provider, proxy]) server.on('connection', socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    });
    await listen(proxy);
    const proxyUrl = `http://openclaw:offline-fixture@127.0.0.1:${proxy.address().port}`;
    const result = await run(process.execPath, [new URL('./fixtures/provider-transport.mjs', import.meta.url).pathname], {
      env: { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
        NO_PROXY: '', no_proxy: '', NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'), GSD_TEST_KEY: 'offline-sentinel-stand-in' },
      timeout: 15000,
    });
    assert.deepEqual(JSON.parse(result.stdout), { successfulStreams: 4, timeoutObserved: true, abortObserved: true });
    assert.ok(tunnels.length > 0);
    assert.equal(requests.length, 6); // No automatic retries after timeout/abort.
    for (const { authorization, url, payload } of requests) {
      assert.equal(authorization, 'Bearer offline-sentinel-stand-in');
      assert.equal(url, '/v1/chat/completions');
      assert.equal(payload.model, 'DeepSeek-V4.1-Flash-1017');
      assert.equal(payload.stream, true);
      assert.equal(payload.max_completion_tokens, undefined);
      assert.equal(payload.thinking, undefined);
    }
    assert.equal(requests[0].payload.max_tokens, undefined); // Server default remains authoritative.
    assert.equal(requests[0].payload.reasoning_effort, 'none');
    assert.equal(requests[1].payload.max_tokens, 32768);
    assert.equal(requests[1].payload.reasoning_effort, 'max');
    assert.equal(requests[2].payload.max_tokens, 1048576);
    assert.equal(requests[2].payload.reasoning_effort, 'xhigh');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([provider, proxy].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  }
});
