# Headless & CI Mode

`gsd headless` runs GSD commands without a terminal UI — designed for CI pipelines, cron jobs, and scripted automation.

## Basic Usage

```bash
# Run auto mode
gsd headless

# Run a single unit
gsd headless next

# With timeout for CI
gsd headless --timeout 600000 auto

# Auto shorthand with session-level model and thinking overrides
gsd auto --model claude-code/sonnet --thinking medium

# Force a specific phase
gsd headless dispatch plan

# Stream all events as JSONL
gsd headless --json auto
```

## Creating Milestones Headlessly

```bash
# From a context file
gsd headless new-milestone --context brief.md --auto

# From inline text
gsd headless new-milestone --context-text "Build a REST API with auth"

# Pipe from stdin
echo "Build a CLI tool" | gsd headless new-milestone --context -
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--timeout N` | See the [authoritative command reference](../../docs/user-docs/commands.md#headless-mode) | Overall timeout in milliseconds |
| `--max-restarts N` | 3 | Auto-restart on crash (0 to disable) |
| `--json` | — | Stream events and the terminal result as JSONL; see the [authoritative command reference](../../docs/user-docs/commands.md#headless-mode) |
| `--model ID` | — | Override model for this session |
| `--thinking LEVEL` | — | Override thinking level for this session (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `--context <file>` | — | Context file for `new-milestone` (use `-` for stdin) |
| `--context-text <text>` | — | Inline context for `new-milestone` |
| `--auto` | — | Chain into auto mode after milestone creation |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Complete |
| `1` | Error or timeout |
| `10` | Blocked |
| `11` | Cancelled |

## Instant State Query

`gsd headless query` returns a JSON snapshot of project state — no AI session, instant response (~50ms):

```bash
gsd headless query | jq '.state.phase'
# "executing"

gsd headless query | jq '.next'
# {"action":"dispatch","unitType":"execute-task","unitId":"M001/S01/T03"}

gsd headless query | jq '.cost.total'
# 4.25
```

Any `/gsd` subcommand works as a positional argument: `gsd headless status`, `gsd headless doctor`, etc.

## MCP Server Mode

`gsd --mode mcp` runs GSD as a Model Context Protocol server over stdin/stdout, exposing all GSD tools to external AI clients:

```bash
gsd --mode mcp
```

Compatible with Claude Desktop, VS Code Copilot, and any MCP host.

MCP mode also exposes the workflow adapter tools used by headless and MCP clients:

- Session control tools: `gsd_execute`, `gsd_status`, `gsd_result`, `gsd_cancel`, `gsd_resolve_blocker`
- Project state and read-only tools: `gsd_query`, `gsd_progress`, `gsd_roadmap`, `gsd_history`, `gsd_doctor`, `gsd_captures`, `gsd_knowledge`, `gsd_graph`
- Interactive form tool: `ask_user_questions`

Start auto-mode work with `gsd_execute`; it returns a `sessionId` that clients should pass to `gsd_status`, `gsd_result`, and `gsd_cancel`. If the client loses the `sessionId`, `gsd_status` can use `projectDir` as a fallback, or omit both fields only when this MCP server tracks exactly one session. The read-only project tools read `.gsd/` directly and do not need a running session.

## Auto-Restart

In headless mode, crashes trigger automatic restart with exponential backoff (5s → 10s → 30s cap, default 3 attempts). SIGINT/SIGTERM bypasses restart. Combined with crash recovery, this enables true overnight unattended execution.
