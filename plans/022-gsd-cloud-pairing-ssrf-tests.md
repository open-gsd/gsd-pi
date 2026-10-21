# Plan 022: Test gsd-cloud's device-flow polling and SSRF gateway guards

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7cca07ae..HEAD -- packages/gsd-cloud/src/device-flow.ts packages/gsd-cloud/src/cloud-config.ts packages/gsd-cloud/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (tests only)
- **Depends on**: plans/018-ship-gsd-cloud-built-and-tested.md (so these tests actually run in CI); plans/020-cloud-pairing-http-timeouts.md if it landed (it adds a `timeoutMs` param to the helper — harmless here)
- **Category**: tests
- **Planned at**: commit `7cca07ae`, 2026-07-07

## Why this matters

`packages/gsd-cloud` is the security boundary for pairing a local machine to
GSD Cloud, and its two most security-critical modules have zero direct tests:

- `device-flow.ts` implements the full RFC 8628 device-authorization flow — the
  poll state machine (pending / approved / denied / expired), and the
  re-validation of the **server-supplied** `gateway_url` (untrusted input that,
  if accepted unchecked, would let a compromised gateway redirect all future
  relay traffic). No test in the package references it.
- `cloud-config.ts` exports the SSRF guards (`parseCloudGatewayUrl`,
  `validateGatewayNetworkTarget`, and the private `isPrivateIpHost`) that stop
  a malicious `--gateway` from pointing pairing/token traffic at
  `169.254.x.x`/`127.0.0.1`/RFC1918 ranges. The package's only test file,
  `cloud-gateway-lookup.test.ts`, imports **just** `createGatewayLookup`; an
  accidental loosening of the protocol check or private-IP matching would not
  fail any test.

The daemon package already tests its equivalent device flow with a loopback
HTTP server (`packages/daemon/src/device-flow.test.ts`) — this plan brings
gsd-cloud to parity using the same harness pattern.

## Current state

Files and roles:

- `packages/gsd-cloud/src/device-flow.ts` — `runDeviceFlow(params)`. Key facts from reading it:
  - Requests `/api/device/code`, expects `{ userCode, deviceCode, verificationUriComplete, expiresIn }`; throws if `userCode`/`deviceCode` missing.
  - Polls `/api/device/token` with `{ deviceCode }`; poll-loop network errors are swallowed and retried until expiry.
  - On `status === "approved"`: requires `token` + `runtimeId` (throws if missing); if the response carries `gateway_url`, it is re-validated via `parseCloudGatewayUrl` + `validateGatewayNetworkTarget` — an INVALID value warns to stderr and falls back to the caller's `params.gatewayUrl`; a VALID value replaces it. Returns `{ deviceToken, runtimeId, gatewayUrl }`.
  - On `status === "denied"` and on expiry it clears the spinner and (per the doc comment) **calls `process.exit(1)`** — read the tail of the file (past line 140) to confirm exact behavior before writing those cases.
  - Writes spinner frames to `process.stdout` on a 100ms interval during polling.
- `packages/gsd-cloud/src/cloud-config.ts` — `parseCloudGatewayUrl` (line ~35: rejects plain-HTTP for non-localhost, rejects HTTPS private/loopback IP hosts), `isPrivateIpHost` (line ~113, not exported), `validateGatewayNetworkTarget` (line ~121), `exchangePairingCode` (line ~19), `postJsonToValidatedGateway` (line ~198).
- `packages/gsd-cloud/src/cloud-gateway-lookup.test.ts` — the package's assertion style (node:test, `assert/strict`, `// Project/App:` two-line header).
- `packages/daemon/src/device-flow.test.ts` — THE harness to copy. Its `startDeviceServer` helper stands up a loopback `node:http` server implementing `/api/device/code` and `/api/device/token`, parameterized by what `gateway_url` the token response carries. First ~35 lines:

