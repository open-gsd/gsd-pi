# open-gsd-openclaw

[OpenClaw](https://docs.openclaw.ai) plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as a structured delivery engine. Plugin id `open-gsd-openclaw`, npm package `@opengsd/open-gsd-openclaw`.

The plugin serves GSD's existing web UI in the **Control UI → GSD** tab, declares GSD's MCP server, and automatically synchronizes local GSD projects into OpenClaw's native project registry and optional Workboard. Gateway services own the web host and observe filesystem and session events. Registration and synchronization run in code, without skill instructions, agent bookkeeping, polling timers, or scheduled prompts. GSD owns execution and recovery.

## Install

Requires **OpenClaw 2026.9.7 or later** and `gsd-pi` installed on the MCP server's host.

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
openclaw config set mcp.servers.gsd.env.GSD_MCP_CLIENT_MANAGED '"1"'
```

The manifest sets `GSD_MCP_CLIENT_MANAGED=1` because OpenClaw owns its MCP
children and can open multiple connections in the same working directory.
Without this setting, GSD's per-project singleton registry can terminate another
connection's server, causing `Transport closed` errors. Keep the setting in
explicit `mcp.servers.gsd` overrides too; operator definitions replace manifest
defaults. It does not make execution durable across connection closure.

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

## Native web UI

On Gateway startup the plugin opens a native portal titled **GSD**, then starts the existing GSD web host on IPv4 loopback with that portal's `PUBLIC_URL` and the selected `PORT`. Open the **GSD** dashboard tab. The app starts at its project picker; selecting a project uses GSD's own UI and APIs. Merely starting the portal does not start a coding run or select another builder's project.

The GSD installation is resolved from `mcp.servers.gsd.env.GSD_CLI_PATH`, or `gsd` on PATH. Packaged installs use the prefixed app at `dist/web/standalone/openclaw/server.js`, sharing dependencies with the ordinary root-relative standalone host. Source checkouts use their installed Next.js development server when the compatible prefixed build is absent. Build production hosts with `pnpm run build:web-host` followed by `pnpm run build:web-host:openclaw` in the GSD checkout. Both variants are included in normal GSD releases; the ordinary standalone URL and saved settings are unchanged. The plugin does not install dependencies or build assets during Gateway startup.

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

The native tab and embedded RPC methods receive the host port only after its boot probe succeeds. Startup failure or child exit withdraws that port immediately; an unavailable host is not proxied through a reserved or cached dead listener.

The web host relies on native portal access control instead of a second application token, and binds only to `127.0.0.1`. Portal bearer URLs remain Gateway-owned and are not persisted or logged by the plugin. The public authenticated Gateway SDK client requests `operator.read` for `portal.list` and `operator.write` for open/close; it does not use the restricted in-process Gateway facade. These are operator-local services, not remote MCP/worker path translation.

During startup and synchronization, transport timeouts or transient connection closures on the four read-only catalog methods are retried at most twice, with a one-second delay between attempts. Each RPC retains its ten-second timeout; event-loop stalls can delay those timers. Authentication and policy failures are not retried. Mutations, including portal registration and closure, are never retried by this client; uncertain registration still follows the ownership reconciliation above. Gateway failures report the method and a fixed error category without copying RPC messages, credentials, URLs, or project paths into service health or host logs.

The dashboard tab uses an authenticated route on the main Gateway origin, including through its HTTPS reverse proxy or tunnel. Its sandboxed frame uses the native Control UI RPC bridge for application operations. The separately registered native portal has its own listener and access control; exposing only the Gateway port does not expose that optional portal listener. See [OpenClaw Portals](https://docs.openclaw.ai/gateway/portals).

## Automatic discovery and synchronization

The integration discovers projects from GSD's existing `projects/*/repo-meta.json` registry under `GSD_STATE_DIR` or `GSD_HOME` (normally `~/.gsd`). It also observes OpenClaw agent workspaces, existing/bound session directories, and GSD tool calls for legacy projects with a local `.gsd` directory. Unknown legacy folders outside those sources are not scanned. Deleted or inaccessible locations remain unavailable; they are not completion evidence.

Filesystem events for GSD database/WAL and state projections trigger the public `gsd read snapshot --json` contract for database-backed projects, or `gsd read progress --json` for legacy Markdown state. An unreadable database does not fall back to stale Markdown. Repeated events coalesce while a read is in progress; no interval, polling loop, debounce timer, or automatic model turn is used to read progress. Filesystem event delivery is required; a missed event is repaired at Gateway restart or the next relevant event.

OpenClaw project registration requires a Git checkout with at least one commit; a denied or invalid registration is reported and retried on a later GSD event. The adapter does not initialize or commit repositories.

Each canonical GSD state directory gets one native project card when Workboard is
enabled. Shared state across worktrees is deduplicated. A managed block in the
card's notes persists bounded project paths, phase, task counts, current
milestone/slice/task, blocker summaries, and whether authoritative state came
from the database. That provenance survives a restart, so a missing database
cannot silently fall back to stale Markdown. New work after completion reuses
the project card. Updates check the native card version; failed writes are
reported before notification or heartbeat context advances. Earlier cards'
embedded snapshots are read without accessing obsolete TaskFlow tables.

Workboard status reflects the **workflow phase**: planning is `todo`,
execution/verification is `running`, reported blockers are `blocked`, and GSD
completion is `done`. These are observations, not proof that a worker process
is alive or independent verification of the user's broader goal. No execution
binding is fabricated. Archived cards remain untouched. User notes outside the
managed block are preserved.

Heartbeat receives current project facts through a native context-contribution
hook in the system owner's configured heartbeat session (or main session when
none is configured). The owner follows `agents.defaults.systemAgent.agentId`;
an ambiguous multi-agent configuration without an owner fails closed.
Significant changes enqueue
factual system events and request a native heartbeat wake, after a successful
Workboard write. With Workboard disabled, the adapter keeps observations only in
memory and backfills cards when enabled again; it creates no replacement ledger.
Memory-only observations do not survive Gateway restarts. Heartbeat enablement,
delivery policy, and model availability remain OpenClaw settings.

Optional exact-project routes belong in plugin config:

```json
{
  "projectSessions": [
    { "projectDir": "/absolute/selected/checkout", "sessionKey": "agent:main:dashboard:oversight" }
  ]
}
```

These routes select the destination for that project's events and context only.
Use the canonical selected checkout path; unrelated paths retain the native
heartbeat destination. The agent is derived from the session key, not assumed to
be main. Invalid or duplicate routes are rejected; removal takes effect on
service restart. Routing does not change the destination's model or the native
heartbeat model, delivery, enablement, or cadence.

## Execution binding and connection lifetime

Always pass the selected absolute `projectDir` to GSD tools. OpenClaw's selected
model is not automatically GSD's provider configuration. Configure the GSD
provider catalog and per-phase project preferences separately, then use a
qualified `provider/model` for `gsd_execute`. Qualified overrides are selected
and read back through GSD's RPC API before the execution prompt; an unavailable
model or mismatched readback fails instead of starting on a default model.
This check establishes the initial model, not every later phase or subagent.
The headless host applies the same qualified-model check after optional session
restoration and before its first prompt, so a restored session cannot silently
override an explicitly requested provider.

`gsd_execute` is owned by its MCP connection. Closing that connection stops its
RPC child; reconnecting creates a new session manager, not a reattachment to the
old session ID. Client-managed mode prevents sibling eviction but does not
provide durable execution. Workflow rows and checkpoints can survive separately
from a process. Status from a new connection cannot prove an old worker is alive.

For work that must outlive an agent turn, use a supported long-lived host for
GSD, such as native background execution of `gsd headless --json auto`, and track
that host's actual process/result alongside GSD's database state. GSD headless
has its own bounded crash recovery; it is not an unlimited restart policy.
Resume only after inspecting current locks, attempts, blockers, and checkpoints.
Do not auto-resume intentional stops or claim that projection data proves a
running worker. The adapter itself remains an observer, not another scheduler.

### Protected credentials for a native background host

On OpenClaw hosts with protected secret egress, launch headless work through
native Gateway background exec/process tools. That process receives a
destination-bound sentinel, proxy environment and trusted CA bundle. Configure
GSD's `models.json` API key as the environment variable **name**, not the secret
value. Before launch, verify that the variable exists, the HTTPS origin is
bound to that secret, and the proxy/CA environment reaches the child. A missing
variable name alone is not a valid credential. Never print its value.

GSD's HTTP dispatcher honors the proxy environment. Protected egress does not
substitute secrets onto remote plain HTTP. Do not disable TLS checks, bypass the
proxy, reclassify a protected secret as an environment entry, or copy it into
MCP configuration or an auth file. Generic MCP `env` accepts scalar values,
not SecretRef objects. This observer plugin does not own the independent native
background process; resolving a SecretRef in a plugin service would not inject
it into that process. A trusted plugin-owned child can use the public
`openclaw/plugin-sdk/secret-input-runtime` API, but that is a different lifecycle
and is not a replacement for the native host's process grant.

For slow local-model prefills, set GSD's `httpIdleTimeoutMs` and
`retry.provider.timeoutMs` deliberately. The former defaults to five minutes
and supports `0` to disable header/body idle deadlines. The latter reaches the
provider SDK's request timeout (OpenAI defaults to ten minutes before response
headers); **zero does not disable that SDK timeout**. Use a positive,
operator-selected prefill deadline, retain cancellation, and verify the actual
HTTPS proxy/server's long-prefill and SSE behavior. Idle disabling alone cannot
extend the SDK or reverse proxy deadline.

Keep the model catalog's native output upper bound separate from a request's
output budget. For OpenAI-compatible completions, GSD omits `max_tokens` unless
`StreamOptions.maxTokens` is supplied, preserving the server's default. Explicit
overrides remain supported. OpenClaw's `params.maxTokens` is not a GSD settings
field. Advertised context is the combined prompt/output budget; catalog limits
do not prove usable concurrency or server overflow behavior.

The adapter creates no recurring jobs and never launches, cancels, or resumes
coding work in response to a board move. GSD owns execution and recovery. Use
`gsd_cancel` to stop execution and GSD's status/results to confirm it. Archiving
an observation card stops its synchronization; it does not stop an external GSD
process. A silent hang with no event cannot be detected by this event-driven
adapter.

## Projects and managed worktrees

Inside the OpenClaw dashboard, GSD lists **OpenClaw Settings → Projects**, using the native `projects.list` API with the current authenticated user's profile and scopes. It inspects each registered checkout itself, not its child directories, so ordinary repositories and registered Git worktrees need no `.gsd` directory to appear. Scope-redacted or inaccessible paths are not exposed. Add, rename, or remove projects in OpenClaw; reopening the picker reads the current registry.

Standalone GSD keeps its own saved development root and project discovery. Embedded browsing does not read or rewrite that setting, and GSD's root-selection and project-creation controls are replaced with guidance to manage projects in OpenClaw.

The embedded surface is administrator-only by default. `plugins.entries.open-gsd-openclaw.config.embeddedProjects.projects` is an optional narrowing list of `{ "projectId": "<native-id>", "canonicalRoot": "/canonical/checkout" }` entries. Omit it to use the native catalog; `[]` denies every project. Existing installations with a legacy list must remove it to see all native projects. Explicit entries never grant access to a project absent from the caller's native catalog. Non-admin access requires both `adminOnly: false` and an explicit list, plus native operator scopes exposing the paths.

The plugin declares `contracts.gatewayMethodDispatch: ["authenticated-request"]` for these RPC handlers; it never uses owner CLI credentials to expand the user's project access.

Use OpenClaw's Place picker to select a project or create an OpenClaw-managed worktree. Pass the actual selected execution directory to GSD. Automatic registration does not create a worktree, switch branches, or relocate running work.

GSD defaults to `git.isolation: none`, which uses the selected checkout's branch. Existing opt-in GSD milestone worktrees remain GSD-owned. Multiple worktrees may share canonical GSD state and are not independent authorization to start concurrent duplicate runs. Do not copy a live GSD database to provision another checkout.

This adapter observes state on the Gateway host. A remote MCP server or cloud execution place needs colocated state and a corresponding integration; paths are not automatically translated. See OpenClaw's [managed worktrees](https://docs.openclaw.ai/concepts/managed-worktrees).

## Embedded theme

The dashboard tab inherits OpenClaw's current light/dark mode and semantic colors, including live changes while the tab is open. This is a per-document override: it does not change GSD's saved theme or write host colors into GSD settings. Opening GSD outside the dashboard uses GSD's own saved preference. Embedded theme controls defer to the dashboard while that override is active.

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

Automatic synchronization runs as a trusted installed plugin on the Gateway host. It reads the local GSD registry, configured/session checkouts, and GSD progress, then uses the public authenticated Gateway client. The client asks for `operator.read` for plugin availability, project, and card lists. OpenClaw declares `projects.register` as `operator.admin`; Workboard card writes ordinarily accept `operator.write`, but attaching an arbitrary discovered local directory is unrestricted only for `operator.admin`. The plugin therefore requests admin scope only for project registration and card creation calls that attach those local workspaces. Status/notes updates request only `operator.write`. The Gateway must authorize those writes; the plugin does not bypass denials or write host databases directly. This local operator feature is separate from the permissions of a chat sender. Install it only where those local projects may appear in the operator's project list, board, and heartbeat context.

`gsd_execute` currently does **not** apply `validateProjectDir`. An agent permitted to call it can launch GSD against any readable directory on the MCP host, using that process's credentials. Other `projectDir`-taking tools apply `GSD_WORKFLOW_PROJECT_ROOT` when configured. That variable is not confinement for `gsd_execute`; gate execution through tool policy and operator access. These are existing MCP server boundaries, not additional plugin permissions.

Progress, project titles, blockers, and final results are project-derived content and may be relayed to the user. No plugin redaction layer transforms them. Subprocess stderr is not copied into heartbeat context or general plugin logs.

## Runtimes and compatibility

The plugin targets OpenClaw 2026.9.7+ and uses only public plugin SDK/Gateway surfaces. Model/runtime choice stays with OpenClaw and GSD. The optional skill describes ordinary GSD tool usage; automatic discovery, native records, and heartbeat data do not depend on loading or following it.

The installed-host test verifies automatic creation/updates, restart deduplication, new-project discovery, optional Workboard, and native managed worktrees without model calls. It does not establish recovery from arbitrary silent hangs or remote placement.

If upgrading an earlier checkout of this PR, remove old `cliPath`, `projects`, `pollSeconds`, and `agentId` plugin configuration fields. Binary overrides belong to `mcp.servers.gsd`. Existing manually created follow-up jobs/cards are not silently deleted or adopted.

## Development

Use Node.js 24.16+ (within OpenClaw's supported Node versions) and pnpm 10.12.1 for dependency installation and integration tests. The development SDK requires this newer runtime; GSD's CLI smoke and SQLite checks still run on its Node.js 22.19 floor.

```bash
pnpm run build:integrations
OPENCLAW_BIN=/path/to/openclaw pnpm --filter @opengsd/open-gsd-openclaw test
```

Tests require OpenClaw 2026.9.7 or newer, built GSD core/MCP packages, and Git. They create temporary state, a temporary Git repository, and a local Gateway, and clean them up. They do not use the operator's OpenClaw configuration, connect channels, or make model calls.

The packed-plugin browser acceptance test starts its own disposable Gateway with
native Control UI enabled. It proves native project registration, standalone
project/preferences independence, host theme inheritance and live updates,
sandboxed frame remount, browser activation, and owned web-host shutdown/restart.
It never uses the operator's Gateway, credentials, or channels. Build the web host
with its required routing prefix before running it:

```bash
pnpm run build:core
pnpm run build:integrations
pnpm run build:web-host
pnpm run build:web-host:openclaw
pnpm exec playwright install chromium
OPENCLAW_BIN=/path/to/openclaw node integrations/openclaw/test/browser-host.mjs
```

`CHROME_BIN` can select an existing Chromium executable. Sanitized receipts and
screenshots go to `integrations/openclaw/reports/browser-host/`, or
`GSD_BROWSER_EVIDENCE_DIR`. This is also the CI acceptance path. It does not prove
remote HTTPS ingress, which needs a separate final deployment check.

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
