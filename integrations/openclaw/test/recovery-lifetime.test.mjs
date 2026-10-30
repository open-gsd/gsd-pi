import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../../packages/mcp-server/package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

test('MCP close stops its RPC child and reconnect does not claim session recovery', { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gsd-mcp-recovery-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const cli = join(root, 'fixture.cjs');
  const stopped = join(root, 'stopped');
  await writeFile(cli, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); });
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      process.stdout.write(JSON.stringify({ type: 'response', command: message.type, id: message.id, success: true,
        data: message.type === 'init' ? { protocolVersion: 2, sessionId: 'retained-id', capabilities: {} } : {} }) + '\\n');
    });
  `);
  async function connect() {
    const client = new Client({ name: 'recovery-test', version: '1.0.0' });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../../packages/mcp-server/bin/gsd-mcp-server.js', import.meta.url))],
      cwd: root, env: { PATH: process.env.PATH, HOME: root, GSD_HOME: root,
        GSD_CLI_PATH: cli, GSD_MCP_CLIENT_MANAGED: '1' }, stderr: 'pipe' });
    await client.connect(transport);
    return client;
  }
  const first = await connect();
  const started = await first.callTool({ name: 'gsd_execute', arguments: { projectDir: root } });
  assert.notEqual(started.isError, true);
  assert.equal(JSON.parse(started.content[0].text).sessionId, 'retained-id');
  const running = await first.callTool({ name: 'gsd_status', arguments: { projectDir: root } });
  assert.equal(JSON.parse(running.content[0].text).status, 'running');
  await first.close();
  for (let i = 0; i < 100; i++) {
    if (await readFile(stopped, 'utf8').catch(() => '') === 'stopped') break;
    await delay(20);
  }
  assert.equal(await readFile(stopped, 'utf8'), 'stopped');
  const second = await connect();
  const status = await second.callTool({ name: 'gsd_status', arguments: { projectDir: root } });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /No tracked GSD sessions/);
});
