# Plan 013: Surface workspace-package link failures instead of silently bricking installs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- scripts/link-workspace-packages.cjs`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

`@opengsd/gsd-pi` publishes only the root package; its workspace deps
(`@gsd/*`, `@earendil-works/*`) are linked into `node_modules` at install time by
`scripts/link-workspace-packages.cjs`. That script wraps every `symlinkSync` and
`cpSync` in an empty `catch {}` and exits 0 regardless. If linking fails
(read-only FS, permissions, Windows without Developer Mode where both symlink
**and** copy fail), the install reports success but `@gsd/*` imports throw
`MODULE_NOT_FOUND` at first run — a bricked install with no diagnostic. This plan
makes the script count failures, warn on each, and print an actionable summary,
so a failed link is visible at install time instead of at a cryptic runtime crash.

## Current state

`scripts/link-workspace-packages.cjs` (lines ~68-111), inside the per-package loop:

```js
  let symlinkOk = false
  try {
    symlinkSync(source, target, 'junction') // junction works on Windows too
    symlinkOk = true
    linked++
  } catch {
    // Symlink failed — common on Windows without Developer Mode or admin rights.
    // Fall back to a directory copy so the package is still resolvable.
  }

  if (!symlinkOk) {
    try {
      cpSync(source, target, { recursive: true })
      copied++
    } catch {
      // Non-fatal — loader.ts will emit a clearer error if resolution still fails
    }
  }
```

And the same symlink-then-copy pair for `@earendil-works/*` further down, with an
identical `catch { /* non-fatal */ }`.

At the end the script prints:

```js
if (linked > 0) process.stderr.write(`  Linked ${linked} workspace package${linked !== 1 ? 's' : ''}\n`)
if (copied > 0) process.stderr.write(`  Copied ${copied} workspace package${copied !== 1 ? 's' : ''} (symlinks unavailable)\n`)
```

Conventions: this is a `.cjs` script (CommonJS, `require`), 2-space indent, no
semicolons, `process.stderr.write` for output. Match it. The script must remain
non-throwing for the symlink→copy fallback (a symlink failure that copy recovers
is NOT an error) — only report when **both** fail for a package.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Syntax check | `node --check scripts/link-workspace-packages.cjs` | exit 0 |
| Dry run (safe) | `node scripts/link-workspace-packages.cjs` | exit 0; prints link/copy summary; re-running is idempotent |

(The script is idempotent — it skips existing targets — so running it in the repo
is safe and does not modify committed files.)

## Scope

**In scope**:
- `scripts/link-workspace-packages.cjs`

**Out of scope** (do NOT touch):
- `scripts/install.js`, `scripts/postinstall.js` — the callers; do not change how
  the script is invoked.
- The symlink→copy fallback logic itself — only add failure accounting around it.
- Converting the script to throw/exit-nonzero on partial failure — see STOP
  conditions; default to warn-loud, not fail-hard, unless you confirm callers
  handle a nonzero exit.

## Git workflow

- Branch: `advisor/013-surface-workspace-link-failures`
- Conventional Commits (e.g. `fix(install): report workspace link failures instead of swallowing them`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Track failures

Add a `const failures = []` near the existing `let linked = 0` / `let copied = 0`
counters. In each `cpSync` fallback `catch`, push a record instead of doing
nothing:

```js
    } catch (err) {
      failures.push({ pkg: /* the scope/name for this package */, reason: err && err.message ? err.message : String(err) })
    }
```

Apply to **both** copy-fallback catches (the `@gsd/*`/scope loop and the
`@earendil-works/*` loop). Use whatever variable already identifies the current
package name in each loop (read the loop headers to get the right identifier).

Leave the symlink `catch` blocks as no-ops — a symlink failure that copy recovers
is expected and not a failure.

**Verify**: `node --check scripts/link-workspace-packages.cjs` → exit 0.

### Step 2: Report the summary

After the existing `linked`/`copied` summary lines, add:

```js
if (failures.length > 0) {
  process.stderr.write(`  WARNING: ${failures.length} workspace package${failures.length !== 1 ? 's' : ''} could not be linked or copied:\n`)
  for (const f of failures) {
    process.stderr.write(`    - ${f.pkg}: ${f.reason}\n`)
  }
  process.stderr.write(`  gsd will fail to start until these resolve. See https://github.com/open-gsd/gsd-pi (Developer Mode / permissions on Windows).\n`)
}
```

Keep exit code 0 (do not `process.exit(1)`) — a loud warning at install time is
the goal; hard-failing the install is a bigger behavior change gated by STOP
conditions.

**Verify**: `node scripts/link-workspace-packages.cjs` → exit 0; on a healthy
repo prints the normal link/copy summary and **no** WARNING block.

### Step 3: Confirm idempotent re-run is clean

Run the script twice; the second run should skip existing targets and still exit 0
with no WARNING.

**Verify**: `node scripts/link-workspace-packages.cjs && node scripts/link-workspace-packages.cjs` → both exit 0.

## Test plan

This is a build/install script with no existing unit-test harness. Verification is
by execution (the commands above) rather than a new test file — adding a
node:test suite for a `.cjs` install script would require mocking `fs` and is out
of proportion to a warn-only change.

If the repo has a `tests/smoke/` entry that exercises install linking (check
`ls tests/smoke/`), run it: `pnpm run test:smoke`. If it does not cover this, do
not add new smoke infrastructure in this plan.

Manual failure-path check (optional, do not commit any artifact): temporarily
point one package `source` at a nonexistent path in a scratch copy and confirm
the WARNING block lists it — then revert. Do this only in `/tmp`, never in the
repo working tree.

## Done criteria

- [ ] `node --check scripts/link-workspace-packages.cjs` exits 0
- [ ] `node scripts/link-workspace-packages.cjs` exits 0 and prints no WARNING on a healthy repo
- [ ] `grep -n "failures.push" scripts/link-workspace-packages.cjs` → two matches (both copy-fallback catches)
- [ ] `grep -n "WARNING" scripts/link-workspace-packages.cjs` → one match (the summary)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- The script no longer matches the "Current state" excerpt (drifted).
- A caller (`install.js`/`postinstall.js`) inspects the script's exit code and a
  nonzero exit would change install behavior — if so, report before considering
  a hard-fail variant; this plan stays warn-only.
- The package-name identifier inside either loop is not readily available (you'd
  have to restructure the loop to know which package failed) — report; a minimal
  refactor to capture the name is fine, a large one is not.

## Maintenance notes

- If Windows-without-Developer-Mode installs remain a common failure, the next
  step is a hard-fail with a remediation link — deliberately deferred here to
  avoid changing install exit-code semantics blind.
- A reviewer should confirm the symlink catches stayed silent (only the
  copy-fallback catches report) so the normal Windows symlink→copy path doesn't
  spam warnings.
