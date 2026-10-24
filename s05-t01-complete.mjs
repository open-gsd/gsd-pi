
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
    name: "gsd_task_complete",
    arguments: {
      projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
      milestoneId: "M001",
      sliceId: "S05",
      taskId: "T01",
      oneLiner: "All T01 gates green: vitest 153 passed, tsc build clean, toolfactory check ok, coverage four surfaces",
      narrative: "Executed the full S05 T01 gate suite un-chained with local node_modules/.bin paths (S04 closeout lane pattern; npm/npx on PATH, L005 substitution not required): vitest run 153 passed | 1 skipped (exit 0), tsc -p tsconfig.json (exit 0, no output), toolfactory check ({ok:true}), toolfactory coverage (four surfaces: skill, mcp, cli, openclaw-native, all operations bridged). Durable evidence written to /home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md. No file outside the evidence file was modified.",
      verification: "Each gate ran as an un-chained command with exit code recorded in /home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md; test summary 153 passed | 1 skipped verified from the vitest output transcript.",
      keyFiles: ["/home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md"],
      keyDecisions: ["Un-chained gate execution per S04 closeout pattern"],
    },
    _meta: { "io.opengsd/idempotency-key": "pask-s05-t01-complete-20261023-2100" },
  });
  console.log("RESULT=" + JSON.stringify(r.content || r).slice(0, 400));
} catch (e) {
  console.log("ERR=" + String(e).slice(0, 300));
}
await client.close();

