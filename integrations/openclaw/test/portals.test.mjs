import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { GsdPortalService, resolveWebLaunch } from '../dist/portals.js';

const PORT = 32117;
const PUBLIC_URL = 'http://portal.example.invalid:32118';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, source = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gsd-portal-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@opengsd/gsd-pi' }));
  const entry = source ? join(root, 'web/node_modules/next/dist/bin/next') : join(root, 'dist/web/standalone/server.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, '// Fixture: never executed.');
  if (source) await writeFile(join(root, 'web/package.json'), '{}');
  return { root, entry };
}

async function harness(t, options = {}) {
  const { root, entry } = await fixture(t, options.source);
  const calls = [];
  const failures = [];
  const child = Object.assign(new EventEmitter(), { pid: 999_999_999, exitCode: null, signalCode: null });
  const request = async (method, params) => {
    calls.push({ method, params });
    if (options.request) return options.request(method, params);
    if (method === 'portal.list') return { portals: [] };
    if (method === 'portal.open') return { id: `p${PORT}`, publicUrl: PUBLIC_URL, url: `${PUBLIC_URL}/?openclaw_portal=not-a-real-secret`, tokenQuery: 'not-a-real-secret' };
    return { closed: true };
  };
  const deps = {
    reservePort: async (requested) => { calls.push({ method: 'reserve', requested }); return PORT; },
    spawn: (command, args, spawnOptions) => {
      calls.push({ method: 'spawn', command, args, options: spawnOptions });
      options.onSpawn?.(child);
      return child;
    },
    probe: async (url, signal) => { calls.push({ method: 'probe', url }); return options.probe ? options.probe(url, signal) : true; },
    terminate: async (owned) => { assert.equal(owned, child); calls.push({ method: 'terminate' }); child.emit('exit', 0); },
    readyTimeoutMs: 100,
    pollMs: 1,
    ...options.deps,
  };
  const service = new GsdPortalService({
    config: { packageRoot: root, ...options.config },
    env: options.env ?? {}, request, deps,
    onError: (error) => failures.push(error),
  });
  t.after(() => service.stop());
  return { root, entry, calls, failures, child, service };
}

test('standalone host is opened only after portal registration and uses sanitized daemon picker environment', async (t) => {
  const h = await harness(t, { env: {
    GSD_HOME: '/existing/gsd', GSD_WEB_AUTH_TOKEN: ['old', 'token'].join('-'),
    GSD_WEB_PROJECT_CWD: '/existing/project', GSD_WEB_PROJECT_SESSIONS_DIR: '/existing/session',
    GSD_WEB_ALLOWED_ORIGINS: '*', GSD_WEB_ALLOW_UNAUTHENTICATED_LAN: '1',
    HOSTNAME: '0.0.0.0', PORT: '123', GSD_WEB_DAEMON_MODE: '0',
  } });
  const first = h.service.start();
  assert.equal(h.service.start(), first, 'concurrent starts share one startup');
  await first;
  await h.service.start();
  assert.deepEqual(h.calls.map((call) => call.method), ['reserve', 'portal.list', 'portal.open', 'spawn', 'probe']);
  const spawned = h.calls.find((call) => call.method === 'spawn');
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args, [h.entry]);
  assert.equal(spawned.options.cwd, dirname(h.entry));
  assert.equal(spawned.options.stdio, 'ignore');
  assert.equal(spawned.options.detached, process.platform !== 'win32');
  assert.equal(spawned.options.shell, undefined);
  const env = spawned.options.env;
  assert.equal(env.GSD_HOME, '/existing/gsd');
  assert.equal(env.GSD_WEB_PACKAGE_ROOT, h.root);
  assert.equal(env.GSD_WEB_HOST_KIND, 'packaged-standalone');
  assert.equal(env.PUBLIC_URL, PUBLIC_URL);
  assert.equal(env.HOSTNAME, '127.0.0.1');
  assert.equal(env.GSD_WEB_HOST, '127.0.0.1');
  assert.equal(env.PORT, String(PORT));
  assert.equal(env.GSD_WEB_DAEMON_MODE, '1');
  assert.equal(env.GSD_WEB_NO_AUTH, '1');
  for (const name of ['GSD_WEB_AUTH_TOKEN', 'GSD_WEB_PROJECT_CWD', 'GSD_WEB_PROJECT_SESSIONS_DIR', 'GSD_WEB_ALLOWED_ORIGINS', 'GSD_WEB_ALLOW_UNAUTHENTICATED_LAN']) assert.equal(env[name], undefined);
  assert.ok(!JSON.stringify(env).includes('not-a-real-secret'));
  await Promise.all([h.service.stop(), h.service.stop()]);
  assert.equal(h.calls.filter((call) => call.method === 'terminate').length, 1);
  assert.deepEqual(h.calls.filter((call) => call.method === 'portal.close').map((call) => call.params), [{ id: `p${PORT}` }]);
  assert.deepEqual(h.failures, []);
});

