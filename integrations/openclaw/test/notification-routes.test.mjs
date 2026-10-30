import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationRoutes } from '../dist/notification-routes.js';

const heartbeat = 'agent:main:dashboard:heartbeat';
const oversight = 'agent:reviewer:dashboard:oversight';
const config = (bindings = []) => ({
  agents: { defaults: { systemAgent: { agentId: 'main' } }, entries: { main: { heartbeat: { session: heartbeat } }, reviewer: {} } },
  plugins: { entries: { 'open-gsd-openclaw': { config: { projectSessions: bindings } } } },
});

test('default route follows the configured native heartbeat session', () => {
  assert.deepEqual(new NotificationRoutes(config()).forProject('/other'), { agentId: 'main', sessionKey: heartbeat });
  assert.deepEqual(new NotificationRoutes({ session: { mainKey: 'custom' } }).forProject('/other'),
    { agentId: 'main', sessionKey: 'agent:main:custom' });
});

test('project-specific route is exact and derives the owning agent from its session key', () => {
  const routes = new NotificationRoutes(config([{ projectDir: '/beer', sessionKey: oversight }]));
  assert.deepEqual(routes.forProject('/beer/.'), { agentId: 'reviewer', sessionKey: oversight });
  assert.deepEqual(routes.forProject('/beer-unrelated'), { agentId: 'main', sessionKey: heartbeat });
  assert.deepEqual(routes.forProject('/other'), { agentId: 'main', sessionKey: heartbeat });
});

test('invalid or duplicate explicit routes fail closed instead of notifying main', () => {
  const unknownOwner = config();
  unknownOwner.agents.defaults.systemAgent.agentId = 'missing';
  assert.throws(() => new NotificationRoutes(unknownOwner), /Invalid GSD/);
  for (const binding of [
    { projectDir: 'relative', sessionKey: oversight },
    { projectDir: '/beer', sessionKey: 'invalid' },
    { projectDir: '/beer', sessionKey: 'agent:missing:main' },
  ]) assert.throws(() => new NotificationRoutes(config([binding])), /Invalid GSD/);
  assert.throws(() => new NotificationRoutes(config([
    { projectDir: '/beer', sessionKey: heartbeat },
    { projectDir: '/beer/.', sessionKey: oversight },
  ])), /Duplicate GSD/);
});
