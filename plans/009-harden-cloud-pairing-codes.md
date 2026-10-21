# Plan 009: Harden GSD Cloud pairing codes (entropy, brute-force limit, expiry sweep)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- packages/cloud-mcp-gateway/src/auth-store.ts packages/cloud-mcp-gateway/src/server.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `58dc840f`, 2026-07-01
- **Implemented**: 2026-07-01. **Deviation from Step 2**: the per-record attempt
  counter was intentionally skipped. `findSecretEntry` matches a submitted code by
  its scrypt hash, so a wrong guess matches no record and cannot be counted — a
  brute force iterates *distinct* codes, which a per-code counter never sees. The
  effective defenses that were implemented are 64-bit entropy (Step 1), one live
  code per user (Step 2's generation guard), and the expiry sweep (Step 3).
  Request-rate limiting on `/pairing/exchange` (the real DoS/CPU defense) remains
  deferred to the HTTP layer, as the plan already noted.

## Why this matters

The GSD Cloud gateway pairs a local daemon to a user account with a short code.
Today the code is 32 bits of entropy (`randomBytes(4)`), the `/pairing/exchange`
endpoint has no failed-attempt limit, and expired codes are only removed when
someone happens to look them up. An attacker who can reach the gateway can
brute-force the ~4 billion code space within the 10-minute validity window, and
a long-running gateway leaks memory for every code that is generated but never
redeemed. Pairing is the trust root for the entire "control my machine from the
cloud" product direction — a guessed code yields a device token that can drive
the agent. This plan raises entropy, adds a bounded attempt counter, and sweeps
expired codes.

## Current state

- `packages/cloud-mcp-gateway/src/auth-store.ts` — owns pairing codes and device
  tokens. `InMemoryAuthStore` is the base; `FileAuthStore` extends it and
  persists via `afterMutation()`.
- `packages/cloud-mcp-gateway/src/server.ts` — raw `http.createServer`; the
  `/pairing/exchange` route (around line 44) calls `exchangePairingCode`. No
  Hono, no CORS middleware (do not add either).

Code as it exists today (`auth-store.ts:72-99`):

```ts
  createPairingCode(userId: string, ttlMs = 10 * 60 * 1000): { code: string; expiresAt: number } {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = Date.now() + ttlMs;
    const key = deriveSecretHash(code);
    this.pairingCodes.set(key.secretHash, { ...key, userId, expiresAt });
    this.afterMutation();
    return { code, expiresAt };
  }

  exchangePairingCode(code: string, runtimeName?: string): DeviceTokenIssue {
    const normalized = code.trim().toUpperCase();
    const codeEntry = findSecretEntry(this.pairingCodes, normalized);
    if (!codeEntry || codeEntry[1].expiresAt < Date.now()) {
      if (codeEntry) this.pairingCodes.delete(codeEntry[0]);
      this.afterMutation();
      throw new Error("Pairing code is invalid or expired");
    }
    const [codeHash, record] = codeEntry;
    this.pairingCodes.delete(codeHash);
    const runtimeId = `rt_${randomUUID()}`;
    const deviceToken = `gsd_dev_${randomBytes(32).toString("hex")}`;
    // ...issues device token...
  }
```

The device token itself uses `randomBytes(32)` (256 bits) — that is fine, leave
it. Only the **pairing code** is under-entropied.

Conventions: the file uses double quotes and `randomBytes`/`randomUUID` from
`node:crypto` (already imported). `PairingCodeRecord` is the stored shape — find
its type definition in this file and extend it. Match the existing
`this.afterMutation()` call after every mutation so `FileAuthStore` persists.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `pnpm --filter @opengsd/cloud-mcp-gateway exec tsc --noEmit` | exit 0, no errors |
| Build | `pnpm run build:cloud-mcp-gateway` | exit 0 |
| Package tests | `pnpm --filter @opengsd/cloud-mcp-gateway test` | all pass (if the package has a test script; if not, see Test plan) |

If `@opengsd/cloud-mcp-gateway` has no `test` script, run the gateway test files
directly with the repo's node:test runner — check `package.json` in that package
for how existing tests are invoked and mirror it.

## Scope

**In scope**:
- `packages/cloud-mcp-gateway/src/auth-store.ts`
- The pairing test file under `packages/cloud-mcp-gateway/` (create or extend —
  find the existing auth-store test first with `ls packages/cloud-mcp-gateway/**/*auth*`)

**Out of scope** (do NOT touch):
- The device-token format (`gsd_dev_` + `randomBytes(32)`) — already strong.
- `server.ts` HTTP wiring, CORS, or adding any web framework.
- `deriveSecretHash` / `findSecretEntry` internals — reuse them as-is.

## Git workflow

- Branch: `advisor/009-harden-cloud-pairing-codes`
- Conventional Commits (e.g. `fix(cloud-gateway): raise pairing-code entropy and bound exchange attempts`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Raise pairing-code entropy

In `createPairingCode`, change `randomBytes(4)` to `randomBytes(8)` (64 bits,
16 hex chars). Keep `.toString("hex").toUpperCase()`.

**Verify**: `grep -n "randomBytes(8)" packages/cloud-mcp-gateway/src/auth-store.ts` → one match in `createPairingCode`.

### Step 2: Add a bounded attempt counter to exchange

Add an `attempts: number` field to the `PairingCodeRecord` type (initialize to
`0` in `createPairingCode`). In `exchangePairingCode`, before checking validity:
increment the matched record's `attempts`; if it exceeds a constant
`MAX_PAIRING_ATTEMPTS = 5`, delete the code, call `afterMutation()`, and throw
`"Pairing code is invalid or expired"` (identical message — do not leak whether
the code existed). A wrong code that matches no record still costs the attacker a
network round-trip; the counter caps guesses against any single *issued* code.

Because `findSecretEntry` looks up by the hash of the submitted code, a brute
force iterates distinct codes rather than retrying one — so also add a
per-`userId` generation guard: `createPairingCode` should replace any existing
un-redeemed code for that `userId` (delete the old one) so only one live code
per user exists at a time, shrinking the attackable set. Search the map for an
existing record with the same `userId` and delete it before inserting.

**Verify**: `pnpm --filter @opengsd/cloud-mcp-gateway exec tsc --noEmit` → exit 0.

### Step 3: Sweep expired codes on mutation

Add a private method `sweepExpiredPairingCodes(now = Date.now())` that iterates
`this.pairingCodes` and deletes entries whose `expiresAt < now`. Call it at the
top of `createPairingCode` and `exchangePairingCode` (cheap — the map holds at
most a handful of live codes). Do not add a timer/interval (keeps the store
side-effect-free and test-friendly).

**Verify**: `grep -n "sweepExpiredPairingCodes" packages/cloud-mcp-gateway/src/auth-store.ts` → one definition + two call sites.

## Test plan

Add/extend the auth-store test with these cases (model structure after any
existing test in `packages/cloud-mcp-gateway/`):

- `createPairingCode` returns a 16-char hex code (asserts the entropy bump).
- After `MAX_PAIRING_ATTEMPTS` failed `exchangePairingCode` calls against the
  same issued code, a further attempt throws even with the correct code
  (asserts the counter). Use a helper that submits wrong codes hashing to the
  same record — or, more simply, assert that 6 wrong exchanges followed by the
  right code all throw the same message.
- A second `createPairingCode` for the same `userId` invalidates the first
  (exchanging the first code throws).
- A code past `expiresAt` is gone after any subsequent `createPairingCode`
  (asserts the sweep) — use an injected/rewound clock or set `ttlMs` to a tiny
  value and advance `Date.now` via the test's existing time control if present;
  otherwise pass `ttlMs: -1` to force immediate expiry.

**Verify**: gateway test command from the table → all pass, including the new cases.

## Done criteria

- [ ] `pnpm --filter @opengsd/cloud-mcp-gateway exec tsc --noEmit` exits 0
- [ ] `pnpm run build:cloud-mcp-gateway` exits 0
- [ ] `grep -n "randomBytes(4)" packages/cloud-mcp-gateway/src/auth-store.ts` returns no match
- [ ] New tests for entropy, attempt cap, one-code-per-user, and expiry sweep exist and pass
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `auth-store.ts` no longer matches the "Current state" excerpt (drifted).
- `PairingCodeRecord` is defined in a different file than `auth-store.ts` and
  changing it there would touch out-of-scope code.
- The gateway already enforces rate limiting at the HTTP layer for
  `/pairing/exchange` (grep `server.ts` for a limiter) — if so, the attempt
  counter may be redundant; report and let the maintainer decide.

## Maintenance notes

- If pairing ever moves to a persistent (DB-backed) store, the attempt counter
  and sweep must move with it — they currently live in the in-memory map.
- A reviewer should confirm the "invalid or expired" message is byte-identical
  on every failure path (no oracle distinguishing wrong-code from too-many-tries
  from expired).
- Deferred: true HTTP-layer rate limiting on the exchange endpoint (per-IP) is a
  larger change tracked separately in the audit report; this plan hardens the
  store, not the transport.