test('source development fallback launches Next directly without npm or gsd CLI side effects', async (t) => {
  const h = await harness(t, { source: true });
  await h.service.start();
  const spawned = h.calls.find((call) => call.method === 'spawn');
  assert.deepEqual(spawned.args, [h.entry, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(PORT)]);
  assert.equal(spawned.options.cwd, join(h.root, 'web'));
  assert.equal(spawned.options.env.NEXT_PUBLIC_GSD_DEV, '1');
  assert.equal(spawned.options.env.NODE_ENV, 'development');
});

test('explicitly disabled UI does not resolve packages, reserve ports or request Gateway access', async () => {
  let called = false;
  const service = new GsdPortalService({ config: { enabled: false, packageRoot: '/missing' }, request: async () => { called = true; return {}; } });
  await service.start();
  await service.stop();
  assert.equal(called, false);
});

test('GSD_CLI_PATH and PATH symlinks resolve to the real GSD package and standalone wins', async (t) => {
  const { root, entry } = await fixture(t, true);
  const cli = join(root, 'dist/bootstrap.js');
  const standalone = join(root, 'dist/web/standalone/server.js');
  await mkdir(dirname(standalone), { recursive: true });
  await writeFile(standalone, '// not executed');
  await writeFile(cli, '// not executed');
  await mkdir(join(root, 'bin'));
  await symlink(cli, join(root, 'bin/gsd'));
  assert.equal(resolveWebLaunch({}, { GSD_CLI_PATH: cli }).entry, standalone);
  assert.equal(resolveWebLaunch({}, { PATH: join(root, 'bin') }).entry, standalone);
  assert.notEqual(entry, standalone);
  assert.throws(() => resolveWebLaunch({ packageRoot: join(root, 'bin') }, {}), /packageRoot/);
  assert.throws(() => resolveWebLaunch({}, { PATH: '' }), /cannot locate GSD/);
});

test('an existing portal is never claimed, spawned over or closed', async (t) => {
  const h = await harness(t, { request: async () => ({ portals: [{ id: `p${PORT}`, port: PORT }] }) });
  await assert.rejects(h.service.start(), /belongs to another portal/);
  assert.deepEqual(h.calls.map((call) => call.method), ['reserve', 'portal.list']);
});

test('an invalid portal listing cannot establish ownership of a target port', async (t) => {
  const h = await harness(t, { request: async () => ({}) });
  await assert.rejects(h.service.start(), /could not verify existing/);
  assert.deepEqual(h.calls.map((call) => call.method), ['reserve', 'portal.list']);
});

test('portal registration failure never launches an unprotected host', async (t) => {
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list') return { portals: [] };
    throw new Error('Gateway unavailable');
  } });
  await assert.rejects(h.service.start(), /registration failed/);
  assert.ok(!h.calls.some((call) => call.method === 'spawn' || call.method === 'portal.close'));
});

test('timed-out registration reconciles a newly created owned portal before cleanup', async (t) => {
  let committed = false;
  let createdAtMs = 0;
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list') return { portals: committed ? [{ id: `p${PORT}`, port: PORT, title: 'GSD', description: 'GSD native web workspace', createdAtMs }] : [] };
    if (method === 'portal.open') { committed = true; createdAtMs = Date.now(); throw new Error('Timeout after commit'); }
    return { closed: true };
  } });
  await assert.rejects(h.service.start(), /registration failed/);
  assert.ok(!h.calls.some((call) => call.method === 'spawn'));
  assert.equal(h.calls.filter((call) => call.method === 'portal.close').length, 1);
  assert.deepEqual(h.failures, []);
});

