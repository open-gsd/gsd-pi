import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: 'node', args: ['/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js'] });
const c = new Client({ name: 'pask-recover-t03', version: '1.0.0' });
await c.connect(t);
const res = await c.listTools();
console.log(JSON.stringify(res.tools.map(x => x.name), null, 0));
await c.close();
