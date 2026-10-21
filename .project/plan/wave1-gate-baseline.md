# Wave 1 gate baseline — re-run at clean HEAD

- Date: 2026-08-02 (UTC)
- HEAD: `254f51d046caa5863956f350210749b6daab680c` (`git rev-parse HEAD`; `git status --porcelain` empty before and after)
- Setup: `pnpm install --frozen-lockfile --ignore-scripts` (pnpm 10.12.1, node v24.15.0) — completed clean
- Procedure: gates run exactly as specified in T001; no packages were built beforehand.

## Gate results

### 1. `pnpm run baseline:refactor:gate` — FAIL (exit code 1)

Runs `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/refactor-baseline.test.ts src/tests/rpc-golden-fixtures.test.ts src/tests/prompt-golden-fixtures.test.ts src/tests/contracts-rpc-fixtures.test.ts`.
Result: 34 tests, 32 pass, 2 fail. Both failures are in `src/tests/prompt-golden-fixtures.test.ts`:

```
✖ prompt golden fixtures render required markers and measurable sizes
✖ prompt golden fixtures meet Phase 2 reduction gate
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../node_modules/@opengsd/contracts/dist/index.js'
  imported from .../src/resources/extensions/gsd/workflow-tool-surface.ts
```

Root cause: `@opengsd/contracts` (`packages/contracts`) is not redirected to source by
`dist-redirect.mjs` (unlike the `@gsd/*` packages), so the gate requires a prebuilt
`packages/contracts/dist`. Nothing in the prescribed procedure builds it, and
`packages/contracts/dist` is not gitignored, so it is never present at clean HEAD.

### 2. `pnpm run baseline:refactor:phase0` — FAIL (exit code 1)

This script is `pnpm run baseline:refactor:gate && node ... --test derive-state-db.test.ts single-writer-invariant.test.ts auto-recovery.test.ts auto-worktree-registry.test.ts`.
The embedded `baseline:refactor:gate` fails first (same 2 failures as above), so the four
phase-0 test files never execute. Failure excerpt is identical to gate 1
(`ERR_MODULE_NOT_FOUND ... @opengsd/contracts/dist/index.js`).

### 3. `pnpm run gate:semantic-shadow-no-cutover` — FAIL (exit code 1)

Runs `node scripts/semantic-shadow-no-cutover-gate.mjs`.

```
Semantic shadow no-cutover gate
Status: FAIL
Structural: 8/8
Behavioral: 2/15
GitHub metadata used: no
```

All 8 structural checks PASS. 13 of 15 behavioral witnesses FAIL: runtime-disagreement,
frozen-public-response, mode-transport-matrix, unadopted-import, park-unpark, discard,
skipped-dispatch, db-unavailable-dispatch, db-unavailable-resolver,
db-unavailable-resolver-no-active, resolve-dispatch-authority, db-unavailable-status,
state-derivation-authority. Each behavioral witness is spawned as
`node --import resolve-ts.mjs --experimental-strip-types --test --test-reporter=tap <witness>`.
Running one witness (`semantic-shadow-no-cutover.test.ts`) directly confirms the same root
cause as gates 1–2: the witness process dies with
`ERR_MODULE_NOT_FOUND: Cannot find module '.../node_modules/@opengsd/contracts/dist/index.js'`,
so no witness test body ever executes.

### 4. `pnpm run legacy:cleanup:gate --file "$TMPFILE"` (TMPFILE nonexistent) — FAIL, honest (exit code 1)

```
ENOENT: no such file or directory, open '/var/folders/.../tmp.HwOKbC3RYd'
ELIFECYCLE  Command failed with exit code 1.
```

The gate does **not** fabricate a green result on a missing telemetry file; it exits 1 with
the raw ENOENT. This is the honest/expected behavior for the probe.

### 5. Fabricated-evidence check: `pnpm run legacy:cleanup:evidence --file "$TMPFILE2"` (TMPFILE2 nonexistent) — exit code 1, fabrication NOT observed at runtime

Pitfalls evidence claimed `ensureTelemetryReport` in `scripts/legacy-cleanup-evidence.mjs`
fabricates an all-zero counters report on ENOENT. Verification at HEAD:

- The fabrication path still exists in code: `ensureTelemetryReport`
  (`scripts/legacy-cleanup-evidence.mjs:73-87`) catches ENOENT from `readTelemetryReport`
  and writes `{ ts, counters: { <every legacy counter>: 0 } }` to the missing path.
