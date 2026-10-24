import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
});
const client = new Client({ name: "pask-heartbeat", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({ name: "gsd_status", arguments: { projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit" } });
console.log("STATUS=" + JSON.stringify(r.content || r).slice(0, 600));
await client.close();
