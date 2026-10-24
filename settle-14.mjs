import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
  env: { ...process.env, GSD_CLI_PATH: "/home/openclaw/.openclaw/projects/gsd-pi/dist/cli.js" },
});
const client = new Client({ name: "pask-heartbeat-settle", version: "1.0.0" });
await client.connect(transport);
const res = await client.callTool({
  name: "gsd_task_settle",
  arguments: {
    projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
    milestoneId: "M001",
    sliceId: "S05",
    taskId: "T01",
    reason: "Attempt 14 orphaned: worker process dead after auto pause-close; Connection error in gsd agent inference path persists (diagnosed, logged on gsd-pi workboard).",
    apply: true,
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-settle-attempt14-3" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
