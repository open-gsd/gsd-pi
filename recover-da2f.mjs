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
    recoveryActionId: "da2f91ef-e8e1-4b35-92bf-0d188b701ac5",
    repairSummary: "Resume aborted recovery da2f91ef: attempt 15 (d65bf1e9) orphaned by gateway restart mid-execution; settled interrupted via gsd_task_settle (tool-side lease view clean, raw row lags); NO_PROXY fix live on auto hosts, model calls healthy. Resume T01 dispatch.",
    evidence: {
      source: "pask-heartbeat-2026-10-23-post-restart",
      attempt15: "settled interrupted via gsd_task_settle 2026-10-23T20:44 CDT (attemptId d65bf1e9-f595-49c4-ad87-2064da853367)",
      restartCause: "gateway restart killed auto host 258411 mid-T01 (log ends 'Interrupted, stopping child process')",
      noProxyFix: "NO_PROXY exemption proven (gsd --print OK) and set explicitly on auto host launch env",
    },
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-recover-da2f91ef-1" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
