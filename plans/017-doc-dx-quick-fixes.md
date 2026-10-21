# Plan 017: Doc & DX quick fixes (ADR pointer, dev env-vars, fast-test path)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- AGENTS.md docs/agents/domain.md CONTRIBUTING.md docs/user-docs/configuration.md`
> If any file changed since this plan was written, compare the excerpts against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

Three small, high-confidence doc gaps cost contributor time:

1. **Broken ADR pointer.** `AGENTS.md` and `docs/agents/domain.md` tell readers
   ADRs live in `docs/adr/`, but that directory holds only a `.gitkeep` — the 44
   actual ADRs live in `docs/dev/ADR-*.md`. A contributor (or agent) following
   the pointer finds an empty dir and concludes there are no ADRs.
2. **Undocumented dev/test env vars.** `GSD_DEBUG`, `GSD_STARTUP_TIMING`,
   `GSD_TEST_CLONE_MARKETPLACES`, `GSD_LIVE_TESTS`, `GSD_SMOKE_BINARY` are used in
   code and test scripts but absent from `configuration.md`, which documents the
   production `GSD_*` vars thoroughly. Contributors can't discover them.
3. **Hidden fast-test path.** `package.json` has `test:changed:src` (runs only
   tests for changed source), but `CONTRIBUTING.md`'s day-to-day section only
   points at the full `verify:*` gates — so contributors run the whole suite to
   check one file.

None of these change code behavior; all three are wrong-or-missing docs that
mislead. This is a pure documentation plan.

## Current state

- `AGENTS.md:13` — `Single-context: `CONTEXT.md` at repo root, `docs/adr/` for decisions. See `docs/agents/domain.md`.`
- `docs/agents/domain.md:8` — `- **`docs/adr/`** — read ADRs that touch the area you're about to work in.`
- `docs/agents/domain.md:19` — a tree diagram line `├── docs/adr/`
- `docs/adr/` — contains only `.gitkeep` (verified). Real ADRs: `ls docs/dev/ADR-*.md` → 44 files.
- `docs/user-docs/configuration.md` — has a `GSD_*` env-var table (around line
  272+) covering `GSD_HOME`, `GSD_STATE_DIR`, `GSD_WORKFLOW_*`, etc., but not the
  dev/test vars above.
- `CONTRIBUTING.md` — "Day-to-day development" section (around lines 33-41) and
  "Before pushing" (42-57); neither mentions `test:changed:src`.
- `package.json:82` — `"test:changed:src": "node scripts/verify-changed-src-tests.mjs"`.

Conventions: Markdown docs use sentence-case headers and backticked commands.
Match the surrounding style in each file. Do not restructure the docs — additive
edits only.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Confirm ADR location | `ls docs/dev/ADR-*.md \| head` | lists ADR files |
| Confirm empty adr dir | `ls -A docs/adr/` | only `.gitkeep` |
| Confirm the fast-test script exists | `node -e "process.exit(require('./package.json').scripts['test:changed:src']?0:1)"` | exit 0 |
| Docs-injection gate (repo CI check) | `pnpm run verify:fast` | exit 0 (or the docs-refs check within it passes) |

## Scope

**In scope**:
- `AGENTS.md`
- `docs/agents/domain.md`
- `docs/user-docs/configuration.md`
- `CONTRIBUTING.md`

**Out of scope** (do NOT touch):
- Moving the actual ADR files (they are correctly cross-referenced by full path
  in `CONTEXT.md` as `docs/dev/ADR-*.md`; only the `docs/adr/` pointers are wrong).
- The `docs/adr/.gitkeep` placeholder — leave it (removing it is a separate call;
  the point is to fix the pointers, not relocate ADRs).
- `gitbook/` and `mintlify-docs/` — the audit flags their staleness as a separate,
  larger effort; do not touch them here.

## Git workflow

