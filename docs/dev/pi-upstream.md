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

1. **Ensure seam is green** — run verification commands above on current pin before touching upstream.
2. **Vendor upstream** (does not touch GSD packages):
   ```bash
   node scripts/vendor-pi.cjs --ref vX.Y.Z
   ```
   Or stepwise:
   ```bash
   node scripts/vendor-pi-deps.cjs --ref vX.Y.Z          # pi-ai, pi-agent-core, pi-tui
   node scripts/vendor-pi-coding-agent-core.cjs --ref vX.Y.Z
   node scripts/apply-seam.cjs                           # post-vendor deletes, import rewrites, boundary verify
   ```
   Seam config: `scripts/pi-seam.json` (forbidden paths, protected files, import rewrites, theme/tool fixes).
3. **Reconcile GSD shims** — re-apply every path in `patchAllowlist`. Prefer **incremental shims** over restoring entire pre-vendor GSD files (HEAD restore of `model-registry.ts` / `settings-manager.ts` broke v0.75.5 compat in Phase 2).
4. **Normalize package.json** — preserve `@gsd/pi-*` names, `gsd.linkable`, workspace `tsc` build scripts, and subpath exports (`./*` → `./dist/*`).
5. **Fix import extensions** — GSD uses Node16 `.js` suffix imports; upstream may use `.ts` for `tsgo`. Bulk-fix or adopt upstream `tsconfig.build.json` if switching compilers.
6. **Merge dependency deltas** — upstream may rename packages (`typebox` vs `@sinclair/typebox`). Merge without dropping `@gsd/native` shims.
7. **Build GSD layers** — errors should surface in `@gsd/agent-core` and `@gsd/agent-modes`, not in vendored pi-* except documented shims.
8. **Session event migration** (pi ≥ 0.65): use `session_start` + `reason` instead of deprecated `session_switch` / `session_fork` / `session_directory`.
9. **Update pin** in `scripts/pi-upstream.json` and note manual patches in this file.
10. **Verify** — full verification block above (+ optional live Cloud Code Assist smoke — see execution plan “Golden C”).

## GSD patches that must survive vendoring

Every row must have a matching entry in `scripts/pi-upstream.json` → `patchAllowlist`.

| Area | Location | Purpose |
|---|---|---|
| Clean seam | `packages/gsd-agent-core`, `packages/gsd-agent-modes` | Session, SDK, modes, CLI |
| Type seam | `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | Avoid compile-time pi ↔ agent-core cycle |
| Session types | `packages/pi-coding-agent/src/core/extension-session-types.ts` | Re-export session types from `@gsd/agent-core` |
| Ambient shim | `packages/pi-coding-agent/src/agent-core.d.ts` | Extension types without package dep |
| Extension loader | `packages/pi-coding-agent/src/core/extensions/loader.ts` | `@gsd/agent-*`, `@earendil-works/*` aliases |
| GSD core files | `model-discovery.ts`, `discovery-cache.ts`, `models-json-writer.ts`, `package-commands.ts`, `local-model-check.ts`, `capability-patches.ts`, `bash-interceptor.ts`, `constants.ts` | Provider discovery, offline mode, capability patches |
| Keybindings | `packages/gsd-agent-core/src/keybindings.ts` | Legacy `AppAction` names + `app.*` keybinding map (pi re-exports via shim) |
| Model registry shims | `packages/pi-coding-agent/src/core/model-registry.ts` | `discoverModels`, `isAllLocalChain`, `getApiKey`, GSD auth modes |
| Settings shims | `packages/pi-coding-agent/src/core/settings-manager.ts` | Adaptive TUI, compaction override, gitignore picker |
| Interactive stream dedup | `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts`, `packages/gsd-agent-modes/src/modes/interactive/components/chat-turn-connect.ts` | Reconcile mismatched tool IDs across event streams |
| pi-tui shims | `style.ts`, `editor-keybindings.ts`, `Container.detachChildren`, `Markdown.maxLines`, `Input.secure`, `Image.getDimensions` | GSD interactive mode compat |
| pi-ai shims | `ServerToolUse` / `WebSearchResult` types, `server_tool_use` event, `supportsXhigh()` | GSD content blocks + thinking level |
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
