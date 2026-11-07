import assert from 'node:assert/strict';
import test from 'node:test';
import { GsdGatewayRequestError, requestGateway } from '../dist/gateway-request.js';

const transport = (kind = 'timeout', code) => Object.assign(new Error('private token and project path'), {
  name: 'GatewayTransportError', kind, code, connectionDetails: {}, requestDispatched: true,
});
const scopes = ['operator.read'];

test('startup reads recover after a transient authenticated Gateway stall', async () => {
  for (const method of ['portal.list', 'plugins.list', 'projects.list', 'workboard.cards.list']) {
    let calls = 0;
    const result = await requestGateway(method, {}, scopes, new AbortController().signal, {
      retryDelayMs: 0,
      request: async () => { if (++calls < 3) throw transport(); return { ready: true }; },
    });
    assert.deepEqual(result, { ready: true });
    assert.equal(calls, 3);
  }
});

test('read recovery is bounded and exposes only method and safe error category', async () => {
  let calls = 0;
  await assert.rejects(requestGateway('portal.list', {}, scopes, new AbortController().signal, {
    retryDelayMs: 0, request: async () => { calls++; throw transport(); },
  }), error => {
    assert.equal(error.message, 'GSD Gateway portal.list failed (transport-timeout)');
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('private'));
    return error instanceof GsdGatewayRequestError;
  });
  assert.equal(calls, 3);
});

test('uncertain writes are never retried, including after a dispatched request timeout', async () => {
  for (const method of ['portal.open', 'portal.close', 'projects.register', 'workboard.cards.create', 'workboard.cards.update', 'other.list']) {
    let calls = 0;
    await assert.rejects(requestGateway(method, {}, scopes, new AbortController().signal, {
      retryDelayMs: 0, request: async () => { calls++; throw transport(); },
    }), GsdGatewayRequestError);
    assert.equal(calls, 1, method);
  }
});

test('authentication, permission and policy closes fail immediately without leaking their message', async () => {
  const errors = [
    Object.assign(new Error('private'), { name: 'GatewaySecretRefUnavailableError' }),
    Object.assign(new Error('private'), { name: 'GatewayClientRequestError' }),
    transport('closed', 1008),
  ];
  for (const failure of errors) {
    let calls = 0;
    await assert.rejects(requestGateway('portal.list', {}, scopes, new AbortController().signal, {
      retryDelayMs: 0, request: async () => { calls++; throw failure; },
    }), error => !error.message.includes('private'));
    assert.equal(calls, 1);
  }
});

test('service cancellation ends read backoff and admits no replacement call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = requestGateway('plugins.list', {}, scopes, controller.signal, {
    retryDelayMs: 10000, request: async () => { calls++; queueMicrotask(() => controller.abort()); throw transport(); },
  });
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('service stop preserves the receipt of an already in-flight mutation', async () => {
  const controller = new AbortController();
  let complete;
  const pending = requestGateway('portal.open', {}, scopes, controller.signal, {
    request: () => new Promise(resolve => { complete = resolve; }),
  });
  controller.abort();
  complete({ id: 'p33277' });
  assert.deepEqual(await pending, { id: 'p33277' });
});

test('missing optional Workboard RPC remains distinguishable from permission failure', async () => {
  await assert.rejects(requestGateway('workboard.cards.list', {}, scopes, new AbortController().signal, {
    request: async () => { throw new Error('unknown method: workboard.cards.list'); },
  }), error => error.methodUnavailable === true);
});
