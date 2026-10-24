import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
  env: { ...process.env, GSD_CLI_PATH: "/home/openclaw/.openclaw/projects/gsd-pi/dist/cli.js" },
});
const client = new Client({ name: "pask-heartbeat-recover", version: "1.0.0" });
await client.connect(transport);
const res = await client.callTool({
  name: "gsd_task_recovery_resume",
  arguments: {
    projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
    recoveryActionId: "4d971c49-4548-41e2-941e-032c2ffd6d02",
    repairSummary: "Resume aborted recovery 84c351e7: attempt 13 settled failed (Connection error in gsd agent inference path); dispatch state clean, no open blockers; resume T01 dispatch.",
    evidence: {
      source: "pask-heartbeat-2026-10-23",
      attempt13: "settled failed 2026-10-24T03:10:58.327Z",
      blockers: 0,
      diagnosis: "persistent Connection error in gsd openai-completions client to spark route; endpoint healthy; logged on gsd-pi workboard card",
    },
  },
  _meta: { "io.opengsd/idempotency-key": "pask-heartbeat-recover-4d971c49-1" },
});
console.log(JSON.stringify(res, null, 2));
await client.close();
