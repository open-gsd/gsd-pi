# Optional cmux Computer Use contract

> [!IMPORTANT]
> Revised proposal, 2026-11-04; not an approved owner choice or shipped integration.
> This docs-only change does not complete
> [#3017](https://github.com/open-gsd/gsd-pi/issues/3017),
> [#3018](https://github.com/open-gsd/gsd-pi/issues/3018), or
> [#3019](https://github.com/open-gsd/gsd-pi/issues/3019).
> No native action/verification or fresh Pi/GSD acceptance has passed.

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

| Gate | Decision required before implementation |
| --- | --- |
| G-01: supported owner/route | Maintainer explicitly adopts the optional adapter **and shared GSD desktop guard**, conditional on the inherited ordinary-agent handoff below. Docs review/merge is the proposed decision point, not proof this choice was already granted on #3017. Record the decision permalink on that issue. |
| G-02: expanded source scope | Approval must name `mac-tools` and subagent enforcement, not merely a new extension directory. If this requires core/loader/orchestration changes or a built-in/core-tier change, obtain the approved RFC required by [CONTRIBUTING.md](../../CONTRIBUTING.md#architecture-guidelines) **before implementation**. Do not silently narrow the coordination boundary instead. |
| G-03: operational safety | Prove native result schemas and non-replaying dispatch for each enabled operation; the exact managed/unmanaged session lifecycle handshake (`start_session`/`end_session` arguments, results, and identity checks); trusted socket endpoint binding before capability transmission; terminal-invocation evidence; and cross-process enforcement against the pinned backend before enabling actions. The pinned background `type_text` path may fall back to CGEvent after an AX write is not positively verified, with `clear_first:false`; keep typing disabled until backend semantics and regression tests prove no replay or definite non-delivery. Unverifiable recovery remains blocked; no invented cancellation/fencing API. |

Required G-01/G-02 decision record: approving maintainer GitHub identity, UTC date,
review/decision URL, reviewed source SHA, selected route, inherited-handoff limit,
explicit approved source paths, and RFC URL/disposition. Proposed decision text is
“Adopt the optional cmux-cua adapter plus shared desktop guard under this contract;
no core exception is granted.” This is a **requested signature**, not an approval.
Delegated maintainer review/merge authority does not itself supply that signature.

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
[#3017 owner gate](https://github.com/open-gsd/gsd-pi/issues/3017#issuecomment-6398319213)
and [docs-first sequence](https://github.com/open-gsd/gsd-pi/issues/3017#issuecomment-6629146646)
are context, not evidence that the recommendation above has been adopted.

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

The pinned proxy has two source-confirmed session modes. Without
`CMUX_CUA_DEFAULT_SESSION`, it uses an unmanaged `mcp-<pid>-<nanos>` identity and
does not rewrite forwarded `session`/`_session_id` arguments. With that variable,
it appends the proxy suffix to the configured base and rewrites those arguments.
The native `start_session` handler returns a resolved identity, not necessarily
the proxy identity. Do not accept model-supplied session/host-owner values, copy a
host-owned default, or claim implicit identity binding.

G-03 remains open: before enabling any native action, implementation must choose
one mode and add fixtures for exact internal `start_session`/`end_session`
request keys and values, returned-identity checks, and subsequent request/session
ownership. These lifecycle calls are internal and never model-exposed; their
allowlist and response decoders are not yet specified here. No mode fallback is
allowed; fail closed if the selected mode or identity cannot be established.
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
durably record owner/connection generation, invocation ID, and unresolved state
(no desktop content); fsync the file and containing directory for atomic
replacement before dispatch. Invalid/unreadable/unwritable state denies mutations.
The OS mutex is **not** this journal. Every driver checks it while holding the
lease; unresolved state quarantines current **and subsequent** owners.

An accepted/dispatched request can outlive proxy death and lock/session closure.
Pinned proxy EOF cleanup and server ended-session checks do **not** demonstrate
cancellation/draining of an already admitted invocation. Operator acknowledgement
plus reinspection is **insufficient** to clear quarantine. Resume only with:

1. Operation-specific evidence that the previous invocation is terminal, not
   merely a transport/dispatch acknowledgement; or
2. A supported backend-generation fence/controlled **host-owned** helper
   replacement proven to prevent all future execution of that invocation.

Neither mechanism is established for unresolved calls by this evidence. If it
cannot be verified, remain blocked, report recovery unavailable, and require
manual external resolution through supported host controls plus terminal/fence
evidence. The adapter must not kill/restart a shared helper or offer a “clear by
acknowledgement” escape. Never claim lock/session close cancels posted OS events.
Clear a marker only under the lease with matching owner, generation, epoch, and
invocation ID; a late completion cannot clear a newer marker. Persist recovery
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

## Implementation plan (gated; no code delivered here)

| Scope / owner | Source boundary and focused required proof |
| --- | --- |
| Adapter implementer; G-01/G-02 | New `src/resources/extensions/cmux-cua/` with manifest, lifecycle/state/result guards and tests; proposed `src/resources/extensions/desktop-safety.ts` shared by **both** drivers. No new daemon or provider framework. |
| Native-tool owner; G-02 | `src/resources/extensions/mac-tools/index.ts` and `tests/`: guard real desktop execution, not just model hooks. Separate-process adapter owner vs ordinary `mac_click`/`mac_type`/capture tests; zero native calls on busy/quarantine; disabled compatibility. |
| Subagent owner; G-02 | `src/resources/extensions/subagent/launch.ts`, `src/resources/extensions/subagent/index.ts`, and `src/resources/extensions/subagent/tests/`: fresh/fork children with adapter absent, tool-selection overrides, guard-disabled/missing and incompatible versions; no inherited consent/lease and no bypass. |
| Pi boundary owner; conditional RFC | Inspect `packages/pi-coding-agent/src/core/extensions/runner.ts` and lifecycle sources linked above; existing hooks supplement driver guards. Prove reload/tree/fork/shutdown invalidation. If mandatory enforcement cannot be achieved without core/loader changes, stop for approved RFC, not implementation by assumption. |
| Conformance owner; G-03 | Adapter `tests/` with real temporary SDK MCP server plus separate OS processes: file FIFO/symlink/growing/4097-byte/special-mode cases, strict permissions/results, schemas/hashes, predicate fixtures, stale tokens, races, crash-after-admission/late completion, no marker clear without quiescence, cleanup escalation/exact exit, images/errors/privacy. Wire tests into normal tiers. |
| Docs/native operator; after implementation | Operator guide and result ledger; fresh explicitly opted-in Pi/GSD benign-window run, then second-owner new inspection/action/verification. Direct proxy scripts are not substitutes. No install, permission grant, native action, deployment, or release approval is authorized here. |

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
