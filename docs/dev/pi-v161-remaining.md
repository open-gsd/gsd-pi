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

## Follow-ups

1. **Readiness probe.** Done. `isProviderRequestReady` uses a registered provider's `isReady` before auth presence, and `settleProviderReadiness` waits for the async probe. Covered by `src/tests/model-registry-settle-readiness.test.ts`.
2. **Richer latency marks.** Only `first_stream_activity` is emitted; older multi-phase marks are not in the v1.6.1 loop.
3. **Reduce host shims.** Prefer upstream APIs over long-lived GSD stubs in `pi-tui` / `pi-coding-agent` where possible.
4. **Upstream agent tests.** Done for the read-only `AgentState.systemPrompt`. `packages/pi-agent-core/test/agent.test.ts` updates the prompt through the transcript and uses an inline model, so it does not call catalog `getModel`.
5. **Docs.** The runbook, ADR-010 pin sentence, overlay-delta pin note, and host-coupling status now say the pin is v1.6.1 and that theme loads from `src/theme/`. Per-file rows in `pi-overlay-triage.md` are still the generic "v1.6.1 pin port or GSD-only" label.
