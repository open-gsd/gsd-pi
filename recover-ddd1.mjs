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
    recoveryActionId: "ddd19142-8d8e-4422-96a0-41d14d7fce94",
    repairSummary: "Resume aborted recovery ddd19142: attempt 17 settled failed on the known runtime length-halt (Provider stop_reason: length, continuation cap 3 exhausted) at T01 closeout AFTER all gate evidence was gathered; the rework resolutions and gate work are durable in the attempt output. NO_PROXY fix live on auto hosts; resume T01 dispatch to re-run the closeout.",
    evidence: {
      source: "pask-heartbeat-2026-10-23-late",
      attempt17: "settled failed 2026-10-24T04:15:03.557Z; closeout was submitting when the length-halt hit",
      lengthHalt: "runtime-level behavior (PREFERENCES.md has no continuation caps); provider stop_reason: length",
      noProxyFix: "NO_PROXY exemption set explicitly on auto host launch env; model calls healthy through the whole attempt (15.5 min run, 88 tool calls)",
    },
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-recover-ddd19142-1" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
