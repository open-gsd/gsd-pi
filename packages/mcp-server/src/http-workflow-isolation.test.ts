import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMcpHttpServer } from './http-server.js';
import { SessionManager } from './session-manager.js';

const MCP_PKG = '@modelcontextprotocol/sdk';
// The real runtime bridge is needed, not a fake DB. Keep the retained projects
// outside live state and let the caller select an evidence directory.
test('HTTP workflow clients never cross-read or cross-write project databases', {
  skip: !process.env.GSD_HTTP_INTEGRATION_ROOT,
}, async () => {
  const root = mkdtempSync(join(process.env.GSD_HTTP_INTEGRATION_ROOT!, 'http-isolation-'));
  const originalCwd = process.cwd();
  process.chdir(homedir());
  const host = await startMcpHttpServer(new SessionManager(), { port: 0, includeWorkflowTools: true });
  const { Client } = await import(`${MCP_PKG}/client/index.js`);
  const { StreamableHTTPClientTransport } = await import(`${MCP_PKG}/client/streamableHttp.js`);
  const clients: Array<{ client: InstanceType<typeof Client>; transport: InstanceType<typeof StreamableHTTPClientTransport>; projectDir: string }> = [];
  try {
    for (let i = 0; i < 2; i++) {
      const projectDir = join(root, String(i)); mkdirSync(projectDir);
      const client = new Client({ name: 'isolation', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(host.url));
      await client.connect(transport);
      clients.push({ client, transport, projectDir });
    }
    const call = async (i: number, name: string, args: Record<string, unknown> = {}) => {
      const result = await clients[i].client.callTool({
        name, arguments: { projectDir: clients[i].projectDir, ...args },
        _meta: { 'io.opengsd/idempotency-key': randomUUID() },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.stringify(result);
    };
    await Promise.all([call(0, 'gsd_project_init'), call(1, 'gsd_project_init')]);
    const omitted = await clients[0].client.callTool({ name: 'gsd_project_init', arguments: {} });
    assert.equal(omitted.isError, true); assert.match(JSON.stringify(omitted), /home directory/i);
    for (let n = 0; n < 8; n++) {
      await Promise.all([0, 1].map(i => call(i, 'gsd_decision_save', {
        scope: 'isolation', decision: 'sentinel-' + n, choice: 'private-project-' + i, rationale: 'isolation regression',
      })));
      await Promise.all([0, 1].map(async i => {
        const decisions = await call(i, 'gsd_decision_list');
        assert.match(decisions, new RegExp('private-project-' + i));
        assert.ok(!decisions.includes('private-project-' + (1 - i)));
        for (const tool of ['gsd_query', 'gsd_progress', 'gsd_roadmap', 'gsd_project_snapshot', 'gsd_knowledge', 'gsd_captures', 'gsd_history', 'gsd_doctor']) {
          assert.ok(!(await call(i, tool)).includes('private-project-' + (1 - i)), tool);
        }
      }));
    }
  } finally {
    for (const { client, transport } of clients) {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }
    await host.close();
    process.chdir(originalCwd);
  }
});
