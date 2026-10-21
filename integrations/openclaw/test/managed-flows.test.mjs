import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../dist/index.js';

// api.runtime.tasks (the host Tasks/TaskFlow registry) has been removed from
// the OpenClaw Plugin SDK runtime with no compatibility facade: it is simply
// absent, so `api.runtime.tasks` is `undefined` on a host that no longer
// provides it. These tests pin the gsd-project-sync service's behavior on
// both sides of that contract without requiring a live OpenClaw binary: the
// mock `runtime` object below plays the same role the real runtime Proxy
// would, so omitting `tasks` reproduces the live-gateway condition exactly.
async function registerSyncService(t, runtimeOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gsd-managed-flows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const services = new Map();
  const warnings = [];
  const hooks = new Map();
  plugin.register({
    config: {}, logger: { warn: (message) => warnings.push(message) },
    registerService: (service) => services.set(service.id, service),
    registerGatewayMethod: () => {},
    registerHttpRoute: () => {}, registerControlUiDescriptor: () => {},
    on: (name, handler) => hooks.set(name, handler),
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => root, session: { listSessionEntries: () => [] } },
      system: { enqueueSystemEvent: () => false, requestHeartbeat: () => {} },
      ...runtimeOverrides,
    },
  });
  const service = services.get('gsd-project-sync');
  assert.ok(service, 'gsd-project-sync service must be registered');
  const cfg = { agents: { defaults: { workspace: root } }, mcp: { servers: { gsd: { env: { GSD_HOME: join(root, 'gsd-home') } } } } };
  return { service, cfg, warnings, hooks };
}

test('gsd-project-sync reports a clear failure instead of crashing when the host has no Tasks API', async (t) => {
  // No `tasks` key at all: matches OpenClaw 2026.9.7, where api.runtime.tasks
  // is undefined (removed; see docs/plugins/sdk-migration/removed-surfaces.md).
  const { service, cfg, warnings } = await registerSyncService(t);
  const failures = [];
  const serviceHealth = { reportFailure: (error) => failures.push(error), clearFailure() {} };
  assert.doesNotThrow(() => service.start({ config: cfg, serviceHealth }),
    'start() must degrade gracefully, not throw "Cannot read properties of undefined (reading \'managedFlows\')"');
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Tasks API/);
  assert.ok(warnings.some((message) => /no Tasks\/TaskFlow API/.test(message)),
    'absence of the removed API must be logged with a specific, actionable message');
  await assert.doesNotReject(() => service.stop());
});

test('gsd-project-sync still binds managedFlows and serves heartbeat context when the host provides the Tasks API', async (t) => {
  const records = [{ controllerId: 'open-gsd-openclaw.projects', flowId: 'flow-1', stateJson: { projectDir: '/fixture', phase: 'executing' } }];
  let boundSessionKey;
  const { service, cfg, hooks } = await registerSyncService(t, {
    tasks: { managedFlows: { bindSession: (input) => { boundSessionKey = input.sessionKey; return { list: () => records }; } } },
  });
  const failures = [];
  const serviceHealth = { reportFailure: (error) => failures.push(error), clearFailure() {} };
  assert.doesNotThrow(() => service.start({ config: cfg, serviceHealth }));
  assert.equal(failures.length, 0, 'a host that provides the Tasks API must not report the removed-API failure');
  assert.equal(boundSessionKey, 'agent:main:main');
  const contribute = hooks.get('heartbeat_prompt_contribution');
  const context = JSON.parse(contribute({ sessionKey: 'agent:main:main' }).appendContext);
  assert.deepEqual(context.projects, [{ flowId: 'flow-1', projectDir: '/fixture', phase: 'executing' }]);
  await assert.doesNotReject(() => service.stop());
});
