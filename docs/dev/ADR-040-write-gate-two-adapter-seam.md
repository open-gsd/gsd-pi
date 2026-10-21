# ADR-040: Write-gate two-process seam — host/child adapters, merged snapshot writes

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Superseded.** Cross-process write coordination and fail-closed protected actions remain valid requirements. File-backed host/child snapshot adapters are replaced by atomic Domain Operations with expected revisions, fencing, idempotency, and a monotonic Authority Epoch.

## Status

Accepted (2026-06-12)

## Context

Write-gate state has two writers — the host process and the MCP child (which dynamically imports the host's compiled `write-gate.js` via `GSD_WORKFLOW_WRITE_GATE_MODULE`) — coordinating through a whole-file snapshot (`.gsd/runtime/write-gate-state.json`) with last-writer-wins. Races were patched ad hoc: the host re-arm clobbering child verification was guarded at exactly one call site (`tool_execution_start`), while the same window on the `tool_call` defer path was unguarded; a single global `deferredApprovalGate` variable was shared across basePaths, so concurrent projects in one process could lose a deferred gate.

## Decision

The seam is named: `WriteGateStateAdapter` with two adapters.

- **Host adapter** — in-memory + reconcile-on-read. Merge rules (documented on `mergeSnapshotIntoState`): verifications are a grow-only union across processes; `pendingGateId`/`activeQueuePhase` disk wins (preserves refresh semantics and the delete-the-file escape hatch); **verified wins over pending** — a pending gate whose id/milestone is in the merged verified set is dropped (the old one-window guard, generalized into adapter policy). Host `setPending` returns suppressed when the gate is verified on disk.
- **Child adapter** — write-through, always-fresh read (load → mutate → persist), no cross-turn memory. Child `setPending` stays unconditional: a fresh question intentionally revokes verification.
- **Persist discipline**: every mutation is read-disk → merge → mutate → atomic temp+rename. The pre-persist read is unconditional, so a concurrent writer's update is always folded in — there is no version/epoch field (an epoch counter was originally added but no code path ever compared it, so it was removed as write-only bookkeeping). Snapshots carry a `writer: host|child` provenance tag, diagnostic only. Old snapshot files (with or without a stale `epoch` field) load unchanged; unknown fields are dropped on the next write. `resetWriteGateState` skips the merge (a reset must not resurrect disk verifications).
- **Ambient vs explicit**: the module-level exports (`setPendingGate`, `markDepthVerified`, …) select the adapter by env-sniffing `GSD_WORKFLOW_*` per call and are reserved for the child's dynamic-import surface; host-owned modules (register-hooks, auto-dispatch) call `hostWriteGateAdapter` explicitly so a leaked child env variable cannot flip host mutations to child semantics. In particular, `setPendingGate` delegates uniformly to the default adapter — in a host process it inherits the verified-on-disk-wins guard rather than bypassing it.
- Adapter selection rides the existing child-spawn env (`GSD_WORKFLOW_WRITE_GATE_MODULE`/`GSD_WORKFLOW_PROJECT_ROOT` present → child adapter); all exported function signatures are unchanged, so `packages/mcp-server` needed zero edits.
- `deferredApprovalGate` is per-basePath (`Map<basePath, gateId>`); the `tool_call` defer path now consults the reconciled snapshot, closing the second clobber window.

No file locking was introduced (Windows/sync-client risk); file-level atomicity (temp+rename, EXDEV fallback) and the `GSD_PERSIST_WRITE_GATE_STATE` opt-out are preserved.

## Consequences

- Host/child interleavings are deterministic adapter tests (`write-gate-seam.test.ts`): clobber windows, concurrent-write re-merge (unconditional read-merge-write), two-basePath deferral, legacy snapshot load.
- Every future two-process race is reasoned about inside the adapter pair, not at each hook site.
