---
id: T025
title: Re-baseline the gates — resolve the prompt-golden Phase-2 red leg and the discard-witness native-lock red leg
wave: 2
deps: [T024]
status: done
agent: build_T025
commit: dd3304633ff567fb8a086db5c3d4a82a590dcc9d
base: c6935a65bd224bd8416cb8552da97af14c1f5904
worktree: .worktrees/gsd-path-T025
task_branch: gsd-path/T025
files:
  - src/tests/fixtures/prompt-golden-fixtures.ts
  - src/tests/prompt-golden-fixtures.test.ts
  - src/resources/extensions/gsd/auto-prompts.ts
  - packages/native/src/native.ts
  - src/resources/extensions/gsd/managed-projection-history.ts
  - src/resources/extensions/gsd/tests/park-milestone.test.ts
  - .project/plan/wave2-gate-baseline.md
---

# T025 — Re-baseline: prompt-golden Phase-2 leg + discard-witness native-lock leg

## Context

After T024's contracts redirect, the gates execute at clean HEAD but the true
baseline is red for two pre-existing reasons (evidence: T024 Log +
`.project/plan/wave1-gate-baseline.md` ## Re-run after T024):
1. `baseline:refactor:gate` — the prompt-golden Phase-2 reduction assertion
   fails: current aggregate 9454 chars vs reference 15400, required
   ≤ floor(15400 × 0.6) = 9240 (61.4% — 214 chars over). The reference lives
   in `src/tests/fixtures/prompt-golden-fixtures.ts`
   (`complete-slice.phase2StartChars: 15400`, whose comment already records
   one evidence-backed adjustment for deliberate growth, allowing "~9154").
   Suspect: recent prompt work on main (commit 331cee83a, "reduce prompt size
   via schema sanitization and prompt compression (#1475) (#1574)") shifted
   sizes after the reference was last tuned — stale reference OR genuine
   bloat regression.
2. `gate:semantic-shadow-no-cutover` — the `discard` witness
   (`tests/park-milestone.test.ts`) fails with "native projection root
   identity locking is unavailable". Root cause is CONFIRMED environmental by
   planner investigation: the pinned npm binary `@opengsd/engine-darwin-arm64`
   v1.11.0 loads (95 exports) but has NO `ProjectionRootIdentityLock` export
   — the lock was added to the Rust engine after the pinned binary was
   published. CI (`.github/workflows/ci.yml` ~lines 161-228) documents this
   exact skew ("the pinned npm binary lags the Rust source") and handles it
   by building from source (`pnpm run build:native:test`) with
   `GSD_NATIVE_PREFER_LOCAL=1`. The gate procedure never builds the native
   addon, and `packages/native/src/native.ts` tries the stale npm package
   FIRST, so it never falls through to local addon builds.
Hard constraints: `verify:pr` must not be weakened (INTENT veto); any
threshold/reference update must carry before/after evidence in the task Log
and be visible in the diff — no silent baseline nudging.

## Steps

1. Leg 1 diagnosis (stale reference vs genuine regression): `git log` the
   complete-slice prompt builder path (`auto-prompts.ts` and its callees)
   and `src/tests/fixtures/prompt-golden-fixtures.ts` since the reference
   was last adjusted; diff what changed in the rendered prompt between the
   last green adjustment and HEAD (render the fixture at both commits —
   check the repo out at the two SHAs in disposable worktrees; do not
   commit fixtures from this). Record the finding in the task Log with
   numbers.
   - If the growth is DELIBERATE content (required markers/product copy,
    like the #846 precedent): update `complete-slice.phase2StartChars` so
    the 40%-reduction gate is satisfiable by the current deliberate
    content, following the existing comment convention — record old value,
    new value, rendered chars at both SHAs, and the rationale in BOTH the
    fixture comment and the task Log. Do not touch the 0.6 factor or the
    test logic.
   - If the growth is accidental bloat (duplication, uncompressed block,
    schema-sanitization regression): fix the builder in `auto-prompts.ts`
    so the rendered prompt returns under the existing reference; the
    reference stays unchanged. Note: `auto-prompts.ts` is also in wave-3
    T011's files — fine (different wave); keep the edit minimal.
   - If the test logic itself is wrong (neither above): fix
    `src/tests/prompt-golden-fixtures.test.ts` minimally with evidence.
   Only ONE of these three resolutions lands; the task Log names which and
   why.
2. Leg 2 resolution (environmental, mirrors CI):
   a. In `packages/native/src/native.ts`: when a local addon build exists
      (`native/addon/gsd_engine.<platform>.node` or `gsd_engine.dev.node`),
      prefer it over the pinned `@opengsd/engine-*` npm package — the
      pinned binary is documented to lag the Rust source, so a present
      local build is always the better match for the source tree. Keep the
      npm package as the fallback for production installs (no `native/addon`
      there), keep `GSD_NATIVE_PREFER_LOCAL=1` as an explicit override, and
      keep the graceful JS-fallback proxy behavior on load failure. Also
      improve the stale-engine error detail: when the loaded addon lacks
      exports the source expects, the fallback warning should say so.
   b. Do NOT touch `package.json`, `scripts/semantic-shadow-no-cutover-gate.mjs`,
      or `scripts/dist-redirect.mjs`/`scripts/dist-test-resolve.mjs` (owned
      by T009/T024). Do NOT weaken the fail-closed policy in
      `managed-projection-history.ts` — it must keep throwing when the lock
      is unavailable and recovery state exists; modify it ONLY if the
      diagnosis shows the availability check itself is wrong (record why).
      Do NOT add a JS re-implementation of the identity lock — the
      fail-closed behavior is a safety property.
   c. The gate procedure gains a documented native build step, mirroring
      CI: `pnpm run build:native:dev` once after install, then the gates
      run bare (the loader prefers the local addon automatically post-2a —
      no env var needed). If `cargo`/the Rust toolchain is unavailable in
      the dispatch environment and the dev addon cannot be built, mark the
      task BLOCKED with the toolchain evidence — do not paper over it with
      a witness skip (skipping `discard` would weaken the gate).
   d. `tests/park-milestone.test.ts` should need no changes; edit it ONLY
      if the diagnosis shows a test-env defect (record why).
3. Full re-baseline at clean HEAD: fresh `pnpm install --frozen-lockfile
   --ignore-scripts`, delete any stale `packages/contracts/dist`, run
   `pnpm run build:native:dev`, then run all four T001 gates and write
   `.project/plan/wave2-gate-baseline.md`: HEAD SHA, procedure (including
   the new native build step), per-gate command + exit code + verdict, and
   a single `VERDICT: BASELINE GREEN` line (or BLOCKED with the remaining
   red). Include the `legacy:cleanup:gate` probe semantics: with a fresh
   zero-counters telemetry file it exits 0; with a nonexistent file it
   still exits non-zero honestly (ENOENT, no fabrication).
4. Also record in that doc: the `legacy:cleanup:evidence` fabrication path
   (`ensureTelemetryReport`, scripts/legacy-cleanup-evidence.mjs:73-87) is
   NOW REACHABLE — its default evidence command (`baseline:refactor:gate`)
   passes post-T025 but writes no telemetry file, so a bare
   `legacy:cleanup:evidence` run fabricates an all-zero green. Flag it as
   owned by wave-3 T015 (fail-closed redesign), which is already scoped for
   exactly this.

## Acceptance criteria

1. Leg 1: exactly one resolution lands (evidence-backed reference update OR
    builder regression fix OR test-logic fix); any reference change shows
    old/new values and rendered-char evidence in the diff comment and Log;
    the 0.6 factor and gate structure are unchanged.
2. Leg 2: the native loader prefers a present local addon build;
    `pnpm run build:native:dev && pnpm run gate:semantic-shadow-no-cutover`
    is green at clean HEAD with all 15/15 witnesses executing; the
    fail-closed native-lock policy is unchanged; no witness is skipped.
3. `.project/plan/wave2-gate-baseline.md` records the full procedure and a
   `VERDICT: BASELINE GREEN` line; `verify:pr` is not weakened in any way
    (no threshold, coverage, or script weakening anywhere in the diff).
4. The fabrication-reachability finding for T015 is recorded in the
   evidence doc.

## Verify

```bash
grep -q "VERDICT: BASELINE GREEN" .project/plan/wave2-gate-baseline.md && pnpm run build:native:dev && pnpm run baseline:refactor:gate && pnpm run baseline:refactor:phase0 && pnpm run gate:semantic-shadow-no-cutover && TMPD=$(mktemp -d) && printf '{"ts":"%s","counters":{"legacy.workflowEngineUsed":0,"legacy.uokFallbackUsed":0,"legacy.mcpAliasUsed":0,"legacy.componentFormatUsed":0,"legacy.providerDefaultUsed":0}}\n' "$(date -u +%FT%TZ)" > "$TMPD/t.json" && node scripts/legacy-cleanup-gate.mjs --file "$TMPD/t.json" && ! node scripts/legacy-cleanup-gate.mjs --file "$TMPD/nonexistent.json"
```

## Log

- 2026-08-02 — created by planner (T024 split: owns the two true-baseline red legs the redirect surfaced; native-leg root cause confirmed environmental — pinned engine binary v1.11.0 lacks ProjectionRootIdentityLock, CI builds from source with GSD_NATIVE_PREFER_LOCAL=1)
- 2026-08-02 — coder: BOTH legs resolved; Verify exit 0 (full chain green).
  Leg 1 = evidence-backed REFERENCE UPDATE (branch 1; no builder/test-logic change, 0.6 factor untouched). Rendered the exact test fixture at both SHAs in disposable worktrees: complete-slice = 9418 chars at 04f3ba14e (last adjustment — the gate was ALREADY over cap there; its "~9154" note was a Linux short-tmp-path measurement: the fixture embeds the absolute tmp path 5×, and this macOS tmp prefix is 44 chars longer than Linux /tmp) and 9454 chars at HEAD c6935a65b (+36 net). The render diff shows deliberate content only — DB-authoritative milestone lifecycle wording (#1476) and terminal-handoff stop-rule strengthening (#846 lineage) — mostly offset by #1475 prompt compression; not accidental bloat. Updated `complete-slice.phase2StartChars` 15400 → 15900 (floor(15900×0.6)=9540, restoring the ~86-char headroom convention of the #846 adjustment); old/new + both-SHA numbers recorded in the fixture comment and in `.project/plan/wave2-gate-baseline.md`.
  Leg 2 = loader fix in `packages/native/src/native.ts` only: a present local addon build (`native/addon/gsd_engine.<platform>.node` / `gsd_engine.dev.node`) is now preferred over the pinned npm package (npm stays the production fallback; `GSD_NATIVE_PREFER_LOCAL=1` stays as explicit override; graceful JS-fallback proxy unchanged), plus a stale-engine stderr warning naming the missing expected exports when a loaded addon lags the source tree. `managed-projection-history.ts` and `tests/park-milestone.test.ts` needed no changes — availability check and witness were correct, only the engine binary was stale; fail-closed policy untouched, no JS lock re-implementation, no witness skipped. cargo 1.96.0 available; `pnpm run build:native:dev` built `native/addon/gsd_engine.dev.node` in 26.6s.
  Re-baseline at HEAD c6935a65b (fresh `pnpm install --frozen-lockfile --ignore-scripts`, contracts dist absent): baseline:refactor:gate 34/34 exit 0; baseline:refactor:phase0 140/140 exit 0; gate:semantic-shadow-no-cutover PASS Structural 8/8 Behavioral 15/15 (incl. discard) exit 0; legacy:cleanup:gate exit 0 on zero-counters file, exit 1 ENOENT on nonexistent file. `.project/plan/wave2-gate-baseline.md` written with VERDICT: BASELINE GREEN + the T015 flag (`legacy:cleanup:evidence` all-zero fabrication path in `ensureTelemetryReport` is now REACHABLE post-T025). Changed paths: src/tests/fixtures/prompt-golden-fixtures.ts, packages/native/src/native.ts, .project/plan/wave2-gate-baseline.md.
