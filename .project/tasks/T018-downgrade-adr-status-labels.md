---
id: T018
title: Downgrade ADR-004/-009/-011/-013/-036 status labels to audit-verified reality
wave: 3
deps: []
status: done
agent: build_T018
commit: f26c624af8dc4a4ea471c003ad13e38e32642ba2
base: 291e71c154aac359be01cc38a34dccd992ab47b4
worktree: .worktrees/gsd-path-T018
task_branch: gsd-path/T018
files:
  - docs/dev/ADR-004-capability-aware-model-routing.md
  - docs/dev/ADR-009-orchestration-kernel-refactor.md
  - docs/dev/ADR-011-progressive-planning-escalation.md
  - docs/dev/ADR-013-memory-store-consolidation.md
  - docs/dev/ADR-036-tool-surface-readiness.md
---

# T018 — Fix-doc: downgrade five ADR status labels to match code reality

## Context

User-accepted fix-doc item (DOCS-AUDIT.md remediation rows 11–15, ruled
2026-08-01): "an ADR labeled Implemented that the auditor can't find is
worse than one honestly labeled Accepted, partially landed". The audit
verdict for each of the five is `unverifiable` from code at HEAD:
- ADR-004 `Status: Implemented (Phase 2)` — capability-routing greps
  inconclusive.
- ADR-009 `Status: Accepted (implemented; emergency legacy fallback
  retained)` — no `OrchestrationKernel` symbol found by name.
- ADR-011 `Status: Accepted (mostly implemented)` — escalation greps match
  unrelated recovery code.
- ADR-013 `Status: Accepted (mostly implemented — Phase 6
  preflight/cutover)` — memory-store greps inconclusive.
- ADR-036 `Status: Accepted (implemented)` — no tool-surface-readiness
  symbol found by name.

## Steps

1. For each ADR, do a targeted code trace at HEAD (not just greps): find
   what actually landed relative to the ADR's scope, and pick the honest
   replacement label from this fixed vocabulary: `Accepted (partially
   landed — <what exists>)`, `Accepted (landed under different names —
   <where>)`, or `Accepted (implementation not verified at HEAD)`. Do NOT
   use `Implemented` anywhere the trace cannot confirm it.
2. Replace ONLY the Status line (and, where the body asserts completion
   that the trace contradicts, append a one-line `> Implementation note
   (2026-08-01 audit): …` directly under the Status line citing what the
   trace found). Do not rewrite the ADR bodies.
3. Record the per-ADR trace evidence (symbols/paths found or not found) in
   the task Log.

## Acceptance criteria

1. No Status line in the five files claims `Implemented` or
   `(implemented)`/`(mostly implemented)` without trace evidence recorded
   in the Log.
2. Each file's new label comes from the fixed vocabulary and matches its
   trace.
3. Audit claim check re-run: each Status claim is now confirmable or
   honestly labeled unconfirmed.

## Verify

```bash
! grep -nE "^\*\*Status:\*\*.*([Ii]mplemented)" docs/dev/ADR-004-capability-aware-model-routing.md docs/dev/ADR-009-orchestration-kernel-refactor.md docs/dev/ADR-011-progressive-planning-escalation.md docs/dev/ADR-013-memory-store-consolidation.md docs/dev/ADR-036-tool-surface-readiness.md && grep -lE "partially landed|landed under different names|implementation not verified" docs/dev/ADR-004-capability-aware-model-routing.md docs/dev/ADR-009-orchestration-kernel-refactor.md docs/dev/ADR-011-progressive-planning-escalation.md docs/dev/ADR-013-memory-store-consolidation.md docs/dev/ADR-036-tool-surface-readiness.md | wc -l | grep -q 5
```

## Log

