
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
});
const client = new Client({ name: "pask-heartbeat", version: "1.0.0" });
await client.connect(transport);
const idem = "pask-s05-plan-20261023-1930";
const tasks = [
  {
    taskId: "T01",
    title: "Run all gates: npm test, npm run build, toolfactory drift/upstream/coverage",
    description: "Execute the full gate suite for groupmetoolkit: npm test, npm run build, and toolfactory drift/upstream/coverage gates. Record pass/fail per gate in the task verification result.",
    estimate: "1h",
    files: ["package.json", "package-lock.json"],
    verify: "npm test",
    inputs: ["ROADMAP.md", "KNOWLEDGE.md"],
    expectedOutput: ["gate-results.md"],
    requiredWorkflowTools: [],
  },
  {
    taskId: "T02",
    title: "CLI and MCP listing smoke with correct missing-auth behavior",
    description: "Smoke every read-only operation on CLI and MCP listings; verify missing-auth behavior is a clear structured error with no network call, and readOnlyHint true, destructiveHint false, idempotentHint true survive onto every surface.",
    estimate: "45m",
    files: ["src/cli.ts", "src/mcp.ts"],
    verify: "npm run build",
    inputs: ["src/cli.ts"],
    expectedOutput: ["smoke-results.md"],
    requiredWorkflowTools: [],
  },
  {
    taskId: "T03",
    title: "Document vault-only token route in skill body and README/AGENTS",
    description: "Write the vault-only GROUPME_ACCESS_TOKEN route documentation into the skill body and README/AGENTS guidance: token only in X-Access-Token header, consumed via context().config, never in URLs, logs, errors, fixtures, or outputs. Verify with a grep of the docs and src for leaked token literals.",
    estimate: "30m",
    files: ["SKILL.md", "README.md", "AGENTS.md"],
    verify: "grep -ri token-leak-check src",
    inputs: ["ROADMAP.md"],
    expectedOutput: ["SKILL.md", "README.md", "AGENTS.md"],
    requiredWorkflowTools: [],
  },
  {
    taskId: "T04",
    title: "Report live OpenClaw runtime acceptance as externally blocked and overseer-owned",
    description: "Record on the workboard card that live OpenClaw runtime acceptance is externally blocked and overseer-owned, with the last successful mocked-suite evidence and the exact external blocker.",
    estimate: "15m",
    files: [],
    verify: "openclaw status",
    inputs: ["ROADMAP.md"],
    expectedOutput: [],
    requiredWorkflowTools: [],
  },
];
const results = [];
for (const t of tasks) {
  try {
    const r = await client.callTool({
      name: "gsd_plan_task",
      arguments: {
        projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
        milestoneId: "M001",
        sliceId: "S05",
        taskId: t.taskId,
        title: t.title,
        description: t.description,
        estimate: t.estimate,
        files: t.files,
        verify: t.verify,
        inputs: t.inputs,
        expectedOutput: t.expectedOutput,
        requiredWorkflowTools: t.requiredWorkflowTools,
      },
      _meta: { "io.opengsd/idempotency-key": idem + ":" + t.taskId },
    });
    results.push({ id: t.taskId, ok: !r.isError, head: JSON.stringify(r.content || r).slice(0, 160) });
  } catch (e) {
    results.push({ id: t.taskId, ok: false, err: String(e).slice(0, 200) });
  }
}
console.log("RESULTS=" + JSON.stringify(results));
await client.close();

