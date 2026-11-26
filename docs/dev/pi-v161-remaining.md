# Pi v1.6.1 pin — status

`scripts/pi-upstream.json` `pinnedRef` is **`v1.6.1`**. Vendored packages under `packages/pi-*` (including new `pi-schema`, `pi-telemetry`, `pi-mcp`, `pi-codemode`) build. `@gsd/agent-core` and `@gsd/agent-modes` typecheck against the pin. Patch and boundary gates pass.

## Landed with this pin

| Item | Status |
| --- | --- |
| External sync + `pi-161-ports` + install into `packages/pi-*` | done |
| Theme staged to `src/theme` before seam deletes `modes/` | done |
| Host `ModelRegistry.create` / `ModelRuntime` construction | done |
| `latencyMark` → `agent_loop.first_stream_activity` in `agent-loop.ts` | done |
| `abortOrigin` enriched on `agent_end` when the run signal is aborted | done |
| Deep `@gsd/pi-*` workspace packages (not npm aliases) | done |
| Package export map for mcp/codemode/telemetry/ai subpaths | done |
| Host API shims for TUI/extension/settings drift | done |
| Ported tests: `agent.test.ts`, `cache-retention.test.ts` (OAuth breakpoint), `settings-manager.test.ts` | done |
| `verify-pi-patches` / `verify-pi-boundary` | green |

## Follow-ups (non-blocking for the pin)

1. **Readiness probe.** `isProviderRequestReady` still delegates to auth presence (`ModelRuntime.hasConfiguredAuth`); the old external-CLI probe cache is not restored.
2. **Richer latency marks.** Only `first_stream_activity` is emitted; older multi-phase marks are not in the v1.6.1 loop.
3. **Reduce host shims.** Prefer upstream APIs over long-lived GSD stubs in `pi-tui` / `pi-coding-agent` where possible.
4. **Skip/adapt remaining upstream tests** that assume mutable `AgentState.systemPrompt` or catalog `getModel` without generated models.
5. **Docs.** Refresh `pi-v161-host-coupling.md` / overlay triage for the expanded package map and theme path.
