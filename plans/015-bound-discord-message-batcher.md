# Plan 015: Bound the Discord message batcher buffer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- packages/daemon/src/message-batcher.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

`MessageBatcher.enqueue()` appends to an unbounded `buffer: FormattedEvent[]`.
A capacity flush triggers at `maxBatchSize` (default 4), but if `flush()` is slow
or the Discord API hangs/rate-limits, `flushing` stays `true` and new events keep
piling into `buffer` with no ceiling. During a busy auto-mode run against a
degraded Discord endpoint, the buffer can grow to tens of thousands of events —
unbounded daemon memory growth tied to an external outage. This plan adds a hard
cap that drops the oldest events (with a warning) once the buffer is saturated,
so a Discord outage degrades notifications instead of the daemon's memory.

## Current state

`packages/daemon/src/message-batcher.ts` — constructor and `enqueue`
(lines ~69-121):

```ts
  private buffer: FormattedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private destroyed = false;

  constructor(send: SendFn, logger?: BatcherLogger, options?: BatcherOptions) {
    this.send = send;
    this.logger = logger ?? noopLogger;
    this.flushIntervalMs = options?.flushIntervalMs ?? 1500;
    this.maxBatchSize = options?.maxBatchSize ?? 4;
  }

  enqueue(formatted: FormattedEvent): void {
    if (this.destroyed) return;
    this.buffer.push(formatted);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }
```

`BatcherOptions` currently has `flushIntervalMs` and `maxBatchSize`. `flush()`
guards re-entrancy with `this.flushing`. The logger has a `warn`/`debug` surface
(`this.logger.debug(...)` is used already).

Conventions: single quotes, 2-space indent, `??` defaults in the constructor,
`this.logger.debug/warn`. Match them.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `pnpm --filter @opengsd/daemon exec tsc --noEmit` | exit 0 |
| Build | `pnpm run build:daemon` | exit 0 |
| Batcher tests | `pnpm --filter @opengsd/daemon test` | all pass |

## Scope

**In scope**:
- `packages/daemon/src/message-batcher.ts`
- The message-batcher test file (find with `ls packages/daemon/**/*batcher*` — extend it)

**Out of scope** (do NOT touch):
- `event-bridge.ts` and other callers — the cap is internal to the batcher.
- The `destroy()`/`flush()` re-entrancy logic — leave it.
- The priority-send path — unrelated.

## Git workflow

- Branch: `advisor/015-bound-discord-message-batcher`
- Conventional Commits (e.g. `fix(daemon): bound the Discord event batcher buffer`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a `maxBufferSize` option

Add `maxBufferSize?: number` to `BatcherOptions` (find the interface at the top
of the file). Add a `private readonly maxBufferSize: number` field and default it
in the constructor: `this.maxBufferSize = options?.maxBufferSize ?? 1000`.

**Verify**: `grep -n "maxBufferSize" packages/daemon/src/message-batcher.ts` → interface + field + constructor default.

### Step 2: Enforce the cap in `enqueue`

Before pushing, drop the oldest event(s) if at capacity, and warn once per
saturation transition (avoid warning on every enqueue during a long outage — warn
only when crossing from under-cap to at-cap):

```ts
  enqueue(formatted: FormattedEvent): void {
    if (this.destroyed) return;
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift(); // drop oldest; bounded memory during Discord outages
      if (!this.saturated) {
        this.saturated = true;
        this.logger.warn('Batcher buffer saturated; dropping oldest events', { maxBufferSize: this.maxBufferSize });
      }
    } else if (this.saturated && this.buffer.length < this.maxBufferSize) {
      this.saturated = false;
    }
    this.buffer.push(formatted);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }
```

Add `private saturated = false;` alongside the other private fields. Reset it to
`false` wherever the buffer is emptied by `flush()` (if `flush()` sets
`this.buffer = []` or splices it to empty, add `this.saturated = false` there so
recovery is clean — read `flush()` to place it correctly).

**Verify**: `pnpm --filter @opengsd/daemon exec tsc --noEmit` → exit 0.

## Test plan

Extend the batcher test (model after the existing cases). Use a `send` stub that
never resolves (or resolves slowly) to hold `flushing` and force accumulation:

- With `maxBufferSize: 3` and a hanging `send`, enqueue 10 events → `buffer`
  length never exceeds 3 (assert via a test seam or by observing that only the
  most-recent events survive to the next successful flush).
- The saturation `warn` fires once, not once per drop, across a run of 10
  over-cap enqueues.
- After a successful flush drains the buffer, `saturated` is back to `false` and
  a later warn can fire again (proves the transition resets).
- Default behavior unchanged: with default options and a fast `send`, no events
  are dropped and no warning fires (regression guard).

If the buffer length isn't directly observable, add a minimal test-only getter
(e.g. `_bufferLengthForTest()`) following the repo's `ForTest` seam convention, or
assert on the `send` payloads (dropped events never appear in a flushed batch).

**Verify**: `pnpm --filter @opengsd/daemon test` → all pass, including the new cases.

## Done criteria

- [ ] `pnpm --filter @opengsd/daemon exec tsc --noEmit` exits 0
- [ ] `pnpm run build:daemon` exits 0
- [ ] New tests prove the cap holds and the warn is once-per-saturation
- [ ] Default-options behavior is unchanged (regression test passes)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `enqueue` or the constructor no longer matches the excerpt (drifted).
- Dropping oldest events would silently lose a **blocker/priority** event — check
  whether priority events flow through `enqueue` or a separate path. If priority
  events share this buffer, report; they may warrant exemption from the drop.

## Maintenance notes

- Default cap is 1000 events; if operators report lost notifications under normal
  (non-outage) load, raise the default rather than removing the cap.
- A reviewer should confirm `saturated` resets on drain so the warning isn't
  permanently suppressed after the first outage.
- Related: the daemon's cloud-runtime has a similar unbounded-send concern handled
  in plan 011 — same drop-oldest philosophy, different transport.