- However, at runtime the fabrication was **not reached**: the script first runs its default
  evidence command `["npm", "run", "baseline:refactor:gate"]`
  (`DEFAULT_EVIDENCE_COMMANDS`, line 15), which failed (exit 1, same contracts-dist cause as
  gate 1), so `collectLegacyCleanupEvidence` threw `Evidence command failed (1): npm run
  baseline:refactor:gate` before `ensureTelemetryReport` was called. No file was created at
  `$TMPFILE2`; exit code 1.
- Conclusion: the latent fabrication defect is still present at HEAD, but it only fires when
  the evidence command(s) pass without writing a telemetry file. In this run no all-zero
  report was fabricated.

## Verdict

VERDICT: BASELINE RED — baseline:refactor:gate, baseline:refactor:phase0, gate:semantic-shadow-no-cutover

Notes for re-baselining before wave 2:

- All three RED gates trace to a single root cause: `@opengsd/contracts` has no built
  `dist/index.js` at clean HEAD, and `dist-redirect.mjs` does not redirect it to source.
  Whether the baseline is otherwise green is undetermined — the prompt-golden-fixture tests,
  all four phase-0 test files, and all 13 failing behavioral witnesses never executed their
  assertions. The plan should either build `packages/contracts` before the gates or extend
  `dist-redirect.mjs` to cover `@opengsd/contracts`, then re-run this baseline.
- `legacy:cleanup:gate` behaves honestly on a missing file (ENOENT, exit 1) — no fabricated
  green; it is not counted among the RED gates.

## Re-run after T024 contracts redirect

- Date: 2026-08-02 (UTC)
- Scope: redirect-only re-run. `packages/contracts/dist` absent throughout (confirmed before
  each run). Fix under test: `dist-redirect.mjs` (strip-types tier) and
  `dist-test-resolve.mjs` (compiled tier) now redirect `@opengsd/contracts` to source /
  `dist-test/packages/contracts/src/index.js`. No gate script, test, fixture, or package
  was built or modified.

### 1. `pnpm run baseline:refactor:gate` — exit code 1 (expected; T025 leg)

Zero `ERR_MODULE_NOT_FOUND` in output. All 34 tests now EXECUTE (previously 2 of 34 died on
the contracts module error before their assertions ran): 33 pass, 1 fail.
Surviving red leg: `prompt golden fixtures meet Phase 2 reduction gate` — a true Phase-2
reduction assertion failure, pre-existing, owned by T025.

### 2. `pnpm run gate:semantic-shadow-no-cutover` — exit code 1 (expected; T025 leg)

Zero `ERR_MODULE_NOT_FOUND` in output. `Structural: 8/8`, `Behavioral: 14/15` (was 2/15 at
baseline). 13 witnesses that previously never executed now execute and pass:
runtime-disagreement, frozen-public-response, mode-transport-matrix, unadopted-import,
park-unpark, skipped-dispatch, db-unavailable-dispatch, db-unavailable-resolver,
db-unavailable-resolver-no-active, resolve-dispatch-authority, db-unavailable-status,
state-derivation-authority — plus semantic-shadow-no-cutover itself.
Surviving red leg: `discard` witness — native projection-root identity locking unavailable
(@gsd/native), pre-existing, owned by T025.

### 3. Compiled-tier spot check — `pnpm run test:compile`, then
`node --import ./scripts/dist-test-resolve.mjs --experimental-test-isolation=process --test dist-test/src/tests/prompt-golden-fixtures.test.js`

`@opengsd/contracts` resolves in the compiled tier (direct import returns all contract
exports: RPC_CONTRACT_VERSION, WORKFLOW_TOOL_CONTRACTS, etc.; compiled output present at
`dist-test/packages/contracts/src/index.js`). The prompt-golden test file executes its 3
tests (1 pass, 2 fail). Both failures are `ERR_MODULE_NOT_FOUND` for
`dist-test/packages/native/dist/file-identity/index.js` (imported transitively via
`atomic-write.js`) — a pre-existing compiled-tier gap for the native package (compile-tests
emits `packages/native/src`, the hook's native mapping expects `dist/`), unrelated to the
contracts redirect and out of scope here; the Phase-2 assertion outcome itself is T025's
concern.

No new VERDICT line: the final green verdict belongs to T025's evidence doc.
