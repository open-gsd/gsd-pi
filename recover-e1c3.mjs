import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
  env: { ...process.env, GSD_CLI_PATH: "/home/openclaw/.openclaw/projects/gsd-pi/dist/cli.js", NO_PROXY: "127.0.0.1,localhost,100.64.0.0/10,100.101.17.115", no_proxy: "127.0.0.1,localhost,100.64.0.0/10,100.101.17.115" },
});
const client = new Client({ name: "pask-heartbeat-recover", version: "1.0.0" });
await client.connect(transport);
const res = await client.callTool({
  name: "gsd_task_recovery_resume",
  arguments: {
    projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
    recoveryActionId: "e1c37c2a-f70a-4f72-9b56-4156c6b289a4",
    repairSummary: "Resume aborted recovery e1c37c2a: attempt 16 orphaned by provider length-halt (continuation cap exhausted) after submitting T01 closeout; all T01 gates green with durable evidence on the gsd-pi workboard card; resume T01 dispatch.",
    evidence: {
      source: "pask-heartbeat-2026-10-23-late",
      attempt16: "settled failed via auto pause-close 2026-10-23T20:58 CDT; gates green (Node22 151 passed, Node24 loud-fail verified, MCP overlay portable)",
      closeout: "gsd_task_complete submitted but never committed (length-halt); durable evidence on card 6f74e8b1 comment 2026-10-23 22:56 CDT",
      noProxyFix: "NO_PROXY exemption explicit on auto host launch env; model calls healthy",
    },
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-recover-e1c37c2a-1" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
