# Environment Variables

For `GSD_WEB_*` variables, see the authoritative [configuration reference](../../docs/user-docs/configuration.md#environment-variables).

## GSD Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_HOME` | `~/.gsd` | Global GSD directory. All paths derive from this unless individually overridden. |
| `GSD_PROJECT_ID` | (auto-hash) | Override automatic project identity hash. Useful for CI/CD or sharing state across repo clones. |
| `GSD_STATE_DIR` | `$GSD_HOME` | Per-project state root. Controls where `projects/<repo-hash>/` directories are created. |
| `GSD_CODING_AGENT_DIR` | `$GSD_HOME/agent` | Agent directory for extensions, auth, and managed resources. |
| `GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK` | (unset) | Set to literal `1` only for tests or explicit recovery workflows that must derive state from rendered markdown when the database is unavailable. Normal runtime treats the database as authoritative and refuses silent markdown fallback. |
| `GSD_FETCH_ALLOWED_URLS` | (none) | Comma-separated hostnames exempt from internal URL blocking. |
| `GSD_ALLOWED_COMMAND_PREFIXES` | (built-in) | Comma-separated command prefixes allowed for value resolution. |
| `GSD_WORKFLOW_PROJECT_ROOT` | current working directory | Canonical project root for the packaged `gsd-workflow` MCP server. Used by workflow tools and by the stale-process registry key in `$GSD_HOME/mcp-instances.json`. |
| `GSD_WORKFLOW_EXECUTORS_MODULE` | auto-discovered when possible | Optional absolute path or `file:` URL for the shared workflow executor module used by `gsd-workflow` mutation tools. |
| `GSD_WORKFLOW_WRITE_GATE_MODULE` | auto-discovered when possible | Optional absolute path or `file:` URL for the shared write-gate module used by `gsd-workflow` mutation tools. |
| `GSD_CURSOR_DISABLE` | (unset) | Set to literal `1` to disable the bundled `cursor-agent` model provider. |
| `GSD_CURSOR_DEBUG` | (unset) | Set to any value to print Cursor Agent readiness probe diagnostics to stderr. |
| `CURSOR_AGENT_BIN` | `cursor-agent` | Optional command or absolute path for the Cursor Agent CLI when it is not on `PATH`. |
| `PI_DISABLE_SYNC_OUTPUT` | (unset) | Set to literal `1` to disable synchronized terminal output mode in the TUI on non-Windows platforms. By default synchronized output is enabled on macOS/Linux and always disabled on Windows. |
| `PI_TUI_MOUSE` | (unset) | Set to literal `1` to enable terminal mouse reporting for TUI clicks and wheel events. Native drag selection is preserved by default; when mouse reporting is enabled, most terminals require Shift+drag to select text. |
| `SCREENSHOT_MAX_WIDTH` | `1568` | Maximum width, in pixels, for inline image payloads returned by `browser_screenshot` and `mac_screenshot`. Oversized screenshots are downscaled with aspect ratio preserved. Set to `0` to disable the width cap and return raw width. |
| `SCREENSHOT_MAX_HEIGHT` | `8000` | Maximum height, in pixels, for inline image payloads returned by `browser_screenshot` and `mac_screenshot`. Oversized screenshots are downscaled with aspect ratio preserved. Set to `0` to disable the height cap and return raw height. |
| `PI_TOKEN_AUDIT` | (unset) | Set to literal `1` to emit metadata-only provider-boundary prompt/tool audit JSONL on stderr. Other values are ignored. |
| `PI_TOKEN_TELEMETRY` | (unset) | Set to literal `1` to emit opt-in per-call token telemetry as JSONL on stderr. Other values are ignored. |

## LLM Provider Keys

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `CURSOR_API_KEY` | Cursor Agent. The local `cursor-agent` CLI is still required because requests run through the CLI. |
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GROQ_API_KEY` | Groq |
| `XAI_API_KEY` | xAI (Grok) |
| `MISTRAL_API_KEY` | Mistral |
| `GH_TOKEN` | GitHub Copilot |
| `AWS_PROFILE` | Amazon Bedrock (named profile) |
| `AWS_ACCESS_KEY_ID` | Amazon Bedrock (IAM keys) |
| `AWS_SECRET_ACCESS_KEY` | Amazon Bedrock (IAM keys) |
| `AWS_REGION` | Amazon Bedrock (region) |
| `AWS_BEARER_TOKEN_BEDROCK` | Amazon Bedrock (bearer token) |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex AI |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex AI (ADC) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI |

## Ollama

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL. A bare `host:port` value is treated as `http://host:port`. |
| `OLLAMA_API_KEY` | (none) | Bearer token for remote or cloud Ollama endpoints. Local Ollama ignores this header. |
| `OLLAMA_PROBE_TIMEOUT_MS` | `1500` | Startup health-check timeout in milliseconds. Unset, empty, non-numeric, zero, or negative values fall back to the default. Values above `2147483647` ms are capped to Node.js's maximum timer delay. |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `10000` | Per-request REST timeout in milliseconds. Unset, empty, non-numeric, zero, or negative values fall back to the default. Values above `2147483647` ms are capped to Node.js's maximum timer delay. |

## Tool API Keys

| Variable | Purpose |
|----------|---------|
| `TAVILY_API_KEY` | Tavily web search |
| `BRAVE_API_KEY` | Brave web search |
| `CONTEXT7_API_KEY` | Context7 documentation lookup |
| `DISCORD_BOT_TOKEN` | Discord remote questions |
| `TELEGRAM_BOT_TOKEN` | Telegram remote questions |

## Token Audit

Set `PI_TOKEN_AUDIT=1` to emit metadata-only audit records for each provider attempt. Audit output is for prompt-size investigation: it reports section sizes, message/tool counts, cache-neutral character totals, and largest message/tool summaries after context transforms and final tool filtering. It does not log raw prompt text, tool result text, user text, system prompt text, or tool schemas.

```bash
PI_TOKEN_AUDIT=1 gsd headless --json auto \
  > gsd-events.jsonl \
  2> token-audit.jsonl
```

Audit records use `type: "token_audit"` for Pi's normalized context and `type: "token_audit_provider_payload"` for the final provider payload around `before_provider_request` hooks. Use the provider-payload records to verify the exact message and tool surface sent to the model.

## Token Telemetry

Set `PI_TOKEN_TELEMETRY=1` to emit raw token and prompt-cache telemetry for each assistant API attempt. Telemetry writes to stderr, so stdout remains available for normal TUI output or headless `--json` events.

```bash
# Capture telemetry separately from headless JSONL events
PI_TOKEN_TELEMETRY=1 gsd headless --json auto \
  > gsd-events.jsonl \
  2> token-telemetry.jsonl

# Capture telemetry from an interactive session
PI_TOKEN_TELEMETRY=1 gsd 2> token-telemetry.jsonl
```

Each line is one JSON object:

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

Records are per attempt, not per user turn. A retrying call can emit one line for the failed assistant message, usually with `stopReason: "error"`, plus one line for each retry attempt that reaches an assistant message. Keep every line for billed-attempt accounting; group with session logs or timestamps downstream if you need a deduplicated final-response view.

## URL Blocking

The `fetch_page` tool blocks requests to private/internal networks by default (SSRF protection). To allow specific internal hosts:

```bash
export GSD_FETCH_ALLOWED_URLS="internal-docs.company.com,192.168.1.50"
```

Or set `fetchAllowedUrls` in `~/.gsd/agent/settings.json`.

Blocked by default: private IP ranges, cloud metadata endpoints, localhost, non-HTTP protocols, IPv6 private ranges.
