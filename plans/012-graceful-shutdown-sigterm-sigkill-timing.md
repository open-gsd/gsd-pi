# Plan 012: Fix SIGTERM→SIGKILL timing so processes shut down gracefully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- src/resources/extensions/gsd/auto.ts packages/rpc-client/src/rpc-client.ts packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts`
> If any file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

Three shutdown paths escalate to `SIGKILL` before the target process can run its
`SIGTERM` handler, defeating cooperative cleanup (lock release, DB snapshot
flush, worktree teardown):

1. `auto.ts` `forceStopAutoRemote` sends `SIGTERM` then **immediately** checks
   `isLockProcessAlive` and, because the process hasn't had a chance to exit,
   almost always fires `SIGKILL` right away.
2. `packages/rpc-client/src/rpc-client.ts` `stop()` waits **1000ms** before
   `SIGKILL`.
3. `packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts` `stop()` is a
   near-identical copy, also **1000ms**.

Meanwhile the same two RPC files' `shutdown()` methods use **5000ms** (line ~542
and ~452 respectively), and `pi-agent-core` uses `SIGKILL_GRACE_MS = 5000` — so
`stop()` is inconsistent with the rest of the codebase. The GSD agent's SIGTERM
handler (in `src/headless.ts`) does async cleanup then `process.exit()`, which
cannot finish in ~1ms (path 1) or reliably in 1000ms (paths 2–3). Consequence:
data loss on incomplete DB transactions, leaked locks, orphaned worktrees, and
lock-conflict failures on the next run. This plan gives each path a real grace
window that resolves early when the process actually exits.

## Current state

`src/resources/extensions/gsd/auto.ts` `forceStopAutoRemote` (lines ~1068-1078):

```ts
  try {
    process.kill(lock.pid, "SIGTERM");
    if (isLockProcessAlive(lock)) {
      process.kill(lock.pid, "SIGKILL");
    }
    clearLock(projectRoot);
    return { found: true, pid: lock.pid };
  } catch (err) {
```

`packages/rpc-client/src/rpc-client.ts` `stop()` (lines ~163-176):

```ts
    this.process.kill("SIGTERM");
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 1000);
      this.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
```

`packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts` `stop()` (lines ~156-166)
is the same block with the same `1000` literal. Note both files also contain a
`shutdown()` method that already uses `5000` — that is the intended grace and is
the value to standardize on.

`isLockProcessAlive` lives in `src/resources/extensions/gsd/crash-recovery.ts`
(uses `process.kill(pid, 0)` — a synchronous liveness probe).

Conventions: `auto.ts` uses single quotes; the two rpc-client files use double
quotes and tabs. Match each file. Do not unify the two rpc-client copies in this
plan (that de-dup is noted in the audit report as separate tech-debt).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck (extensions) | `pnpm run typecheck:extensions` | exit 0 |
| Typecheck (rpc-client) | `pnpm --filter @opengsd/rpc-client exec tsc --noEmit` | exit 0 |
| Typecheck (agent-modes) | `pnpm --filter @gsd/agent-modes exec tsc --noEmit` | exit 0 |
| Build core | `pnpm run build:rpc-client && pnpm run build:agent-modes` | exit 0 |
| Compile tests | `pnpm run test:compile` | exit 0 |

## Scope

**In scope**:
- `src/resources/extensions/gsd/auto.ts` (only `forceStopAutoRemote`)
- `packages/rpc-client/src/rpc-client.ts` (only `stop()`)
- `packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts` (only `stop()`)
- A test for `forceStopAutoRemote` timing under `src/resources/extensions/gsd/tests/`
  (create or extend an existing auto/crash-recovery test)

**Out of scope** (do NOT touch):
- The `shutdown()` methods (already 5000ms) — leave them.
- `stopAutoRemote` (the cooperative SIGTERM-only path) — correct as-is.
- Merging the two duplicate rpc-client files — separate effort.
- `SIGKILL_GRACE_MS` in pi-agent-core (vendored) — leave it.

## Git workflow

