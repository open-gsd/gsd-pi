
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
});
const client = new Client({ name: "pask-heartbeat", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({
  name: "gsd_task_complete",
  arguments: {
    projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
    milestoneId: "M001",
    sliceId: "S05",
    taskId: "T01",
    oneLiner: "All T01 gates passed: npm test 153/1 skipped, tsc build clean, toolfactory validate all checks ok.",
    narrative: "Executed the full gate suite for groupmetoolkit S05 T01 after reconciling a stale T01-running stale pointer (DB lifecycle truth: all four S05 tasks ready, no active execution, latest workflow attempt settled succeeded 2:40 PM CDT). npm test = 153 passed/1 skipped (exit 0, vitest 9 test files, 2.19s). npm run build = tsc clean (exit 0). toolfactory validate = all checks ok including plugin-inspector inspect and runtime --mock-sdk (exit 0). Executed by Pask heartbeat 2026-10-23 8:29 PM CDT.",
    verification: "npm test exit 0; npm run build exit 0; toolfactory validate exit 0 with all checks ok. Verified live by Pask heartbeat; no reruns needed.",
    keyFiles: ["package.json", "tsconfig.json"],
  },
  _meta: { "io.opengsd/idempotency-key": "pask-t01-complete-20261023-2032" },
});
console.log("RESULT=" + JSON.stringify(r.content || r).slice(0, 400));
await client.close();

