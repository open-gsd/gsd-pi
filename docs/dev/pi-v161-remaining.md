# What is left before the Pi pin is v1.6.1

The running engine stays `v0.75.5`. `node scripts/sync-pi-engine.cjs --dest <outside-repo> --ref v1.6.1` builds the next engine outside `packages/pi-*`. For that tag, the 17 conflict paths and `session-cwd.ts` are not copied from the v0.75.5 overlay. `scripts/pi-161-ports.cjs` reapplies the behavior that still has a home on the v1.6.1 files.

## Done on the external v1.6.1 tree

| Behavior | Where it lands |
| --- | --- |
| One OAuth cache breakpoint | `packages/pi-ai/src/api/anthropic-messages.ts` |
| `cacheRetention`, optional `abort(origin)`, `latencyMark` field | `packages/pi-agent-core/src/agent.ts` and `types.ts` |
| `@gsd/agent-core`, `@gsd/agent-modes`, and `@gsd/pi-*` loader aliases | `packages/pi-coding-agent/src/core/extensions/loader.ts` |
| `cacheRetention`, `adaptiveMode`, memory, and fallback | `settings-schema.ts` and `settings-manager.ts` |
| Claude tool-schema sanitizer and the Gemini 3 unsigned-call sentinel | `api/claude-tool-schema.ts` and `api/google-shared.ts` |
| Plain highlight unless `GSD_ENABLE_NATIVE_TUI_HIGHLIGHT=1` | `modes/interactive/theme/theme.ts` |
| Old `theme/theme.ts` import path | re-export shim |
| `GsdProgressState` and extension type names | small `extension-upstream-types.ts` shim over `types.ts` |
| `isProviderRequestReady` and `settleProviderReadiness` | v1.6.1 `ModelRegistry` facade over `ModelRuntime` |
| Mistral `x-affinity` | already in `api/mistral-conversations.ts`; the old client is not copied |
| `keybindings.ts`, `system-prompt.ts`, `extensions/types.ts` | left as the v1.6.1 modules |
| `copy-assets` | left as the v1.6.1 script, which already copies `modes/interactive/theme` |

## Still required before `pinnedRef` changes

Changing `pinnedRef` and copying this tree into `packages/pi-*` is the pin move. These items still block it:

1. **Host construction of `ModelRegistry`.** v1.6.1 takes a `ModelRuntime`. `packages/gsd-agent-core` and `packages/gsd-agent-modes` still call `new ModelRegistry(authStorage, modelsJsonPath)`.
2. **`latencyMark` is stored and not emitted.** v1.6.1 `agent-loop.ts` has no call site. First-stream timing in `agent-session-prompt.ts` stays silent until those marks are ported into the loop.
3. **Readiness is auth presence.** `isProviderRequestReady` delegates to `ModelRuntime.hasConfiguredAuth`. The old external-CLI probe cache is not ported.
4. **Deep-import API drift.** The host map in `docs/dev/pi-v161-host-coupling.md` still imports session, message, tool, and theme symbols through `@gsd/pi-coding-agent/<subpath>`. Those modules moved or changed shape between v0.75.5 and v1.6.1. The theme and extension shims cover two paths; the rest need a typecheck of `gsd-agent-core` and `gsd-agent-modes` against the generated tree.
5. **Patch gate.** `verify-pi-patches` treats every diff against `main` under `packages/pi-*` as an allowlisted patch. A pin move has to treat a file that matches the pinned upstream tree as not a patch, or the fast gate rejects the whole vendor.
6. **Do not point `@gsd/pi-*` at the published npm packages.** v1.6.1 exports package roots, not `./*`. The generated workspace packages stay the runtime.
