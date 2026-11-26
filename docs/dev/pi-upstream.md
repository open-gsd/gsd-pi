# Pi upstream tracking and upgrade runbook

GSD vendors the [earendil-works/pi](https://github.com/earendil-works/pi) monorepo (formerly `badlogic/pi-mono` / `@mariozechner/pi-*`) into `packages/pi-*`. GSD-specific session, mode, and CLI code lives in `@gsd/agent-core` and `@gsd/agent-modes` per [ADR-010](./ADR-010-pi-clean-seam-architecture.md).

**Overlay policy (2026-05-26):** Vendored pi is **upstream + allowlisted deltas**, not pristine upstream. See [ADR-010 amendment](./ADR-010-pi-clean-seam-architecture.md) and the executable checklist in [pi-overlay-execution-plan.md](./pi-overlay-execution-plan.md).

## Current status (Phase 2 complete)

| Item | Value |
|---|---|
| Upstream repo | `earendil-works/pi` |
| Pinned ref | **v0.75.5** |
| npm scope (upstream) | `@earendil-works/pi-*` |
| GSD packages | `@gsd/pi-*`, `@gsd/agent-core`, `@gsd/agent-modes` |
| Build | `npm run build:pi` |
| Boundary | `npm run verify:pi-boundary` (also in `scripts/ci-fast-gates.sh`) |
| Patch inventory CI | `npm run verify:pi-patches` |
| Claude tool schemas | `npm run test:pi-claude-schemas` |

Phase 2 used **GSD shim restoration** (incremental compat on upstream v0.75.5 APIs) rather than a full upstream modes sync. `@gsd/agent-modes` was migrated from the old GSD fork and reconciled via shims in pi-tui, pi-coding-agent, pi-ai, and agent-core.

## Pin metadata

See [`scripts/pi-upstream.json`](../../scripts/pi-upstream.json):

| Upstream path | GSD package |
|---|---|
| `packages/agent` | `@gsd/pi-agent-core` |
| `packages/ai` | `@gsd/pi-ai` |
| `packages/tui` | `@gsd/pi-tui` |
| `packages/coding-agent` | `@gsd/pi-coding-agent` |

Protected from vendor overwrite: `packages/gsd-agent-core`, `packages/gsd-agent-modes`.

`patchAllowlist` in the same JSON file lists every path GSD may diverge from upstream under `packages/pi-*`. CI (`verify:pi-patches`) fails if you change other pi-* files without updating the allowlist. By default the script checks **working tree** changes only; set `VERIFY_PI_PATCHES_BRANCH=1` to include the full branch diff vs main (vendor bumps).

## Verification (after every vendor or seam change)

```bash
npm run build:pi
npm run verify:pi-boundary
npm run verify:pi-patches
npm run test:pi-claude-schemas
npm run test:smoke
```

Optional fuller checks:

```bash
npm run build
npm test
node scripts/verify-pi-boundary.cjs
```

Smoke tests exercise CLI `--help` and `--version` only; they do not require API keys. **Smoke does not catch Cloud Code Assist tool-schema 400s** — use golden B (`test:pi-claude-schemas`).

## Upgrade workflow

`pinnedRef` stays **v0.75.5** until a follow-on plan. Do not move it in order to inspect upstream.

Safe inspection does not write `packages/pi-*`:

```bash
node scripts/sync-pi-engine.cjs --dry-run
```

A real copy is opt-in and must use an absolute `--dest` outside this repo. `--ref <tag>` selects that tag; omit it and the command uses `pinnedRef`. The command uses `.cache/pi-upstream` when that checkout is the selected ref. Otherwise it clones that tag into a temporary directory. It then copies the four packages and reapplies `scripts/pi-overlay/`. For any tag other than the pin, the conflict paths and `session-cwd.ts` stay on the upstream versions. `scripts/pi-161-ports.cjs` reapplies the behaviors listed in `docs/dev/pi-v161-remaining.md`. It deletes the seam paths listed in `scripts/pi-seam.json` from the external coding-agent tree and rewrites that tree's seam imports. It does not run `scripts/apply-seam.cjs` against this repo, and it does not write `packages/pi-*`.

`scripts/vendor-pi.cjs`, `scripts/vendor-pi-deps.cjs`, and `scripts/vendor-pi-coding-agent-core.cjs` are not the upgrade path. Do not run them when the cache was fetched at a tag other than v0.75.5. A mismatched cache exits non-zero before copying.

File-by-file disposition for the overlay is [pi-overlay-triage.md](./pi-overlay-triage.md). The plan is [../plans/2026-11-25-1707-refactor-pi-engine-host-plan.md](../plans/2026-11-25-1707-refactor-pi-engine-host-plan.md).

Seam config remains `scripts/pi-seam.json`. Prefer incremental shims over restoring entire pre-vendor files (`model-registry.ts` and `settings-manager.ts` broke v0.75.5 compat when restored whole in Phase 2).

## GSD patches that must survive vendoring

Every row must have a matching entry in `scripts/pi-upstream.json` → `patchAllowlist`.

| Area | Location | Purpose |
|---|---|---|
| Clean seam | `packages/gsd-agent-core`, `packages/gsd-agent-modes` | Session, SDK, modes, CLI |
| Type seam | `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | Avoid compile-time pi ↔ agent-core cycle |
| Session types | `packages/pi-coding-agent/src/core/extension-session-types.ts` | Re-export session types from `@gsd/agent-core` |
| External usage accounting | `packages/pi-coding-agent/src/core/session-manager.ts` | `addExternalUsage`, durable `external-usage` custom entries, `getUsageTotals({ includeExternalUsage })` (#2821, #2836) |
| Ambient shim | `packages/pi-coding-agent/src/agent-core.d.ts` | Extension types without package dep |
| Extension loader | `packages/pi-coding-agent/src/core/extensions/loader.ts` | `@gsd/agent-*`, `@earendil-works/*` aliases |
| GSD core files | `model-discovery.ts`, `discovery-cache.ts`, `models-json-writer.ts`, `package-commands.ts`, `local-model-check.ts`, `capability-patches.ts`, `bash-interceptor.ts`, `constants.ts` | Provider discovery, offline mode, capability patches |
| Keybindings | `packages/gsd-agent-core/src/keybindings.ts` | Legacy `AppAction` names + `app.*` keybinding map (pi re-exports via shim) |
| Model registry shims | `packages/pi-coding-agent/src/core/model-registry.ts` | `discoverModels`, `isAllLocalChain`, `getApiKey`, GSD auth modes |
| Settings shims | `packages/pi-coding-agent/src/core/settings-manager.ts` | Adaptive TUI, compaction override, gitignore picker |
| Interactive stream dedup | `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts`, `packages/gsd-agent-modes/src/modes/interactive/components/chat-turn-connect.ts` | Reconcile mismatched tool IDs across event streams |
| pi-tui shims | `style.ts`, `editor-keybindings.ts`, `Container.detachChildren`, `Markdown.maxLines`, `Input.secure`, `Image.getDimensions` | GSD interactive mode compat |
| pi-ai shims | `ServerToolUse` / `WebSearchResult` types, `server_tool_use` event, `supportsXhigh()` | GSD content blocks + thinking level |
| Host-compat barrels | `packages/pi-ai/src/host-compat.ts`, `packages/pi-coding-agent/src/host-compat.ts` | Re-export GSD surfaces trimmed from v1.6.1 package roots |
| Models catalog helpers | `packages/pi-ai/src/gsd-models-catalog.ts` | Catalog overlay type guards for host registration |
| Moonshot tool schema | `packages/pi-ai/src/utils/moonshot-tool-schema.ts` | Sanitize tool schemas for Moonshot providers |
| GitHub Copilot OAuth URL | `packages/pi-ai/src/auth/oauth/github-copilot.ts` | Host helper for Copilot base URL |
| API-family predicates | `packages/pi-ai/src/providers/api-family.ts` | `isAnthropicApi` / `isOpenAIApi` / `isGeminiApi` / `isBedrockApi` (ADR-012) |
| Tool JSON repair | `packages/pi-ai/src/utils/repair-tool-json.ts` | `hasXmlParameterTags` / `repairToolJson` for CLI stream adapters |
| Config value helpers | `packages/pi-coding-agent/src/core/resolve-config-value.ts` | Allowed command prefix resolution |
| Skills loader | `packages/pi-coding-agent/src/core/skills.ts` | Host skill discovery re-exports |
| Shell helpers | `packages/pi-coding-agent/src/utils/shell.ts` | Process-tree kill + command sanitize |
| Provider display names | `packages/pi-coding-agent/src/core/provider-display-names.ts` | Built-in provider label map for interactive auth selectors |
| Slash commands list | `packages/pi-coding-agent/src/core/slash-commands.ts` | Browser-safe builtin list (no `config.ts` / Node fs import) |
| Codex responses stream | `packages/pi-ai/src/api/openai-codex-responses.ts` | GSD-friendly nested Codex error formatting |
| Provider readiness | `packages/pi-coding-agent/src/core/provider-readiness.ts` | External-CLI settleReadiness / isReady policy |
| Bash tool | `packages/pi-coding-agent/src/core/tools/bash.ts` | GSD timeout_ms schema and session env guards |
| Extension discovery | `packages/pi-coding-agent/src/core/extension-discovery.ts` | Export getAliases for GSD extension loader |
| Resource loader | `packages/pi-coding-agent/src/core/resource-loader.ts` | extensionPathsTransform for installed extensions |
| TUI terminal | `packages/pi-tui/src/terminal.ts` | Non-TTY / isTTY guards for GSD tests |
| TUI main screen | `packages/pi-tui/src/tui-main-screen.ts` | GSD differential main-screen render |
| TUI alignment | `packages/pi-tui/src/tui-main-screen-alignment.ts` | Shrink/seam helpers for differential render |
| OAuth providers list | `packages/pi-ai/src/oauth-gsd-compat.ts` | Descriptor-only built-in OAuth catalog (incl. xAI) for onboarding `oauthAvailable`; login via ModelRuntime |
| Env API key vars | `packages/pi-ai/src/env-api-keys.ts` | Export `getApiKeyEnvVars` for GSD auth selector UI |
| Tool argument normalization tests | `packages/pi-ai/src/utils/tests/normalize-tool-arguments.test.ts` | Regression coverage for shared validation/transcript argument normalization |
| **Claude tool schemas** | `packages/pi-ai/src/providers/google-shared.ts` | Cloud Code Assist / Claude `input_schema` sanitization (`toClaudeInputSchemaRoot`, `normalizeClaudeToolSchemaForGoogle`) |
| **Claude schema tests** | `packages/pi-ai/test/google-shared-convert-tools.test.ts`, `src/resources/extensions/gsd/tests/claude-tool-schema-golden.test.ts` | Golden B regression |
| OAuth cache breakpoint | `packages/pi-ai/src/providers/anthropic.ts` (`buildParams`) | Drop `cache_control` from the constant Claude Code identity block when a real system prompt follows — the trailing breakpoint already covers it; saves one of Anthropic's 4 cache breakpoints |
| OAuth cache breakpoint test | `packages/pi-ai/test/cache-retention.test.ts` | Regression coverage for single-breakpoint OAuth system array |
| `cacheRetention` passthrough | `packages/pi-agent-core/src/agent.ts` (`AgentOptions.cacheRetention`, `Agent.cacheRetention`, `createLoopConfig`) | Threads a settable prompt-cache TTL preference into `AgentLoopConfig`/`StreamOptions` — previously the field existed on `StreamOptions` but nothing populated it for the `Agent` class (only the separate, unused `AgentHarness` had it) |
| `cacheRetention` passthrough test | `packages/pi-agent-core/test/agent.test.ts` | Regression coverage for `cacheRetention` reaching `streamFn` options, pattern-matched off the existing `sessionId` passthrough test |
| `cacheRetention` setting test | `packages/pi-coding-agent/test/settings-manager.test.ts` | Regression coverage for `getCacheRetention`/`setCacheRetention` persistence, pattern-matched off `httpIdleTimeoutMs` |
| Theme path | `packages/pi-coding-agent/src/theme/` | Shared theme (not under `modes/`) |
| Copy assets | `packages/pi-coding-agent/scripts/copy-assets.cjs` | Theme + LSP assets |
| Root staging | `scripts/copy-themes.cjs`, `scripts/copy-export-html.cjs` | Bun binary / pkg layout |

## CI boundary

```bash
npm run verify:pi-boundary
npm run verify:pi-patches
```

Fails if `packages/pi-*/src/` imports `@gsd/agent-*` or `@opengsd/*` outside the allowlist, or if pi-* files change without `patchAllowlist` coverage.

`verify:pi-boundary` also chains `bash scripts/check-mcp-bridge-boundary.sh`, which fails if `packages/mcp-server/src/workflow-tools.ts` imports core GSD extension modules (`bootstrap/write-gate`, `bootstrap/dynamic-tools`, `gsd-db`, `state`, `preferences`, `db-writer`, `doctor`, `journal`, `milestone-ids`) directly instead of through `src/resources/extensions/gsd/mcp-bridge.ts`.

## Tool schema authoring

GSD extension tools must pass golden B when sanitized for Claude. Authoring rules: [tool-schema-authoring.md](./tool-schema-authoring.md).

## Legacy names

Docs and extension loader still accept `@mariozechner/pi-*` during transition. New code should reference `earendil-works/pi` and `@earendil-works/pi-*`.

## Known limitations after v0.75.5 vendor

- **Provider discovery** is wired via `ModelRegistry.discoverModels()` + `model-discovery.ts` adapters; cache at `~/.pi/agent/discovery-cache.json`. Static providers (Anthropic, Bedrock) still have no runtime discovery.
- **GSD content blocks** (`serverToolUse`, `webSearchResult`) use type guards in agent-modes (`gsd-content-blocks.ts`) rather than extending upstream `AssistantMessage.content` unions (avoids breaking pi-ai providers).
- **Extension context** uses optional `setCompactionThresholdOverride` and legacy keybinding action names; upstream uses `app.*` keybinding IDs internally.
- **Cloud Code Assist** requires strict Claude tool schemas; sanitizer in `google-shared.ts` plus golden B tests are mandatory overlay deltas.
