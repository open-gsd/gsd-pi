import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../../../packages/mcp-server/dist/session-manager.js';

for (const scenario of ['selected', 'unavailable', 'mismatch']) {
  test(`qualified execution model binding: ${scenario}`, { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-model-binding-'));
    const manager = new SessionManager();
    t.after(async () => { await manager.cleanup(); await rm(root, { recursive: true, force: true }); });
    const log = join(root, 'requests.jsonl');
    const cli = join(root, 'fixture.cjs');
    await writeFile(cli, `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), ...message }) + '\\n');
        if (!message.id) return;
        const response = { type: 'response', id: message.id, command: message.type, success: true, data: {} };
        if (message.type === 'init') response.data = { protocolVersion: 2, sessionId: 'fixture-session', capabilities: {} };
        if (message.type === 'set_model') {
          if (${JSON.stringify(scenario)} === 'unavailable') { response.success = false; response.error = 'Requested model unavailable'; }
          else response.data = { provider: message.provider, id: message.modelId };
        }
        if (message.type === 'get_state') response.data = { model: ${JSON.stringify(scenario)} === 'mismatch'
          ? { provider: 'other', id: 'default' } : { provider: 'spark', id: 'target-model' } };
        process.stdout.write(JSON.stringify(response) + '\\n');
      });
    `);
    const start = manager.startSession(root, { cliPath: cli, model: 'spark/target-model' });
    if (scenario === 'selected') assert.equal(await start, 'fixture-session');
    else await assert.rejects(start, scenario === 'unavailable' ? /Requested model unavailable/ : /refusing to start execution/);
    const messages = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(messages.every(message => message.cwd === root));
    const selection = messages.find(message => message.type === 'set_model');
    assert.equal(selection.provider, 'spark');
    assert.equal(selection.modelId, 'target-model');
    const types = messages.map(message => message.type);
    if (scenario === 'selected') {
      assert.ok(types.indexOf('set_model') < types.indexOf('get_state'));
      assert.ok(types.indexOf('get_state') < types.indexOf('prompt'));
    } else assert.ok(!types.includes('prompt'), 'no execution prompt is sent to a fallback model');
  });
}
