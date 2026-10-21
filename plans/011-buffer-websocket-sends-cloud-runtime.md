# Plan 011: Buffer WebSocket sends across reconnects in the cloud runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- packages/daemon/src/cloud-runtime.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

`CloudRuntime.send()` drops any message when the socket is not `OPEN`:

```ts
  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
```

The socket disconnects and auto-reconnects after 5s (`handleSocketClose`), and
during that window every `send()` is silently discarded — including
`tool_result` messages produced by `handleMessage` when a device task finishes.
The cloud gateway waits up to ~10 minutes for a result that will never arrive
(see `packages/cloud-mcp-gateway/src/runtime-registry.ts`), so a remote workflow
hangs opaquely while the daemon looks healthy. This plan adds a bounded outbound
queue that buffers non-transient messages while disconnected and flushes them on
reconnect.

## Current state

- `packages/daemon/src/cloud-runtime.ts` — the daemon's outbound cloud
  connection. Key methods:
  - `connect()` (line ~45): builds the WebSocket, sets `this.socket`, closes the
    previous socket, wires `open`/`message`/`close`/`error`.
  - `handleSocketOpen(socket)` (line ~93): guards `socket !== this.socket`, then
    `advertiseProjects()` and starts a 30s heartbeat.
  - `handleSocketClose(socket)` (line ~106): clears heartbeat, nulls
    `this.socket`, schedules `connect()` after 5000ms unless `this.stopped`.
  - `handleMessage(text)` (line ~133): on `tool_call`, runs the executor and
    `this.send({ type: "tool_result", requestId, result })`.
  - `send(message)` (line ~183): the drop-on-not-open method above.
  - `stop()` (line ~38-43): detaches and closes the socket.

Conventions: double quotes, `void`-prefixed fire-and-forget async calls, handler
methods guard socket identity with `if (socket !== this.socket) return`. Match
that style.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `pnpm --filter @opengsd/daemon exec tsc --noEmit` | exit 0, no errors |
| Build | `pnpm run build:daemon` | exit 0 |
| Daemon tests | `pnpm --filter @opengsd/daemon test` | all pass |

## Scope

**In scope**:
- `packages/daemon/src/cloud-runtime.ts`
- The cloud-runtime test file under `packages/daemon/` (find with
  `ls packages/daemon/**/*cloud-runtime*` — create if absent)

**Out of scope** (do NOT touch):
- `handleSocketMessage` / inbound handling — this is about outbound only.
- The gateway's 10-minute timeout (`cloud-mcp-gateway`) — a separate concern.
- The reconnect backoff timing (5000ms) — leave as-is.

## Git workflow

- Branch: `advisor/011-buffer-websocket-sends-cloud-runtime`
- Conventional Commits (e.g. `fix(daemon): buffer cloud-runtime sends across reconnects`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a bounded outbound queue

Add a private field `private outbox: string[] = []` and a constant
`private static readonly MAX_OUTBOX = 200`. Rewrite `send()`:

```ts
  private send(message: unknown): void {
    const text = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(text);
      return;
    }
    // Buffer while disconnected; flushed on reconnect.
    this.outbox.push(text);
    if (this.outbox.length > CloudRuntime.MAX_OUTBOX) {
      // Drop oldest to bound memory; a stale heartbeat is worth less than a fresh result.
      this.outbox.shift();
    }
  }
```

Heartbeats will also queue — that is acceptable at MAX_OUTBOX=200 and the shift()
drops the oldest first. Do not special-case them in step 1.

**Verify**: `pnpm --filter @opengsd/daemon exec tsc --noEmit` → exit 0.

### Step 2: Flush on reconnect

In `handleSocketOpen`, after the existing `advertiseProjects()` /
heartbeat setup, drain the outbox in FIFO order into the now-open socket:

```ts
    const pending = this.outbox;
    this.outbox = [];
    for (const text of pending) {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
      else { this.outbox.push(text); }
    }
```

Order matters: `advertiseProjects()` (the `hello`) should reach the gateway
before buffered `tool_result`s so the runtime is re-registered first. Since
`advertiseProjects()` calls `send()` synchronously before this drain runs, the
`hello` is sent directly (socket is OPEN) ahead of the drained queue — keep the
drain **after** the `advertiseProjects()` call. Confirm that ordering.

**Verify**: `grep -n "this.outbox = \[\]" packages/daemon/src/cloud-runtime.ts` → one match in `handleSocketOpen`.

### Step 3: Clear the outbox on stop

In `stop()`, add `this.outbox = []` so a stopped runtime does not retain buffered
task results (prevents a memory leak across restart cycles and avoids replaying
stale results if the same instance is reused).

**Verify**: `grep -n "this.outbox = \[\]" packages/daemon/src/cloud-runtime.ts` → two matches (open flush + stop).

## Test plan

Add/extend the cloud-runtime test (model after existing daemon tests, which
typically stub the WebSocket). Cases:

- A `send()` issued while `this.socket` is undefined/CLOSED is buffered, not
  lost, and is delivered after a simulated `open`.
- FIFO order: three buffered messages arrive in order after reconnect.
- The outbox is capped: pushing MAX_OUTBOX+10 messages while disconnected leaves
  exactly MAX_OUTBOX buffered (oldest dropped).
- `stop()` empties the outbox (a subsequent simulated open sends nothing).
- Regression for the bug: simulate `handleMessage` producing a `tool_result`
  while disconnected, then reconnect, and assert the `tool_result` reaches the
  socket.

If the daemon test harness has no WebSocket stub, inject a minimal fake socket
object exposing `readyState` and a `send` spy; wire it via the same seam the
existing tests use (inspect one first).

**Verify**: `pnpm --filter @opengsd/daemon test` → all pass, including the new cases.

## Done criteria

- [ ] `pnpm --filter @opengsd/daemon exec tsc --noEmit` exits 0
- [ ] `pnpm run build:daemon` exits 0
- [ ] New cloud-runtime tests exist and pass (buffer, FIFO, cap, stop-clears, tool_result regression)
- [ ] `grep -n "outbox" packages/daemon/src/cloud-runtime.ts` shows the queue used in send/open/stop
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `send()` or `handleSocketOpen` no longer matches the excerpts (drifted).
- The gateway protocol already has an ack/replay mechanism for `tool_result`
  (grep `cloud-mcp-gateway` for `ack`/`requestId` resend) that makes client-side
  buffering redundant or conflicting — report before proceeding.
- Buffering `tool_result` could cause a **duplicate** execution result if the
  gateway also retries the `tool_call` on reconnect — if you find retry-on-both-
  sides, report; de-dup by `requestId` may be needed and is out of this plan's
  scope.

## Maintenance notes

- MAX_OUTBOX bounds memory; if large results are common, consider byte-based
  bounding instead of count-based — noted, not required here.
- A reviewer should check that the `hello`/re-advertise still precedes drained
  results after any future refactor of `handleSocketOpen`.
- Deferred: gateway-side idempotency of `tool_result` by `requestId` (only
  relevant if duplicates surface in testing).