- Branch: `advisor/017-doc-dx-quick-fixes`
- Conventional Commits (e.g. `docs: fix ADR pointer, document dev env-vars and fast-test path`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix the ADR pointer

In `AGENTS.md:13` and `docs/agents/domain.md` (lines 8 and 19), change `docs/adr/`
to `docs/dev/` (where `ADR-*.md` files live). Keep the surrounding wording;
`docs/dev/` also holds the plan-of-plans and FILE-SYSTEM-MAP docs, so "read ADRs
in `docs/dev/`" is accurate.

**Verify**: `grep -rn "docs/adr/" AGENTS.md docs/agents/domain.md` → no matches;
`grep -rn "docs/dev/" AGENTS.md docs/agents/domain.md` → the updated references.

### Step 2: Document the dev/test env vars

In `docs/user-docs/configuration.md`, add a short subsection (e.g. "Developer &
test environment variables") near the existing `GSD_*` table, listing:

| Var | Scope | Purpose |
|-----|-------|---------|
| `GSD_DEBUG` | dev | Enables verbose `debugLog` diagnostic tracing. |
| `GSD_STARTUP_TIMING` | dev | Prints startup phase timings from the loader. |
| `GSD_TEST_CLONE_MARKETPLACES` | test | Gate for `test:marketplace` (clones real marketplaces). |
| `GSD_LIVE_TESTS` | test | Gate for `test:live` (runs live provider/network tests). |
| `GSD_SMOKE_BINARY` | test | Points the smoke suite at a specific built binary. |

Confirm each var's purpose against its use in code before writing the row
(`grep -rn "GSD_DEBUG" src/ scripts/` etc.) — correct the one-line purpose if the
grep shows something different from the summary above. Do not invent vars; only
document ones that actually appear in `src/`, `scripts/`, or `package.json`.

**Verify**: `grep -n "GSD_DEBUG\|GSD_STARTUP_TIMING\|GSD_LIVE_TESTS" docs/user-docs/configuration.md` → matches.

### Step 3: Document the fast-test path

In `CONTRIBUTING.md`'s day-to-day section, add one or two lines:

> To test only the code you changed, run `pnpm run test:changed:src` — it runs
> the unit tests associated with your modified source files instead of the full
> suite. To test a single package, use `pnpm --filter @gsd/<package> test`.

Place it near the existing test/verify guidance so it's discoverable. Confirm the
`--filter` package-test invocation works by checking one package has a `test`
script (`grep -l '"test"' packages/*/package.json`).

**Verify**: `grep -n "test:changed:src" CONTRIBUTING.md` → one match.

### Step 4: Run the repo docs gate

**Verify**: `pnpm run verify:fast` → exit 0 (this includes the repo's docs-refs /
injection checks; if it flags an unrelated pre-existing failure, note it and
confirm your edits are not the cause).

## Test plan

No code tests — documentation only. Verification is the grep checks above plus
`pnpm run verify:fast`. Do not add test infrastructure for doc content.

## Done criteria

- [ ] `grep -rn "docs/adr/" AGENTS.md docs/agents/domain.md` returns no matches
- [ ] `configuration.md` documents `GSD_DEBUG`, `GSD_STARTUP_TIMING`, `GSD_TEST_CLONE_MARKETPLACES`, `GSD_LIVE_TESTS`, `GSD_SMOKE_BINARY`
- [ ] `CONTRIBUTING.md` mentions `test:changed:src`
- [ ] `pnpm run verify:fast` exits 0
- [ ] Only the four in-scope docs changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `AGENTS.md` / `domain.md` no longer contain `docs/adr/` (someone already fixed
  it — verify and mark this sub-task done).
- A grep for one of the env vars shows it is actually a production var (not
  dev/test) — document it in the appropriate table instead, and note the
  reclassification.
- `pnpm run verify:fast` fails on a check your edits touched (e.g. a docs-injection
  rule rejects a new table) — fix to satisfy the gate, don't disable it.

## Maintenance notes

- If ADRs are ever actually moved into `docs/adr/`, reverse step 1 and update
  `CONTEXT.md`'s 30 `docs/dev/ADR-*` references too.
- New `GSD_*` vars should be added to the configuration table as they're
  introduced; a reviewer adding a gated env var should update the doc in the same
  PR.
- The three doc systems (`docs/`, `gitbook/`, `mintlify-docs/`) drift is a larger,
  separate cleanup noted in the audit report — not addressed here.
