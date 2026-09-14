# GSD Pi Stabilization Plan (v1.12+)

Project/App: gsd-pi  
File Purpose: Prioritized stabilization roadmap for broken features and regressions since the v1.12.0 DB-authority cutover (2026-08-03).

## Context

Since v1.12.0, GSD Pi shipped the state-DB cutover (#1627) and eight minor releases (through v1.20.0). Each release fixed dozens of wedge/livelock/closeout bugs, but several failure classes remain open. This plan groups them by subsystem, assigns priority, and tracks fix status.

**Current version:** 1.20.0  
**Open issues (total):** ~30  
**Agent-ready bugs:** 0 (as of 2026-09-13) — stabilization waves 1–8 complete

## Failure Taxonomy

Most post-1.12 bugs fall into six recurring classes:

| Class | Symptom | Examples |
|-------|---------|----------|
| **Wedge / livelock** | Auto-mode trips `completed-no-advance`, `finalize-retry`, or `finalize-break` and cannot recover | #2309, #2310, #2159, #1754 |
| **Closeout blocked** | Milestone/slice cannot close despite correct work | #2239, #2313, #2033 |
| **Provider / model** | Wrong error classification, missing failover, stale catalog | #2314, #2250, #2077 |
| **Verification / pre-exec** | False prose-heuristic rejections, attempt-scoped evidence gaps | #2290, #2259, #1994 |
| **Lifecycle / import** | Missing canonical lifecycle rows block progression | #2313, #2070, #1914 |
| **Platform / test debt** | Windows PATH, non-hermetic tests, pi-agent-core harness | #2086, #2139, #2140 |

## Wave 1 — Auto-mode wedge recovery (P0, shipped)

These bugs block `/gsd auto` with no sanctioned recovery path. Highest user impact.

| Issue | Title | Status | Branch |
|-------|-------|--------|--------|
| #2314 | Anthropic 400 "extra usage" pauses instead of failing over | **fixed** | `cursor/stabilization-wave1-3f39` |
| #2310 | `recheckWedge` never clears gate-evaluate `completed-no-advance` wedges | **fixed** | `cursor/stabilization-wave1-3f39` |
| #2309 | gate-evaluate background Agent dispatch drops second gate | **fixed** | `cursor/stabilization-wave1-3f39` |
| #2159 | False stale liveness wedges from interrupted closeouts | **fixed** | `cursor/stabilization-wave6-3f39` |
| #2267 | Manual blocker route omits `recoveryActionId` (regression of #1593) | **fixed** | `cursor/stabilization-wave2-3f39` |

### Wave 1 exit criteria

- `snapshotUnitTargetRows('gate-evaluate', …)` includes `quality_gates` verdict rows
- Anthropic "from your extra usage" errors classify as `rate-limit` and trigger fallback
- gate-evaluate prompt explicitly forbids `Agent` with `run_in_background: true`
- Tests green for `error-classifier`, `auto-liveness-backstop`, `gate-dispatch`

## Wave 2 — Closeout and lifecycle authority (P1, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2239 | Husk-task gates wedge milestone closeout | **fixed** | Husk filter + adopted-milestone gate closure in `closeout-consistency-gate.ts` |
| #2313 | Legacy slice cannot close without parent lifecycle authority | **fixed** | `repairMilestoneLifecycleShadowsForward` before `completeSlice` |
| #2033 | finalize-retry wedge without satisfiability pre-check | **fixed** | Wave 5 — `CLOSEOUT-VERIFICATION-FAILED` alias |
| #2126 | `/gsd park` no-ops on adopted milestones | **fixed** | Canonical `paused` transition + legacy `parked` projection |
| #2294 | validate-milestone verdict persistence blocked | **fixed** | Wave 5 — V49 schema + regression test |

## Wave 3 — Verification and pre-exec (P1, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2290 | Prose heuristic rejects grep patterns with English function words | **fixed** | Quoted-segment stripping (#2292); plan-time `validateVerificationCommand` |
| #2259 | Verification evidence accumulates task-scoped, not attempt-scoped | **fixed** | Latest `created_at` batch only; cleared on `task.reopen` |
| #1994 | `PROSE_MARKER_WORDS` is English-only | **fixed** | Language-neutral tail detection + positive command evidence |
| #2248 | Decisions register never enforced at `gsd_plan_task` write time | **fixed** | Wave 8 — plan-time decision guard + project-wide decision visibility |

## Wave 4 — Platform, provider, and test hygiene (P2, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2250 | GPT-6 Astra missing for Codex users | **fixed** | `gpt-6-astra` added to `openai-codex` in `generate-models.ts` |
| #2086 | Windows `env.PATH` shadows inherited `Path` in verify spawn | **fixed** | `prependPathEntry` in `verificationChildEnvironment` |
| #2139 | Copilot overlay quarantine test non-hermetic | **fixed** | `mkdtempSync` + cleanup in `copilot-model-catalog.test.ts` |
| #2114 | Custom provider headers broken in TUI mode | **fixed** | `loadCustomModels` persists headers/api/authHeader in `registeredProviders` |

## Wave 5 — Closeout refusal and startup resilience (P2, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2033 | complete-milestone deliberate refusal wedges as finalize-retry | **fixed** | `CLOSEOUT-VERIFICATION-FAILED` alias + named path in prompt |
| #2077 | startup `validateConfiguredModel` rewrites on transient unavailability | **fixed** | Preserve when model remains in catalog and provider is ready |
| #2294 | validate-milestone re-run cannot persist verdict | **fixed** | Regression test; V49 schema already allows interrupted→pass rerun |

## Wave 6 — Stale wedge GC and closeout resilience (P1, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2159 | False stale liveness wedges from interrupted closeouts | **fixed** | `garbageCollectResolvedWedges` on advance/complete/start; `clearAbandonedCloseoutSignatures`; `validate-milestone` snapshot rows |

## Wave 7 — Platform exchange resilience and test harness (P2, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2178 | Windows unbound-evidence resolution wedges projection writes | **fixed** | Copy+delete fallback + exchange-path restaging in `moveEvidenceIntoGuard` |
| #2140 | 26 pi-agent-core test failures on clean main | **fixed** | Vitest resolve aliases for `@earendil-works/pi-ai` → workspace `@gsd/pi-ai` |

## Wave 8 — Decisions register enforcement (P1, shipped)

| Issue | Title | Status | Notes |
|-------|-------|--------|-------|
| #2248 | Decisions register never enforced at `gsd_plan_task` write time | **fixed** | `validateVerifyAgainstActiveDecisions` in plan/replan; project-wide decisions visible via empty `when_context` |

## Deferred / structural (ADR-gated)

These require design decisions or timebox gates, not point fixes:

- **ADR-046 wave-4 deletions** (T020–T023): 7 unowned `parsers-legacy` symbol offenders block zero-importer gate
- **ADR-045 flat-phase migration** (plans 033–034): `detectStaleRenders` still stubbed; fixtures needed before re-enable
- **#1560** UAT-as-CLI RFC: blocked on external design
- **#818** multi-repo parent workspace: large-scope feature
- **#1754** Additional wedge/livelock class — tracked in taxonomy, no agent-ready fix scoped

## Changelog cross-reference (1.12 → 1.20)

Key stabilization themes already shipped:

- **1.13.0**: DB-authority cutover + 15 live-1.12.0 bug fixes
- **1.16.x**: Auto-mode UnitRun collapse (ADR-048), 50+ wedge fixes
- **1.18.0**: Progress reads DB-authoritative, legacy adoption repairs
- **1.19.0**: Husk-task gate closeout (#2197 area), blocker escalation at verify gate
- **1.20.0**: gate-evaluate UAT binding, recovery action id on receipts, quoted-shell prose fix

## Verification gates per wave

Each wave must pass before the next starts:

```bash
npm run typecheck:extensions
npm run test:unit -- --test-name-pattern='error-classifier|liveness-backstop|gate-dispatch|closeout-consistency'
npm run test:integration
```

For wedge fixes, also run the ADR-047 harness:

```bash
npm run test:unit -- src/resources/extensions/gsd/tests/auto-liveness-backstop-1655.test.ts
```

## Tracking

Update this file when an issue moves to "fixed" or a new regression is discovered. Link PRs in the Branch column. Do not duplicate GitHub issue bodies here — reference issue numbers only.
