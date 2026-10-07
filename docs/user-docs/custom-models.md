# Custom Models

Add custom providers and models (Ollama, vLLM, LM Studio, proxies) via `~/.gsd/agent/models.json`.

## Table of Contents

- [Minimal Example](#minimal-example)
- [Full Example](#full-example)
- [Supported APIs](#supported-apis)
- [Provider Configuration](#provider-configuration)
- [Model Configuration](#model-configuration)
- [Overriding Built-in Providers](#overriding-built-in-providers)
- [Per-model Overrides](#per-model-overrides)
- [Updating the Model Catalog](#updating-the-model-catalog)
- [OpenAI Compatibility](#openai-compatibility)

## Minimal Example

For local models (Ollama, LM Studio, vLLM), only `id` is required per model:

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

The `apiKey` is required but Ollama ignores it, so any value works.

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so GSD sends the system prompt as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too.
Some servers (including certain vLLM/TensorRT-LLM deployments) can return 400 errors when prior assistant `reasoning_content` is replayed. Set `compat.stripReasoningContent` to `true` to remove those replayed fields from outbound history.

You can set `compat` at the provider level to apply to all models, or at the model level to override a specific model. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "stripReasoningContent": true
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## Full Example

Override defaults when you need specific values:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

The file reloads each time you open `/model`. Edit during session; no restart needed.

## Supported APIs

| API | Description |
|-----|-------------|
| `openai-completions` | OpenAI Chat Completions (most compatible) |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

Set `api` at provider level (default for all models) or model level (override per model).

## Provider Configuration

| Field | Description |
|-------|-------------|
| `baseUrl` | API endpoint URL |
| `api` | API type (see above) |
| `apiKey` | API key (see value resolution below) |
| `headers` | Custom headers (see value resolution below) |
| `authHeader` | Set `true` to add `Authorization: Bearer <apiKey>` automatically |
| `models` | Array of model configurations |
| `modelOverrides` | Per-model overrides for built-in models on this provider |

### Value Resolution

The `apiKey` and `headers` fields support three formats:

- **Shell command:** `"!command"` executes and uses stdout

  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```

- **Environment variable:** Uses the value of the named variable

  ```json
  "apiKey": "MY_API_KEY"
  ```

- **Literal value:** Used directly

  ```json
  "apiKey": "sk-..."
  ```

#### Command Allowlist

Shell commands (`!command`) are restricted to a set of known credential tools. Only commands starting with one of these are allowed to execute:

`pass`, `op`, `aws`, `gcloud`, `vault`, `security`, `gpg`, `bw`, `gopass`, `lpass`

Commands not on this list are blocked and the value resolves to `undefined`. A warning is written to stderr.

Shell operators (`;`, `|`, `&`, `` ` ``, `$`, `>`, `<`) are also blocked in command arguments to prevent injection.

**Customizing the allowlist:**

If you use a credential tool not on the default list, override it in global settings (`~/.gsd/agent/settings.json`):

```json
{
  "allowedCommandPrefixes": ["pass", "op", "sops", "doppler", "mycli"]
}
```

This replaces the default list entirely — include any defaults you still want.

Alternatively, set the `GSD_ALLOWED_COMMAND_PREFIXES` environment variable (comma-separated). The env var takes precedence over settings.json:

```bash
export GSD_ALLOWED_COMMAND_PREFIXES="pass,op,sops,doppler"
```

> **Note:** This setting is global-only. Project-level settings.json (`<project>/.gsd/settings.json`) cannot override the command allowlist — this prevents a cloned repo from escalating command execution privileges.

### Custom Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## Model Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Model identifier (passed to the API) |
| `name` | No | `id` | Human-readable model label. Used for matching (`--model` patterns) and shown in model details/status text. |
| `api` | No | provider's `api` | Override provider's API for this model |
| `reasoning` | No | `false` | Supports extended thinking |
| `input` | No | `["text"]` | Input types: `["text"]` or `["text", "image"]` |
| `contextWindow` | No | `128000` | Context window size in tokens |
| `maxTokens` | No | `16384` | Maximum output tokens |
| `cost` | No | all zeros | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}` (per million tokens) |
| `compat` | No | provider `compat` | OpenAI compatibility overrides. Merged with provider-level `compat` when both are set. |

Current behavior:

- `/model` and `--list-models` list entries by model `id`.
- The configured `name` is used for model matching and detail/status text.

## Overriding Built-in Providers

Route a built-in provider through a proxy without redefining models:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

All built-in Anthropic models remain available. Existing OAuth or API key auth continues to work.

To merge custom models into a built-in provider, include the `models` array:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

Merge semantics:

- Built-in models are kept.
- Custom models are upserted by `id` within the provider.
- If a custom model `id` matches a built-in model `id`, the custom model replaces that built-in model.
- If a custom model `id` is new, it is added alongside built-in models.

## Per-model Overrides

Use `modelOverrides` to customize specific built-in models without replacing the provider's full model list.

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` supports these fields per model: `name`, `reasoning`, `input`, `cost` (partial), `contextWindow`, `maxTokens`, `headers`, `compat`.

Behavior notes:

- `modelOverrides` are applied to built-in provider models.
- Unknown model IDs are ignored.
- You can combine provider-level `baseUrl`/`headers` with `modelOverrides`.
- If `models` is also defined for a provider, custom models are merged after built-in overrides. A custom model with the same `id` replaces the overridden built-in model entry.

## Updating the Model Catalog

Run `gsd update --models` from the shell, or `/gsd update --models` in a running session, to fetch the latest published model catalog without a full npm upgrade:

```bash
gsd update --models
# In a running GSD session:
/gsd update --models
```

The command downloads the current generated catalog snapshot from the gsd-pi repository's `main` branch and stores it as a versioned JSON overlay at `~/.gsd/agent/models-catalog.json`. The fetch is auth-free, uses only the published all-provider catalog, and is bounded by a 15-second timeout. The flag is standalone; a trailing value is rejected before any fetch. `/gsd upgrade --models` is an alias for the in-session form.

At startup, models resolve in precedence order (lowest to highest):

1. **Bundled catalog** shipped with the installed GSD version.
2. **Overlay** from `~/.gsd/agent/models-catalog.json` — replaces bundled entries with the same provider + model `id` and adds new models and providers.
3. **`models.json`** (this file) — custom providers, custom models, and `modelOverrides` always take highest precedence and are never modified by the update.

This delivers new models, pricing, and context-window updates as they are published, without upgrading GSD itself. The in-session form reloads the model registry after a successful update, so the new catalog is active immediately without a restart. The overlay is replaced atomically only after a complete catalog passes validation, so a download, HTTP, validation, or write failure leaves an existing overlay unchanged. If the overlay is missing or malformed, it is ignored and startup continues with the bundled catalog and `models.json`.

## GitHub Copilot Live Catalog Sync

GitHub Copilot now has a separate live-catalog workflow in addition to `gsd update --models`.

Old workflow:

1. GitHub Copilot exposes or changes a model.
2. The next published bundled/generated catalog eventually learns about it.
3. `gsd update --models` or a future GSD release makes it part of the effective local catalog.

New workflow:

1. `/gsd copilot-models sync` fetches the authenticated account's live Copilot `/models` catalog.
2. The response is normalized into a non-secret local snapshot with last-known-good protection.
3. `/gsd copilot-models changes`, `pricing`, `promos`, `doctor`, and `why` inspect that accepted snapshot locally.
4. `/gsd copilot-models sync --register` can add **complete** remote-only GitHub Copilot models to `~/.gsd/agent/models-catalog.json` immediately, without waiting for a published bundled catalog refresh.

Registering a model reloads the in-memory model registry right away, so a newly-registered model is selectable via `/gsd model` (and usable for `tier_models` pins) in the same session — no restart required.

This workflow is intentionally extension-first and provider-specific:

- non-Copilot providers do not incur Copilot network traffic;
- `why`, `changes`, `pricing`, `promos`, and `doctor` do not need a new network request once an accepted snapshot exists;
- models are never auto-registered from a suspicious or failed sync.

### Effective local catalog precedence

For GitHub Copilot, the effective local catalog still resolves in the same precedence order as every other provider:

1. **Bundled catalog** shipped with the installed GSD version.
2. **Overlay** from `~/.gsd/agent/models-catalog.json`.
3. **`models.json`** user overrides and custom models.

That means `/gsd copilot-models sync` is observational by default, while `sync --register` only writes into the same overlay layer that `gsd update --models` already uses. It never edits `models.json`, never rewrites user overrides, and never mutates unrelated providers.

### Complete versus quarantined models

Remote-only Copilot models are classified before any write is attempted.

- **Complete**: the live provider response and existing provider-static compatibility data together prove a usable runtime API/endpoint mapping, tool-call support, context/output limits, and provider-aware token pricing. These models can be registered safely into the local overlay.
- **Quarantined**: any missing, conflicting, preview-disabled, policy-blocked, or suspicious metadata keeps the model out of the effective local catalog. The model remains visible in `changes`, `doctor`, and `why`, together with its concrete blockers.

Quarantined models are intentionally **not** written as placeholder entries with invented zero pricing, invented limits, or guessed protocols.

Reasoning levels in a synthesized overlay are limited to the live effort metadata when present; an explicit empty or invalid list does not fall back to bundled levels. Otherwise, static aliases and unsupported-level markers are preserved only when the static transport compatibility allows them. OpenAI Completions effort is enabled only when live support matches the Completions transport; missing, contradictory, or mismatched evidence stays disabled. This is a local compatibility decision, not proof that a particular Copilot account or backend accepts every advertised effort.

The normalizer accepts `supportedReasoningEfforts`, the snake-case effort-list fields, and `capabilities.supports.reasoning_effort` lists. Multiple declarations are intersected rather than combined. Legacy normalized records without the new reasoning metadata are quarantined during registration until a fresh sync. Registration remains insert-only: it does not replace bundled or user-defined models. Bundled Copilot Completions models with `supportsReasoningEffort: false` offer only `off`, because their adapter cannot transmit a selectable effort; an explicit custom compatibility override remains supported. Claude adaptive effort aliases and budget-based thinking remain unchanged.

### Provider-aware economics precedence

Copilot economics resolve per provider + model identity. The precedence is:

1. explicit user override from `models.json` (a full custom model definition or a `modelOverrides` entry for `github-copilot`);
2. fresh provider-live economics from the accepted Copilot snapshot;
3. provider-static economics from the current bundled GitHub Copilot catalog entry;
4. unknown.

There is intentionally no generic cross-provider bundled-fallback tier for Copilot: the shared bundled cost table is keyed by bare model ID only, so a Copilot model reusing an ID from another provider (for example `gpt-5.5`) could otherwise silently report that other provider's price. Unmatched models report `unknown` pricing instead of a possibly-wrong guess.

`/gsd copilot-models pricing` and `/gsd copilot-models why <model>` show both the resolved value and its source/freshness. Unknown values stay `unknown`; they are never silently rewritten to `$0.0000`.

Request multipliers and promotions are tracked separately from token prices. Promotions are lifecycle metadata, not an instruction to double-discount already-effective live prices.

### Routing-confidence safety

Live Copilot discovery does **not** mean every new model is automatically routed.

- Unprofiled or unknown-confidence models remain manual-only by default.
- Preview and policy-restricted state is reported as an advisory caveat by `why`, not enforced by the router itself — the router's automatic-routing gate is capability-confidence only. A locally profiled preview or policy-restricted model can still be auto-selected; treat the preview/policy caveat as a warning, not a routing guarantee.
- Wrong-provider model IDs are rejected locally by `why` before any auth or network path is touched.

`/gsd copilot-models why <model>` reports whether a model is merely visible in the live catalog, present in the effective local catalog, available in the current session, or actually eligible for automatic routing under the current confidence and policy rules.

### Command examples

```bash
/gsd copilot-models sync
/gsd copilot-models sync --register
/gsd copilot-models changes
/gsd copilot-models pricing
/gsd copilot-models pricing github-copilot/mai-code-1.1-flash
/gsd copilot-models promos
/gsd copilot-models doctor
/gsd copilot-models why github-copilot/gpt-5.4
```

### Failure and last-known-good behavior

The live Copilot snapshot is protected by fail-closed rules:

- auth failure, network failure, malformed JSON, or provider errors do not overwrite a known-good snapshot;
- a suspicious shrink (for example, a known-good catalog collapsing to zero models) is rejected rather than accepted blindly;
- `doctor` reports whether the accepted snapshot is cached, stale, suspicious, or absent;
- secrets are never written into the snapshot, overlay, or diagnostics.

### Current limitations

- The live-catalog path is specific to GitHub Copilot; other providers still rely on their own existing catalog/discovery paths.
- Automatic routing still requires trustworthy GSD capability profiles; live discovery alone is not enough.
- Quota-aware optimization is not part of the current feature.
- The longer-term provider-owned live-catalog architecture discussed in the planning docs remains a future direction; the current implementation ships safely within GSD's bundled extension layer.

## OpenAI Compatibility

For providers with partial OpenAI compatibility, use the `compat` field.

- Provider-level `compat` applies defaults to all models under that provider.
- Model-level `compat` overrides provider-level values for that model.

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `supportsStore` | Provider supports `store` field |
| `supportsDeveloperRole` | Use `developer` vs `system` role |
| `supportsReasoningEffort` | Support for `reasoning_effort` parameter |
| `reasoningEffortMap` | Map GSD thinking levels to provider-specific `reasoning_effort` values |
| `supportsUsageInStreaming` | Supports `stream_options: { include_usage: true }` (default: `true`) |
| `maxTokensField` | Use `max_completion_tokens` or `max_tokens` |
| `requiresToolResultName` | Include `name` on tool result messages |
| `requiresAssistantAfterToolResult` | Insert an assistant message before a user message after tool results |
| `requiresThinkingAsText` | Convert thinking blocks to plain text |
| `stripReasoningContent` | Strip replayed assistant `reasoning_content` fields from outbound message history (default: `false`; enable for some vLLM/TensorRT-LLM endpoints that otherwise return 400 errors) |
| `thinkingFormat` | Use `reasoning_effort`, `zai`, `qwen`, or `qwen-chat-template` thinking parameters |
| `supportsStrictMode` | Include the `strict` field in tool definitions |
| `openRouterRouting` | OpenRouter routing config passed to OpenRouter for model/provider selection |
| `vercelGatewayRouting` | Vercel AI Gateway routing config for provider selection (`only`, `order`) |

`qwen` uses top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that require `chat_template_kwargs.enable_thinking`.

Example:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "order": ["anthropic"],
              "fallbacks": ["openai"]
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway example:

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
