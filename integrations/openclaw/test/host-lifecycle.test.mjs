import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { stopIsolatedGateway } from './host-lifecycle.mjs';

async function child(t, stop) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', `
    process.on('SIGTERM', () => { ${stop} });
    setInterval(() => {}, 1000);
    console.log('ready');
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  await once(process.stdout, 'data');
  return process;
}

test('isolated stop requires a graceful native exit and honors the advertised budget', async (t) => {
  const process = await child(t, "setTimeout(() => process.exit(0), 40)");
  const result = await stopIsolatedGateway(process, 'shutdown budget at startup: drain=100ms shutdown=200ms');
  assert.deepEqual(result, { code: 0, signal: null, watchdogMs: 5200, forced: false });
});

test('a killed child cannot be reported as graceful shutdown', async (t) => {
  const process = await child(t, "process.kill(process.pid, 'SIGKILL')");
  await assert.rejects(stopIsolatedGateway(process, ''), /did not shut down gracefully.*SIGKILL/);
});
