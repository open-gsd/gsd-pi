# Pi v1.6.1 overlay delta

Disposition of every file under `scripts/pi-overlay/` against earendil-works/pi **v1.6.1** (`ef4a1cf`).
Path mapping matches `scripts/pi-upstream.json`: `packages/pi-agent-core` → `packages/agent`, `packages/pi-ai` → `packages/ai`, `packages/pi-tui` → `packages/tui`, `packages/pi-coding-agent` → `packages/coding-agent`.

v0.75.5 (`89ba72c`, the current pin) is used only to tell a GSD-only insertion from an edit in a region v1.6.1 also rewrote. `@gsd/pi-*` versus `@earendil-works/pi-*`, and `.js` versus `.ts` import suffixes, are treated as mechanical.

| path | disposition | evidence |
| --- | --- | --- |
| `packages/pi-agent-core/src/agent.ts` | conflict | The overlay threads `cacheRetention`, `latencyMark`, and `abort(origin)` through the constructor and `agent_end`; v1.6.1 rewrote that constructor and `Agent.abort()` still takes no origin. |
| `packages/pi-agent-core/test/agent.test.ts` | still-needed | The overlay adds latency-mark, `abortOrigin`, and `cacheRetention` cases that v1.6.1 `agent.test.ts` does not contain, and those insertions do not overlap v1.6.1's edits to the v0.75.5 test. |
| `packages/pi-ai/src/models/fake-model.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `packages/ai/src/models/fake-model.ts`; this file registers the `gsd-fake` model behind `GSD_FAKE_LLM_TRANSCRIPT`. |
| `packages/pi-ai/src/providers/anthropic.ts` | conflict | v1.6.1 replaced this client with a 90-line provider factory, and `api/anthropic-messages.ts` still sets `cache_control` on both OAuth system blocks where the overlay keeps a single breakpoint on the last block. |
| `packages/pi-ai/src/providers/fake.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `packages/ai/src/providers/fake.ts`; this file is the JSONL replay provider gated on `GSD_FAKE_LLM_TRANSCRIPT`. |
| `packages/pi-ai/src/providers/google-shared.ts` | missing-upstream | v1.6.1 deleted `providers/google-shared.ts` (the module is now `api/google-shared.ts`) and that successor has neither `normalizeClaudeToolSchemaForGoogle` nor `skip_thought_signature_validator`. |
| `packages/pi-ai/src/providers/mistral.ts` | conflict | v1.6.1 replaced this streaming client with a 15-line `mistralProvider` factory, so the overlay's SDK v2 message typing and lazy `Mistral` import have no remaining body on this path. |
| `packages/pi-ai/src/providers/provider-capabilities.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `provider-capabilities.ts`; this file is the GSD provider capability registry from ADR-005. |
| `packages/pi-ai/src/utils/tests/normalize-tool-arguments.test.ts` | missing-upstream | v1.6.1 has no `normalize-tool-arguments` test or helper; the overlay test covers GSD empty-path argument normalization. |
| `packages/pi-ai/test/cache-retention.test.ts` | still-needed | The overlay adds an OAuth case that expects no `cache_control` on `system[0]` when a system prompt exists, and v1.6.1's copy of this test still expects `system[0].cache_control`. |
| `packages/pi-ai/test/google-shared-convert-tools.test.ts` | conflict | Both sides rewrote this test's imports and schema cases: the overlay collapses Claude const-unions and strips `$ref`, while v1.6.1 imports `api/google-shared` and keeps `$ref`. |
| `packages/pi-coding-agent/scripts/copy-assets.cjs` | missing-upstream | v1.6.1 has no `scripts/copy-assets.cjs`; its `copy-assets` npm script copies `modes/interactive/theme`, while this overlay copies `src/theme`. |
| `packages/pi-coding-agent/src/core/artifact-manager.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `artifact-manager.ts`; the overlay is a re-export of `@gsd/agent-core`. |
| `packages/pi-coding-agent/src/core/blob-store.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `blob-store.ts`; the overlay is a re-export of `@gsd/agent-core`. |
| `packages/pi-coding-agent/src/core/capability-patches.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `capability-patches.ts`; the overlay applies GSD capability flags onto models. |
| `packages/pi-coding-agent/src/core/constants.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `src/core/constants.ts`; the overlay holds GSD timing and lock constants. |
| `packages/pi-coding-agent/src/core/db-snapshot.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `db-snapshot.ts`; the overlay adds `atomicWriteDbSnapshotSync`. |
| `packages/pi-coding-agent/src/core/discovery-cache.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `discovery-cache.ts`; the overlay is the on-disk `ModelDiscoveryCache`. |
| `packages/pi-coding-agent/src/core/extension-session-types.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `extension-session-types.ts`; the overlay re-exports session types from `@gsd/agent-core`. |
| `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts` | missing-upstream | v1.6.1 has no `extension-upstream-types.ts`; this 1761-line file is the peeled copy of extension types, while v1.6.1 grew `extensions/types.ts` to 2366 lines. |
| `packages/pi-coding-agent/src/core/extensions/loader.ts` | conflict | Both rewrote the extension alias maps: the overlay adds `@gsd/agent-core` and `@gsd/agent-modes`, and v1.6.1 retargets `@earendil-works/pi-ai` to a compat view plus `providers/all` and `models` entries. |
| `packages/pi-coding-agent/src/core/extensions/types.ts` | conflict | The overlay replaced this module with a 65-line barrel over `gsd-extension-types` and `extension-upstream-types`; v1.6.1 kept the original types module and grew it to 2366 lines. |
| `packages/pi-coding-agent/src/core/fallback-resolver.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `fallback-resolver.ts`; the overlay is a re-export of `@gsd/agent-core`. |
| `packages/pi-coding-agent/src/core/gsd-extension-types.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `gsd-extension-types.ts`; the overlay holds GSD extension events such as session switch, fork, and unit boundaries. |
| `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `gsd-seam-types.ts`; the overlay holds seam types (`BashResult`, compaction, file operations) so extensions avoid importing GSD packages. |
| `packages/pi-coding-agent/src/core/keybindings.ts` | conflict | The overlay is a 7-line re-export from `@gsd/agent-core`; v1.6.1 still has a 359-line keybindings implementation on this path. |
| `packages/pi-coding-agent/src/core/lifecycle-hooks.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `lifecycle-hooks.ts`; the overlay is a re-export of `@gsd/agent-core`. |
| `packages/pi-coding-agent/src/core/local-model-check.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `local-model-check.ts`; the overlay adds `isLocalModel`. |
| `packages/pi-coding-agent/src/core/model-discovery.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `model-discovery.ts`; the overlay is the runtime provider discovery adapters. |
| `packages/pi-coding-agent/src/core/model-registry.ts` | conflict | The overlay extends the v0.75.5 registry with a models-catalog overlay, discovery, and auth modes; v1.6.1 replaced this path with a 244-line `ModelRuntime` facade that has none of those. |
| `packages/pi-coding-agent/src/core/models-json-writer.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `models-json-writer.ts`; the overlay is the locked `models.json` writer. |
| `packages/pi-coding-agent/src/core/package-commands.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `package-commands.ts`; the overlay runs install, remove, update, and list through lifecycle hooks. |
| `packages/pi-coding-agent/src/core/session-cwd.ts` | upstream-now | After scope normalization the overlay matches v0.75.5, and v1.6.1 already replaced the missing-cwd prompt and added `getMissingSessionCwdOptions`. |
| `packages/pi-coding-agent/src/core/settings-manager.ts` | conflict | The overlay adds `cacheRetention`, `adaptiveMode`, memory, and fallback on the inline settings types; v1.6.1 moved `Settings` to `settings-schema.ts`, which has none of those fields. |
| `packages/pi-coding-agent/src/core/system-prompt.ts` | conflict | The overlay is a 2-line re-export from `@gsd/agent-core`; v1.6.1 still has a 228-line `buildSystemPrompt` on this path. |
| `packages/pi-coding-agent/src/core/tools/bash-interceptor.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `bash-interceptor.ts`; the overlay blocks shell commands that duplicate dedicated tools. |
| `packages/pi-coding-agent/src/core/tools/tool-compatibility-registry.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `tool-compatibility-registry.ts`; the overlay is the ADR-005 tool compatibility map. |
| `packages/pi-coding-agent/src/theme/theme-highlight.test.ts` | missing-upstream | v1.6.1 has no `src/theme/`; this test covers the GSD plain-text highlight fallback, and upstream highlighting lives under `modes/interactive/theme`. |
| `packages/pi-coding-agent/src/theme/theme-schema.ts` | missing-upstream | v1.6.1 has no `src/theme/theme-schema.ts`; its schema is `modes/interactive/theme/theme-schema.ts`. |
| `packages/pi-coding-agent/src/theme/theme.ts` | missing-upstream | v1.6.1 has no `src/theme/theme.ts`; `modes/interactive/theme/theme.ts` highlights through `syntax-highlight.ts` and has no `GSD_ENABLE_NATIVE_TUI_HIGHLIGHT` gate. |
| `packages/pi-coding-agent/src/theme/themes.ts` | missing-upstream | v1.6.1 has no `src/theme/themes.ts`; builtin themes are loaded from `modes/interactive/theme` JSON. |
| `packages/pi-coding-agent/test/settings-manager.test.ts` | still-needed | The overlay adds `cacheRetention` and `terminal.toolsExpanded` cases and resolves the project dir through `CONFIG_DIR_NAME`, while v1.6.1's test still writes `.pi/settings.json` and has neither case. |
| `packages/pi-tui/src/editor-keybindings.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `editor-keybindings.ts`; editor cursor actions in v1.6.1 are entries on `src/keybindings.ts`. |
| `packages/pi-tui/src/style.ts` | missing-upstream | v1.6.1 and v0.75.5 have no `src/style.ts`; this file is the GSD framed-terminal style helper (`TerminalBorderStyle`, density, tone). |

## Counts

| disposition | count |
| --- | ---: |
| still-needed | 3 |
| upstream-now | 1 |
| conflict | 10 |
| missing-upstream | 30 |
| total | 44 |

## Files that block moving the pin

A file blocks the pin when the overlay cannot be dropped and cannot be copied onto the same v1.6.1 path. That is every `conflict` row, plus `missing-upstream` rows that are a fork of a module v1.6.1 still ships somewhere else.

`still-needed` tests are insertions on files that still exist; port the cases, they are not same-area merges. `session-cwd.ts` (`upstream-now`) can be dropped. The other `missing-upstream` files were in neither v0.75.5 nor v1.6.1; they stay extra files and do not block the checkout.

Conflict:

- `packages/pi-agent-core/src/agent.ts`
- `packages/pi-ai/src/providers/anthropic.ts`
- `packages/pi-ai/src/providers/mistral.ts`
- `packages/pi-ai/test/google-shared-convert-tools.test.ts`
- `packages/pi-coding-agent/src/core/extensions/loader.ts`
- `packages/pi-coding-agent/src/core/extensions/types.ts`
- `packages/pi-coding-agent/src/core/keybindings.ts`
- `packages/pi-coding-agent/src/core/model-registry.ts`
- `packages/pi-coding-agent/src/core/settings-manager.ts`
- `packages/pi-coding-agent/src/core/system-prompt.ts`

Missing upstream path with a diverged successor:

- `packages/pi-ai/src/providers/google-shared.ts`
- `packages/pi-coding-agent/scripts/copy-assets.cjs`
- `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts`
- `packages/pi-coding-agent/src/theme/theme-highlight.test.ts`
- `packages/pi-coding-agent/src/theme/theme-schema.ts`
- `packages/pi-coding-agent/src/theme/theme.ts`
- `packages/pi-coding-agent/src/theme/themes.ts`
