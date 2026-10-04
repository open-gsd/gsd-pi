import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../dist/index.js';
import { GsdPortalService } from '../dist/portals.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Use the actual compiled entry/SDK and its real RPC handlers. Only host launch
// and daemon I/O are stubbed: no gateway, process, listener, or credentials.
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-registration-')));
  const requests = [];
  const registrations = [];
  const connections = [];
  t.mock.method(GsdPortalService.prototype, 'start', async function () {
    Object.defineProperty(this, 'webPort', { value: 33277 });
  });
  t.mock.method(GsdPortalService.prototype, 'stop', async () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return Response.json({ entries: ['fixture'] });
  });
  t.after(async () => {
    // Connection retirement also cleans up a failing regression's leaked stream.
    for (const connection of connections) connection.abort();
    for (const registration of registrations) await registration.service.stop();
    await flush();
    rmSync(directory, { recursive: true, force: true });
  });
  const register = (id) => {
    const methods = new Map();
    const services = new Map();
    plugin.register({
      config: {}, pluginConfig: {}, registrationMode: 'full',
      registerGatewayMethod: (name, handler) => methods.set(name, handler),
      registerService: (service) => services.set(service.id, service),
      registerHttpRoute() {}, registerControlUiDescriptor() {}, on() {},
      logger: { warn() {} },
    });
    const service = services.get('gsd-web-portal');
    assert.ok(service);
    const registration = {
      id, service,
      project: { projectId: id, canonicalRoot: directory },
      async start(policy = { projects: [this.project] }) {
        await service.start({ config: { plugins: { entries: {
          'open-gsd-openclaw': { config: { webUi: { enabled: true }, embeddedProjects: policy } },
        } } } });
        await flush();
      },
      async call(name, params = {}, overrides = {}) {
        const connection = new AbortController();
        connections.push(connection);
        let respond;
        const response = new Promise((resolve) => { respond = (ok, payload, error) => resolve({ ok, payload, error }); });
        await methods.get(name)({
          params, client: { connId: id, connectionSignal: connection.signal, internal: { controlUiAdmin: true } },
          context: {}, respond, ...overrides,
        });
        return response;
      },
    };
    registrations.push(registration);
    return registration;
  };
  return { directory, requests, register };
}

test('each compiled registration receives its own approved policy before service startup', { timeout: 5000 }, async (t) => {
  const h = fixture(t);
  const a = h.register('a');
  const b = h.register('b');
  await a.start();
  const result = await a.call('gsd.ui.directories.list', { root: h.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.requests.at(-1).searchParams.get('path'), h.directory);
  assert.equal((await a.call('gsd.ui.preferences.read')).ok, true);
  const untouched = await b.call('gsd.ui.projects.list', { projectId: 'a' });
  assert.equal(untouched.error?.message, 'no approved project matches', 'starting A must not grant B a project');
  const denied = await a.call('gsd.ui.projects.list', { projectId: 'a' }, { client: { internal: { controlUiAdmin: false } } });
  assert.equal(denied.error?.message, 'administrator admission required', 'admin-only remains the default');
});

test('policy withdrawal and removal affect only the registration being reloaded', { timeout: 5000 }, async (t) => {
  const h = fixture(t);
  const a = h.register('a');
  await a.start();
  const b = h.register('b');
  await b.start();
  assert.equal((await a.call('gsd.ui.projects.list', { projectId: 'a' })).ok, true);
  await a.service.stop();
  await a.start({ adminOnly: true, projects: [] });
  assert.equal((await a.call('gsd.ui.projects.list', { projectId: 'a' })).error?.message, 'no approved project matches');
  assert.equal((await b.call('gsd.ui.projects.list', { projectId: 'b' })).ok, true, 'A withdrawal preserves B policy');
  await a.start();
  assert.equal((await a.call('gsd.ui.projects.list', { projectId: 'a' })).ok, true);
  await a.start({});
  assert.equal((await a.call('gsd.ui.projects.list', { projectId: 'a' })).error?.message, 'no approved project matches');
  assert.equal((await b.call('gsd.ui.projects.list', { projectId: 'b' })).ok, true);
});

test('service stop disposes its own subscriptions without closing another registration', { timeout: 5000 }, async (t) => {
  const h = fixture(t);
  const streams = [];
  const events = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const state = { cancelled: 0, controller: undefined, signal: init.signal };
    const body = new ReadableStream({
      start(controller) { state.controller = controller; },
      cancel() { state.cancelled += 1; },
    });
    streams.push(state);
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const context = { broadcastToConnIds(_event, payload, recipients) { events.push({ payload, recipients: [...recipients] }); } };
  const a = h.register('a');
  await a.start();
  assert.equal((await a.call('gsd.ui.workspace.events.subscribe', { projectId: 'a' }, { context })).ok, true);
  const b = h.register('b');
  await b.start();
  assert.equal((await b.call('gsd.ui.workspace.events.subscribe', { projectId: 'b' }, { context })).ok, true);
  await a.service.stop();
  await flush();
  assert.equal(streams[0].cancelled, 1, 'A stream must close');
  assert.equal(streams[0].signal.aborted, true);
  assert.equal(streams[1].cancelled, 0, 'B stream must remain open');
  assert.equal(streams[1].signal.aborted, false);
  assert.deepEqual(events.filter((event) => event.payload.closed).map((event) => event.recipients), [['a']]);
  streams[1].controller.enqueue(new TextEncoder().encode('data: {"still":"live"}\n\n'));
  await flush();
  assert.ok(events.some((event) => event.payload.event?.still === 'live' && event.recipients[0] === 'b'));
  await b.service.stop();
  await flush();
  assert.equal(streams[1].cancelled, 1);
  assert.deepEqual(events.filter((event) => event.payload.closed).map((event) => event.recipients), [['a'], ['b']]);
});
