import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyQualifiedModelBinding } from './model-binding.js';

test('legacy unqualified model resolution makes no RPC binding calls', async () => {
  await verifyQualifiedModelBinding({ setModel: assert.fail, getState: assert.fail }, 'legacy-id');
});

test('a stalled explicit model selection is bounded', async () => {
  await assert.rejects(verifyQualifiedModelBinding({
    setModel: () => new Promise(() => {}), getState: assert.fail,
  }, 'spark/target', 10), /Explicit model binding timed out/);
});

test('malformed qualified overrides fail before selection', async () => {
  await assert.rejects(verifyQualifiedModelBinding({ setModel: assert.fail, getState: assert.fail }, 'spark/'), /Expected provider\/model/);
});
