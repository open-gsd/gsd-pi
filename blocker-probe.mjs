
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
  name: "gsd_resolve_blocker",
  arguments: {
    projectDir: "/home/openclaw/.openclaw/projects/groupmetoolkit",
    sessionId: "01a16ba9-3b58-7799-99b7-2279a56d5e82",
    response: "Provider verified healthy by heartbeat 9:24 PM CDT Oct 23: openclaw secrets audit shows unresolved=0 (the UNQUANT ref resolves), the persistent heartbeat session itself is running on unquant/glm-5.3-flash and responding, and the transient connection error at 02:07Z has cleared. Note the earlier /tmp probe 401 used a SecretRef string as a bearer token (probe artifact, not a key failure); secrets audit confirms no unresolved refs. Proceed: Run /gsd auto after resolving the blocker.",
  },
  _meta: { "io.opengsd/idempotency-key": "pask-blocker-resolve-20261023-2140" },
});
console.log("RESOLVE=" + JSON.stringify(r.content || r).slice(0, 400));
await client.close();

