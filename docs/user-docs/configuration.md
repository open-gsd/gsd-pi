# Configuration

GSD preferences live in `~/.gsd/PREFERENCES.md` (global) or `.gsd/PREFERENCES.md` (project-local). Manage interactively with `/gsd prefs`.

## `/gsd prefs` Commands

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Open the global preferences wizard (default) |
| `/gsd prefs global` | Interactive wizard for global preferences (`~/.gsd/PREFERENCES.md`) |
| `/gsd prefs project` | Interactive wizard for project preferences (`.gsd/PREFERENCES.md`) |
| `/gsd prefs status` | Show current preference files, merged values, and skill resolution status |
| `/gsd prefs wizard` | Alias for `/gsd prefs global` |
| `/gsd prefs setup` | Alias for `/gsd prefs wizard` — creates preferences file if missing |
| `/gsd prefs import-claude` | Import Claude marketplace plugins and skills as namespaced GSD components |
| `/gsd prefs import-claude global` | Import to global scope |
| `/gsd prefs import-claude project` | Import to project scope |

## Preferences File Format

Preferences use YAML frontmatter in a markdown file:

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
skill_discovery: suggest
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 50.00
token_profile: balanced
---
```

To opt a project into the staged project-level discovery flow, add:

```yaml
planning_depth: deep
```

## Global vs Project Preferences

| Scope | Path | Applies to |
|-------|------|-----------|
| Global | `~/.gsd/PREFERENCES.md` | All projects |
| Project | `.gsd/PREFERENCES.md` | Current project only |

**Merge behavior:**
- **Scalar fields** (`skill_discovery`, `budget_ceiling`): project wins if defined
- **Array fields** (`always_use_skills`, etc.): concatenated (global first, then project)
- **Object fields** (`models`, `git`, `auto_supervisor`): shallow-merged, project overrides per-key

### Invalid or malformed preferences

Preference loading never throws. When a `PREFERENCES.md` file is malformed or contains invalid settings, GSD keeps running with safe defaults but attaches diagnostics so the problem is visible instead of silently ignored:

- **Parse failures** (missing closing `---` delimiter, YAML syntax error, unrecognized format) cause the whole file to be ignored. GSD normally falls back to a valid global or legacy preferences file. If a malformed project file attempts to configure `runtime.contract`, runtime operations fail closed instead of falling back to another contract.
- **Invalid settings** (unknown keys, type mismatches) are sanitized or dropped; the remaining valid settings in the file still apply.

Diagnostics surface through session-start notifications, `/gsd doctor` (with file path and, for YAML errors, line and column), and auto-mode preflight. See [Troubleshooting](./troubleshooting.md#preferences-file-ignored-or-settings-not-taking-effect).

## Project-local runtime contract

Projects can publish authoritative local-runtime instructions at `script/local-runtime/`, or nominate another project-local path in `.gsd/PREFERENCES.md`:

```yaml
---
runtime:
  contract:
    path: ops/dev
    entry: run.mjs
---
```

`path` is relative to the active project or worktree root. `entry` is relative to the contract directory. Both must remain within their respective roots, and this setting is project-only: a global `runtime.contract` is never inherited. See [Project-local runtime contract](./local-runtime-contract.md) for discovery priority, document limits, subagent propagation, and failure behavior.

## Global API Keys (`/gsd config`)

Tool API keys are stored globally in `~/.gsd/agent/auth.json` and apply to all projects automatically. Set them once with `/gsd config` — no need to configure per-project `.env` files.

```bash
/gsd config
```

This opens an interactive wizard showing which keys are configured and which are missing. Select a tool to enter its key.

### Supported keys

| Tool | Environment Variable | Purpose | Get a key |
|------|---------------------|---------|-----------|
| Tavily Search | `TAVILY_API_KEY` | Web search for non-Anthropic models | [tavily.com/app/api-keys](https://tavily.com/app/api-keys) |
| Brave Search | `BRAVE_API_KEY` | Web search for non-Anthropic models | [brave.com/search/api](https://brave.com/search/api) |
| Context7 Docs | `CONTEXT7_API_KEY` | Library documentation lookup | [context7.com/dashboard](https://context7.com/dashboard) |

### How it works

1. `/gsd config` saves keys to `~/.gsd/agent/auth.json`
2. On every session start, `loadToolApiKeys()` reads the file and sets environment variables
3. Keys apply to all projects — no per-project setup required
4. Environment variables (`export BRAVE_API_KEY=...`) take precedence over saved keys
5. Anthropic models don't need Brave/Tavily — they have built-in web search

## MCP Servers

GSD can connect to external MCP servers configured in project files. This is useful for local tools, internal APIs, self-hosted services, or integrations that aren't built in as native GSD extensions.

### Config file locations

GSD reads MCP client configuration from these project-local paths:

- `.mcp.json`
- `.gsd/mcp.json`

If both files exist, server names are merged and the first definition found wins. Use:

- `.mcp.json` for repo-shared MCP configuration you may want to commit
- `.gsd/mcp.json` for local-only MCP configuration you do **not** want to share

For existing GSD projects, GSD also auto-prepares the repo-shared `.mcp.json` on session startup. The auto-prep runs regardless of the selected model provider, but only when the project root already contains `.gsd/`; non-GSD repositories are left untouched. It writes the managed `gsd-workflow` entry and, unless `GSD_BROWSER_MCP_ENABLED=0`, the managed `gsd-browser` entry for external MCP clients such as Claude Code.

### Supported transports

| Transport | Config shape | Use when |
|-----------|--------------|----------|
| `stdio` | `command` + optional `args`, `env`, `cwd` | Launching a local MCP server process |
| `http` | `url` | Connecting to an already-running MCP server over HTTP |

### Example: stdio server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "API_URL": "http://localhost:8000"
      }
    }
  }
}
```

### Example: gsd-browser MCP server

Use `gsd-browser` when GSD or an external MCP client needs deterministic browser automation, versioned element refs, assertions, screenshots, visual diffs, recordings, or a live human takeover viewer.

GSD Pi Providers such as Codex and non-Claude harnesses do not need an external
MCP entry to use browser automation. Browser-facing projects prefer the managed
`@opengsd/gsd-browser` engine when it is available and starts cleanly, then fall
back to Playwright; non-browser-facing projects use Playwright unless you force
the managed engine. The easiest way to write the external MCP entry is:

```bash
/gsd mcp init
```

If you prefer to maintain the MCP entry manually, add:

```json
{
  "mcpServers": {
    "gsd-browser": {
      "command": "gsd-browser",
      "args": ["mcp", "--session", "gsd-my-project", "--identity-scope", "project", "--identity-key", "my-project", "--identity-project", "my-project"]
    }
  }
}
```

`--identity-key` and `--identity-project` are stable project identifiers (not filesystem paths) — they may not contain path separators.

Set `GSD_BROWSER_MCP_EXTRA_ARGS` to forward extra flags to the launched `gsd-browser` daemon without hand-editing `.mcp.json` args. It accepts a plain command-line string (`--stealth --browser-path /usr/bin/chromium`) or a JSON array (`["--stealth"]`), and the flags are appended after the managed session/identity flags for both the MCP server entry and the daemon-start warm-up. Use this in environments where Chrome needs extra launch flags — for example, containers with unprivileged user namespaces disabled (Ubuntu 23.10+, many CI runners), where Chrome's sandbox refuses to start; there, `GSD_BROWSER_MCP_EXTRA_ARGS=--stealth` supplies Chrome's `--no-sandbox`.

Keep this in `.gsd/mcp.json` when browser paths, vault settings, or session state are machine-local. Use `.mcp.json` only when the team should share the same server entry. Set `GSD_BROWSER_MCP_ENABLED=0` only to skip writing the external MCP entry; it does not disable Pi browser tools. Browser-facing projects automatically prefer the managed `gsd-browser` engine when it is available and starts cleanly, falling back to Playwright otherwise. Use `GSD_BROWSER_ENGINE=gsd-browser` to force the managed engine, `GSD_BROWSER_ENGINE=playwright` (or `legacy`) to force the Playwright engine, or `GSD_BROWSER_ENGINE=off` to disable Pi browser tools.

