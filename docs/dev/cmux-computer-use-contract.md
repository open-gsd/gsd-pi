# Optional cmux Computer Use contract

For incremental production-transaction fixture coverage and explicit remaining operator/native gates, see [Portable conformance and operator boundary](cmux-cua-conformance.md). That evidence is partial; it does not advance this document's full acceptance ledger or authorize runtime admission.

> [!IMPORTANT]
> Updated 2026-11-05 to reflect maintainer approval of RFC [#3103](https://github.com/open-gsd/gsd-pi/issues/3103).
> On 2026-11-06, the maintainer separately authorized the host-derived local-interactive admission signal in PR #3115; G-03 remains disabled and no runtime acceptance is claimed.
> G-01/G-02 authorize only the RFC-scoped disabled implementation plus the narrow 2026-11-06 host-signal amendment recorded below; they are not G-03 operational proof or permission to enable native actions.
> G-03 remains open, `type_text` remains disabled pending proof of non-replaying behavior, and no fresh integrated Pi/GSD acceptance has passed.
> This document does not complete implementation acceptance for [#3018](https://github.com/open-gsd/gsd-pi/issues/3018) or [#3019](https://github.com/open-gsd/gsd-pi/issues/3019).

## Recommendation and adoption gates

Recommend an optional `cmux-cua` extension using the existing MCP TypeScript SDK,
not configuration alone: the current
[generic MCP wrapper](../../src/resources/extensions/mcp-client/index.ts) converts
images to text and loses MCP `isError`/structured-result fidelity. Process-launch
trust is not consent to drive an app or share observations. Reuse SDK transport,
not that wrapper's result conversion; do not change generic MCP as a prerequisite.

Keep this separate from cmux progress, Vault, resume, themes, and browser tooling.
Baseline ownership, cancellation, privacy, and failure handling must ship with the
**first working connection** (#3017), not be deferred to #3018/#3019.

| Gate | Approved status and remaining proof |
| --- | --- |
| G-01: supported owner/route | Approved: the optional adapter and shared GSD desktop guard are limited to the inherited ordinary-agent handoff below. RFC #3103 and the dated [#3017 decision comment](https://github.com/open-gsd/gsd-pi/issues/3017#issuecomment-6634964004) authorize gated implementation only. |
| G-02: expanded source scope | RFC #3103 approves the `cmux-cua` adapter plus shared desktop guard across the listed adapter, `shared/desktop-ownership.ts`, `mac-tools`, and `subagent` paths/tests. **Maintainer-authorized exception for PR #3115 (2026-11-06):** add only a host-derived `isLocalInteractiveDesktop` signal and use it to gate CUA and standalone `mac-tools` in RPC/headless contexts. Other core/loader/orchestration changes still require separate approval; this exception does not authorize epoch/process-binding/backend work or G-03 enablement. |
| G-03: operational safety | Prove native result schemas and non-replaying dispatch for each enabled operation; the exact inherited-managed-session lifecycle handshake (`start_session`/`end_session` arguments, results, and identity checks); trusted socket endpoint binding before capability transmission; terminal-invocation evidence; and cross-process enforcement against the pinned backend before enabling actions. The pinned background `type_text` path may fall back to CGEvent after an AX write is not positively verified, with `clear_first:false`; keep typing disabled until backend semantics and regression tests prove no replay or definite non-delivery. Unverifiable recovery remains blocked; no invented cancellation/fencing API. |

**Recorded approval:** maintainer `@pimmink` approved RFC #3103 on 2026-11-04 against source baseline `fae322618b3b64bdaa21689df3d3937fa6af459b`. The decision adopts the optional adapter and shared desktop guard for the inherited ordinary-agent route only, with the exact source paths and exclusions in the RFC. This authorizes gated implementation; it does not establish G-03 proof, authorize native use, or complete #3018/#3019. See the [decision record](https://github.com/open-gsd/gsd-pi/issues/3017#issuecomment-6634964004).

## Version-bound boundary and present evidence

Reviewed source: GSD **1.23.0** at
[`b631874218fb97d722a198562f7881b7f3e8482d`](https://github.com/open-gsd/gsd-pi/tree/b631874218fb97d722a198562f7881b7f3e8482d),
repository-resolved MCP SDK **1.32.0** (declared range `^1.27.1`), cmux
**0.65.0 (108)** at
[`dda24fbd2`](https://github.com/manaflow-ai/cmux/tree/dda24fbd2), and native engine
**0.7.1** at
[`e0f738807dbff2f35fe67d7fbcc99c7082cffc23`](https://github.com/manaflow-ai/cmux-cua/tree/e0f738807dbff2f35fe67d7fbcc99c7082cffc23).
This is a reviewed baseline, not an accepted integration. Earlier SDK **1.32.2**
probe observations are not interchangeable with 1.32.0 results.

Primary sources: [official guide](https://cmux.com/docs/computer-use),
[host wrapper](https://github.com/manaflow-ai/cmux/blob/dda24fbd2/Resources/bin/cmux-claude-wrapper#L1368-L1425),
[helper CLI](https://github.com/manaflow-ai/cmux-cua/blob/e0f738807dbff2f35fe67d7fbcc99c7082cffc23/libs/cmux-cua/rust/crates/cmux-cua/src/cli.rs),
[proxy](https://github.com/manaflow-ai/cmux-cua/blob/e0f738807dbff2f35fe67d7fbcc99c7082cffc23/libs/cmux-cua/rust/crates/cmux-cua/src/proxy.rs),
and [server](https://github.com/manaflow-ai/cmux-cua/blob/e0f738807dbff2f35fe67d7fbcc99c7082cffc23/libs/cmux-cua/rust/crates/cmux-cua/src/serve.rs).
Automatic attachment is documented for Claude Code/Codex, **not Pi**. The
[RFC #3103](https://github.com/open-gsd/gsd-pi/issues/3103) and the [dated decision record](https://github.com/open-gsd/gsd-pi/issues/3017#issuecomment-6634964004) document the approved gated route; the earlier comments are historical context.

| Evidence class | Observed limit |
| --- | --- |
| Lower-level discovery/permission probes | Metadata discovery reported 39 tools; a separate authenticated, non-prompting permission probe reported both permissions true. Neither proves Pi/GSD attachment, safety, or an action. Counts/versions alone are not schema conformance. |
| E1: local direct-proxy Calculator report | `.artifacts/cmux-cua-native-contract-bcca26d8-d43d-447d-b10c-dd56e7893470.json`: `actionAttempts:0`; blocker `ambiguous-calculator-numeric-display`; `nativeContractProven:false`, `piGsdAcceptance:false`; its four cleanup assertions are true. **BLOCKED**, not an action/verify or stop/cancel pass. |
| E2: local direct-proxy TextEdit report | `.artifacts/cmux-cua-native-contract-5024dc34-ae1e-414f-982c-4a7d5582dbbf.json`: proxy session established and TextEdit launched, but `actionAttempts:0`; blocker `ambiguous-text-editor-target`; `nativeContractProven:false`. The artifact did not confirm app termination; a separate filtered post-check found no registered TextEdit app and zero matching process paths. Treat artifact cleanup as **unverified**, not a pass. This artifact predates later lab-script edits and has no tested-script hash; it does not verify the current source. |
| Product / integrated proof | Adapter unimplemented; portable conformance and fresh Pi/GSD native acceptance **NOT-RUN**. A baseline typecheck was cancelled after 443.3 seconds, not passed. |

E1/E2 are operator-local evidence identities, not shipped artifact links or a
portable fixture. Preserve only these redacted facts. Experimental untracked
lab scripts are **not product code or PR deliverables**. Independent review found
capability-read bounds/blocking, permission conflict, negative-result,
arbitrary-key/metadata, inherited-PATH, and temporary-state cleanup defects in
discarded lab probes. Do not call those experiments secure, passing, or acceptance
harnesses, or use their cleanup assertions to prove the proposed product lifecycle.

## Attachment, consent, and privacy

cmux owns helper readiness, OS permission onboarding, recovery, and shutdown. The
adapter owns its proxy child, session authority, shared guard, validated results,
and local cleanup. The SDK supplies transport, not desktop safety or rollback.

Disabled startup/install/status, unsupported platforms, unattended/headless calls,
and ordinary CI must do **zero** capability reads, proxy spawns, native discovery,
permission prompts, or desktop access. Proposed `/cmux-cua enable`, `status`, and
`stop` are not shipped commands. Enable is interactive and session-only: select
backend and running app/window, approve driving, then separately approve sharing
AX text with the selected model and normal Pi session history. No consent restored
from history or inherited by children. Declined sharing disables inspect/action.
Accessibility and Screen Recording are operator-controlled; never auto-grant them.

Only after opt-in validate the inherited `CMUX_CUA_SOCKET_PATH` and
`CMUX_CUA_AUTH_TOKEN_FILE`. Open the supplied capability with
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; on that descriptor require a regular file,
current UID, and `(mode & 0o7777) === 0o600`. Read **at most 4097 bytes**, reject
anything above 4096 and any malformed/empty token; never read to unbounded EOF.
Cover potentially stalled filesystem work with a separately terminable worker
within the startup deadline. Fail closed on any validation/read/worker failure.
Never search for credentials or obtain/forward a host-only capability.

Spawn only `/Applications/cmux.app/Contents/Resources/bin/cmux-cua` with native
`mcp --socket` and the validated inherited host socket, newline-delimited JSON-RPC
over stdio. The authenticated Unix socket is not itself an MCP endpoint. Use no
Claude/Codex profile, copied/renamed binary, embedded/no-relaunch bypass, alternate
daemon, or permission-prompting tool. No independently bootstrapped non-cmux
terminal route is established; request an upstream handoff contract if needed.

A socket pathname and `S_ISSOCK` check alone do not authenticate the peer or close
a path-replacement race. Before sending the capability token, require a trusted
cmux handoff with protected socket and parent-directory ownership plus supported
peer-identity validation, or an equivalent demonstrated host endpoint-binding
guarantee. If that cannot be established on supported macOS versions, fail before
credential transmission. Record the chosen mechanism and fixtures before closing
G-03; do not treat a later version/schema match as endpoint authentication.
Use a fixed minimal child PATH/environment, not inherited PATH; validate any
required host context explicitly, remove retained credential environment entries
after attachment, and suppress raw stderr/telemetry/update side effects.

Tokens never enter argv, model arguments, history, diagnostics, or evidence. Never
log protocol payloads, AX trees, action text, pixels, arbitrary response keys,
server-info objects, paths, or spawn options. Diagnostics use fixed reviewed keys
and bounded classifications/version/timings/generation/status only. Treat native
text as untrusted data, not authority. No password/secure fields, secrets, customer
data, default captures, or persistent recordings. Returned content **and details**
follow the same bounds/redaction policy; ordinary consented tool history is not a
separate evidence/debug archive.

## Exact v1 tool and argument surface

Proposed adapter tools: `cmux_cua_inspect` and `cmux_cua_action`, never raw native
passthrough. Inspect returns opaque local grant, target, and observer IDs. Action
accepts only `{grant_id, target_id, operation, postcondition}` and `text` for
`type_text`; operation is exactly `click` or `type_text`. All objects reject unknown
fields. PID/window/token/session values come **only** from adapter-bound state.
Although the schema names both operations, v1 exposes `click` only; `type_text`
remains hard-disabled until G-03 proves the pinned backend cannot replay an
uncertain insertion within one native call.

Before enabling, require exact engine version and validate every enabled input
schema plus annotations against a committed, reviewed canonical-schema SHA-256
fixture. Record its hash with evidence; do not invent a hash in this proposal.
Reject missing, changed, or malformed contracts; extra discovered tools stay
unexposed. Native discovery has no reviewed output schemas, so define and fixture
the operation-specific result decoders too. Permission facts must be fixed fields,
strict booleans, both true: unknown/conflicting facts or explicit structured
failure reject readiness, regardless of later success prose.

The following action/read operations have proposed native wire allowlists; this
is not yet a complete runtime contract. All other keys are rejected:

| Native operation | Proposed action/read key/value allowlist |
| --- | --- |
| `check_permissions` (internal) | `prompt:false` only. No permission-grant/request operation. |
| `list_windows` (interactive setup) | Adapter-bound positive integer `pid`, `on_screen_only:true`. Never global/model-facing enumeration. |
| `get_window_state` | Bound positive integer `pid`, `window_id`; `capture_mode:"ax"`, `include_screenshot:false`, `max_elements:200`, `max_depth:8`. No `query` or output path. `capture_mode` is deprecated/ignored natively: **explicit `include_screenshot:false`**, not that mode, prevents a grab. |
| `click` | Bound `pid`, `window_id`, nonempty native `element_token` from the exact snapshot; `action:"press"`, `button:"left"`, `count:1`, `delivery_mode:"background"`. No modifiers, menus, alternate buttons/actions, coordinates, or foreground fallback. |
| `type_text` | **Disabled in v1 pending G-03 non-replay proof.** Proposed future request: same bound PID/window/token; `delivery_mode:"background"`, `delay_ms:0`, `text` of 1–256 Unicode scalar values **and** at most 1024 UTF-8 bytes. No controls/newlines, secure fields, secrets, credentials, or coordinate focus. |

The pinned macOS backend first writes `AXSelectedText`; if a subsequent read-back
cannot positively confirm insertion, the background path falls back to CGEvent
with `clear_first:false`. An AX API success followed by an unconfirmed read-back
can therefore replay text before the adapter receives a result. See the pinned
[`type_text.rs` implementation](https://github.com/manaflow-ai/cmux-cua/blob/e0f738807dbff2f35fe67d7fbcc99c7082cffc23/libs/cmux-cua/rust/crates/platform-macos/src/tools/type_text.rs#L631-L660).
Postcondition checking or adapter-level retry suppression cannot prevent this
within-call fallback. Do not expose text insertion until a backend contract
provides non-replaying dispatch or proves the first attempt was not delivered.

The pinned proxy source exposes two session modes, but RFC #3103 authorizes only
the inherited managed route using `CMUX_CUA_DEFAULT_SESSION`; unmanaged mode is
out of scope and must never be selected as a fallback. The managed proxy appends
its suffix to the configured base and rewrites forwarded `session`/`_session_id`
arguments. The native `start_session` handler returns a resolved identity, not
necessarily the proxy identity. Never accept model-supplied session/host-owner
values or treat environment-variable presence as proof of identity binding.

G-03 remains open: before enabling any native action, prove the exact internal
`start_session`/`end_session` request keys and values, returned-identity checks,
subsequent routing, session ownership, and cleanup. These lifecycle calls are
internal and never model-exposed. No mode fallback is allowed; fail closed if the
inherited managed mode or resolved identity cannot be established.
Require `element_token` only: no `element_index`, even alongside a token.
Index-only targeting needs separate proof of server-side snapshot binding/stale
rejection.
Exclude `press_key`, modifiers/hotkeys, `scroll`, drag, app launch/quit/activation,
global enumeration, recording, installation/update, and all unlisted operations.
No automatic alternate targeting, foreground delivery, or mutation retry.

All coordinates and output paths (`screenshot_out_file`, `debug_image_out`, etc.)
are forbidden in v1, even with screenshot disabled. A per-request interactive
operator confirmation may change **only** `include_screenshot` to true for one
approved-window inspection, including post-action inspection. Default consent or
a model request is insufficient. Return at most one PNG/JPEG, 4 MiB decoded,
4096×4096 pixels; reject malformed/oversized images, never stringify base64.
Bound text to 32 KiB and authorize targets only from the bounded returned tree.
Preserve MCP `isError`, validated structured-result meaning, and real Pi image
blocks; return only approved result fields. Truncation invalidates omitted targets.

## Shared GSD exclusion, not global OS control

Every supported in-repo GSD desktop driver must use the **same cross-process
lease**, including `mac-tools` in sessions/subagents that never enable this
adapter. An extension-local `tool_call` hook alone is insufficient. Guard the
actual driver execution boundary as well; tool-selection flags, child launch,
reload, and direct in-repo invocation must not bypass it. Guard absence/version
mismatch fails closed for desktop tools, not by falling back to an unguarded path.

Proposed v1 mutex: an exclusive loopback TCP listener, no RPC, no port reuse or
fallback. Reserve `127.0.0.1:(42317 + (loginUID % 8192))` consistently across GSD
versions, projects, `GSD_HOME`, and processes; validate exclusivity on supported
macOS before adoption. Immediately close unsolicited connections; accept no
commands/data. Port squatting or a cross-UID collision means busy/unavailable,
never authority. State-format mismatch must not choose another port.

- Adapter enable acquires before operational attachment and holds the parent
  lease for the **entire active interactive session**, including idle time,
  inspection, mutation, verification, and cleanup. One serialized transaction.
- Competing `mac-tools` desktop reads/captures/actions acquire that same lease
  before accessing the native helper and hold through completion. While adapter
  ownership is active they reject `desktop-busy` **before** native execution.
  Permission-status-only checks need no desktop lease or consent transfer.
- Subagents receive neither lease handles nor consent. Standard native drivers
  guard themselves even without the adapter loaded; the launch path must enforce
  guard-enabled drivers or exclude them. Known alternate native MCP routes must
  join the guard or be disabled. Unsupported/custom native drivers are outside
  the supported toolset, not an accepted subagent bypass.
- After clean release a new owner needs explicit opt-in, fresh inspection, new
  grant, and a new verified action. Never forward a parent grant or replay work.

Browser DOM/Playwright automation is separate, not a desktop-lease consumer.
Human input, unrelated external controllers, arbitrary shell programs, and
unsupported external extensions are not a security sandboxed boundary. Operators
must stop conflicting external controllers. Do **not** exclude ordinary GSD
`mac-tools`/subagents from the supported guarantee or claim global OS control.
Disabled cmux must preserve ordinary native/browser/MCP behavior except legitimate
contention/quarantine checks in the shared guard; no cmux dependency/spawn.

## Quarantine, verification, and lifecycle

### Durable uncertainty and recovery

Use the OS account database's home for the login UID, not environment `HOME` or
`GSD_HOME`: `Library/Application Support/gsd-desktop-safety/state.json` beneath it,
with owner-only directories (0700), file (0600), and no symlink traversal. No
version-specific alternate path on incompatibility. Before any desktop mutation,
durably record the owner, authenticated daemon identity, resolved CMUX session
identity, session admission epoch, invocation ID, and unresolved state
(no desktop content); fsync the file and containing directory for atomic
replacement before dispatch. Invalid/unreadable/unwritable state denies mutations.
The OS mutex is **not** this journal. Every driver checks it while holding the
lease; unresolved state quarantines current **and subsequent** owners. The
quarantine epoch is scoped to the affected cmux session/invocation. Authenticated
daemon identity identifies the peer; it is not an admission epoch. Advancing a
daemon-wide generation must not invalidate unrelated sessions.

An accepted/dispatched request can outlive proxy death and lock/session closure.
Pinned proxy EOF cleanup and server ended-session checks do **not** demonstrate
cancellation/draining of an already admitted invocation. Operator acknowledgement
plus reinspection is **insufficient** to clear quarantine. Resume only with:

1. Operation-specific evidence that the previous invocation is terminal, not
   merely a transport/dispatch acknowledgement; or
2. A supported **session-scoped backend-generation fence**, proven to prevent
   all future execution of that invocation without invalidating unrelated sessions.

A daemon-wide generation bump or shared-helper restart is not an approved
recovery mechanism: it may invalidate unrelated sessions. A session-scoped fence
is not established for unresolved calls by this evidence. If that fence cannot be
verified, remain blocked, report recovery unavailable, and require
operation-specific terminal proof or a separately reviewed RFC change. The
adapter must not kill/restart a shared helper or offer a “clear by acknowledgement”
escape. Never claim lock/session close cancels posted OS events.
Clear a marker only under the lease with matching owner, daemon identity,
session identity, session admission epoch, and invocation ID; a late completion
cannot clear a newer marker. Persist recovery
proof identity/classification, not payloads. Normal verified completion also needs
terminal-invocation evidence; an acknowledgement alone cannot authorize reuse.

### Observable action protocol

Bind app identity to a strong OS process-generation identity and executable,
not PID alone or second-resolution `ps` text. Recheck it and the exact window
before every observation, dispatch, and verification; if unavailable, fail closed.
Never signal a replacement PID. A grant binds this identity, native snapshot/token,
connection generation, cancellation epoch, and monotonic expiry (maximum 10 s).
Intervening inspection, layout/navigation change, reconnect, or action invalidates
old targets. Atomically consume the grant and persist uncertainty **before** send.
Known-stale rejection requires reinspection/new decision, never automatic retry.

Action must supply a local `postcondition` of exactly
`{kind:"ax-value-equals", observer_id, expected}`. The observer ID is minted during
inspection for one uniquely identifiable nonsecure AX value in the approved
window; `expected` is nonsecret text bounded as above. The adapter resolves a
stable role/identifier selector and evaluates exact value equality on a **new**
validated snapshot. It must differ from the pre-action value. Missing/nonunique
observers or an already-matching value cannot uniquely confirm an effect: reject
before dispatch. The model/operator selects the expected outcome; the adapter's
deterministic evaluator, not an LLM narrative, decides verification. If the task
cannot express a unique observable postcondition, do not enable that action.

| Stage/result | Meaning and transition |
| --- | --- |
| Accepted for dispatch | Grant consumed/journal durable; not a native effect or success. |
| May have executed | Send begun; timeout, cancellation, disconnect, or ambiguous acknowledgement preserves uncertainty. No retry. |
| Dispatch acknowledged / unverified | Native `verified:false` after a click is **neither success nor failure**; it requires post-action observation and terminal evidence. |
| Post-action observation | Fresh, schema-valid same-window result only. Observation `success:false`, `verified:false`, `isError`, contradictory status, or invalid identity cannot produce a grant or satisfy a predicate. |
| Verified | Terminal invocation established, expected predicate matches uniquely, and owner/generation/epoch still current; clear matching marker durably. |
| Contradicted / unverified | Predicate mismatch / ambiguous or unavailable observation, respectively; retain quarantine, report honestly, no new action grant. |

Required portable fixtures: dispatched `verified:false` + terminal proof + matching
predicate => verified; mismatch => contradicted; ambiguous/missing/duplicate value
=> unverified; matching value without terminal proof => unverified. In all but the
first case the marker remains. Verification never authorizes a second action:
even sequential success requires **fresh inspection and a new single-use grant**.
Native token checks reduce known staleness, not all AX/OS races or interference.

### Stop and cleanup are different guarantees

Stop/AbortSignal immediately revokes authority, increments epoch, invalidates
grants, rejects queued work, and stops dispatch. Abort SDK requests; never publish
late observations into history or let late initialization restore a client.
Apply this path on `session_shutdown`, session replacement/switch, fork/tree
navigation, reload, disconnect, helper replacement, and failed startup using the
[current event definitions](../../packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts)
and [lifecycle implementation](../../packages/gsd-agent-core/src/session/agent-session-extensions.ts).
Re-enable requires new interactive consent; children/forks inherit no authority.

Proposed client budgets: initialization and discovery 5 s each, permission check
10 s, each inspection/action/verification 15 s. They bound waiting, not rollback.
For SDK **1.32.0**, stdio `close()` can wait **2 s after stdin close plus 2 s after
SIGTERM before SIGKILL**, and returning does not establish exact child exit.
Supervise the owned child with a proposed **6 s total cleanup budget**, including
escalation and exit observation; validate that budget in tests, not by assertion.
Observe the exact spawned process-generation's exit/reaping before reporting child
termination or releasing a usable owner lease. Session release, child termination,
temporary-state removal, and backend invocation quiescence are separate checks.

On deadline expiry report cleanup incomplete; retain the durable quarantine and,
while alive, the physical lease. Process death can release the mutex but cannot
make a quarantined next owner usable. Even confirmed proxy exit cannot clear an
unresolved backend action. Remove and verify removal of owned temporary HOME/state
in `finally`, with sanitized cleanup errors. Never terminate unrelated apps or a
shared helper. A native test may stop only its own generation-verified benign app.
No “2-second cleanup” or “no children remain” promise without measured evidence.

## Proposed G-03 protocol contract (not yet implemented)

This section makes the missing G-03 requirements executable as a backend contract. It is a proposal for future implementation; it is **not evidence** that the currently pinned CMUX 0.65.0 / cmux-cua 0.7.1 runtime provides these guarantees. G-03 proof remains open, runtime admission remains closed, and this document authorizes no native action or capability transmission.

### Authenticate the endpoint before MCP initialization

1. The proxy must authenticate the intended CMUX host/daemon on the exact connection it will use. Establish a fresh, connection-bound challenge that identifies the expected signed host, the live daemon process generation, and the protocol version. The response must be verifiable through a maintainer-supported macOS peer-binding mechanism; a filesystem/socket path, ownership/mode check, PID, code signature, bearer token, or schema hash alone is insufficient.
2. Do not send MCP `initialize` (including client capabilities), request `tools/list`, deliver tool schemas, or transmit the inherited session/bearer capability until the peer proof succeeds. If the SDK automatically initializes during `Client.connect`, the proxy must perform the authenticated preflight before invoking that call or provide an equivalent pre-initialize transport.
3. Bind the proof to a fresh nonce and the exact socket/process generation. Reject missing, stale, replayed, ambiguous, or mismatched identities. Every reconnect requires new proof; no fallback to pathname/PID-only trust is allowed.
4. Keep caller authorization and endpoint authentication distinct: the host may authenticate the calling proxy, but the proxy must independently authenticate the host before disclosing capabilities or bearer credentials.

The authenticated daemon process generation identifies the peer only; it is not the CUA admission or quarantine epoch. After resolving a CMUX session, the adapter must bind a separate session-scoped admission epoch to that session identity. Revoking or fencing that epoch affects only that session; daemon-generation rotation is not a substitute.

### Require operation-specific terminal evidence

1. Assign each action a unique adapter-generated `operation_id` and bind it to the authenticated daemon identity, resolved CMUX session identity, and that session's admission epoch. The model cannot select or reuse any identifier.
2. Distinguish accepted/acknowledged, running, terminal-success, terminal-failure, and unknown outcomes. A terminal receipt must be authenticated on the established host-bound channel and match the operation ID and generation. Both terminal-success and terminal-failure require proof that the operation has no remaining dispatch, queued native events, or deferred work capable of executing. An error without that proof is unknown or nonterminal and preserves quarantine. A successful AX postcondition is separate evidence and cannot substitute.
3. After response loss, query authoritative status by the original operation ID and generation or use a demonstrated host-controlled generation fence. Never replay a possibly dispatched click. A missing, conflicting, stale, or nonterminal receipt leaves the desktop quarantined.
4. A fence must establish an atomic admission boundary for the affected session-scoped admission epoch, distinct from daemon process generation: reject only requests in that session/epoch that were not admitted before the fence, including delayed or reconnect-delivered requests; prove every previously admitted invocation in that session/epoch is terminal; and guarantee no deferred event from it can execute afterward. The fence must not terminate or invalidate unrelated concurrent sessions. Proxy exit, session close, child exit, lock release, reinspection, and acknowledgement are not fences.

### Required conformance evidence before enabling actions

- Negative handshake tests prove that no MCP initialize, tool schema, or bearer capability is sent to a wrong, stale, replaying, or unidentifiable peer; reconnect performs fresh authentication.
- Backend tests cover duplicate IDs, lost responses, late receipts, cancellation ignored, a terminal-failure report while deferred work is still pending (must remain unknown/quarantined), generation mismatch, concurrent sessions, and a fence racing with a pending action. Requests arriving after atomic fence closure—including delayed and reconnect-delivered requests—must be rejected. Unknown outcomes remain quarantined and are never retried automatically.
- Source-bound operational evidence must tie the tested host/backend versions to the installed runtime and show that the same authenticated channel and generation are used for each receipt/fence. Mock tests alone do not close G-03.
- Until the implementation and evidence are independently reviewed and the operator explicitly authorizes any first native verification, keep `G03_RUNTIME_ADMISSION_ENABLED = false` and do not send capabilities or perform native actions.

## Implementation plan (gated; disabled source work in PR #3115 is not runtime acceptance)

The order below keeps desktop ownership load-bearing before the adapter. Tests are
written alongside implementation; this table separates implementation, CI coverage,
and the later G-03 operational gate.

| Stage / status | Scoped source boundary and focused required proof |
| --- | --- |
| 1. Shared ownership guard | Implement `src/resources/extensions/shared/desktop-ownership.ts` and `src/resources/extensions/shared/tests/desktop-ownership.test.ts`. Prove account-wide cross-process ownership, durable quarantine, generation/epoch/invocation checks, fail-closed persistence, crash and late-completion behavior. |
| 2. Host local-interactive admission | Add a trusted `isLocalInteractiveDesktop` context signal only from the local interactive TUI binding; default false and keep RPC/print false. Gate CUA and standalone `mac-tools` before compilation, capability access, or native dispatch. Test local TUI, RPC with UI+TTY, embedded, print, and headless cases. |
| 3. Native-driver and child enforcement | Use `src/resources/extensions/mac-tools/index.ts` and `src/resources/extensions/mac-tools/swift-cli/Sources/main.swift` with tests under `src/resources/extensions/mac-tools/tests/`, plus `src/resources/extensions/subagent/launch.ts`, `src/resources/extensions/subagent/index.ts`, and tests under `src/resources/extensions/subagent/tests/`. Prove direct driver calls are guarded, `quitApp` ownership remains held until app termination is confirmed, uncertain termination is quarantined, failure reasons remain bounded and sanitized, disabled compatibility is unchanged, and children inherit neither consent nor usable capability. |
| 4. Optional adapter | Implement only `src/resources/extensions/cmux-cua/index.ts` and tests under `src/resources/extensions/cmux-cua/tests/`. Keep default loading side-effect-free and runtime admission closed; use the approved inherited managed route only, with no unmanaged fallback, new dependency, loader, or separate registration path. |
| 5. Portable tests and CI discovery (A2/A3 approved 2026-11-05) | After PR #3114 merged, the maintainer approved only the bounded test-runner amendment in [RFC #3103](https://github.com/open-gsd/gsd-pi/issues/3103#issuecomment-6670030867): add `cmux-cua/tests/*.test.js` to `test:unit:compiled`, `mac-tools/tests/*.test.ts` to `test:integration` (preserving `.test.cjs`), and classify `cmux-cua` extension tests as unit-runner tests in `scripts/lib/test-audit-lib.mjs` with the regression assertion in `scripts/__tests__/audit-test-matrix.test.mjs`. The amendment includes no dependency, workflow, loader, orchestration, runtime, or external CMUX repository changes. Claim CI coverage only after these suites pass in CI. |
| 6. G-03 operational prerequisites | Obtain source-bound proof for endpoint trust, exact managed-session identity/routing, operation-terminal evidence, and cleanup/quiescence against pinned backend versions. This RFC authorizes no external CMUX repository edits; if changes are required, obtain separate owner approval and reviewed scope. Adapter mocks cannot close G-03. |
| 7. Integrated acceptance | Only after G-03 passes and a first native run is explicitly authorized: use a fresh Pi/GSD session and owned benign window, verify one unambiguous action, stop and measure cleanup, then prove a second owner performs a fresh inspection and new action. Direct-proxy scripts are not substitutes. |
| Scope boundary | The maintainer-authorized host-signal exception in G-02 is the only approved core path for PR #3115: add the `isLocalInteractiveDesktop` context field and mode binding, and gate CUA/`mac-tools`. Session-lifecycle epochs, grants, backend/proxy, dependency manifests, workflows, and other unlisted paths remain out of scope and require separate reviewed approval. |
| 5. Portable tests and CI discovery (A2/A3 approved 2026-11-05) | After PR #3114 merged, the maintainer approved only the bounded test-runner amendment in [RFC #3103](https://github.com/open-gsd/gsd-pi/issues/3103#issuecomment-6670030867): add `cmux-cua/tests/*.test.js` to `test:unit:compiled`, `mac-tools/tests/*.test.ts` to `test:integration` (preserving `.test.cjs`), and classify `cmux-cua` extension tests as unit-runner tests in `scripts/lib/test-audit-lib.mjs` with the regression assertion in `scripts/__tests__/audit-test-matrix.test.mjs`. The amendment includes no dependency, workflow, loader, orchestration, runtime, or external CMUX repository changes. Claim CI coverage only after these suites pass in CI. |

## Acceptance ledger

Stable IDs below map every source-issue checklist item; additional G-01–G-03 gates
are above. Owners: **A** adapter, **M** native-tools, **S** subagent, **C** conformance,
**O** operator/docs, **R** maintainer/reviewer. Dependencies are delivery gates,
not permission to defer baseline safety. **P/D/G** mean portable / direct-native
proxy / **fresh integrated Pi/GSD**. **NR = NOT-RUN**, **B = BLOCKED**; no native pass
is inferred from portable proof, discovery, permissions, or E1 cleanup.

For **each check/execution**, persist `check_id`, `criterion`, `owner`,
`dependencies`, `proof_class` (P/D/G/artifact), `outcome` (PASS/FAIL/BLOCKED/NOT-RUN/
CANCELLED), tested source SHA **and dirty/untracked scope**, OS/GSD/cmux/SDK versions,
command/tool, UTC start/end, exit code or blocker, and `evidence_refs[]` (durable
redacted report/log/run URL plus digest). No ref means no proof; do not invent URLs
for local artifacts. Publish separate P/D/G results. All implementation rows below
remain unaccepted; E1 is only the bounded blocked direct-proxy observation above.

| Check / source criterion | Owner; prerequisite | Required proof | P / D / G now; refs |
| --- | --- | --- | --- |
| 17-01: reviewed working delivery | A/R; G-01/G-02 | Delivered code/config + reviewed contribution, not this proposal | NR / NR / NR; none |
| 17-02: supported version-bound launch | A/C; G-01 | Pinned primary-source handshake, schema hash/result decoders, real discovery | NR / NR / NR; none |
| 17-03: fresh discovery/action/verify/stop | A/O; 17-01, G-03 | Explicit opt-in; harmless uniquely verified action and queued-stop rejection in fresh Pi/GSD | NR / B / NR; E1 |
| 17-04: scoped tests/typechecks | A/C; 17-01 | No-spawn, missing helper, denied permission, cancellation regressions; commands/SHA/exits | NR / NR / NR; none |
| 17-05: existing tools/platforms unaffected | A/M/C; G-02 | Disabled native/browser/MCP, unsupported platform/default startup compatibility | NR / NR / NR; none |
| 17-06: delivered handoff/evidence | A/O/R; 17-01–05 | Linked implementation + exact verification + gaps, not agent narrative | NR / NR / NR; none |
| 18-S01: supported single desktop owner | A/M/S/C; G-02 | Parent adapter vs ordinary GSD/subagent/mac-tools separate processes; pre-native rejection; external limit | NR / NR / NR; none |
| 18-S02: stop/crash/disconnect/release | A/M/C; G-03 | No new dispatch; crash-after-admission quarantine; exact child exit vs session release; no rollback claim | NR / NR / NR; none |
| 18-S03: inspection/freshness | A/C; G-03 | Token-only stale rejection, app generation/layout change, new inspection/grant | NR / NR / NR; none |
| 18-S04: no blind retries | A/C; G-03 | Ambiguous mutation/timeout/late completion cannot replay or clear quarantine | NR / NR / NR; none |
| 18-S05: privacy/authorization | A/C/O; G-01 | No auto-grants/unrelated app/secret/capture persistence; per-request image consent; no approval bypass | NR / NR / NR; none |
| 18-01: fresh setup/discovery | A/O; 17-02 | Proven inherited handoff in fresh Pi/GSD, no claimed automatic Pi attach | NR / NR / NR; none |
| 18-02: offline failure regression matrix | A/C; G-02/G-03 | Default-off, non-Mac, helper absent, permission denied, malformed schema/results, disconnect/timeout/cancel/competing owner | NR / NR / NR; none |
| 18-03: disabled compatibility | M/C; G-02 | Existing native tools and browser behavior unchanged when cmux disabled/unavailable | NR / NR / NR; none |
| 18-04: package verification | A/C; 17-01 | Relevant scoped tests/typechecks with exact revision, command and exit | NR / NR / NR; none |
| 18-05: benign native smoke | O/C; 18-01, G-03 | Discovery/action/verify/stop in Pi/GSD; non-Mac explicitly unverified | NR / B / NR; E1 |
| 19-P01: default-off/no-spawn | C; 17-01 | Zero helper/capability/discovery/desktop counters including status/install | NR / NR / NR; none |
| 19-P02: discovery contracts | C; 17-02 | Supported/missing/malformed/version/schema drift and helper absence | NR / NR / NR; none |
| 19-P03: sequencing/stale/images | C; G-03 | Matching/mismatch/ambiguous predicates, new grant for second action, real image blocks, oversized/malformed images, MCP/structured errors | NR / NR / NR; none |
| 19-P04: cancellation/failures | C; G-03 | Cancel, helper death, disconnect, ambiguous timeout; no replay/late history | NR / NR / NR; none |
| 19-P05: concurrency/handoff | C/M/S; G-02/G-03 | Separate GSD/subagent/mac-tools owners; crash quarantine; clean release/reacquire with new authority | NR / NR / NR; none |
| 19-P06: compatibility | C/M; G-02 | Disabled/unavailable native/browser/unrelated MCP regression fixtures | NR / NR / NR; none |
| 19-P07: bounded redacted evidence | C/O; 17-01 | Fixed keys, no arbitrary metadata/AX/pixels/credentials; synthetic public fixtures | NR / NR / NR; none |
| 19-N01: supported versions/setup guide | O; 17-02, 18-01 | Exact proven setup and versions; no guessed flags/binary route/automatic attachment | NR / NR / NR; none |
| 19-N02: permission onboarding guide | O; 18-S05 | Accessibility/Screen Recording operator-controlled; actual missing/denied cases, no auto-grant | NR / NR / NR; none |
| 19-N03: benign smoke and safe second action | O/C; 17-03, 18-S02 | Fresh-session cycle, stop, clean handoff, second owner fresh inspection + **new action/verify**, not replay | NR / B / NR; E1 |
| 19-N04: failure/cleanup guide | O/C; 18-02 | Missing/denied permission, helper unavailable, stale target, competing controller, disable/cleanup/quarantined recovery | NR / NR / NR; none |
| 19-N05: truthful result publication | O/R; all checks | Separate portable/direct/Pi-GSD and blocked/cancelled/not-run results; no Mac means no native pass | NR / NR / NR; none |
| 19-N06: non-goals documented | O/R; G-01 | Browser DOM stays separate; native actions are no approval, lifecycle authority, or release/deployment proof | NR / NR / NR; none |

For native acceptance use a fresh, explicitly opted-in Pi/GSD session and owned
benign app/window with a unique public AX value. Inspect without screenshots,
perform one targeted action with expected postcondition, verify, stop before a
queued second dispatch, and check cleanup. A second owner must inspect afresh and
perform a **new** action/verification. If Calculator's display is ambiguous, stop
and record BLOCKED; do not reinterpret E1 as success or change targets blindly.

## Verification commands

Docs-only checks (no Markdownlint binary was available in the local checkout; do
not claim it ran):

```bash
git diff --no-index --check /dev/null docs/dev/cmux-computer-use-contract.md
bash scripts/docs-prompt-injection-scan.sh --file docs/dev/cmux-computer-use-contract.md
gitleaks dir --redact=100 docs/dev/cmux-computer-use-contract.md
bash scripts/base64-scan.sh --file docs/dev/cmux-computer-use-contract.md
```

`secret-scan.sh --file` is **not applicable** to Markdown: `should_scan` excludes
`*.md` even in file mode, so a zero exit status is not a secret-scan pass. The
Markdown-capable Gitleaks 8.30.1 scan above reported no leaks with full redaction.
Record the actual diff-check exit/output: a no-index new-file difference is not a
staged review or an implementation test. No package/type/native pass is implied.
After approved implementation/tests exist, run the smallest scoped tests first,
`pnpm run test:compile`, relevant compiled `node --test` suites,
`pnpm run typecheck:extensions`, and `pnpm run verify:fast`. Before review run
`pnpm run verify:merge:needed -- --base upstream/main` on committed changes and
satisfy applicable merge gates per contribution policy. Portable or remote CI
cannot replace fresh Pi/GSD native proof; retain all unavailable/blocked outcomes.

## Upstream comparison snapshot (2026-11-07)

This snapshot compares the reviewed local adapter with an immutable upstream cmux reference. It is documentation only. It does not change the adapter, enable any runtime admission, or authorize native desktop actions.

### Baselines recorded separately

| Baseline | Reference | Use |
| --- | --- | --- |
| Reviewed local runtime | cmux `dda24fbd2`, engine `e0f738807dbff2f35fe67d7fbcc99c7082cffc23` | Contract pinned in the sections above. |
| Upstream comparison | `manaflow-ai/cmux` commit `be5e24339c6eabb8e929a7029c4e6f834e257c97` | Reference for compatibility review only. |

### Compatibility table

| Area | Upstream reference | Local adapter | Status |
| --- | --- | --- | --- |
| Executable identity | Helper selected through `client-policy.sh` with canonicalization and ownership checks. | Requires the client executable inside `cmux.app/Contents/Resources/bin/`. | Compatibility gap with the current upstream helper layout. Not a demonstrated bypass. |
| TCC attribution | Accessibility and Screen Recording are assigned to cmux Computer Use. | Requires `attribution: "host"` and `embedded: true`. | Conflicts with the helper-owned permission contract. Must be resolved before any enablement. |
| Native and Codex profiles | Upstream exposes a broader profile for Codex compatibility. | Declares a narrower native subset with click and AX access only. | Intentional difference. Do not copy the upstream profile. |
| Session ownership | Upstream tells agents not to call `start_session` or `end_session`. | Lifecycle is internal and not exposed to the model. | Intentional difference. The internal handshake needs revalidation against current proxy semantics. |
| Hard kill policy | `CMUX_COMPUTER_USE_MCP_DISABLED=1` or managed policy disables the integration. | No explicit handling of this flag in the adapter or shared desktop-ownership guard. | Policy-integration gap. Daemon-side enforcement is not verified. |
| Skill discovery | Skill sets `disable-model-invocation: true` and `allow_implicit_invocation: false`. | No skill-link reconciler in the runtime adapter. | Intentional difference. Any future invocation contract needs its own review. |

### Required proof before any enablement

- Connection-bound authentication of the endpoint before MCP initialization, as required by the G-03 protocol above.
- Exact validation of the tool contract: schemas, annotations and the complete roster, not only names and counts.
- Immediate session-scoped revocation that invalidates an epoch before queued work is aborted.
- Operation-specific terminal and quiescence evidence before any further action is accepted.
- Negative tests for the hard kill policy, including a daemon-side check.

### Limits

- The findings are source-level. No fresh tests, real MCP handshake, installed-layer activation or native acceptance were verified for this snapshot.
- G-03 remains closed. Neither upstream skill instructions nor a version label authorizes activation.
- The historical smoke stopped with `missing-inherited-native-socket` and zero actions (`actionAttempts: 0`, `nativeContractProven: false`). Source: sanitized artifact `cmux-cua-native-contract-c9bc8789-1349-4865-91d4-c6dec8253905.json` in the CUA implementation checkout. It is a prerequisite failure, not acceptance evidence.

## Evidence plan for conditional gates (2026-11-07)

The operator decision (D309) makes G-03 runtime admission and `type_text` registration conditional. Neither gate opens on the decision alone. Each needs the source-bound evidence below. Until a reviewed run produces that evidence, the adapter stays fail-closed with `G03_RUNTIME_ADMISSION_ENABLED=false` and no `type_text` tool.

Proof classes: **P** is offline and portable. **D** is a direct run on a real cmux host. **G** is a fresh integrated Pi/GSD run. Offline proof never opens the runtime gate by itself.

### Gate A: G-03 runtime admission

| Requirement | Evidence artifact | Pass criterion and required prior failure |
| --- | --- | --- |
| Authenticate the endpoint before initialization | Conformance report, redacted NDJSON transport trace, peer-verification result | A fresh nonce binds the expected signed host, daemon process generation and protocol version to the same connection. No MCP `initialize`, capabilities, schemas, `tools/list` or session capability is sent before verification. Wrong peer, missing proof, replayed proof and reconnect with old proof must fail before the fix. Path, PID, signature or token checks alone are insufficient. |
| Operation-specific terminal and quiescence evidence | Versioned protocol fixtures, TAP reports before and after the fix, receipt and fence traces | An adapter-generated `operation_id` binds daemon identity, resolved session and admission epoch. Terminal success and terminal failure both prove that no dispatch, queued event or deferred work remains. Acknowledgement, AX postcondition, timeout and process exit do not count. Red tests: lost reply, late conflicting receipt, wrong generation or operation, ignored cancellation, and terminal failure while deferred work is pending. Uncertainty keeps the operation quarantined. |
| Immediate session-scoped revocation | Scheduler or model-check report and trace of linearization points | Revocation invalidates the session epoch before queued work is aborted, without waiting behind the serial queue. Old requests, including delayed ones and ones after reconnect, are rejected. Work admitted before revocation needs terminal or quiescence proof before release. Other sessions remain valid. Red tests, each with its violating behavior and green assertion: |
| Hard kill policy | Separate adapter and daemon TAP reports with a configuration matrix and dispatch counters | With `CMUX_COMPUTER_USE_MCP_DISABLED=1`, the adapter performs no registration, spawn, capability transmission or native dispatch. The daemon must also refuse a client that bypasses the adapter check. Each layer needs its own red test. One shared block does not prove both layers. |

Revocation red tests:

- **Epoch before abort:** block action A, queue B, revoke. Red if the epoch stays valid while A is blocked or if revocation waits behind the serial queue. Green if the epoch is invalid before B is aborted, while A is still blocked.
- **Delayed and reconnect delivery:** deliver a request with the revoked epoch late and after reconnect. Red if it is admitted. Green if it is rejected.
- **Unrelated session:** revoke session 1 while session 2 is active. Red if session 2 is blocked. Green if session 2 still dispatches.
- **Ownership release:** revoke while previously admitted work has no terminal or quiescence proof. Red if ownership is released. Green if it stays quarantined until proof exists.

Offline-provable (P): transport ordering against instrumented peers, exact decoders, epoch and queue races, and adapter hard kill. Daemon logic counts only when the pinned daemon source is available and testable. Regression tests must exercise the future internal execution paths. A flag set to `false` is not evidence of implementation.

Requires a real host (D), after separate approval: supported macOS peer binding on the actual connection, daemon hard kill, real event and deferred-work quiescence, and D then G tests with exactly bound binaries. A process exit or an empty mock queue proves none of these.

Stop conditions: if supported pre-initialize peer binding, operational status or fencing, or evidence about OS-deferred events is unavailable, the gate stays closed. Mocks do not replace those guarantees.

### Gate B: `type_text` registration

Artifact: a JSON no-replay conformance report, red and green TAP results, and redacted NDJSON traces of native dispatch, fallback, receipts and recovery. Record P, D and G results separately.

Pass criterion: one typing action produces at most one semantic insertion, including internal AX-to-CGEvent fallback. After an ambiguous reply to a possibly completed insertion, only a status query or fence is allowed, never a redispatch. A new model call, grant, reconnect, or adapter or daemon restart must not bypass that uncertainty. Deduplication must hold, or old epochs must be provably and permanently rejected.

Red tests required before the fix: AX insertion succeeds but read-back fails or times out (no CGEvent retry with `clear_first:false`); lost reply before and after insertion; delayed insertion after adapter timeout; duplicate operation ID; the same ID with a different payload; a new ID during quarantine; restart or reconnect; late receipts; cancellation that the backend ignores.

Offline (P): dispatch and fallback policy, durable recording of uncertainty, and recovery rules. Host (D): real AX and CGEvent insertion and delayed events, using a synthetic non-secret text field. Registration follows only after review, exact-SHA CI, and separately approved host runs. If fallback cannot prove definite non-delivery, stop.

### Manifest rules

Every evidence manifest records: ledger ID, criterion, owner and dependencies, proof class, outcome, source SHA with dirty and untracked scope, binary digests, OS, GSD, cmux and SDK versions, tool, UTC start and end times, exit or blocker, and durable redacted evidence references with digests. Without a reference there is no evidence.

## Host-run preparation (not executed)

This section prepares the real-host checks that the evidence plan requires. It is a plan only. Nothing here has been run, and it does not open G-03 or `type_text`. Each run needs explicit, per-run approval from the maintainer before anything touches a desktop.

### Preconditions

- Offline suites are green on the exact source revision: `cmux-cua-admission` (9 tests) and `cmux-cua-revocation` (10 tests) at `0b212e054` or later.
- `G03_RUNTIME_ADMISSION_ENABLED` is `false` and no `type_text` tool is registered on the revision under test.
- A disposable macOS session is available, with a synthetic, non-secret text target. No real customer data is open.
- The maintainer has approved one named run in writing. Each run uses a single checklist item.

### Checks to run, one at a time

Each check's evidence manifest must include every field in [Manifest rules](#manifest-rules): ledger ID, criterion, owner and dependencies, proof class, outcome, source SHA with dirty and untracked scope, binary digests, OS, GSD, cmux and SDK versions, tool, UTC times, and durable evidence references.

| Check | Gate | What is observed | What is recorded |
| --- | --- | --- | --- |
| D1: peer binding on the live connection | A | Whether the supported host proves its identity on the same connection before MCP initialize. | Redacted transport trace, verification result, and daemon generation. |
| D2: hard kill, daemon side | A | Whether the daemon refuses a client that bypasses the adapter check when `CMUX_COMPUTER_USE_MCP_DISABLED=1`. | Separate daemon TAP report and dispatch counter. |
| D3: revocation of a live operation | A | Whether an operation admitted before revoke reaches terminal proof before ownership is released. | Trace of linearization points and terminal evidence. |
| D4: typed insertion, no replay | B | Whether one typing action yields at most one insertion, including the AX-to-CGEvent fallback. | Redacted trace of dispatch, fallback, and receipts. |

### Stop conditions

Stop and report, without retrying, when any of these happens:

- A native action runs without an approved run.
- The live connection carries capabilities before peer proof.
- A check targets a real application or real data.
- The same check fails twice with the same reason.
- Any failure is ambiguous. Treat that as unproven, not as a pass.

### Evidence rules

Each result is a manifest entry with: ledger ID, criterion, proof class, outcome, source SHA and dirty scope, binary digests, OS and cmux versions, UTC times, exit or blocker, and digested, redacted references. Without a reference there is no evidence. A process exit or an empty mock queue does not prove a host check.