- 2026-08-01 — created by planner
- 2026-08-05 — coder: traced each ADR against HEAD, then replaced only the
  Status line in each of the five files and appended a one-line
  `> Implementation note (2026-08-01 audit): …` under it. No ADR bodies rewritten.

  Per-ADR trace evidence:

  - **ADR-004** (was `Implemented (Phase 2)`, now `landed under different names`):
    FOUND `ModelCapabilities`, `MODEL_CAPABILITY_PROFILES:171`, `BASE_REQUIREMENTS:238`,
    `computeTaskRequirements:277`, `selectionMethod:47` in
    `src/resources/extensions/gsd/model-router.ts`; `loadCapabilityOverrides` +
    `pi.emitBeforeModelSelect` at `auto-model-selection.ts:799,811`; hook registered at
    `bootstrap/register-hooks.ts:2021`; 371-line `tests/capability-router.test.ts`.
    So the capability router landed in CORE (the ADR's Phase 3 shape), while the Phase 2
    "prototype as an extension" step the status label named never existed as such.
  - **ADR-009** (was `Accepted (implemented; …)`, now `landed under different names`):
    NOT FOUND any `OrchestrationKernel` / `PlanPlane` / `GitOpsPlane` / `AuditPlane` /
    `ExecutionPlane` symbol. FOUND the kernel under `src/resources/extensions/gsd/uok/`:
    `kernel.ts`, `gate-runner.ts`, `gitops.ts`, `audit.ts`, `model-policy.ts`,
    `plan-v2.ts`, `execution-graph.ts`, `contracts.ts`, `parity-report.ts` (15 files),
    imported by ~15 gsd modules. Legacy fallback is real: `uok/kernel.ts:54-67`
    (`"legacy-fallback"` path label) and `incrementLegacyTelemetry("legacy.uokFallbackUsed")`
    at `uok/kernel.ts:188`. Body already carries an ADR-046 disposition marking this design
    non-current.
  - **ADR-011** (was `mostly implemented`, now `partially landed`): FOUND every Phase 1/2
    evidence row — `db-base-schema.ts:174-175` (`is_sketch`, `sketch_scope`),
    `types.ts:425` (`progressive_planning`), `escalation.ts`, `uok/gate-runner.ts`,
    `prompts/refine-slice.md`, `buildRefineSlicePrompt` (`auto-prompts.ts:2690`, dispatched
    `auto-dispatch.ts:1450`), `state-reconciliation/drift/sketch-flag.ts`,
    `tests/progressive-planning.test.ts`. NOT FOUND: the two Outstanding (#5754) rows
    (full-pipeline e2e test, refine-slice UOK audit events). Note: the auditor's original
    greps matched unrelated recovery code because the escalation surface is named
    `escalation.ts` / `refine-slice`, not "escalate".
  - **ADR-013** (was `mostly implemented — Phase 6 preflight/cutover`, now
    `partially landed`): FOUND `structured_fields` at `db-base-schema.ts:80`,
    `bootstrap/memory-tools.ts`, `memory-backfill.ts`, `memory-consolidation-scanner.ts`;
    confirmed `db-writer.ts` no longer calls `db.upsertDecision` (only the reversal comment
    at `db-writer.ts:563` mentions it), i.e. the Phase 6 cutover DID land — the old label
    understated it. NOT FOUND the drop: `decisions` table still created at
    `db-base-schema.ts:20` and `active_decisions` view at `db-base-schema.ts:414`, so #5756
    is genuinely outstanding.
  - **ADR-036** (was `Accepted (implemented)`, now `partially landed`): FOUND
    `getToolSurfaceReadinessError` at `tool-surface-readiness.ts:356`, wired in
    `claude-code-cli/stream-adapter.ts:68,2079`; `TOOL_SURFACE_NOT_READY` phrase constant at
    `tool-surface-readiness.ts:32` (asserted in `stream-adapter.test.ts:2870-2874`);
    `"tool-unavailable"` kind at `recovery-classification.ts:14,86,104` +
    `recovery-policy.ts:100` + `guidance.ts:40`; `warmWorkflowToolBridges` at
    `packages/mcp-server/src/workflow-tools.ts:982`; `pid-registry.ts`, `stdio-watchdog.ts`,
    `probe-mode.ts`; `unit-tool-contracts.ts`; `CanonicalWorkflowToolName` at
    `packages/contracts/src/workflow.ts:302`. The auditor's "no symbol found by name" was a
    miss — every table row verifies except the self-declared deferred static-gate fold,
    which is why the label is `partially landed` rather than implemented.

  Verify (run in worktree root): exit 0 — the `! grep …Status…implemented` half found no
  offending Status line, and all 5 files match the fixed-vocabulary phrase set.
- 2026-08-05 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — no Status line claims "implemented"; all five ADRs carry a
  fixed-vocabulary label. Diff scope check: 5 declared files plus the task
  file; zero paths outside `files`.