### Example: HTTP server

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Verifying a server

After adding config, verify it from a GSD session:

```text
mcp_servers
mcp_discover(server="my-server")
mcp_call(server="my-server", tool="<tool_name>", args={...})
```

Recommended verification order:

1. `mcp_servers` — confirms GSD can see the config file and parse the server entry
2. `mcp_discover` — confirms the server process starts and responds to `tools/list`
3. `mcp_call` — confirms at least one real tool invocation works

### Notes

- Use absolute paths for local executables and scripts when possible.
- For `stdio` servers, prefer setting required environment variables directly in the MCP config instead of relying on an interactive shell profile.
- GSD and `gsd-mcp-server` both hydrate supported model and tool keys saved in `~/.gsd/agent/auth.json`, so MCP configs can safely reference them through `${ENV_VAR}` placeholders without committing raw credentials.
- MCP server runtime variables such as `GSD_WORKFLOW_EXECUTORS_MODULE`, `GSD_WORKFLOW_WRITE_GATE_MODULE`, `GSD_WORKFLOW_PROJECT_ROOT`, `GSD_CLI_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` cannot be set through `secure_env_collect`; configure them explicitly in the operator environment or MCP config.
- When `secure_env_collect` writes to a local dotenv file, the accepted keys are also hydrated into the current MCP server process. When it pushes to Vercel or Convex, the values are sent to the remote destination only and are not added to `process.env`.
- If a server is team-shared and safe to commit, `.mcp.json` is usually the better home.
- If a server depends on machine-local paths, personal services, or local-only secrets, prefer `.gsd/mcp.json`.
- For the built-in `gsd-workflow` server, set `GSD_WORKFLOW_PROJECT_ROOT` to the canonical project root when launching from a worktree or wrapper. The packaged server uses it for workflow tool paths and the per-project stale-process registry at `$GSD_HOME/mcp-instances.json`.
- The packaged `gsd-workflow` MCP server exposes canonical workflow tool names by default. Set `GSD_MCP_ADVERTISE_ALIASES=1` only for clients that still call legacy alias names. Native in-process GSD tools use `GSD_ADVERTISE_TOOL_ALIASES=1` instead.
- Custom clients calling `gsd_plan_milestone`, `gsd_plan_slice`, `gsd_plan_task`, `gsd_replan_slice`, `gsd_replan_task`, `gsd_reassess_roadmap`, or `gsd_task_recovery_resume` must send a nonblank private `_meta["io.opengsd/idempotency-key"]` value and reuse it for retries. This is transport metadata, not a public tool parameter; missing identity fails before mutation.
- Claude Code sessions that require GSD workflow tools are fail-closed: GSD preflights the same inline `mcpServers.gsd-workflow` entry passed to the Claude SDK, and if `gsd-workflow` is absent, still pending, failed, disabled, missing required tools at startup, or cannot be probed, GSD aborts the unit before the first model turn and retries instead of allowing tool calls against an incomplete surface. Timeout diagnostics include the last MCP probe error when available.

### Per-Model MCP Filtering

Small-context models (e.g. Claude Haiku) suffer prompt-size blowouts when every available MCP server is announced to them. A subagent that only needs `gsd-workflow` does not need the 28 other servers in the prompt. GSD lets you restrict, per model, which MCP servers are exposed to the SDK by configuring `claude_code_mcp.per_model` in `.gsd/PREFERENCES.md`.

#### YAML shape

The block lives in the YAML frontmatter of `.gsd/PREFERENCES.md` under `claude_code_mcp.per_model`. Each key is a **model-ID prefix**; each value has optional `allowed_servers` and `blocked_servers` arrays of MCP server names:

```yaml
claude_code_mcp:
  per_model:
    <model-prefix>:
      allowed_servers: [server-a, server-b]
      blocked_servers: [server-c]
```

Both fields are optional. A model with no matching prefix gets the unfiltered set.

#### Longest-prefix-wins matching

Keys are matched against the active model ID by prefix; when multiple keys match, the **longest matching prefix wins** (longest-prefix-wins). This lets you set a coarse default for a model family and override it for a specific variant without tracking every date-stamped ID:

| Model ID at runtime           | Keys configured                       | Winner             |
|-------------------------------|---------------------------------------|--------------------|
| `claude-haiku-4-5-20251001`   | `claude-haiku`, `claude-haiku-4-5`    | `claude-haiku-4-5` |
| `claude-haiku-3-5-20241022`   | `claude-haiku`, `claude-haiku-4-5`    | `claude-haiku`     |
| `claude-sonnet-4-6-20250101`  | `claude-haiku`                        | (no match)         |

#### Resolution order: allowlist-first, blocklist-removes

When `allowed_servers` is present, only those servers (plus the implicit `gsd-workflow` allow described below) are exposed; everything else is blocked. `blocked_servers` then removes entries from the resulting set. On overlap, **the blocklist wins** — a server listed in both `allowed_servers` and `blocked_servers` is blocked.

| `allowed_servers` | `blocked_servers` | Effective exposure                                                |
|-------------------|-------------------|-------------------------------------------------------------------|
| absent / empty    | absent / empty    | All discovered servers exposed                                    |
| `[a, b]`          | absent / empty    | Only `a`, `b`, and `gsd-workflow`                                 |
| absent / empty    | `[c]`             | All discovered servers except `c`                                 |
| `[a, b]`          | `[b]`             | Only `a` and `gsd-workflow` (`b` removed by blocklist)            |

Blocking is implemented two ways depending on how the server arrives: user MCPs loaded by the SDK from `.mcp.json` / `.claude/settings.json` are blocked via `disallowedTools` patterns (`mcp__<name>__*`); the `gsd-workflow` server, which GSD controls directly, is dropped from the `mcpServers` map when explicitly blocked.

#### `gsd-workflow` implicit allow

GSD's own workflow MCP server (`gsd-workflow`) is **always allowed**, even when not listed in `allowed_servers`, because the GSD engine itself depends on it. The only way to remove `gsd-workflow` from a model's exposure is to name it explicitly in `blocked_servers`. Do this only if you understand that auto-mode tooling on that model will stop working.

#### Worked example

A Haiku subagent that only needs `gsd-workflow` and a single search MCP, and a Sonnet model that has everything except a noisy analytics server:

```yaml
claude_code_mcp:
  per_model:
    claude-haiku-4-5:
      allowed_servers:
        - google-search
      # gsd-workflow is allowed implicitly; no need to list it.
    claude-sonnet-4-6:
      blocked_servers:
        - analytics-noisy
```