test('unresolved registration outcome is reported, never blindly closed or launched', async (t) => {
  let attempted = false;
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list' && !attempted) return { portals: [] };
    attempted = true;
    throw new Error('Gateway unavailable');
  } });
  await assert.rejects(h.service.start(), /registration failed/);
  assert.ok(!h.calls.some((call) => call.method === 'spawn' || call.method === 'portal.close'));
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0].message, /registration outcome is unverified/);
});

test('a token-bearing public URL is rejected and its just-created portal is cleaned up', async (t) => {
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list') return { portals: [] };
    return { id: `p${PORT}`, publicUrl: `${PUBLIC_URL}/?openclaw_portal=not-a-real-secret` };
  } });
  await assert.rejects(h.service.start(), /token-free/);
  assert.ok(!h.calls.some((call) => call.method === 'spawn'));
  assert.equal(h.calls.filter((call) => call.method === 'portal.close').length, 1);
});

test('host startup failure promptly terminates owned child and closes portal', async (t) => {
  const h = await harness(t, {
    onSpawn: (child) => queueMicrotask(() => child.emit('error', new Error('private stderr must not escape'))),
    probe: () => new Promise(() => {}),
  });
  await assert.rejects(h.service.start(), /host exited or failed/);
  assert.deepEqual(h.calls.filter((call) => ['terminate', 'portal.close'].includes(call.method)).map((call) => call.method), ['terminate', 'portal.close']);
});

test('readiness retries and timeout fail startup rather than claiming successful launch', async (t) => {
  const h = await harness(t, { probe: async () => false, deps: { readyTimeoutMs: 15 } });
  await assert.rejects(h.service.start(), /readiness timed out/);
  assert.ok(h.calls.filter((call) => call.method === 'probe').length > 1);
  assert.equal(h.calls.filter((call) => call.method === 'terminate').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'portal.close').length, 1);
});

test('stop during portal.open waits for ownership receipt then closes without spawning', async (t) => {
  const opened = deferred();
  const entered = deferred();
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list') return { portals: [] };
    if (method === 'portal.open') { entered.resolve(); return opened.promise; }
    return { closed: true };
  } });
  const started = h.service.start();
  await entered.promise;
  const stopped = h.service.stop();
  opened.resolve({ id: `p${PORT}`, publicUrl: PUBLIC_URL });
  await Promise.all([started, stopped]);
  assert.ok(!h.calls.some((call) => call.method === 'spawn'));
  assert.equal(h.calls.filter((call) => call.method === 'portal.close').length, 1);
});

test('stop cancels a hung health probe, cleans once, and permits a later fresh start', async (t) => {
  let ready = false;
  const entered = deferred();
  const h = await harness(t, { probe: () => { entered.resolve(); return ready ? Promise.resolve(true) : new Promise(() => {}); } });
  const started = h.service.start();
  await entered.promise;
  await h.service.stop();
  await started;
  assert.equal(h.calls.filter((call) => call.method === 'terminate').length, 1);
  ready = true;
  await h.service.start();
  assert.equal(h.calls.filter((call) => call.method === 'spawn').length, 2);
});

test('unexpected exit after readiness closes owned portal and reports one sanitized failure', async (t) => {
  const h = await harness(t);
  await h.service.start();
  h.child.emit('error', new Error('private output'));
  h.child.emit('exit', 1);
  await nextTurn();
  assert.equal(h.calls.filter((call) => call.method === 'terminate').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'portal.close').length, 1);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0].message, /host exited or failed/);
  assert.ok(!h.failures[0].message.includes('private output'));
});

test('Gateway shutdown failure cannot prevent owned host termination', async (t) => {
  const h = await harness(t, { request: async (method) => {
    if (method === 'portal.list') return { portals: [] };
    if (method === 'portal.open') return { id: `p${PORT}`, publicUrl: PUBLIC_URL };
    throw new Error('Gateway already stopped');
  } });
  await h.service.start();
  await h.service.stop();
  assert.deepEqual(h.calls.slice(-2).map((call) => call.method), ['terminate', 'portal.close']);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0].message, /closure could not be verified/);
});
