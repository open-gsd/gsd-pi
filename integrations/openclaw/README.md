# open-gsd-openclaw

[OpenClaw](https://docs.openclaw.ai) plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as a structured delivery engine. Plugin id `open-gsd-openclaw`, npm package `@opengsd/open-gsd-openclaw`.

The plugin serves GSD's existing web UI in **Control UI → Portals**, declares GSD's MCP server, and automatically synchronizes local GSD projects into OpenClaw's native project registry, TaskFlow, and optional Workboard. Gateway services own the web host and observe filesystem and session events. Registration and synchronization run in code, without skill instructions, agent bookkeeping, polling timers, or scheduled prompts. GSD owns execution and recovery.

## Install

Requires **OpenClaw 2026.9.2 or later** and `gsd-pi` installed on the MCP server's host.

```bash
openclaw plugins install npm:@opengsd/open-gsd-openclaw --pin
openclaw plugins enable open-gsd-openclaw
openclaw gateway restart
openclaw mcp doctor gsd --probe
```

The manifest launches `gsd-mcp-server`; it must resolve on the Gateway process PATH. Its GSD child must also resolve `gsd`. For explicit paths:

```bash
openclaw config set mcp.servers.gsd.command /absolute/path/to/gsd-mcp-server
openclaw config set mcp.servers.gsd.env.GSD_CLI_PATH /absolute/path/to/gsd
```

From a source checkout:

```bash
pnpm run build:integrations
openclaw plugins install --link /path/to/gsd-pi/integrations/openclaw --force
```

[Workboard](https://docs.openclaw.ai/plugins/workboard) is bundled but optional. Enable it for a board of ongoing objectives:

```bash
openclaw plugins enable workboard
openclaw gateway restart
```

Once Workboard is enabled, GSD cards appear automatically. No GSD plugin configuration is needed. Existing projects are reconciled when the Gateway starts, including when Workboard is enabled later.

## Native web UI portal

On Gateway startup the plugin opens a native portal titled **GSD**, then starts the existing GSD web host on IPv4 loopback with that portal's `PUBLIC_URL` and the selected `PORT`. Open **Control UI → Portals → GSD**. The app starts at its project picker; selecting a project uses GSD's own UI and APIs. Merely starting the portal does not start a coding run or select another builder's project.

The GSD installation is resolved from `mcp.servers.gsd.env.GSD_CLI_PATH`, or `gsd` on PATH. Packaged installs use `dist/web/standalone/server.js`. Source checkouts use their installed Next.js development server when the standalone build is absent. Build a production host with `pnpm run build:web-host` in the GSD checkout. The plugin does not install dependencies or build assets during Gateway startup.

Optional overrides belong under `plugins.entries.open-gsd-openclaw.config.webUi`:

```json
{
  "enabled": true,
  "packageRoot": "/absolute/path/to/gsd-pi",
  "port": 43120
}
```

All fields are optional. `enabled` defaults to true; the default port is available and dynamically selected. Set `enabled: false` to disable web hosting without disabling MCP or synchronization. Remove overrides to restore defaults.

The plugin owns only its child process and portal. It does not call `gsd --web`, open a browser, replace GSD's web-instance registry, or stop another server. Daemon mode keeps the host alive when a tab closes. Plugin service stop/reload terminates its child and closes its portal; a new Gateway lifetime creates a fresh portal. Closing a portal in the dashboard closes its proxy, not the host; restart the plugin service to recreate it. Failed startup closes the owned proxy and reports service failure rather than announcing a working UI.

The web host relies on native portal access control instead of a second application token, and binds only to `127.0.0.1`. Portal bearer URLs remain Gateway-owned and are not persisted or logged by the plugin. The public authenticated Gateway SDK client requests `operator.read` for `portal.list` and `operator.write` for open/close; it does not use the restricted in-process Gateway facade. These are operator-local services, not remote MCP/worker path translation.

Native portals use a separate listener port and origin. HTTP, Next assets, WebSockets and SSE pass through the native proxy without a custom base path. An HTTPS reverse proxy or tunnel exposing only the main Gateway port does **not** automatically expose portal ports. The dashboard checks reachability before embedding; if it offers retry guidance, the portal's separate listener needs a reachable route. A token-free `publicUrl` alone is not an authenticated launch link. See [OpenClaw Portals](https://docs.openclaw.ai/gateway/portals).

## Automatic discovery and synchronization

The integration discovers projects from GSD's existing `projects/*/repo-meta.json` registry under `GSD_STATE_DIR` or `GSD_HOME` (normally `~/.gsd`). It also observes OpenClaw agent workspaces, existing/bound session directories, and GSD tool calls for legacy projects with a local `.gsd` directory. Unknown legacy folders outside those sources are not scanned. Deleted or inaccessible locations remain unavailable; they are not completion evidence.

Filesystem events for GSD database/WAL and state projections trigger the public `gsd read snapshot --json` contract for database-backed projects, or `gsd read progress --json` for legacy Markdown state. An unreadable database does not fall back to stale Markdown. Repeated events coalesce while a read is in progress; no interval, polling loop, debounce timer, or automatic model turn is used to read progress. Filesystem event delivery is required; a missed event is repaired at Gateway restart or the next relevant event.

OpenClaw project registration requires a Git checkout with at least one commit; a denied or invalid registration is reported and retried on a later GSD event. The adapter does not initialize or commit repositories.

Each canonical GSD state directory gets one native project card and a managed TaskFlow record. Shared state across worktrees is deduplicated. TaskFlow persists bounded project paths, phase, task counts, current milestone/slice/task, and blocker summaries. It waits for external GSD events and succeeds when GSD reports phase `complete`. New work after completion gets a fresh flow and reuses the project card. Updates check native revision/version conflicts; failed writes are reported, not treated as completion.

Workboard status reflects the **workflow phase**: planning is `todo`, execution/verification is `running`, reported blockers are `blocked`, and GSD completion is `done`. These are workflow records, not proof that a worker process is alive or independent verification of the user's broader goal. There are no invented ACP/subagent task IDs or execution bindings. Archived cards remain untouched. The plugin owns the generated card's status and notes; put user discussion in Workboard comments.

Flows belong to the configured default agent's main session, which is the operator view for these host-local projects. Heartbeat receives current project facts through a native context-contribution hook. Significant state changes also enqueue factual system events and request a native heartbeat wake. This supplies data automatically; it does not inject a recovery procedure or modify the user's heartbeat instructions. Heartbeat enablement, delivery policy, and model availability remain OpenClaw settings.

[TaskFlow](https://docs.openclaw.ai/automation/taskflow) persists state but does not schedule or restart executions. [Tasks](https://docs.openclaw.ai/automation/tasks) is an execution ledger, and native automations own scheduled work. Merely writing a card or flow does not make the heartbeat a supervisor. This integration does not create recurring jobs or supervise or restart GSD coding executions. GSD retains its existing timeouts and sanctioned recovery. A silent hang that produces no event cannot be detected by this event-driven adapter.

Cancelling a TaskFlow cancels synchronization of that observation flow; it does **not** stop an external GSD process. Use `gsd_cancel` to stop execution and GSD's status/results to confirm it. The adapter never launches, cancels, or resumes coding work in response to a board move or flow cancellation. Cancelled flow records remain cancelled while retained by OpenClaw (terminal flows are normally pruned after seven days).

## Projects and managed worktrees

Use OpenClaw's Place picker to select a project or create an OpenClaw-managed worktree. Pass the actual selected execution directory to GSD. Automatic registration does not create a worktree, switch branches, or relocate running work.

GSD defaults to `git.isolation: none`, which uses the selected checkout's branch. Existing opt-in GSD milestone worktrees remain GSD-owned. Multiple worktrees may share canonical GSD state and are not independent authorization to start concurrent duplicate runs. Do not copy a live GSD database to provision another checkout.

This adapter observes state on the Gateway host. A remote MCP server or cloud execution place needs colocated state and a corresponding integration; paths are not automatically translated. See OpenClaw's [managed worktrees](https://docs.openclaw.ai/concepts/managed-worktrees).

## GSD tools

All tools come from `packages/mcp-server`; the plugin does not wrap them.

| Group | Tools |
| --- | --- |
| Run | `gsd_execute`, `gsd_status`, `gsd_result`, `gsd_cancel`, `gsd_resolve_blocker` |
| Read | `gsd_query`, `gsd_progress`, `gsd_roadmap`, `gsd_history`, `gsd_doctor`, `gsd_captures`, `gsd_knowledge`, `gsd_graph` |
| Plan / memory / recovery | Workflow tools such as `gsd_plan_milestone`, `gsd_task_complete`, `gsd_decision_save`, and `gsd_task_recovery_resume`, when the workflow bridge is available |

Workflow mutation tools are available automatically inside a gsd-pi monorepo checkout. Standalone servers require the documented workflow bridge configuration. See the [MCP server README](../../packages/mcp-server/README.md) for schemas, availability, and replay requirements.

## Tool policy and data access

OpenClaw's MCP tool policy and approvals govern GSD tool calls. Restrict tools with `mcp.servers.gsd.toolFilter.include` / `.exclude` or the session's **Connectors → Tool access** controls.

Automatic synchronization runs as a trusted installed plugin on the Gateway host. It reads the local GSD registry, configured/session checkouts, and GSD progress, then uses the public authenticated Gateway client. The client asks for `operator.read` only for project and card lists. OpenClaw 2026.9.2 declares `projects.register` as `operator.admin`; Workboard card writes ordinarily accept `operator.write`, but attaching an arbitrary discovered local directory is unrestricted only for `operator.admin`. The plugin therefore requests admin scope only for project registration and card create/update calls that carry those local workspaces. The Gateway must authorize those writes; the plugin does not bypass denials or write host databases directly. This local operator feature is separate from the permissions of a chat sender. Install it only where those local projects may appear in the operator's project list, board, TaskFlow, and heartbeat context.

`gsd_execute` currently does **not** apply `validateProjectDir`. An agent permitted to call it can launch GSD against any readable directory on the MCP host, using that process's credentials. Other `projectDir`-taking tools apply `GSD_WORKFLOW_PROJECT_ROOT` when configured. That variable is not confinement for `gsd_execute`; gate execution through tool policy and operator access. These are existing MCP server boundaries, not additional plugin permissions.

Progress, project titles, blockers, and final results are project-derived content and may be relayed to the user. No plugin redaction layer transforms them. Subprocess stderr is not copied into heartbeat context or general plugin logs.

## Runtimes and compatibility

The plugin targets OpenClaw 2026.9.2+ and uses only public plugin SDK/Gateway surfaces. Model/runtime choice stays with OpenClaw and GSD. The optional skill describes ordinary GSD tool usage; automatic discovery, native records, and heartbeat data do not depend on loading or following it.

The installed-host test verifies automatic creation/updates, restart deduplication, new-project discovery, optional Workboard, and native managed worktrees without model calls. It does not establish recovery from arbitrary silent hangs or remote placement.

If upgrading an earlier checkout of this PR, remove old `cliPath`, `projects`, `pollSeconds`, and `agentId` plugin configuration fields. Binary overrides belong to `mcp.servers.gsd`. Existing manually created follow-up jobs/cards are not silently deleted or adopted.

## Development

Use Node.js 24.16+ (within OpenClaw's supported Node versions) and pnpm 10.12.1 for dependency installation and integration tests. The development SDK requires this newer runtime; GSD's CLI smoke and SQLite checks still run on its Node.js 22.19 floor.

```bash
pnpm run build:integrations
OPENCLAW_BIN=/path/to/openclaw pnpm --filter @opengsd/open-gsd-openclaw test
```

Tests require OpenClaw 2026.9.2, built GSD core/MCP packages, and Git. They create temporary state, a temporary Git repository, and a local Gateway, and clean them up. They do not use the operator's OpenClaw configuration, connect channels, or make model calls.

The opt-in live portal proof uses the selected local Gateway and a fresh headless browser. It opens a temporary native portal, verifies token protection, the real GSD picker/assets/API and folder-browser interaction, then removes its portal and web host. It does not select a project or start coding. It requires Playwright in the GSD checkout and Chrome (`CHROME_BIN` overrides the executable), and writes token-free receipts under `validation/`:

```bash
OPENCLAW_BIN=/path/to/openclaw GSD_PORTAL_PACKAGE_ROOT=/path/to/gsd-pi node integrations/openclaw/test/portal-live.mjs
```

This local browser check does not establish remote HTTPS dashboard ingress or activation of new plugin code in a running Gateway.

Offline package inspection:

```bash
plugin-inspector ci --plugin-root integrations/openclaw --no-openclaw --runtime --mock-sdk --allow-execute
```

## License

MIT