With this configuration, a Haiku-4-5 subagent sees only `gsd-workflow` and `google-search` regardless of how many servers `.mcp.json` defines; a Sonnet-4-6 session sees every discovered server except `analytics-noisy`. Other models match no prefix and are unaffected.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_HOME` | `~/.gsd` | Global GSD directory. All paths derive from this unless individually overridden. Affects preferences, skills, sessions, and per-project state. |
| `GSD_PROJECT_ID` | (auto-hash) | Override the automatic project identity hash. Per-project state goes to `$GSD_HOME/projects/<GSD_PROJECT_ID>/` instead of the computed hash. Useful for CI/CD or sharing state across clones of the same repo. |
| `GSD_STATE_DIR` | `$GSD_HOME` | Per-project state root. Controls where `projects/<repo-hash>/` directories are created. Takes precedence over `GSD_HOME` for project state. |
| `GSD_CODING_AGENT_DIR` | `$GSD_HOME/agent` | Agent directory containing managed resources, extensions, and auth. Takes precedence over `GSD_HOME` for agent paths. |
| `GSD_WORKFLOW_PROJECT_ROOT` | current working directory | Canonical project root for the packaged `gsd-workflow` MCP server. Used by workflow tools and by the stale-process registry key in `$GSD_HOME/mcp-instances.json`. |
| `GSD_WORKFLOW_EXECUTORS_MODULE` | auto-discovered when possible | Optional absolute path or `file:` URL for the shared workflow executor module used by `gsd-workflow` mutation tools. |
| `GSD_WORKFLOW_WRITE_GATE_MODULE` | auto-discovered when possible | Optional absolute path or `file:` URL for the shared write-gate module used by `gsd-workflow` mutation tools. |
| `GSD_MCP_ADVERTISE_ALIASES` | (unset) | Set to literal `1` to include legacy workflow aliases in the packaged `gsd-workflow` MCP server's `tools/list`. Unset keeps the MCP surface canonical-only to avoid duplicate schemas. |
| `GSD_MCP_HIDE_ALIASES` | (unset) | Legacy force-hide switch. Set to literal `1` to keep packaged MCP aliases hidden even when `GSD_MCP_ADVERTISE_ALIASES=1`. |
| `GSD_ADVERTISE_TOOL_ALIASES` | (unset) | Set to literal `1` to register legacy workflow aliases on the native in-process GSD tool surface, including `gsd --mode mcp`. This does not affect `gsd-workflow`; use `GSD_MCP_ADVERTISE_ALIASES` for the packaged MCP server. |
| `GSD_CURSOR_DISABLE` | (unset) | Set to literal `1` to disable the bundled `cursor-agent` model provider. |
| `GSD_CURSOR_DEBUG` | (unset) | Set to any value to print Cursor Agent readiness probe diagnostics to stderr. |
| `CURSOR_AGENT_BIN` | `cursor-agent` | Optional command or absolute path for the Cursor Agent CLI when it is not on `PATH`. |
| `CURSOR_API_KEY` | (none) | Auth signal for the `cursor-agent` provider. GSD still requires the local `cursor-agent` CLI because requests run through the CLI. |
| `GSD_ALLOWED_COMMAND_PREFIXES` | (built-in list) | Comma-separated command prefixes allowed for `!command` value resolution. Overrides `allowedCommandPrefixes` in settings.json. See [Custom Models — Command Allowlist](custom-models.md#command-allowlist). |
| `GSD_FETCH_ALLOWED_URLS` | (none) | Comma-separated hostnames exempted from `fetch_page` URL blocking. Overrides `fetchAllowedUrls` in settings.json. See [URL Blocking](#url-blocking-fetch_page). |
| `GSD_WEB_AUTH_TOKEN` | generated by `gsd --web` unless auth is disabled | Local web bearer token required on `/api/*` requests. |
| `GSD_WEB_HOST` | `127.0.0.1` | Web server host used for local origin checks. Usually set by `gsd --web --host`. |
| `GSD_WEB_PORT` | `3000` | Web server port used for local origin checks. Usually set by `gsd --web --port`. |
| `GSD_WEB_ALLOWED_ORIGINS` | (none) | Comma-separated extra origins allowed by the local web bearer-token proxy. Usually set by `gsd --web --allowed-origins`. |
| `GSD_WEB_PROJECT_CWD` | — | Default local project path for `gsd --web` when `?project=` is not specified. |
| `GSD_WEB_NO_AUTH` | (unset) | Set to `1` to disable the built-in web bearer token gate on loopback hosts. Non-loopback hosts are refused unless `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` is also set. |
| `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN` | (unset) | Set to `1` to explicitly allow unauthenticated web mode on non-loopback hosts. This exposes terminal and file APIs unless trusted external access control is in place. |
| `SCREENSHOT_MAX_WIDTH` | `1568` | Maximum width, in pixels, for inline image payloads returned by `browser_screenshot` and `mac_screenshot`. Oversized screenshots are downscaled with aspect ratio preserved. Set to `0` to disable the width cap and return raw width. |
| `SCREENSHOT_MAX_HEIGHT` | `8000` | Maximum height, in pixels, for inline image payloads returned by `browser_screenshot` and `mac_screenshot`. Oversized screenshots are downscaled with aspect ratio preserved. Set to `0` to disable the height cap and return raw height. |
| `PI_DISABLE_SYNC_OUTPUT` | (unset) | Set to literal `1` to disable synchronized terminal output mode in the TUI on non-Windows platforms. By default synchronized output is enabled on macOS/Linux and always disabled on Windows. |
| `PI_TUI_MOUSE` | (unset) | Set to literal `1` to enable terminal mouse reporting for TUI clicks and wheel events. Native drag selection is preserved by default; when mouse reporting is enabled, most terminals require Shift+drag to select text. |
| `PI_TOKEN_TELEMETRY` | (unset) | Set to literal `1` to emit opt-in per-call token telemetry as JSONL on stderr. Other values are ignored. |
| `GSD_TOOL_LOOP_GUARD_ENABLED` | (from preferences) | Master switch for the tool-call loop guard. `true`/`false`. Overrides `tool_call_loop_guard.enabled`. |
| `GSD_TOOL_LOOP_IDENTICAL_MAX` | (from preferences) | Max consecutive identical-args calls before the guard trips. Overrides `tool_call_loop_guard.identical_args.max_consecutive_calls`. |
| `GSD_TOOL_LOOP_REPEATED_DEFAULT_CAP` | (from preferences) | Per-turn per-tool cap for ordinary tools. Overrides `tool_call_loop_guard.repeated_tool.default_cap`. |
| `GSD_TOOL_LOOP_REPEATED_REPEATABLE_CAP` | (from preferences) | Per-turn per-tool cap for inherently repeatable tools. Overrides `tool_call_loop_guard.repeated_tool.repeatable_cap`. |
| `GSD_TOOL_LOOP_EXEMPT_TOOLS` | (from preferences) | Comma-separated tool names exempted from the per-tool cap. Added to the built-in exempt defaults and any `tool_call_loop_guard.repeated_tool.exempt_tools`. |

How to set `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN` (copy-paste for each OS family):

```bash
# POSIX shell (bash, zsh)
export GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1
gsd --web --host 0.0.0.0 --no-auth
```

```powershell
# PowerShell
$env:GSD_WEB_ALLOW_UNAUTHENTICATED_LAN="1"
gsd --web --host 0.0.0.0 --no-auth
```

```bat
REM CMD
set GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1
gsd --web --host 0.0.0.0 --no-auth
```

### Developer and test environment variables

These are for contributors debugging locally or running specific test tiers — not for normal use. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

| Variable | Scope | Description |
|----------|-------|-------------|
| `GSD_DEBUG` | dev | Set to `1` to enable verbose diagnostic tracing (`debugLog`) across the CLI and extensions. |
| `GSD_STARTUP_TIMING` | dev | Set to `1` to print startup phase timings from the loader (alias of `PI_TIMING`). |
| `GSD_TEST_CLONE_MARKETPLACES` | test | Set to `1` to enable clone-based marketplace fixtures used by `pnpm run test:marketplace`. |
| `GSD_LIVE_TESTS` | test | Set to `1` (done automatically by `pnpm run test:live`) to run live provider/network tests. |
| `GSD_SMOKE_BINARY` | test | Path to the built binary the smoke/e2e suite should exercise (e.g. `dist/loader.js`). |

### Token Telemetry

Set `PI_TOKEN_TELEMETRY=1` when you need raw per-call token and cache data for cost analysis or prompt-cache tuning. The stream is off by default and writes to stderr, so stdout remains available for the TUI or for headless `--json` events.

```bash
# Capture telemetry separately from headless JSONL events
PI_TOKEN_TELEMETRY=1 gsd headless --json auto \
  > gsd-events.jsonl \
  2> token-telemetry.jsonl

# Capture telemetry from an interactive session
PI_TOKEN_TELEMETRY=1 gsd 2> token-telemetry.jsonl
```

Each line is one JSON object with this shape:

| Field | Description |
|-------|-------------|
| `ts` | Assistant message timestamp in milliseconds since Unix epoch. |
| `model` | Model identifier used for the call. |
| `stopReason` | Provider stop reason recorded for the assistant message, such as `stop` or `error`. |
| `input` | Input tokens reported for the call, excluding tokens served from prompt cache. |
| `output` | Output tokens reported for the call. |
| `cacheRead` | Input tokens read from prompt cache. |
| `cacheWrite` | Input tokens written to prompt cache. |
| `costTotal` | Provider total cost from the model registry. This is `0` when no rate is known for the model. |
| `cacheHitRatio` | `cacheRead / (cacheRead + input)`. This is `0` when both values are zero and `1` for a full cache hit. |

Telemetry is emitted per assistant API attempt, not per user turn. If a provider call records an error and auto-retry runs, the failed attempt can produce a line with `stopReason: "error"`, and each retry attempt that reaches an assistant message produces its own line. Keep all lines for billed-attempt accounting; group with session logs or timestamps downstream if you need a deduplicated final-response view.

### Ollama

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL. A bare `host:port` value is treated as `http://host:port`. |
| `OLLAMA_API_KEY` | (none) | Bearer token for remote or cloud Ollama endpoints. Local Ollama ignores this header. |
| `OLLAMA_PROBE_TIMEOUT_MS` | `1500` | Startup health-check timeout in milliseconds. Unset, empty, non-numeric, zero, or negative values fall back to the default. Values above `2147483647` ms are capped to Node.js's maximum timer delay. |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `10000` | Per-request REST timeout in milliseconds. Unset, empty, non-numeric, zero, or negative values fall back to the default. Values above `2147483647` ms are capped to Node.js's maximum timer delay. |

## All Settings

### `models`

Per-phase model selection. Each key accepts a model string or an object with fallbacks.

```yaml
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6
  subagent: claude-sonnet-4-6
```

**Phases:** `research`, `planning`, `discuss`, `execution`, `execution_simple`, `completion`, `validation`, `subagent`, `uat`

- `execution_simple` — used for tasks classified as "simple" by the [complexity router](./token-optimization.md#complexity-based-task-routing)
- `subagent` — model for delegated subagent tasks (scout, researcher, worker)
- Provider targeting: use `provider/model` format (e.g., `bedrock/claude-sonnet-4-6`) or the `provider` field in object format
- Omit a key to use whatever model is currently active

### Custom Model Definitions (`models.json`)

Define custom models and providers in `~/.gsd/agent/models.json`. This lets you add models not included in the default registry — useful for self-hosted endpoints (Ollama, vLLM, LM Studio), fine-tuned models, proxies, or new provider releases.

GSD resolves models.json with fallback logic:
1. `~/.gsd/agent/models.json` — primary (GSD)
2. `~/.pi/agent/models.json` — fallback (Pi)
3. If neither exists, creates `~/.gsd/agent/models.json`

**Quick example for local models (Ollama):**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The file reloads each time you open `/model` — no restart needed.

For full documentation including provider configuration, model overrides, OpenAI compatibility settings, and advanced examples, see the [Custom Models Guide](./custom-models.md).

**With fallbacks:**

```yaml
models:
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
    provider: bedrock    # optional: target a specific provider
```

When a model fails to switch (provider unavailable, rate limited, credits exhausted), GSD automatically tries the next model in the `fallbacks` list.

### Community Provider Extensions

For providers not built into GSD, community extensions can add full provider support with proper model definitions, thinking format configuration, and interactive API key setup.

| Extension | Provider | Models | Install |
|-----------|----------|--------|---------|
| [`pi-dashscope`](https://www.npmjs.com/package/pi-dashscope) | Alibaba DashScope (ModelStudio) | Qwen3, GLM-5, MiniMax M2.5, Kimi K2.5 | `gsd install npm:pi-dashscope` |

Community extensions are recommended over the built-in `alibaba-coding-plan` provider for DashScope models — they use the correct OpenAI-compatible endpoint and include per-model compatibility flags for thinking mode.

### `token_profile`

Coordinates model selection, phase skipping, and context compression. See [Token Optimization](./token-optimization.md).

Values: `budget`, `balanced` (default), `quality`

| Profile | Behavior |
|---------|----------|
| `budget` | Skips research + reassessment phases, uses cheaper models |
| `balanced` | Default behavior — all phases run, standard model selection |
| `quality` | All phases run, prefers higher-quality models |

### `phases`

Fine-grained control over which phases run in auto mode:

```yaml
phases:
  skip_research: false        # skip milestone-level research
  skip_reassess: false        # skip roadmap reassessment after each slice
  skip_slice_research: true   # skip per-slice research
  reassess_after_slice: true  # enable roadmap reassessment after each slice (required for reassessment)
  require_slice_discussion: false  # pause auto-mode before each slice for discussion
```

These are usually set automatically by `token_profile`, but can be overridden explicitly.

> **Note:** Roadmap reassessment requires `reassess_after_slice: true` to be set explicitly. Without it, reassessment is skipped regardless of `skip_reassess`.

### `planning_depth`

Controls how much discovery runs before milestone-level planning.

```yaml
planning_depth: deep
```

| Value | Behavior |
|-------|----------|
| `light` | Default. Uses the normal milestone discussion flow that writes milestone context and roadmap artifacts. |
| `deep` | Runs staged project discovery first: workflow preferences, `.gsd/PROJECT.md`, `.gsd/REQUIREMENTS.md`, a research decision marker, and optional project research before milestone planning. |

Enable deep mode for the current project with `/gsd new-project --deep` or `/gsd new-milestone --deep`; both write `planning_depth: deep` to `.gsd/PREFERENCES.md`. You can also set it manually in project or global preferences.

In deep mode, `research-decision` writes `.gsd/runtime/research-decision.json` with `research` or `skip`. A `research` decision dispatches `research-project`, which writes `.gsd/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, and `PITFALLS.md`; a `skip` decision proceeds directly to milestone work.

### `workspace`

Declares repository targets for project or parent workspaces. `plan-slice` validates `targetRepositories` against these IDs and scopes task file/input/output paths to the selected repository roots.

```yaml
workspace:
  mode: parent   # "project" or "parent"
  repositories:
    frontend:
      path: frontend
      role: ui
      verification:
        - npm run test
      commit_policy: auto   # "auto" or "skip"
    backend:
      path: backend
```

- `workspace.mode`: `project` (single-repo default) or `parent` (multi-repo workspace rooted at the current project). In `parent` mode, at least one repository must be declared under `workspace.repositories` or the setting is rejected.
- `workspace.repositories.<id>.path`: required repository path (relative or absolute).
- `workspace.repositories.<id>.role`: optional label used for planning/reporting context.
- `workspace.repositories.<id>.verification`: optional default verification commands for that repository.
- `workspace.repositories.<id>.commit_policy`: optional per-repository auto-commit policy (`auto` or `skip`).
- Omitted slice/task `targetRepositories` default to `["project"]` in `project` mode, and to the declared child repository IDs in `parent` mode.
- In parent workspaces, `gsd_plan_slice.targetRepositories` sets a slice-wide default and `gsd_plan_task.targetRepositories` records the repository IDs an individual task touches. Use only declared repository IDs, plus the implicit `project` ID; omit these fields in single-repo projects.
- In parent mode with declared child repositories, `/gsd codebase generate` and automatic `CODEBASE.md` refreshes include the implicit `project` repository plus each child repository, using workspace-relative paths and repo-labeled sections.

### `reactive_execution`

Controls automatic parallel task dispatch inside a slice. This is enabled by default and only dispatches when task-plan IO annotations produce a non-ambiguous graph with enough ready, non-conflicting tasks.

```yaml
reactive_execution:
  enabled: false    # opt out; omit this block to keep default-on behavior
```

Defaults and tuning:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Set to `false` to force sequential task execution. Set to `true` explicitly to use the lower two-ready-task threshold. |
| `max_parallel` | number | `2` | Maximum tasks to dispatch in one reactive batch. Valid range: `1`-`8`. |
| `isolation_mode` | string | `same-tree` | Execution isolation mode. `same-tree` is currently the only supported value. |
| `subagent_model` | string | `models.subagent` fallback | Optional model override for reactive task subagents. |

When `enabled` is omitted, reactive execution uses the default-on safety threshold of three ready tasks before it attempts a parallel batch. When `enabled: true` is set explicitly, GSD uses the earlier opt-in threshold of two ready tasks.

### `taskIsolation`

Controls optional filesystem isolation for explicit subagent tool calls that set `isolated: true`. This is a global `~/.gsd/agent/settings.json` setting.

```json
{
  "taskIsolation": {
    "mode": "worktree"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | none | `"worktree"` creates a temporary detached git worktree for the child task. `"fuse-overlay"` uses `fuse-overlayfs` on Linux when installed and falls back to `worktree`. Any other value disables subagent filesystem isolation. |

See [Subagents](./subagents.md#filesystem-isolation) for invocation, merge, and recovery behavior.

### `skill_discovery`

Controls how GSD finds and applies skills during auto mode.

| Value | Behavior |
|-------|----------|
| `auto` | Skills found and applied automatically |
| `suggest` | Skills identified during research but not auto-installed (default) |
| `off` | Skill discovery disabled |

### `auto_supervisor`

Timeout thresholds for auto mode supervision:

```yaml
auto_supervisor:
  model: claude-sonnet-4-6    # optional: model for supervisor (defaults to active model)
  soft_timeout_minutes: 20    # warn LLM to wrap up
  idle_timeout_minutes: 10    # detect stalls
  hard_timeout_minutes: 30    # pause auto mode
  stalled_tool_timeout_minutes: 5  # recover a tool that hangs mid-call (default: 5)
```

Long-running coordination tools (`subagent`, and its `Task` alias) are exempt from
`stalled_tool_timeout_minutes`: a subagent running parallel reviewers can legitimately
outlast this budget. A genuinely hung subagent is still bounded by `hard_timeout_minutes`.

### `min_request_interval_ms`

Minimum milliseconds between auto-mode LLM request dispatches. Use this to proactively slow auto-mode on rate-limited providers and reduce 429 errors. Set to `0` to disable.

```yaml
min_request_interval_ms: 1000   # wait at least 1 second between LLM requests
```

Default: `0` (disabled)

### `budget_ceiling`

Maximum USD to spend during auto mode. No `$` sign — just the number.

```yaml
budget_ceiling: 50.00
```

### `budget_enforcement`

How the budget ceiling is enforced:

| Value | Behavior |
|-------|----------|
| `warn` | Log a warning but continue |
| `pause` | Pause auto mode (default when ceiling is set) |
| `halt` | Stop auto mode entirely |

### `context_pause_threshold`

Context window usage percentage (0-100) at which auto mode pauses for checkpointing. Set to `0` to disable.

```yaml
context_pause_threshold: 80   # pause at 80% context usage
```

Default: `0` (disabled)

### `tool_call_loop_guard`

Tunes the tool-call loop guard, which stops a model from repeating tool calls within a single turn. The two guards are configured independently:

- **Identical-args guard** — blocks a streak of calls to the same tool with identical arguments. Catches real infinite loops; usually keep enabled.
- **Repeated-tool-name cap** — caps repeated calls to a tool name regardless of arguments. Successful file mutations, shell calls, and `gsd_requirement_save` calls count as progress and decay the per-tool count; failed calls do not. Catches improvisation loops while allowing productive automation, and is tunable or disableable on its own.

```yaml
tool_call_loop_guard:
  enabled: true                    # master switch for both guards (default: true)
  identical_args:
    enabled: true                  # default: true
    max_consecutive_calls: 4       # default: 4
  repeated_tool:
    enabled: true                  # default: true
    default_cap: 6                 # default: 6
    repeatable_cap: 15             # default: 15 (for inherently repeatable tools like bash/edit/gsd_exec)
    exempt_tools:                  # additive to built-in exempt defaults
      - ctx_execute
      - ctx_batch_execute
      - ctx_search
```

Omitted fields fall back to built-in defaults, so existing installs keep their current behavior. `exempt_tools` is merged with the built-in exempt set (`find`, `glob`, `grep`, `ls`, `read`, `search_and_read`) rather than replacing it. Every field can also be overridden with `GSD_TOOL_LOOP_*` environment variables (see [Environment Variables](#environment-variables)), which win over the preferences file. When a call is blocked, the message names the active cap and the relevant config key. Applies to both interactive sessions and `/gsd auto`.

### `uat_dispatch`

Enable automatic UAT (User Acceptance Test) runs after slice completion:

```yaml
uat_dispatch: true
```

When enabled, auto-mode runs UAT after slice completion. Non-PASS verdicts on closed slices do not hard-stop dispatch progression, so downstream remediation slices can continue, but automatic milestone closure is still gated on explicit UAT PASS sign-off for closed slices.

### Verification

Configure shell commands that run automatically after every task execution. Runnable failures can trigger auto-fix retries before advancing.

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true       # auto-retry runnable failures (default: true)
verification_max_retries: 2       # max retry attempts (default: 2)
verification_timeout_ms: 120000   # host verification and verification-oriented gsd_exec default (default: 120000)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verification_commands` | string[] | `[]` | Simple executable commands to run after task execution |
| `verification_auto_fix` | boolean | `true` | Auto-retry runnable verification failures |
| `verification_max_retries` | number | `2` | Maximum auto-fix retry attempts for runnable failures |
| `verification_timeout_ms` | number | `120000` | Per-command host-verification timeout in milliseconds and the default timeout for verification-oriented `gsd_exec` workloads. Unset keeps the 120s host-verification default. A timeout is reported as `failureClass: timeout`, never as exit 127. |

If the shell cannot find an executable, GSD classifies the check as `failureClass: command-not-found`. This includes exit code 127, `command not found` output, and Windows `is not recognized as an internal or external command` errors. The check is recorded as `inconclusive` in verification evidence, its failure does not consume `verification_max_retries`, and auto mode pauses for you to install the executable or correct the command before resuming.

Verification commands must be simple executable commands. Shell piping (`|`) is supported, but logical OR (`||`) is rejected. GSD also rejects redirects (`>` and `<`), semicolons, backticks, and command substitution (`$(...)`) because verification is run as a controlled command list, not as an arbitrary shell program.

For `gsd_exec`, verification-oriented workloads include builds, tests, linting, type checks, and verification commands. An explicit `context_mode.exec_timeout_ms` takes precedence over `verification_timeout_ms`; unrelated `gsd_exec` workloads keep the sandbox's 30-second default when `context_mode.exec_timeout_ms` is unset.

For task-level `verify` commands (`taskPlanVerify`), GSD splits checks on newlines. `<item>...</item>` wrappers around commands are treated as separators, not shell syntax. `&&` chains stay within a single shell invocation, so commands such as `cd path && npm test` preserve directory context. If a task names verify commands but every one is rejected as shell-unsafe (unquoted redirects, `;`, `$(...)`, backticks), GSD does not fall back to preference or `package.json` checks; the task fails with a `task-plan-unsafe` discovery source and asks you to rewrite the Verify field.

When `verification_commands` is empty and no task-level `verify` command is available, GSD can auto-discover project checks. JavaScript projects use `package.json` scripts in this order: `typecheck`, `lint`, `test`. GSD selects the package manager from lock files in this order: `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` or `bun.lock`, then `package-lock.json`. If no lock file exists, it uses the supported manager named by the `packageManager` field and otherwise defaults to npm. Discovered scripts use each manager's command form: `npm test` for npm's test script, `npm run <script>` for other npm scripts, `<manager> <script>` for pnpm and Yarn, and `bun run <script>` for Bun. Python projects use the `python-project` discovery source and run `python3 -m pytest` when GSD finds files matching pytest's default test file patterns (`test_*.py` or `*_test.py`) under `tests/` or an explicit pytest configuration marker: `pytest.ini`, `[tool.pytest]`, `[tool.pytest.*]`, `[pytest]`, or `[tool:pytest]` in `pyproject.toml`.

### `workspace`

Multi-repository workspace configuration for a parent project that coordinates child repositories.

```yaml
workspace:
  mode: parent
  repositories:
    frontend:
      path: apps/frontend
      role: web
      verification:
        - pnpm -C apps/frontend test
      commit_policy: auto
    backend:
      path: services/backend
      role: api
      verification:
        - pnpm -C services/backend test
      commit_policy: skip
```

`project` is always available as an implicit repository ID pointing at the project root. If plan/task `targetRepositories` is omitted, GSD defaults to `["project"]` in `project` mode, and to the declared child repository IDs in `parent` mode.

In parent workspaces, use `gsd_plan_slice.targetRepositories` to set a slice-wide repository default. Use `gsd_plan_task.targetRepositories` when an individual task touches a different or more specific set of declared repositories.

In parent mode with declared child repositories, `/gsd codebase generate` and automatic `.gsd/CODEBASE.md` refreshes enumerate the implicit `project` repository plus each child repository. Generated maps group files under `## [repo-id]` sections, preserve workspace-relative paths, and record repository IDs in map metadata so registry changes refresh stale maps.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace.mode` | `"project" \| "parent"` | `"project"` | Workspace operating mode. Use `parent` to declare and resolve child repositories; requires at least one entry under `workspace.repositories`. |
| `workspace.repositories` | object | `{}` | Mapping of repository IDs to repository config. |
| `workspace.repositories.<id>.path` | string | required | Child repository path, resolved relative to project root. Must stay inside the project root. |
| `workspace.repositories.<id>.role` | string | optional | Human-oriented label used by prompts/reporting. |
| `workspace.repositories.<id>.verification` | string[] | optional | Default verification commands for that repository. |
| `workspace.repositories.<id>.commit_policy` | `"auto" \| "skip"` | optional | Per-repository auto-mode turn-commit policy. |

Validation rules:

- Repository IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- Repository paths are normalized and must be unique (case-insensitive).
- Paths resolving outside the project root are rejected.
- `workspace.mode: "parent"` requires at least one repository under `workspace.repositories`; otherwise it is rejected (a parent workspace with no child repos is indistinguishable from `project` mode).
- `mode: "team"` combined with `workspace.mode: "parent"` produces a warning: team branch-push/PR resolves at the project root and does not push child repositories. This is a known limitation (see "Known limitations" below).
- Unknown keys under `workspace` and each repository entry are ignored with warnings.

**Layout constraint (nested-only).** Child repositories must live **inside** the project root — sibling-repo layouts (e.g. a path like `../frontend` or any path resolving outside the root) are **not supported** and are rejected. This is a deliberate safety guard, not an arbitrary limitation: declared repository roots back the task path-scope allowlist used during planning (`plan-slice` validates that every task `files`/`inputs`/`expectedOutput` path stays under a declared root). Allowing escapes would weaken that guard and let a typo'd or malicious path authorize edits outside the project. To coordinate sibling repos, nest them under a common parent directory and run GSD from that parent.

**Known limitations of parent-workspace mode.** Per-repository *commits* and *verification* honor `commit_policy` and run in each repo's directory today. The following are **not** yet wired:

- **Repo path-scope is enforced at planning time only.** When a task targets `frontend`, the planner is instructed its files must stay under `frontend/`'s root, but nothing mechanically blocks an executor from writing to `backend/` at runtime under `git.isolation: "none"`. Isolation modes (`worktree`/`branch`) provide stronger containment but operate at the project root, not per child repo.
- **Per-repository git isolation (worktree/branch) is root-only.** One worktree/branch per milestone is created at the project root and shared across child repos. This inverts the isolation model and is RFC-gated; see `docs/dev/ADR-044-per-repository-git-isolation.md` when it lands.
- **Parallel orchestration is root-only.** Each parallel worker gets one milestone worktree at the project root with no per-repo dimension — a known limit tied to the same isolation-model question (ADR-044).
- **Per-repository push policy.** Push/PR at milestone merge resolves at the project root and pushes a single branch; child repos are not pushed individually.

### URL Blocking (`fetch_page`)

The `fetch_page` tool blocks requests to private and internal network addresses to prevent server-side request forgery (SSRF). This protects against the agent being tricked into accessing internal services, cloud metadata endpoints, or local files.

**Blocked by default:**

| Category | Examples |
|----------|----------|
| Private IP ranges | `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x` |
| Link-local / cloud metadata | `169.254.x.x` (AWS/GCP instance metadata) |
| Cloud metadata hostnames | `metadata.google.internal`, `instance-data` |
| Localhost | `localhost` (any port) |
| Non-HTTP protocols | `file://`, `ftp://` |
| IPv6 private ranges | `::1`, `fc00:`, `fd`, `fe80:` |

Public URLs (`https://example.com`, `http://8.8.8.8`) are not affected.

**Allowing specific internal hosts:**

If you need the agent to fetch from internal URLs (self-hosted docs, internal APIs behind a VPN), add their hostnames to `fetchAllowedUrls` in global settings (`~/.gsd/agent/settings.json`):

```json
{
  "fetchAllowedUrls": ["internal-docs.company.com", "192.168.1.50"]
}
```

Alternatively, set the `GSD_FETCH_ALLOWED_URLS` environment variable (comma-separated). The env var takes precedence over settings.json:

```bash
export GSD_FETCH_ALLOWED_URLS="internal-docs.company.com,192.168.1.50"
```

Allowed hostnames bypass the blocklist checks. The protocol restriction (HTTP/HTTPS only) still applies — `file://` and `ftp://` cannot be allowlisted.

> **Note:** This setting is global-only. Project-level settings.json cannot override the URL allowlist — this prevents a cloned repo from directing `fetch_page` at internal infrastructure.

### `auto_report`

Auto-generate HTML reports after milestone completion:

```yaml
auto_report: true    # default: true
```

Reports are written to `.gsd/reports/` as self-contained HTML files with embedded CSS/JS.

### `unique_milestone_ids`

Generate milestone IDs with a random suffix to avoid collisions in team workflows:

```yaml
unique_milestone_ids: true
# Produces: M001-eh88as instead of M001
```

### `git`

Git behavior configuration. All fields optional:

```yaml
git:
  auto_push: false            # push commits to remote after committing
  push_branches: false        # push milestone branch to remote
  remote: origin              # git remote name
  snapshots: true             # WIP snapshot commits during long tasks
  pre_merge_check: auto       # run checks before worktree merge (true/false/"auto")
  commit_type: feat           # override conventional commit prefix
  main_branch: main           # primary branch name
  merge_strategy: squash      # how worktree branches merge: "squash" or "merge"
  isolation: none             # git isolation: "none" (default), "worktree", or "branch"
  commit_docs: true           # commit .gsd/ artifacts to git (set false to keep local)
  manage_gitignore: true      # set false to prevent GSD from modifying .gitignore
  worktree_post_create: .gsd/hooks/post-worktree-create  # script to run after worktree creation
  auto_pr: false              # create a PR on milestone completion (requires push_branches)
  pr_target_branch: develop   # target branch for auto-created PRs (default: main branch)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_push` | boolean | `false` | Push commits to remote after committing |
| `push_branches` | boolean | `false` | Push milestone branch to remote |
| `remote` | string | `"origin"` | Git remote name |
| `snapshots` | boolean | `true` | WIP snapshot commits during long tasks |
| `pre_merge_check` | bool/string | `"auto"` | Run checks before merge (`true`/`false`/`"auto"`) |
| `commit_type` | string | (inferred) | Override conventional commit prefix (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`) |
| `main_branch` | string | `"main"` | Primary branch name |
| `merge_strategy` | string | `"squash"` | How worktree branches merge: `"squash"` (combine all commits) or `"merge"` (preserve individual commits) |
| `isolation` | string | `"none"` | Auto-mode isolation: `"none"` (no isolation — commits on current branch, no worktree or milestone branch), `"worktree"` (separate directory), or `"branch"` (work in project root — useful for submodule-heavy repos). `worktree` requires a committed `HEAD`; zero-commit repos temporarily run as `none` until the first commit exists |
| `commit_docs` | boolean | `true` | Commit `.gsd/` planning artifacts to git. Set `false` to keep local-only |
| `manage_gitignore` | boolean | `true` | When `false`, GSD will not modify `.gitignore` at all — no baseline patterns, no self-healing. Use if you manage your own `.gitignore` |
| `worktree_post_create` | string | (none) | Script to run after worktree creation. Receives `SOURCE_DIR` and `WORKTREE_DIR` env vars |
| `auto_pr` | boolean | `false` | Automatically create a pull request when a milestone completes. Requires `auto_push: true` and `gh` CLI installed and authenticated |
| `pr_target_branch` | string | (main branch) | Target branch for auto-created PRs (e.g. `develop`, `qa`). Defaults to `main_branch` if not set |

#### `git.worktree_post_create`

Script to run after a worktree is created (both auto-mode and manual `/worktree`). Useful for copying `.env` files, symlinking asset directories, or running setup commands that worktrees don't inherit from the main tree.

```yaml
git:
  worktree_post_create: .gsd/hooks/post-worktree-create
```

The script receives two environment variables:
- `SOURCE_DIR` — the original project root
- `WORKTREE_DIR` — the newly created worktree path

Example hook script (`.gsd/hooks/post-worktree-create`):

```bash
#!/bin/bash
# Copy environment files and symlink assets into the new worktree
cp "$SOURCE_DIR/.env" "$WORKTREE_DIR/.env"
cp "$SOURCE_DIR/.env.local" "$WORKTREE_DIR/.env.local" 2>/dev/null || true
ln -sf "$SOURCE_DIR/assets" "$WORKTREE_DIR/assets"
```

The path can be absolute or relative to the project root. The script runs with a 30-second timeout. Failure is non-fatal — GSD logs a warning and continues.

#### `git.auto_pr`

Automatically create a pull request when a milestone completes. Designed for teams using Gitflow or branch-based workflows where work should go through PR review before merging to a target branch.

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop  # or qa, staging, etc.
```

**Requirements:**
- `auto_push: true` — the milestone branch must be pushed before a PR can be created
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

**How it works:**
1. Milestone completes → GSD squash-merges the worktree to the main branch
2. Pushes the main branch to remote (if `auto_push: true`)
3. Pushes the milestone branch to remote
4. Creates a PR from the milestone branch to `pr_target_branch` via `gh pr create`

If `pr_target_branch` is not set, the PR targets the `main_branch` (or auto-detected main branch). PR creation failure is non-fatal — GSD logs and continues.

### `github`

GitHub sync configuration. When enabled, GSD auto-syncs milestones, slices, and tasks to GitHub Issues, PRs, and Milestones.

```yaml
github:
  enabled: true
  repo: "owner/repo"              # auto-detected from git remote if omitted
  labels: [gsd, auto-generated]   # labels applied to created issues/PRs
  project: "Project ID"           # optional GitHub Project board
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable GitHub sync |
| `repo` | string | (auto-detected) | GitHub repository in `owner/repo` format |
| `labels` | string[] | `[]` | Labels to apply to created issues and PRs |
| `project` | string | (none) | GitHub Project ID for project board integration |

**Requirements:**
- `gh` CLI installed and authenticated (`gh auth login`)
- Sync mapping is persisted in `.gsd/github-sync.json`
- Rate-limit aware — skips sync when GitHub API rate limit is low

**Commands:**
- `/github-sync bootstrap` — initial setup and sync
- `/github-sync status` — show sync mapping counts

### `workspace`

Multi-repository parent workspace configuration. This lets one `.gsd` state manage multiple child repositories and constrains planning file paths to declared repository roots.

```yaml
workspace:
  mode: parent                  # "project" (default) or "parent"
  repositories:
    frontend:
      path: frontend            # relative to project root (or absolute path within project root)
      role: ui                  # optional
      verification:             # optional default verification commands
        - npm run test
      commit_policy: auto       # optional: "auto" or "skip"
    backend:
      path: backend
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `project` | Workspace mode. `parent` enables multi-repo registry behavior and requires at least one entry under `repositories`. |
| `repositories` | object | `{}` | Map of repository ids to repository config objects. |
| `repositories.<id>.path` | string | required | Repository root path. Relative paths resolve from project root and must stay inside project root. |
| `repositories.<id>.role` | string | (none) | Optional human-oriented label for prompts/reporting. |
| `repositories.<id>.verification` | string[] | (none) | Optional default verification commands for that repository. |
| `repositories.<id>.commit_policy` | string | (none) | Optional per-repo auto-mode turn commit policy: `auto` or `skip`. |

**Path-scope behavior:**
- During planning (`plan-slice`/`replan-slice`), file paths are validated against the selected `targetRepositories`.
- `gsd_plan_slice.targetRepositories` sets the slice-wide default repository IDs.
- `gsd_plan_task.targetRepositories` records or overrides the repository IDs for an individual task.
- Absolute and relative paths are both checked; paths that resolve outside declared repository roots are rejected.
- Use only repository IDs declared under `workspace.repositories`, plus the implicit `project` ID. If no explicit `targetRepositories` are provided, planning defaults to `["project"]` in `project` mode, and to the declared child repository IDs in `parent` mode.

**Codebase-map behavior:** In parent mode with declared child repositories, `/gsd codebase generate` and automatic `.gsd/CODEBASE.md` refreshes include `project` plus each child repository, render repo-labeled `## [repo-id]` sections, and store repository metadata for freshness checks.

### `notifications`

Control what notifications GSD sends during auto mode:

```yaml
notifications:
  enabled: true
  local_bell: false           # play terminal bell on questions and auto-mode stops
  on_complete: true           # notify on unit completion
  on_error: true              # notify on errors
  on_budget: true             # notify on budget thresholds
  on_milestone: true          # notify when milestone finishes
  on_attention: true          # notify when manual attention needed
```

Set `local_bell: true` to play the local terminal bell when `ask_user_questions`
needs an answer or auto-mode stops. The bell respects `enabled` and
`on_attention`.

**macOS delivery:** GSD uses [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) when available, falling back to `osascript`. We recommend installing `terminal-notifier` for reliable notification delivery:

```bash
brew install terminal-notifier
```

Why: `osascript display notification` is attributed to your terminal app (Ghostty, iTerm2, etc.), which may not have notification permissions in System Settings → Notifications. `terminal-notifier` registers as its own app and prompts for permission on first use. See [Troubleshooting: Notifications not appearing on macOS](troubleshooting.md#notifications-not-appearing-on-macos) if notifications aren't working.

### `remote_questions`

Route interactive questions **and informational notifications** to Slack, Discord, or Telegram for headless auto mode:

```yaml
remote_questions:
  channel: slack              # or discord or telegram
  channel_id: "C1234567890"
  timeout_minutes: 15         # question timeout (1-30 minutes)
  poll_interval_seconds: 10   # poll interval (2-30 seconds)
```

When `notifications.enabled: true` is set **and** a remote channel is configured, informational notifications (milestone complete, blocker, budget alerts, all milestones done) are also sent to the remote channel — not just to the desktop. No additional configuration is needed.

See [Remote Questions](./remote-questions.md) for setup instructions and Telegram command reference.

### `post_unit_hooks`

Custom hooks that fire after specific unit types complete:

```yaml
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review the code changes for quality and security issues."
    model: claude-opus-4-6          # optional: model override
    max_cycles: 1                   # max fires per trigger (1-10, default: 1)
    artifact: REVIEW.md             # optional: skip if this file exists
    retry_on: NEEDS-REWORK.md       # optional: re-run trigger unit if this file appears
    agent: review-agent             # optional: agent definition to use
    enabled: true                   # optional: disable without removing
```

**Known unit types for `after`:** `research-milestone`, `plan-milestone`, `research-slice`, `plan-slice`, `execute-task`, `complete-slice`, `replan-slice`, `reassess-roadmap`, `run-uat`

**Prompt substitutions:** `{milestoneId}`, `{sliceId}`, `{taskId}` are replaced with current context values.

### `pre_dispatch_hooks`

Hooks that intercept units before dispatch. Three actions available:

**Modify** — prepend/append text to the unit prompt:

```yaml
pre_dispatch_hooks:
  - name: add-standards
    before: [execute-task]
    action: modify
    prepend: "Follow our coding standards document."
    append: "Run linting after changes."
```

**Skip** — skip the unit entirely:

```yaml
pre_dispatch_hooks:
  - name: skip-research
    before: [research-slice]
    action: skip
    skip_if: RESEARCH.md            # optional: only skip if this file exists
```

**Replace** — replace the unit prompt entirely:

```yaml
pre_dispatch_hooks:
  - name: custom-execute
    before: [execute-task]
    action: replace
    prompt: "Execute the task using TDD methodology."
    unit_type: execute-task-tdd     # optional: override unit type label
    model: claude-opus-4-6          # optional: model override
```

All pre-dispatch hooks support `enabled: true/false` to toggle without removing.

### `planning_subagents`

Project-local allowlists for controlled read-only subagent dispatch during planning:

```yaml
planning_subagents:
  plan-milestone:
    allowed: [scout, planner, security]
  plan-slice:
    allowed: [scout, planner, reviewer, security]
```

Only `plan-milestone` and `plan-slice` are configurable. Agents must be GSD-classified read-only planning specialists (`mnemo`, `scout`, `planner`, `reviewer`, `security`, or `tester`). The write gate still blocks source writes outside `.gsd/**`, unsafe agents, and agents not listed for the active unit.

### `always_use_skills` / `prefer_skills` / `avoid_skills`

Skill routing preferences:

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills: []
```

Skills can be bare names (looked up in priority order from `~/.gsd/agent/skills/`, `~/.agents/skills/`, `.agents/skills/`, then Claude compatibility skill directories) or absolute paths.

### `skill_rules`

Situational skill routing with human-readable triggers:

```yaml
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
  - when: working with legacy code
    avoid: [aggressive-refactor]
```

### `custom_instructions`

Durable instructions appended to every session:

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```

For project-specific knowledge, use the GSD knowledge and memory surfaces instead. `.gsd/KNOWLEDGE.md` is a hybrid projection: manually maintained Rules stay in the file, while generated Patterns and Lessons are backed by the `memories` table and rendered back into the file for review. Add durable operating rules with `/gsd knowledge rule <description>`; agent-discovered patterns and lessons are stored as memories and selected for prompt injection automatically.

### `RUNTIME.md` — Runtime Context

Declare project-level runtime context in `.gsd/RUNTIME.md`. This file is inlined into task execution prompts, giving the agent accurate information about your runtime environment without relying on hallucinated paths or URLs.

**Location:** `.gsd/RUNTIME.md`

**Example:**

```markdown
# Runtime Context

## API Endpoints
- Main API: https://api.example.com
- Cache: redis://localhost:6379

## Environment Variables
- DEPLOYMENT_ENV: staging
- DB_POOL_SIZE: 20

## Local Services
- PostgreSQL: localhost:5432
- Redis: localhost:6379
```

Use this for information that the agent needs during execution but that doesn't belong in `DECISIONS.md` (architectural) or project knowledge (rules, patterns, lessons). Common examples: API base URLs, service ports, deployment targets, and environment-specific configuration.

### `dynamic_routing`

Complexity-based model routing. See [Dynamic Model Routing](./dynamic-model-routing.md).

```yaml
dynamic_routing:
  enabled: true
  capability_routing: true          # score models by task capability
  tier_models:
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true
  budget_pressure: true
  cross_provider: true
```

### `disabled_model_providers`

Hide specific providers from model selection and routing without removing their auth credentials. Useful when you want a provider for tools (like `google_search`) but never want its models in `/model` or auto routing.

```yaml
disabled_model_providers:
  - google-gemini-cli
```

### `context_management`

Controls observation masking and tool result truncation during auto-mode sessions. Reduces context bloat between compactions with zero LLM overhead. In step mode, the configurable threshold is a soft warning; automatic session re-rooting happens only at the fixed 90% hard context boundary.

```yaml
context_management:
  observation_masking: true          # replace old tool results with placeholders (default: true)
  observation_mask_turns: 8          # keep results from last N user turns (1-50, default: 8)
  compaction_threshold_percent: 0.60 # soft warning at 60% context usage (0.5-0.95, default: 0.60)
  tool_result_max_chars: 800         # cap individual tool result content (200-10000, default: 800)
```

### `service_tier`

OpenAI service tier preference for supported models. Toggle with `/gsd fast`.

| Value | Behavior |
|-------|----------|
| `"priority"` | Priority tier — 2x cost, faster responses |
| `"flex"` | Flex tier — 0.5x cost, slower responses |
| (unset) | Default tier |

```yaml
service_tier: priority
```

### `forensics_dedup`

Opt-in: search existing issues and PRs before filing from `/gsd forensics`. Uses additional AI tokens.

```yaml
forensics_dedup: true    # default: false
```

### `show_token_cost`

Opt-in: show per-prompt and cumulative session token cost in the footer.

```yaml
show_token_cost: true    # default: false
```

### `auto_visualize`

Show the workflow visualizer automatically after milestone completion:

```yaml
auto_visualize: true
```

See [Workflow Visualizer](./visualizer.md).

### `parallel`

Run multiple milestones simultaneously. Disabled by default.

```yaml
parallel:
  enabled: false            # Master toggle
  max_workers: 2            # Concurrent workers (1-4)
  budget_ceiling: 50.00     # Aggregate cost limit in USD
  merge_strategy: "per-milestone"  # "per-slice" or "per-milestone"
  auto_merge: "confirm"            # "auto", "confirm", or "manual"
```

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## Full Example

```yaml
---
version: 1

# Model selection
models:
  research: openrouter/deepseek/deepseek-r1
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6

# Token optimization
token_profile: balanced

# Dynamic model routing
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true

# Budget
budget_ceiling: 25.00
budget_enforcement: pause
context_pause_threshold: 80

# Supervision
auto_supervisor:
  soft_timeout_minutes: 15
  hard_timeout_minutes: 25

# Git
git:
  auto_push: true
  merge_strategy: squash
  isolation: none             # "none" (default), "worktree", or "branch"
  commit_docs: true

# Skills
skill_discovery: suggest
skill_staleness_days: 60     # Skills unused for N days get deprioritized (0 = disabled)
always_use_skills:
  - debug-like-expert
skill_rules:
  - when: task involves authentication
    use: [clerk]

# Notifications
notifications:
  on_complete: false
  on_milestone: true
  on_attention: true
  local_bell: false

# Visualizer
auto_visualize: true

# Service tier
service_tier: priority         # "priority" or "flex" (for /gsd fast)

# Diagnostics
forensics_dedup: true          # deduplicate before filing forensics issues
show_token_cost: true          # show per-prompt cost in footer

# Hooks
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review {sliceId}/{taskId} for quality and security."
    artifact: REVIEW.md
---
```
