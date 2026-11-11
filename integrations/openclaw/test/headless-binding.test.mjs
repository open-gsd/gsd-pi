import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
for (const scenario of ['unavailable', 'mismatch']) {
  test(`headless refuses qualified model ${scenario} before execution`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-headless-binding-'));
    await mkdir(join(root, '.gsd'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cli = join(root, 'fixture.cjs');
    const log = join(root, 'requests.jsonl');
    await writeFile(cli, `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const msg = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n');
        if (!msg.id) return;
        const result = { type: 'response', id: msg.id, command: msg.type, success: true, data: {} };
        if (msg.type === 'init') result.data = { protocolVersion: 2, sessionId: 'fixture-id', capabilities: {} };
        if (msg.type === 'set_model' && ${JSON.stringify(scenario)} === 'unavailable') {
          result.success = false; result.error = 'Requested model unavailable';
        }
        if (msg.type === 'get_state') result.data = { model: { provider: 'paid-fallback', id: 'other' } };
        process.stdout.write(JSON.stringify(result) + '\\n');
      });
    `);
    const code = `import { runHeadless } from ${JSON.stringify(new URL('../../../dist/headless.js', import.meta.url).href)};
      await runHeadless({ timeout: 5000, timeoutExplicit: true, json: true, outputFormat: 'stream-json',
        model: 'spark/target-model', command: 'auto', commandArgs: [], maxRestarts: 0 });`;
    let failure;
    try {
      await exec(process.execPath, ['--input-type=module', '--eval', code], {
        cwd: root, timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: root, GSD_HOME: root, GSD_BIN_PATH: cli },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 1, failure?.stderr ?? 'headless should reject startup');
    assert.match(failure.stderr, scenario === 'unavailable' ? /Requested model unavailable/ : /refusing to start execution/);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(requests.some(request => request.type === 'set_model'));
    assert.ok(!requests.some(request => request.type === 'prompt'));
  });
}
