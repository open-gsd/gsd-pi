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
  const sdk = new Map(['plugin-entry', 'gateway-runtime', 'agent-scope-runtime', 'routing']
    .map((name) => [`openclaw/plugin-sdk/${name}`, require.resolve(`openclaw/plugin-sdk/${name}`)]));
  // Resolve the public SDK from the same host as the installed-artifact test.
  const loader = registerHooks({ resolve(specifier, context, next) {
    return next(sdk.get(specifier) ?? specifier, context);
  } });
  t.after(() => loader.deregister());
  const { default: plugin, gatewayScopes } = await import('../dist/index.js');
  const root = await mkdtemp(join(tmpdir(), 'gsd-openclaw-heartbeat-'));
  await symlink('.gsd', join(root, '.gsd'));
  const hooks = new Map();
  const warnings = [];
  const failures = [];
  let service;
  const records = [{ controllerId: 'open-gsd-openclaw.projects', flowId: 'flow-1', stateJson: { projectDir: '/fixture', phase: 'executing' } },
    { controllerId: 'another-plugin', flowId: 'private', stateJson: { projectDir: '/other' } }];
  const cfg = { agents: { defaults: { workspace: root } }, mcp: { servers: { gsd: { env: { GSD_HOME: join(root, 'gsd-home') } } } } };
  plugin.register({
    config: cfg, logger: { warn: (message) => warnings.push(message) },
    registerService: (value) => { service = value; },
    on: (name, handler) => hooks.set(name, handler),
    runtime: {
      tasks: { managedFlows: { bindSession: () => ({ list: () => records }) } },
      agent: { resolveAgentWorkspaceDir: () => root, session: { listSessionEntries: () => [] } },
      system: { enqueueSystemEvent: assert.fail, requestHeartbeat: assert.fail },
    },
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  service.start({ config: cfg, serviceHealth: {
    reportFailure: (error) => failures.push(error), clearFailure() {},
  } });
  assert.deepEqual(gatewayScopes('projects.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('projects.register'), ['operator.admin']);
  assert.deepEqual(gatewayScopes('workboard.cards.list'), ['operator.read']);
  assert.deepEqual(gatewayScopes('workboard.cards.create'), ['operator.admin']);
  assert.deepEqual(gatewayScopes('workboard.cards.update'), ['operator.admin']);
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
  assert.deepEqual(context.projects, [{ flowId: 'flow-1', projectDir: '/fixture', phase: 'executing' }]);
  assert.equal(contribute({ sessionKey: 'agent:other:main' }), undefined, 'operator data stays with its owner');
  records[0].endedAt = Date.now();
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined);
  await service.stop();
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined, 'a stopped service contributes no stale context');
});
