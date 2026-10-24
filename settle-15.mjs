import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
  env: { ...process.env, GSD_CLI_PATH: "/home/openclaw/.openclaw/projects/gsd-pi/dist/cli.js", NO_PROXY: "127.0.0.1,localhost,100.64.0.0/10,100.101.17.115", no_proxy: "127.0.0.1,localhost,100.64.0.0/10,100.101.17.115" },
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
    reason: "Attempt 15 orphaned: worker killed by gateway restart mid-execution (log ends 'Interrupted, stopping child process'); model calls were healthy under the NO_PROXY host up to the restart.",
    apply: true,
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-settle-attempt15-1" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
