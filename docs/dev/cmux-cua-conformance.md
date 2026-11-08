# cmux CUA portable conformance and operator boundary

This guide accompanies the optional [Computer Use contract](cmux-computer-use-contract.md) and the incremental conformance work for [#3019](https://github.com/open-gsd/gsd-pi/issues/3019). It is not an operational enablement or a claim that the umbrella is complete.

## Admission remains closed

`G03_RUNTIME_ADMISSION_ENABLED` remains `false`. The default extension registers no Computer Use tools or lifecycle handlers. There is no `type_text` tool. Reading this guide, loading the skill, inspecting permissions, or passing fixture tests is not consent to use the desktop.

`pre-init-binding.ts` and `revocation-quiescence.ts` remain offline models. Their signatures, receipts, terminality and revocation tests do not authenticate a live cmux endpoint or prove runtime backend quiescence. The connected-session fixture binding is never a runtime admission route: production retains its private host handoff, capability resolution, stdio startup and mandatory peer checks.

## Versions and attachment evidence

| Boundary | Source or observation | Qualification |
| --- | --- | --- |
| Native contract expected by the adapter | `cmux-cua` 0.7.1, 39 tools; pinned source `e0f738807dbff2f35fe67d7fbcc99c7082cffc23` | A source expectation, not authenticated endpoint evidence or an accepted complete schema archive |
| MCP SDK in this source checkout | Lockfile 1.32.0, legacy v1 `@modelcontextprotocol/sdk` API | Exact locked execution requires current-head CI |
| Borrowed local fixture SDK | Installed 1.32.2 | Distinct from the locked dependency and deployed/runtime evidence |
| Installed cmux observed read-only on 2026-11-08 | 0.65.0 (108), `dda24fbd2` | CLI version only; not a qualified fresh Pi/GSD connection |
| Fresh integrated Pi/GSD desktop support | Not proven | No supported-version or automatic-attachment claim |

The [contract's attachment boundary](cmux-computer-use-contract.md#attachment-consent-and-privacy) describes the required host-owned handoff. Do not replace it with user-constructed environment flags, another agent's credentials, an undocumented binary invocation, or a fixture peer assertion. Documented Claude/Codex wrapper attachment is not proof of automatic Pi attachment.

No exact fresh Pi/GSD setup route has been accepted by these fixtures. Missing helper tools or a failed status check do not authorize installing components, launching a helper, changing settings, or restarting cmux. Installation and restart require an explicit operator go and a current READY gate; READY alone is not consent.

The initial read-only observation was `cmux-cua status` exit 1, with `cmux CUA daemon is not running`, while command-name-only process inspection found cmux-managed helper processes. This does not prove absence of every helper, a connected peer, or a healthy daemon. Different standalone and managed socket paths remain a hypothesis until source-bound routing and connection evidence are obtained. Do not read bearer/capability contents or other panes to resolve it.

## What the fixture suite actually executes

`src/resources/extensions/cmux-cua/tests/cmux-cua-conformance.test.ts` connects a real legacy-v1 MCP `Client` and `Server` through `InMemoryTransport`. Protocol setup creates no filesystem root, ownership manager or lease. Source inspection and action fixtures separately acquire an isolated real ownership guard and inject an explicit synthetic peer-generation assertion that can reject changes. Both partitions use the corresponding exported production code; neither the assertion nor the transport is native authentication.

The 32-test file has two execution partitions:

- **12 portable/default-off tests:** default-off registration (1), SDK discovery/catalogue and malformed-result rejection (8), deterministic platform-qualification plus guard-free fixture shape (1), SDK protocol cancellation without replay (1), and exact PID-value redaction without opaque UUID-substring false positives (1). These run without guard acquisition, fake leases or skipped discovery, including on Windows. The qualification matrix is a pure predicate test, not a simulated Windows runtime or native proof.
- **20 source inspect/act and real-guard tests:** opaque grants, privacy minimization, stale evidence, actual-clock expiry, native-result rejection, synthetic binding, ambiguous-click cancellation/disconnect/timeout, quarantine and competing ownership. They run only on Darwin or Linux with `process.getuid` and `/bin/ps`, matching the shared desktop-ownership suite. Otherwise each is explicitly skipped with `POSIX desktop ownership guard requires getuid and /bin/ps`; Windows and other unsupported guard/native state remain unverified.

A fully qualified POSIX run therefore expects 31 passes and no skips; an unsupported guard platform expects 11 passes and 20 qualification skips. A local macOS run is not Windows execution evidence. The pure protocol cancellation test does not replace the three guard-backed ambiguous-click cases or establish backend quiescence. The original 29 cases and their failure, metadata and opaque-grant assertions remain intact; the two boundary/protocol tests are additional coverage.

The fixture has no cmux connection, native helper, real application window, screenshot or customer asset. Its peer assertion proves transaction ordering and rejection only, never macOS authenticity. Its partial native-tool catalogue is intentionally not padded with invented names to fabricate a valid 39-tool inventory.

| Criterion | Fixture coverage in this increment | Remaining acceptance |
| --- | --- | --- |
| 19-P01 default-off | Actual registration touches no supplied API; native-command guards detect no attempts | Full cold-import/file/token counters and combined non-Mac startup |
| 19-P02 discovery | Real initialization and identity/version checks; missing/malformed/duplicate inventory, cursor and page-limit rejection | Accepted complete canonical 39-tool/schema/annotation catalogue and capability matrix |
| 19-P03 transaction sequencing | Source inspection, opaque grants, one synthetic click, exact verification, expiry/stale targeting, denied images/metadata, bounded results and redaction | Complete selection, no-op, changed-postcondition and verification-error partitions |
| 19-P04 failure visibility | Source action with real SDK abort, disconnect and timeout; no replay/new action and persistent guard denial | Initialization/read/verification cancellation; physical helper death; queued cleanup/revocation races |
| 19-P05 competing drivers | Real guard exclusion during reads; guard-only clean terminal connection-close release/reacquisition | Native proxy exit, subagent routing, queued lifecycle and backend-quiescence evidence |
| 19-P06 compatibility | No combined compatibility result claimed | Native-tools/browser/unrelated-MCP and non-Mac regression fixtures |
| 19-P07 bounded evidence | Synthetic-only data; tested inspection/text/structured bounds and withheld native IDs, tokens, trees and unsafe labels | Complete logging, telemetry and evidence-writer pipeline |

These are covered subsets, not PASS verdicts for the entire seven-row checklist. The native [acceptance ledger](cmux-computer-use-contract.md#acceptance-ledger) is not advanced by an in-memory exchange.

Even a matching synthetic UI postcondition returns quarantine while backend quiescence is unproven. A second inspection or a new grant is not permission to replay the action. Closing `InMemoryTransport` has no child PID and never proves native proxy exit or operation terminality. Guard-only read cleanup is a different proof class from recovery after a potentially mutating native action.

## Portable verification and report contract

The existing compiled unit lane includes `dist-test/src/resources/extensions/cmux-cua/tests/*.test.js`. Use the repository's canonical scripts on a clean runner rather than a machine-specific borrowed-dependency loader:

```bash
pnpm run typecheck:extensions
pnpm run test:compile
pnpm run test:unit:compiled
```

Build, packaging and full merge verification belong to online CI for this operator workflow. This guide does not authorize local installation or a local build. Borrowed local SDK/type dependencies are supplementary: zero owned diagnostics with transitive errors is not a clean whole-project typecheck. Do not convert that result into a package, current-head CI or native-support claim.

Record each execution's exact source SHA and dirty-file/content scope, environment/dependency versions, command, UTC start/end, exit, counts and durable redacted evidence reference. A later commit invalidates previous-head CI and review proof. Keep a compact report of fixed check IDs, method classifications and counters; do not archive raw tool arguments/results, AX trees, stderr containing credentials, bearer data, real window contents or image pixels.

| Evidence class | Current disposition |
| --- | --- |
| Local source/fixture tests | Supplementary; require terminal command evidence and actual changed-file hashes |
| Exact-head locked CI/typecheck/build/pack | Pending until the published candidate's checks finish successfully |
| Native macOS direct-helper evidence | NOT-RUN for this increment |
| Fresh integrated Pi/GSD operational evidence | NOT-RUN/BLOCKED; admission remains closed |

## Operator-controlled permissions and future smoke

Accessibility and Screen Recording onboarding is an operator-controlled system step. Never grant either permission automatically or interpret previously granted permissions as action consent. Separate approval for sharing bounded AX text is also required by the source contract. No onboarding, permission request or native smoke was executed for this increment.

Only after a compatible host-owned setup, source-bound peer and terminality proof, the required approvals and the relevant admission review exist may a benign scenario be evaluated:

1. Start a fresh approved session through the proven host-owned route; verify exact cmux/Pi/GSD/helper revisions and endpoint identity. Stop if the route is unavailable or unproven; do not guess a command.
2. Let the operator select one benign Calculator window with a unique public AX observer. Inspect without screenshots and obtain a fresh opaque grant. Ambiguous display, stale target, denied permission or absent helper means BLOCKED, not success.
3. Under separate narrowly scoped action approval, perform at most one action with a previously unsatisfied postcondition and verify that same observer. Do not infer delivery or backend completion solely from the displayed value.
4. Revoke/stop before any queued second dispatch and collect source-bound operation terminality, proxy-exit and ownership evidence. Disconnection or timeout must not trigger blind repetition.
5. A subsequent owner may inspect afresh and make a new action only after actual safe release and backend proof. If the journal is quarantined, preserve the denial and use the genuine reviewed recovery route; fixture closure is insufficient.
6. Clean up or disable through the proven lifecycle route. Record unresolved exit/operation/permission failures; do not silently restart cmux or affect another controller.

This is a future scenario, not an executable permission grant. With the current `false` admission gate and no typing tool, native action/typing steps remain unavailable. Do not run `cmux-cua serve`, `call`, or `permissions` directly as a shortcut.

## Native proof still required

| Proof | Current result | Required distinction |
| --- | --- | --- |
| D1 live-connection peer binding before initialization | NOT-RUN/BLOCKED | Endpoint authenticity, not matching metadata or fixture signatures |
| D2 daemon-side hard kill | NOT-RUN | Native process/backend evidence, not client close |
| D3 revocation of a live operation | NOT-RUN | No future effect or regrant from an old generation; not an offline reducer result |
| D4 no-replay typing | NOT-RUN/BLOCKED | No typing admitted; source-bound non-replay proof is absent |

Native UI control is not browser automation, an approval mechanism, GSD lifecycle authority, or release/deployment evidence. Missing native checks must stay explicitly unverified; do not close the umbrella or claim full support from portable CI, issue state, permissions, or an agent's success narrative.
