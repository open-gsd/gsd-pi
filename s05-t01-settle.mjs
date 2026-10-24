
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
});
const client = new Client({ name: "pask-heartbeat", version: "1.0.0" });
await client.connect(transport);
try {
  const r = await client.callTool({
    name: "gsd_task_settle",
    arguments: {
      projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
      milestoneId: "M001",
      sliceId: "S05",
      taskId: "T01",
      reason: "Attempt 2 (d0096df8) is a stale running row: the durable tmux host was killed mid-attempt by the exec-scope cleanup class (log stopped 19:03:25, bootstrap process gone, no attempt result recorded). The T01 gate work itself is finished and verified: vitest 153 passed | 1 skipped, tsc build exit 0, toolfactory check ok, coverage four surfaces; durable evidence /home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md and card record on 8ff607aa. Retry is now safe: the gates are green and the auto loop is re-enterable.",
      apply: true,
      reconcileLifecycle: true,
    },
    _meta: { "io.opengsd/idempotency-key": "pask-s05-t01-settle-apply-20261023-2120" },
  });
  console.log("SETTLE=" + JSON.stringify(r.content || r).slice(0, 600));
} catch (e) {
  console.log("ERR=" + String(e).slice(0, 300));
}
await client.close();