- Branch: `advisor/012-graceful-shutdown-timing`
- Conventional Commits (e.g. `fix(gsd): give processes a real grace window before SIGKILL`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Give `forceStopAutoRemote` a bounded grace loop

Replace the immediate liveness check with a short poll loop. Add a module-level
constant near the top of `auto.ts` (or reuse one if a grace constant already
exists — grep first): `const FORCE_STOP_GRACE_MS = 3000` and
`const FORCE_STOP_POLL_MS = 100`. Rewrite the try block:

```ts
  try {
    process.kill(lock.pid, 'SIGTERM');
    const deadline = Date.now() + FORCE_STOP_GRACE_MS;
    while (Date.now() < deadline) {
      if (!isLockProcessAlive(lock)) break;
      // Synchronous short sleep keeps this helper non-async for its callers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FORCE_STOP_POLL_MS);
    }
    if (isLockProcessAlive(lock)) {
      process.kill(lock.pid, 'SIGKILL');
    }
    clearLock(projectRoot);
    return { found: true, pid: lock.pid };
  } catch (err) {
```

The `Atomics.wait` idiom is a synchronous sleep that keeps `forceStopAutoRemote`
a sync function (its callers do not await it). If `forceStopAutoRemote` is
already `async` (check the signature), prefer `await new Promise(r => setTimeout(r, FORCE_STOP_POLL_MS))`
instead — do NOT change the function's sync/async signature just to fit one
approach. Pick the sleep that matches the existing signature.

**Verify**: `pnpm run typecheck:extensions` → exit 0; `grep -n "FORCE_STOP_GRACE_MS" src/resources/extensions/gsd/auto.ts` → constant + use.

### Step 2: Raise the RPC `stop()` grace to match `shutdown()`

In **both** `packages/rpc-client/src/rpc-client.ts` and
`packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts`, change the `stop()`
timeout literal from `1000` to `5000` so it matches the `shutdown()` path in the
same file. Do not touch anything else in the method — the early-resolve on
`exit` already makes a clean shutdown fast; this only lengthens the ceiling for a
slow-but-cooperative exit.

**Verify**:
`grep -n "}, 5000)" packages/rpc-client/src/rpc-client.ts packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts`
→ two matches per file (the existing `shutdown()` 5000 + the newly-changed `stop()` 5000);
`grep -n "}, 1000)" packages/rpc-client/src/rpc-client.ts packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts`
→ no matches.

### Step 3: Build to confirm no downstream break

**Verify**: `pnpm run build:rpc-client && pnpm run build:agent-modes` → exit 0.

## Test plan

Add a focused test for `forceStopAutoRemote` (model after an existing
`crash-recovery` or `auto` test in `src/resources/extensions/gsd/tests/`):

- A stubbed `isLockProcessAlive` that returns `true` twice then `false` results
  in **no** `SIGKILL` (the process exited during the grace window) — assert the
  SIGKILL `process.kill(pid, 'SIGKILL')` spy was not called.
- A stubbed `isLockProcessAlive` that stays `true` past the deadline **does**
  fire `SIGKILL` — assert the spy was called once.

Inject the liveness/kill seams the way the existing tests do (grep the test dir
for `isLockProcessAlive` / `process.kill` stubbing precedents; if none exist,
use the module's exported test seams — search `auto.ts` for `ForTest` exports).
Keep the grace constant small in the test (or make it injectable) so the test is
fast; if it is not currently injectable, prefer stubbing `isLockProcessAlive` to
flip quickly rather than sleeping 3s of real time.

The two rpc-client `stop()` changes are one-line literal bumps covered by the
existing `stop()` tests — run them:
`pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --experimental-test-isolation=process --test "dist-test/packages/rpc-client/**/*.test.js"`
(adjust the glob to where the rpc-client tests compile).

**Verify**: new `forceStopAutoRemote` test passes; existing rpc-client `stop()` tests still pass.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] `pnpm run build:rpc-client && pnpm run build:agent-modes` exit 0
- [ ] `grep -rn "}, 1000)" packages/*/src/**/rpc-client.ts` returns no match in a `stop()` method
- [ ] `forceStopAutoRemote` no longer calls `SIGKILL` when the process exits within the grace window (new test passes)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `forceStopAutoRemote` or either `stop()` no longer matches the excerpts (drifted).
- `SharedArrayBuffer`/`Atomics` is unavailable or disallowed in the runtime (it
  is standard on Node 22, but if a lint/policy forbids it, use the async sleep
  and confirm the function/callers tolerate `async`).
- `forceStopAutoRemote` is on a latency-critical UI path where a 3s worst-case
  block is unacceptable — if a caller awaits it in a render/keystroke path,
  report; an async version may be required.

## Maintenance notes

- The two rpc-client files are near-duplicates; the audit report flags de-duping
  them as separate tech-debt. Until then, any change to one `stop()`/`shutdown()`
  must be mirrored to the other — a reviewer should check both moved together.
- If a future SIGTERM handler in `headless.ts` grows slower than 5000ms, revisit
  the grace ceiling rather than removing the early-exit.
