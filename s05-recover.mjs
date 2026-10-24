
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
    name: "gsd_task_recovery_resume",
    arguments: {
      projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
      recoveryActionId: "c9fb9673-d6cc-42b8-a9ca-2f7f6e1f5721",
      repairSummary: "The interrupted Attempt 2 (d0096df8) was settled honestly as interrupted and the lifecycle reconciled to ready (M001/S05/T01) without deleting SUMMARYs. The T01 gate work is finished and verified green: vitest 153 passed | 1 skipped, tsc build exit 0, toolfactory check ok:true, coverage four surfaces; durable evidence /home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md and a verified card record on workboard card 8ff607aa (S05 T01 GATES GREEN). The prior failure chain (v10 non-executable bootstrap.js, tmux server killed by exec-scope cleanup) is repaired: bootstrap.js chmod +x, and retry is safe because no running Attempt remains (count 0) and the gates are green.",
      evidence: {
        evidenceFile: "/home/openclaw/.gsd/projects/b1098e91efab/evidence/S05-T01-gates.md",
        gates: "vitest 153 passed | 1 skipped (exit 0); tsc -p tsconfig.json exit 0; toolfactory check {ok:true}; toolfactory coverage exit 0 (four surfaces)",
        staleAttemptSettled: "d0096df8-2aca-4e02-8717-0e63c8e9d43a settled interrupted, lifecycle reconciled to ready M001/S05/T01",
        runningAttempts: 0,
        bootstrapExecutable: "/home/openclaw/.openclaw/projects/gsd-pi/dist/bootstrap.js chmod +x verified",
        cardRecord: "workboard 8ff607aa-bf9e-484d-82e9-8a248cd33b8b comment S05 T01 GATES GREEN (verified latest comment)",
      },
    },
    _meta: { "io.opengsd/idempotency-key": "pask-s05-t01-recovery-20261023-2125" },
  });
  console.log("RECOVERY=" + JSON.stringify(r.content || r).slice(0, 600));
} catch (e) {
  console.log("ERR=" + String(e).slice(0, 300));
}
await client.close();