```ts
// Device-flow gateway_url resolution tests: server-valid-wins, absent-falls-back,
// invalid-falls-back-no-throw. Drives runDeviceFlow against a local loopback HTTP server.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
...
function startDeviceServer(gatewayCase: GatewayCase): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    ...
      if (req.url === "/api/device/code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          userCode: "ABCD-1234",
          deviceCode: "device-code-fixture",
          verificationUriComplete: "https://example.test/verify?code=ABCD-1234",
          expiresIn: 600,
```

- `packages/gsd-cloud/package.json` — `test` script lists compiled test files explicitly; new files must be appended:

```json
"test": "pnpm run build && node --test dist/inject-gateway.test.js dist/cloud-gateway-lookup.test.js dist/cloud-runtime.test.js dist/executors/mcp-stdio-client.test.js dist/executors/gsd-pi-executor.test.js"
```

Conventions: double quotes, semicolons, `// Project/App:` + `// File Purpose:`
two-line headers on new files, `node:test` + `assert/strict`. IMPORTANT: the
SSRF guard permits plain HTTP only for localhost, so loopback `http://127.0.0.1:<port>`
test servers are valid targets (this is exactly how the daemon tests work).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build + run package tests | `pnpm --filter @opengsd/gsd-cloud run test` | exit 0, all pass |
| Run one compiled test file | `pnpm --filter @opengsd/gsd-cloud run build && node --test packages/gsd-cloud/dist/device-flow.test.js` | all pass |

## Scope

**In scope**:

- `packages/gsd-cloud/src/device-flow.test.ts` (create)
- `packages/gsd-cloud/src/cloud-config.test.ts` (create — if plan 020 already created it, extend it)
- `packages/gsd-cloud/package.json` (append the two compiled test files to the `test` script)

**Out of scope**:

- Any production source change in `device-flow.ts` / `cloud-config.ts`. If a behavior looks wrong while testing, STOP and report — do not "fix" production code in a test plan. Exception: if `process.exit(1)` on denial/expiry makes those paths untestable in-process, note it in the report; do NOT refactor to injectable exit in this plan.
- `packages/daemon/**` — its flow is already tested.
- `cloud-token.ts` — worth testing later; kept out to keep this plan bounded (recorded in `plans/README.md`).

## Git workflow

- Branch: `advisor/022-gsd-cloud-pairing-ssrf-tests`
- Conventional Commit, e.g. `test(gsd-cloud): cover device-flow polling and SSRF gateway guards`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: SSRF-guard unit tests (`cloud-config.test.ts`)

Create `packages/gsd-cloud/src/cloud-config.test.ts` with a table-driven matrix
over `parseCloudGatewayUrl` (and `validateGatewayNetworkTarget` where a URL
parses but the target must be rejected). First READ `cloud-config.ts` lines
35–130 to confirm which function rejects which case, then assert at minimum:

Rejected (assert `throws`, and match the error message the code actually uses):
- `http://evil.example` (plain HTTP, non-localhost)
- `https://10.0.0.1`, `https://192.168.1.1`, `https://172.16.0.1` (RFC1918)
- `https://169.254.169.254` (link-local / cloud metadata)
- `https://127.0.0.1`, `https://[::1]` (loopback over HTTPS)
- `ftp://gateway.example` or similar non-HTTP protocol
- empty string / garbage (`"not a url"`)

Accepted (assert no throw, and the returned `URL` round-trips):
- `https://cloud-gateway.opengsd.net`
- `http://localhost:8787` and `http://127.0.0.1:8787` (the documented local-dev carve-out — confirm the exact allowed forms from the code first)

`isPrivateIpHost` is unexported — cover it through the public functions; do not
export it just for tests (this package has no `_xxxForTest` seam convention yet,
and the public surface reaches every branch via the matrix above).

**Verify**: `pnpm --filter @opengsd/gsd-cloud run build && node --test packages/gsd-cloud/dist/cloud-config.test.js` → all pass.

### Step 2: Device-flow tests (`device-flow.test.ts`)

