import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js"],
  cwd: "/home/openclaw/.openclaw/projects/groupmetoolkit",
  env: { ...process.env, GSD_CLI_PATH: "/home/openclaw/.openclaw/projects/gsd-pi/dist/cli.js", GSD_VERSION: "1.21.1" },
});
const client = new Client({ name: "pask-heartbeat", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({
  name: "gsd_execute",
  arguments: { projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit" },
});
console.log("EXEC=" + JSON.stringify(r.content || r).slice(0, 600));
// Keep the client connection open for the lifetime of the spawned agent
// (lifetime=client-connection): poll the process list until no gsd agent remains.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const run = promisify(execFile);
let alive = true;
let waited = 0;
while (alive && waited < 6 * 3600 * 1000) {
  await new Promise((res) => setTimeout(res, 60 * 1000));
  waited += 60 * 1000;
  try {
    const { stdout } = await run("pgrep", ["-f", "gsd.*auto|dist/cli.js"]);
    alive = stdout.trim().length > 0;
  } catch {
    alive = false; // pgrep exit 1 = no match
  }
}
console.log("AGENT_DONE waited_ms=" + waited);
await client.close();
