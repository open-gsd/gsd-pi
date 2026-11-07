import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('heartbeat receives factual project context without a skill or scheduled prompt', async (t) => {
  assert.ok(process.env.OPENCLAW_BIN, 'Set OPENCLAW_BIN to the isolated OpenClaw host');
  const require = createRequire(await realpath(process.env.OPENCLAW_BIN));
  const sdk = new Map(['plugin-entry', 'gateway-runtime', 'agent-scope-runtime', 'routing', 'tool-plugin']
    .map((name) => [`openclaw/plugin-sdk/${name}`, require.resolve(`openclaw/plugin-sdk/${name}`)]));
  // Resolve the public SDK from the same host as the installed-artifact test.
  const loader = registerHooks({ resolve(specifier, context, next) {
    return next(sdk.get(specifier) ?? specifier, context);
  } });
  t.after(() => loader.deregister());
  const { default: plugin, gatewayScopes } = await import('../dist/index.js');
  const { ProjectSync } = await import('../dist/sync.js');
  const root = await mkdtemp(join(tmpdir(), 'gsd-openclaw-heartbeat-'));
  await symlink('.gsd', join(root, '.gsd'));
  const hooks = new Map();
  const warnings = [];
  const failures = [];
  let service;
  const records = [{ projectDir: '/fixture', phase: 'executing', status: 'running' }];
  t.mock.method(ProjectSync.prototype, 'restore', async () => []);
  t.mock.method(ProjectSync.prototype, 'snapshots', () => records);
  const cfg = { agents: { defaults: { workspace: root } }, mcp: { servers: { gsd: { env: { GSD_HOME: join(root, 'gsd-home') } } } } };
  plugin.register({
    config: cfg, logger: { warn: (message) => warnings.push(message) },
    registerService: (value) => { service = value; },
    on: (name, handler) => hooks.set(name, handler),
    // The real Gateway API surface the web tab registers against; no-ops here.
    registerHttpRoute: () => {},
    registerControlUiDescriptor: () => {},
    registerGatewayMethod: () => {},
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => root, session: { listSessionEntries: () => [] } },
      system: { enqueueSystemEvent: assert.fail, requestHeartbeat: assert.fail },
    },
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  service.start({ config: cfg, serviceHealth: {
    reportFailure: (error) => failures.push(error), clearFailure() {},
  } });
  assert.deepEqual(gatewayScopes('plugins.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('projects.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('projects.register'), ['operator.admin']);
  assert.deepEqual(gatewayScopes('workboard.cards.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('workboard.cards.create'), ['operator.admin']);
  assert.deepEqual(gatewayScopes('workboard.cards.update'), ['operator.write']);
  assert.deepEqual(gatewayScopes('portal.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('portal.open'), ['operator.write']);
  assert.deepEqual(gatewayScopes('portal.close'), ['operator.write']);
  assert.throws(() => gatewayScopes('unrelated.write'), /Unsupported GSD synchronization method/);
  for (let attempt = 0; attempt < 100 && warnings.length === 0; attempt++) await delay(10);
  assert.ok(warnings.length > 0, 'discovery error reaches the generic host health path');
  assert.ok(warnings.every((message) => message === 'GSD project synchronization failed; check GSD state and Gateway access.'));
  assert.ok(failures.length > 0);
  assert.ok(failures.every((error) => error.message === 'GSD project synchronization failed'));
  assert.ok(!JSON.stringify({ warnings, failures: failures.map((error) => error.message) }).includes(root),
    'absolute paths from discovery errors do not reach host logs or health reports');
  const contribute = hooks.get('heartbeat_prompt_contribution');
  const context = JSON.parse(contribute({ sessionKey: 'agent:main:main' }).appendContext);
  assert.deepEqual(context.projects, [{ projectDir: '/fixture', phase: 'executing', status: 'running' }]);
  assert.equal(contribute({ sessionKey: 'agent:other:main' }), undefined, 'operator data stays with its owner');
  records[0].status = 'done';
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined);
  await service.stop();
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined, 'a stopped service contributes no stale context');
});

test('session discovery is read-only and uses public spawnedCwd with sessionRoot precedence', async (t) => {
  assert.ok(process.env.OPENCLAW_BIN, 'Set OPENCLAW_BIN to the isolated OpenClaw host');
  const require = createRequire(await realpath(process.env.OPENCLAW_BIN));
  const sdk = new Map(['plugin-entry', 'gateway-runtime', 'agent-scope-runtime', 'routing', 'tool-plugin']
    .map((name) => [`openclaw/plugin-sdk/${name}`, require.resolve(`openclaw/plugin-sdk/${name}`)]));
  const loader = registerHooks({ resolve(specifier, context, next) {
    return next(sdk.get(specifier) ?? specifier, context);
  } });
  t.after(() => loader.deregister());
  const { default: plugin } = await import('../dist/index.js');
  const { ProjectSync } = await import('../dist/sync.js');
  const { ProjectEvents } = await import('../dist/discovery.js');
  const paths = [];
  const listCalls = [];
  const getCalls = [];
  let service;
  let listener;
  let unsubscribed = 0;
  let changedEntry;
  t.mock.method(ProjectEvents.prototype, 'start', () => {});
  t.mock.method(ProjectEvents.prototype, 'add', async (path) => { paths.push(path); });
  t.mock.method(ProjectEvents.prototype, 'stop', async () => {});
  t.mock.method(ProjectSync.prototype, 'restore', async () => []);
  const cfg = {};
  plugin.register({
    config: cfg, logger: { warn: assert.fail },
    registerService: (value) => { if (value.id === 'gsd-project-sync') service = value; },
    on() {}, registerHttpRoute() {}, registerControlUiDescriptor() {}, registerGatewayMethod() {},
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: () => '/workspace',
        session: {
          listSessionEntries: (input) => {
            listCalls.push(input);
            return [
              { entry: { spawnedCwd: '/startup-spawned' } },
              { entry: { sessionRoot: '/startup-root', spawnedCwd: '/ignored-spawned' } },
              { entry: { cwd: '/obsolete-cwd' } },
            ];
          },
          getSessionEntry: (input) => { getCalls.push(input); return changedEntry; },
        },
      },
      system: { enqueueSystemEvent: assert.fail, requestHeartbeat: assert.fail },
    },
  });
  t.after(() => service.stop());
  service.start({ config: cfg, gatewayEvents: { onSessionsChanged: (callback) => {
    listener = callback;
    return () => { unsubscribed++; };
  } } });
  assert.deepEqual(listCalls, [{ agentId: 'main', readOnly: true }]);
  assert.deepEqual(paths, ['/workspace', '/startup-spawned', '/startup-root']);
  changedEntry = { spawnedCwd: '/event-spawned' };
  const event = { sessionKey: 'agent:main:fixture', agentId: 'main' };
  listener(event);
  changedEntry = { sessionRoot: '/event-root', spawnedCwd: '/ignored-event-spawned' };
  listener(event);
  changedEntry = { cwd: '/obsolete-event-cwd' };
  listener(event);
  assert.deepEqual(getCalls, [event, event, event]);
  assert.deepEqual(paths, ['/workspace', '/startup-spawned', '/startup-root', '/event-spawned', '/event-root']);
  await service.stop();
  assert.equal(unsubscribed, 1);
});

test('notification routing isolates project events and context and refreshes on service restart', async (t) => {
  const require = createRequire(await realpath(process.env.OPENCLAW_BIN));
  const sdk = new Map(['plugin-entry', 'gateway-runtime', 'agent-scope-runtime', 'routing', 'tool-plugin']
    .map((name) => [`openclaw/plugin-sdk/${name}`, require.resolve(`openclaw/plugin-sdk/${name}`)]));
  const loader = registerHooks({ resolve(specifier, context, next) { return next(sdk.get(specifier) ?? specifier, context); } });
  t.after(() => loader.deregister());
  const { default: plugin } = await import('../dist/index.js');
  const { ProjectSync } = await import('../dist/sync.js');
  const { ProjectEvents } = await import('../dist/discovery.js');
  const hooks = new Map();
  const notifications = [];
  const wakes = [];
  let service;
  const records = [{ projectDir: '/fixture', status: 'running' }, { projectDir: '/other', status: 'running' }];
  const heartbeat = 'agent:main:dashboard:heartbeat';
  const oversight = 'agent:reviewer:dashboard:oversight';
  const cfg = { agents: { defaults: { systemAgent: { agentId: 'main' } }, entries: { main: { heartbeat: { session: heartbeat } }, reviewer: {} } },
    plugins: { entries: { 'open-gsd-openclaw': { config: { projectSessions: [{ projectDir: '/fixture', sessionKey: oversight }] } } } } };
  t.mock.method(ProjectEvents.prototype, 'start', () => {});
  t.mock.method(ProjectEvents.prototype, 'add', async () => {});
  t.mock.method(ProjectEvents.prototype, 'stop', async () => {});
  t.mock.method(ProjectSync.prototype, 'snapshots', () => records);
  t.mock.method(ProjectSync.prototype, 'restore', async function () {
    this.host.notify('fixture-key', 'fixture fact', '/fixture');
    return [];
  });
  plugin.register({
    config: cfg, logger: { warn: assert.fail },
    registerService: (value) => { if (value.id === 'gsd-project-sync') service = value; },
    on: (name, handler) => hooks.set(name, handler),
    registerHttpRoute() {}, registerControlUiDescriptor() {}, registerGatewayMethod() {},
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => '/workspace', session: { listSessionEntries: () => [] } },
      system: {
        enqueueSystemEvent: (text, options) => { notifications.push({ text, ...options }); return true; },
        requestHeartbeat: (options) => wakes.push(options),
      },
    },
  });
  t.after(() => service.stop());
  assert.ok(service.reload.configPrefixes.includes('plugins.entries.open-gsd-openclaw'));
  service.start({ config: cfg });
  assert.equal(notifications[0].sessionKey, oversight);
  assert.deepEqual(wakes[0], { source: 'other', intent: 'event', reason: 'gsd-project-changed', sessionKey: oversight, agentId: 'reviewer' });
  const contribute = hooks.get('heartbeat_prompt_contribution');
  assert.deepEqual(JSON.parse(contribute({ sessionKey: oversight }).appendContext).projects.map(p => p.projectDir), ['/fixture']);
  assert.deepEqual(JSON.parse(contribute({ sessionKey: heartbeat }).appendContext).projects.map(p => p.projectDir), ['/other']);
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined);
  await service.stop();
  assert.equal(contribute({ sessionKey: oversight }), undefined);
  const nextCfg = structuredClone(cfg);
  nextCfg.plugins.entries['open-gsd-openclaw'].config.projectSessions = [];
  service.start({ config: nextCfg });
  assert.equal(notifications[1].sessionKey, heartbeat);
  assert.equal(contribute({ sessionKey: oversight }), undefined);
  assert.deepEqual(JSON.parse(contribute({ sessionKey: heartbeat }).appendContext).projects.map(p => p.projectDir), ['/fixture', '/other']);
});