Create `packages/gsd-cloud/src/device-flow.test.ts`, porting the
`startDeviceServer` harness from `packages/daemon/src/device-flow.test.ts`
(adapt imports/params to gsd-cloud's `runDeviceFlow` signature — read
`DeviceFlowParams` first; it includes `gatewayUrl` and `binaryName` and
optional `runtimeName`). To keep tests fast, have `/api/device/code` return a
small `expiresIn` (e.g. 5) — the poll interval constant is
`DEFAULT_POLL_INTERVAL_MS`; read its value first and, if it makes tests slow
(>2s), have the token endpoint approve on the first poll.

Cases:

1. **Immediate approval**: token endpoint returns `{ status: "approved", token: "tok", runtimeId: "rt" }` → resolves with `{ deviceToken: "tok", runtimeId: "rt", gatewayUrl: <params.gatewayUrl> }`.
2. **Pending then approved**: first token call returns `{ status: "pending" }` (or whatever non-approved status the code treats as continue — read the loop), second returns approved → resolves; assert the server saw ≥2 token POSTs.
3. **Server-supplied VALID `gateway_url` wins**: approved response carries `gateway_url: "https://relay.opengsd.net"` → result `gatewayUrl` equals that value (normalized via `parseCloudGatewayUrl(...).toString()` — mirror the daemon test's expectation style).
4. **Server-supplied INVALID `gateway_url` falls back**: approved response carries `gateway_url: "https://169.254.169.254"` → result `gatewayUrl` equals `params.gatewayUrl`, and the run does not throw (the code warns on stderr and continues).
5. **Approval response missing token/runtimeId throws**: approved status with no `token` → rejects with `/missing token or runtimeId/`.

Do NOT test the denied/expired paths if they call `process.exit(1)` (confirmed
by reading the file tail) — an in-process `node:test` cannot survive that.
Instead add a comment in the test file noting the exclusion and why.

Silence spinner noise if it pollutes test output: the spinner writes via
`process.stdout` `cursorTo`/`clearLine` — if that breaks in a non-TTY test
environment, that is a STOP condition (report it as a real bug: device flow
assumed a TTY), not something to patch around.

**Verify**: `node --test packages/gsd-cloud/dist/device-flow.test.js` (after build) → all 5 pass in < 30s.

### Step 3: Wire the new files into the package test script

Append `dist/cloud-config.test.js dist/device-flow.test.js` to the `test`
script's file list in `packages/gsd-cloud/package.json`.

**Verify**: `pnpm --filter @opengsd/gsd-cloud run test` → exit 0; output shows tests from BOTH new files plus the 5 pre-existing files.

## Test plan

This plan IS the test plan: ~11+ new tests across two files. Pattern files:
`packages/daemon/src/device-flow.test.ts` (harness),
`packages/gsd-cloud/src/cloud-gateway-lookup.test.ts` (style).

## Done criteria

- [ ] `packages/gsd-cloud/src/cloud-config.test.ts` exists; SSRF matrix covers ≥6 rejected + ≥2 accepted URLs
- [ ] `packages/gsd-cloud/src/device-flow.test.ts` exists; the 5 cases above pass
- [ ] `pnpm --filter @opengsd/gsd-cloud run test` → exit 0 and runs both new files
- [ ] No production source files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any test reveals a real behavioral bug (e.g. an invalid server `gateway_url` is accepted, a private IP passes the guard, the spinner crashes in non-TTY) — report the bug with the failing test; do not change production code.
- `runDeviceFlow`'s signature or the endpoint paths differ from Current state.
- The poll loop cannot be made to complete in <30s per test without production changes.

## Maintenance notes

- When plan 018 lands, these tests run on every CI push — they are the regression net for the pairing security boundary.
- Follow-ups deferred and recorded in the index: `cloud-token.ts` tests; making denial/expiry testable via an injectable exit seam (would need a maintainer decision on adding a `ForTest` seam to this package); daemon `orchestrator-agent.ts`/`cloud-cli.ts` coverage.
- Reviewer: check the SSRF matrix against `cloud-config.ts`'s actual branches — the value of this suite is that loosening ANY branch turns a test red.
