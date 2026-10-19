# MCP-host smoke: gsd_progress and gsd_project_snapshot

Records MCP-host smoke evidence for the two canonical read tools (issue #2173, umbrella #2099), keeping host-configuration differences separate from GSD contract defects.

## Run the GSD-side probe first

The probe proves the server side before any host is involved. From a repo root with `pnpm install` done:

```sh
pnpm run build:core
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types scripts/mcp-host-smoke.mjs
```

`build:core` is required (not just `build:mcp-server`): the workflow-tool bridge warm-up loads the GSD runtime from the checkout's root `dist/`, and a fresh checkout has none.

- Exits 0 when the packaged server advertises both tools and their responses pass the current required-field, provenance, envelope, bounded-output, and parity assertions. Harmless additive fields are accepted.
- Pass `--project <absolute dir>` to probe a real project instead of the seeded fixture.
- If a response fails an assertion, treat it as a GSD server/probe-contract defect and preserve the named failure before changing host configuration. The probe does not claim that a host can start, discover, or correctly render the server.

## What the probe proves

The probe is evidence for one built `gsd-pi` MCP server process over stdio. It checks that:

- `gsd_progress` returns a valid JSON object with database provenance (`readMetadata.source: "database"` and `readMetadata.authority: "db-authoritative"`);
- `gsd_project_snapshot` returns the current authority fields, read operation, matching envelope revision, truncation metadata, 50-item output caps, and equal values in text and structured content (object key order is irrelevant); and
- MCP error envelopes, missing or malformed text, null payloads, array payloads, missing fields, and wrong field types fail with named nonzero checks.

This is server-side contract evidence only. It does not prove VS Code Copilot, Cursor, Claude Code, or Codex compatibility, and it does not prove snapshot atomicity, token-budget guarantees, or correctness of downstream consumer policy.

## Per-host checklist

For each host below: use the config snippet against a local build (`pnpm run build:core`), then record results in the template at the bottom. Replace `<repo>` with the absolute path to your gsd-pi checkout.

### VS Code Copilot

- Config: `.vscode/mcp.json` in the workspace:

```json
{
  "servers": {
    "gsd": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/cli.js"]
    }
  }
}
```

- Start: reload window, open Copilot Chat → tools/tools-picker, confirm `gsd` tools appear after approval.
- Invoke: ask Copilot "show GSD project progress", then "show the full project snapshot"; confirm the tool calls run and answers reflect DB state (active milestone/slice/task, blockers, next action).

### Cursor

- Config: `~/.cursor/mcp.json` with the same `mcpServers.gsd` shape (`command: "node"`, `args: ["<repo>/packages/mcp-server/dist/cli.js"]`).
- Start: Cursor Settings → MCP → confirm `gsd` listed and tools discovered.
- Invoke: in agent mode, request project progress, then the project snapshot; confirm both tool invocations succeed.

### Claude Code

- Config: `claude mcp add gsd -- node <repo>/packages/mcp-server/dist/cli.js`
- Start: `/mcp` — confirm the `gsd` server connects and lists tools.
- Invoke: "use the gsd_progress tool" and "use gsd_project_snapshot"; confirm structured results render.

### Codex

- Config: `~/.codex/config.toml`:

```toml
[mcp_servers.gsd]
command = "node"
args = ["<repo>/packages/mcp-server/dist/cli.js"]
```

- Start: new Codex session; confirm the server connects (no startup warnings).
- Invoke: request project progress, then the project snapshot; confirm both calls succeed.

## Classification rules

- Probe green + host failure → investigate the host route or host-specific configuration; record the observed host and version here rather than treating the probe as host-E2E evidence.
- Probe failure → investigate the named GSD server/probe contract failure first; do not work around it in host config.
- A host that cannot run stdio servers in your configuration → record that explicitly; never silently omit the host.

## Results template

Attach per host to issue #2173:

```text
Host: <name> <version>
Config mode: <snippet used, verbatim>
Probe result at time of run: <pass/fail + date>
- Discovery: gsd_progress <yes/no>, gsd_project_snapshot <yes/no>
- Invocation gsd_progress: <pass/fail + observed phase/active refs>
- Invocation gsd_project_snapshot: <pass/fail + revision + milestone count>
- Deviations from expected observations: <none / details>
Classification: <host-config | GSD-defect | n/a — all passed>
```
