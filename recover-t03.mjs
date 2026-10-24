import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: 'node', args: ['/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js'] });
const c = new Client({ name: 'pask-recover-t03', version: '1.0.0' });
await c.connect(t);
const res = await c.callTool({
  name: 'gsd_plan_task',
  arguments: {
    projectDir: '/home/openclaw/.openclaw/projects/groupmetoolkit',
    milestoneId: 'M001',
    sliceId: 'S05',
    taskId: 'T03',
    title: 'Document vault-only token route in skill body and README/AGENTS',
    description: 'Document vault-only token route in skill body and README/AGENTS (replan of prior attempt: verify command corrected so the gate actually passes)',
    estimate: '20m',
    files: ['SKILL.md', 'README.md', 'AGENTS.md', 'scripts/check-token-leak.mjs', 'package.json'],
    verify: 'node scripts/check-token-leak.mjs && node node_modules/.bin/toolfactory check',
    inputs: [],
    expectedOutput: ['scripts/check-token-leak.mjs', 'SKILL.md', 'README.md', 'AGENTS.md'],
    requiredWorkflowTools: []
  },
  _meta: { 'io.opengsd/idempotency-key': 'pask-t03-verify-fix-20261024c' }
});
console.log(JSON.stringify(res, null, 1).slice(0, 2000));
await c.close();
