import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const require = createRequire(new URL('../../../packages/mcp-server/package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

test('manifest-owned MCP clients coexist in the same cwd without closing each other', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gsd-openclaw-mcp-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const definition = manifest.mcpServers.gsd;
  const serverBin = fileURLToPath(new URL('../../../packages/mcp-server/bin/gsd-mcp-server.js', import.meta.url));
  for (let i = 0; i < 2; i++) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverBin], cwd: root,
      // No developer credentials, project registry or model configuration.
      env: { PATH: process.env.PATH, HOME: root, GSD_HOME: root, ...definition.env },
      stderr: 'pipe',
    });
    const client = new Client({ name: `openclaw-lifecycle-${i}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
  }
  for (const client of clients) {
    const status = await client.callTool({ name: 'gsd_status', arguments: { projectDir: root } });
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /No tracked GSD sessions/);
    const progress = await client.callTool({ name: 'gsd_progress', arguments: { projectDir: root } });
    assert.notEqual(progress.isError, true);
    assert.equal(JSON.parse(progress.content[0].text).tasks.total, 0);
  }
  assert.equal(definition.env.GSD_MCP_CLIENT_MANAGED, '1');
  await assert.rejects(readFile(join(root, 'mcp-instances.json')), { code: 'ENOENT' });
});
