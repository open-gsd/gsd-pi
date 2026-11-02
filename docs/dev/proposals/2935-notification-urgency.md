# Notification urgency and identity-scoped deduplication

## Status and scope

Design proposal for [#2935](https://github.com/open-gsd/gsd-pi/issues/2935), D05 under [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). **Not an accepted design or implementation authorization.** Audience: notification producers, native TUI and host-adapter maintainers, and reviewers planning acceptance fixtures.

Initial source inspection baseline: `f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19`; follow-up review on 2026-11-02 rechecked the relevant current-source claims against live main at `52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`. Issue bodies and comments were consulted on the same date, including the [D05 design comment](https://github.com/open-gsd/gsd-pi/issues/2935#issuecomment-6304855362). The issue's `b09bdf3fc` source references and proposed fields are historical input, not proof about current main.

At inspection, #2935, #2913, #2933, #2932 and #2936 were open and the four D01/D02/D03/D05 design issues had no assignees. The D05 comment supplies design input, not a recorded approval. PR [#2917](https://github.com/open-gsd/gsd-pi/pull/2917) is merged at `5b71b60a46dc6f75b36e2bc31c7c96930baf1531`; prerequisite [#2922](https://github.com/open-gsd/gsd-pi/pull/2922) is merged at `dbe483fde7161ec16c69f32d3a37a4565666d92a`. #2915 is closed, while #2914 and #2916 remain open. Those states do not establish final-head CI or real-host acceptance. Native issue hierarchy remains a maintainer concern.

This document changes no producer, schema, transport, configuration or installed runtime. It proposes reuse of the notification store and existing lifecycle owners, not another event bus, notification daemon, orchestrator, approval UI or cross-process synchronization service. It neither expands #2917 nor supplies #2916 acceptance.

## Observed implementation

Paths below are repository-relative; current-source claims refer to the follow-up review baseline unless explicitly labeled historical.

| Surface or producer | Existing behavior and identity limit |
| --- | --- |
| `src/resources/extensions/gsd/notification-store.ts` | `NotificationMeta` carries optional `kind` and `scope`. `appendNotification` keys a 30-second process-local cache by base path, severity, source and either kind/scope or truncated message prose. The entry's random UUID identifies a stored row, not a lifecycle transition. No session/run/transition identity is carried. |
| Store retention | Messages are truncated after 500 characters. History is appended to `.gsd/notifications.jsonl`, with rotation targeting the newest 500 entries. Cache pruning above 200 removes expired keys; 200 is a pruning threshold, **not a hard cap** on fresh keys. The cache is updated before the append, whose errors are swallowed. Initialization counts disk history; it does not reconstruct delivery identity. |
| `bootstrap/notify-interceptor.ts`; `bootstrap/register-hooks.ts` | The interceptor persists `ctx.ui.notify` before calling the original UI method, without metadata. A WeakSet prevents wrapping the same UI object twice. Session initialization resolves the notification base path through the worktree project root. A shared path is therefore not a session identity. |
| `notification-overlay.ts`; `notification-widget.ts` | Existing keyboard history, severity filtering and unread footer chip are reusable. Opening the overlay calls `markAllRead`; refreshing changed history also calls it. Clearing history is supported. Thus `read` is presentation state, not evidence that a request was answered. |
| `workflow-logger.ts` | Warning/error persistence calls `appendNotification` without identity metadata. A log entry is not itself proof of terminal execution failure or required user action. |
| `auto/phases.ts`; `auto.ts` | Stop directives, budget thresholds and context-pause paths already notify. The stop path plays the local bell. These are distinct owner-controlled transitions, not synonyms for failed execution, session end or assistant idle. |
| `undo.ts` | Successful undo sends an in-app notification and desktop completion notification. It is an undo-operation outcome, not completion of the original execution. |
| `provider-switch-observer.ts`; `memory-consolidation-scanner.ts` | Direct store producers supply kinds `provider-switch` and `memory-consolidation`. Neither kind identifies a unique occurrence or proves an actionable failure. |
| `tools/workflow-tool-executors.ts` | Lease reclaim supplies `milestone-lease-reclaim` plus milestone scope; UAT human checks supply `uat-needs-human` plus milestone/slice scope. Two reclaim operations or UAT attempts in one scope must remain distinguishable. |
| `notifications.ts` | `sendDesktopNotification` returns void. Remote dispatch runs independently of desktop preferences. Desktop policy uses existing kind/preferences; cmux is attempted first, successful CLI invocation skips native desktop, otherwise OSC fallback may be written and native desktop is still attempted. There is no shared transition identity or dedup across these calls. |
| `src/resources/extensions/cmux/index.ts` | `CmuxClient.notify` returns false when disabled and otherwise reports whether its command runner returned non-null. OSC 777 writes an escape sequence. Neither result proves human receipt. |
| `src/resources/extensions/remote-questions/notify.ts` and `manager.ts` | One-way notification dispatch and interactive remote questions are separate paths. Questions already have a prompt ID, persisted prompt status, dispatch reference and answer/timeout/cancellation handling. Notification delivery must never settle that prompt. |
| Native tools and background jobs | `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts` tracks active tools by `toolCallId`. `src/resources/extensions/subagent/run-store.ts` records `runId`, child records and run status. These are candidate subject identities, not proof of a shared session/attempt/transition envelope. |
| VS Code activity | `vscode-extension/src/activity-feed.ts` now delegates to `activity-model.ts` following the #2930 lifecycle work. The model distinguishes disconnect/rebind interruption from error and notes that `agent_start` has no wire identifier. A feed row number or inferred agent-start count is not a replay-stable run ID. `gsd-client.ts` has process/context-generation guards to preserve, not replace. |

Unqualified paths in this table are under `src/resources/extensions/gsd/`, except `activity-model.ts` and `gsd-client.ts`, which are under `vscode-extension/src/`. `packages/pi-coding-agent/src/core/session-manager.ts` exposes `getSessionId()`. The producer integration still needs to prove how the owning session reaches each emission site. None of the candidate identifiers above may be silently substituted for that proof.

## Recommendation and alternatives

Choose **A: source-stamped identity, bounded process-local presentation memory, per-adapter delivery decisions**. Keep the existing store as notification history and the D03 owners as action truth. Share the same logical identity across local fan-out; do not infer cross-host binding.

| Option | Benefit | Cost and gate |
| --- | --- | --- |
| A — recommended | Prevents proven local replay spam without coupling independent processes. Incremental adapter/projection change. | Producer identity and attempt/transition ownership must be proven first. Independent hosts may still both notify. |
| B — coordinated cross-surface suppression | Could reduce duplicates between separately attached hosts. | Requires an existing shared authority, ownership and restart contract named by maintainers. Deferred; no new synchronization engine is authorized here. |
| C — no suppression where identity is incomplete | More noise, but no lost distinct request. | Mandatory fallback for unknown identity; owner must identify the missing producer prerequisite. No prose/time-window substitute. |

A is conditional, not a claim that today's fields suffice. Legacy records remain readable. The proposed policy never deduplicates by message text, including for meta-less callers: incomplete identity uses C. Replacing the existing prose fallback requires explicit migration review and updated regression expectations; it is not an approved fallback for the new policy.

## Identity contract

The following are **design concepts, not existing event fields or a proposed universal wire schema**. Agree the smallest additive carrier with producer and D01 owners before implementation.

| Component | Required meaning |
| --- | --- |
| Origin binding | D01-verified project/worktree context and originating session ID, namespaced by its authority. Paths, names, terminal titles, process IDs and display labels are not durable identity. |
| Subject | Typed run/job or tool invocation ID; for attention, the specific request/blocker/prompt ID as well as its run/invocation relationship. Two requests within one invocation are distinct subjects. |
| Execution occurrence | Authoritative attempt/occurrence ID when a logical unit can execute again. Reusing milestone/slice/task scope is insufficient. |
| Semantic transition | Owner namespace, transition kind and stable occurrence/revision distinguishing a repeated transition within one attempt, such as wait → resume → wait. Cosmetic message changes and snapshot polling revisions do not create transitions. |

Logical identity is the unambiguous tuple of those components. Use a canonical tuple encoding, not delimiter concatenation susceptible to collisions. The adapter's delivery key adds its logical destination/surface. Notification history row UUIDs, severity, wording, timestamps and connection generations are **not** logical identity components.

Rules:

1. Stamp once at the authoritative transition, then preserve the identity through UI/history/logger/transport fan-out and replay. Do not generate a fresh transition UUID in every adapter or callback. Source labels may be retained as provenance but must not prevent coalescing proven fan-out of one event.
2. A retry of **delivery** preserves the logical event identity. A new execution attempt, new approval/input request or genuine repeated transition gets a new owner-issued occurrence. A changing clock or reconnect is neither of those.
3. Keep the original session on replay. The viewing session or new connection generation must not relabel an old event as current. A session switch fences destinations/actions under D01; it does not transfer ownership.
4. A durable subagent run ID needs an explicit association with its originating session. A tool call ID needs its session/authority namespace. Neither is assumed globally unique or sufficient for all producers.
5. Missing, malformed or conflicting identity means **no dedup suppression** and no actionable binding guessed from prose. Show source context as unknown; retain the notification and direct the user to the existing owner for inspection. Repair identity upstream before claiming replay idempotency.
6. Scope/kind remain useful filtering metadata. They are not request IDs, attempt IDs or transition IDs. Snapshot revision/authority epoch can fence actions without being blindly appended to every delivery key.

The producer ledger required before code must record, for each adopted producer: actual event/envelope, identity authority and lifetime, attempt boundary, transition occurrence rule, terminal rule, current destination, restart/replay behavior, and adapter result semantics. Auto pauses/budgets/stops, undo, lease reclaim, UAT human checks and background completion each need separate rows. For example, a lease's existing event ID may be a candidate, but it must be propagated rather than reconstructed from milestone text.

## Urgency and separate lifecycles

Urgency is routing intent, **not severity, execution state or permission**. Classify from the producer's structured transition, never keywords or an error-colored message. Preserve existing severity for history filtering; do not add urgency to the logical identity merely to emit the same transition again.

| Owner-proven condition | Proposed presentation and routing |
| --- | --- |
| Pending approval, ordinary input, forwarded question, human UAT check | Action-needed, with distinct wording and D03 destination. Announce a new identity once while retained. Forwarding updates the existing request's delivery status; it is not another approval or an answer. |
| Failed prerequisite with a real requested action | Action-needed only when D03 can expose that specific action/owner. Otherwise show a failure/warning with details, not a fabricated Retry button. |
| Terminal execution failure | Prominent outcome/history entry and policy-controlled external alert. Keep discoverable even if no user action exists. A tool error followed by an owner-managed retry is not automatically terminal. |
| Completion or successful undo | FYI history, with external completion alert according to preferences and agreed focus policy. Retain the report/detail destination after dismissal. |
| Execution success with recording, review or test conclusion | Preserve execution success; show the evidence/conclusion independently with its own semantic transition and details. A recording warning must not overwrite outcome or imply tests passed. |
| Retry scheduled, retry progress, ordinary progress | Update status in place; no repeated external toast or focus change. A later authoritative terminal outcome belongs to that execution attempt. |
| Pause/budget threshold | Preserve pause reason and actual continuation semantics. Action-needed only if owner supplies a current next action; threshold observations alone do not prove failure or a new session. |
| Disconnect, stale binding, absent outcome | Explicit unknown/disconnected status. Preserve unresolved attention; never invent completion, failure, cancellation or approval. |

Keep five independent facts:

- **Execution lifecycle:** running, retrying, paused, terminal success/failure, or unknown, as supplied by its owner.
- **Request lifecycle:** pending/resolved/cancelled/expired only as supplied by the request authority. Reading, clearing, dismissing, clicking or delivering a notification never mutates it.
- **Recording/review/test lifecycle:** recorded or not, and each actual conclusion, separate from execution outcome.
- **Presentation lifecycle:** unread/read, visible/dismissed, retained/evicted; store history can rotate independently of a still-pending request.
- **Transport lifecycle:** disabled, attempted, failed, or result unknown. An accepted command/spawn is not a human receipt and not a lifecycle terminal event.

Assistant `agent_end`/idle is not global workflow/job completion. Two running background jobs remain two running subjects. D02 consumes those facets and D03 attention; D05 does not collapse them into one state.

## Bounded retention, races and replay

Proposed defaults for owner review: **256 logical transition records total per owning process, 30-minute dedup age from first observation**, with fixed-size per-surface attempt flags. This is a hard total cap, not 256 for each unbounded session/destination. Use monotonic elapsed time for eviction; replays do not extend age. Also prune on access/session teardown. Do not add a disk-backed dedup journal in this slice.

- Evict expired records first, then oldest FYI/status records, then oldest remaining presentation records if necessary. Active dispatch reservations are not eviction candidates: pending callbacks and their fixed-size surface flags count toward the cap. An expired in-flight reservation holds only its bounded slot until the operation settles; it cannot extend semantic freshness or repopulate history. If all slots are active, persist history and expose D03 attention but omit optional external attempts with a bounded capacity diagnostic; do not queue them or label them delivered. Reconciliation/reminder policy remains an owner decision. No unbounded queue or one timer per event. Under sustained overload, FYIs may repeat; the cap must still hold.
- Cache eviction, expiry, process restart, history rotation and user clearing **never resolve attention**. D03 must project current pending requests from their existing authority, independent of the 500-entry notification history. Terminal failures likewise need an existing execution-record/detail destination independent of alert delivery. If an authoritative destination cannot preserve a request or terminal outcome after history eviction, that producer is blocked from the relevant slice until the gap is owned. This proposal does not make JSONL history an unlimited archive.
- History initialization/reload is read-only presentation, not an external-delivery replay. Legacy rows with unknown provenance are history, not current-session actions. Explicit reconnect reconciliation queries the existing owners; it does not replay the entire JSONL file as alerts.
- Within a retained, proven identity, repeated input updates one notification's presentation without a second external alert. All distinct requests and terminal outcomes remain inspectable. Beyond expiry/eviction/restart, repeated FYIs or reminders are permitted; **no exactly-once or cross-process guarantee** is made.
- Reserve a per-surface attempt synchronously before asynchronous fan-out, so concurrent callbacks cannot both launch the same retained event. Track history persistence separately from external attempts. Disk failure must not mark history as persisted, and failure of one adapter must not suppress another.
- Current dispatch is fire-and-forget; the initial slice should record at most an attempt, not pretend it can observe remote receipt. Disabled transports do not become delivered. No automatic retry queue or backlog flush on preference changes. Any later delivery retry policy needs an explicit owner/budget and retains the original event identity.
- Fence callbacks by originating binding and connection/process generation. Late callbacks may not create current-session actions, recreate evicted cache records, or mark a successor record delivered. Async completion must not read a newly switched global base path as its original destination.
- Do not use global `suppressPersistence` around asynchronous fan-out. A producer-owned envelope needs an agreed way to append once while the ordinary interceptor continues to capture unrelated notifications. Review this integration before changing `ctx.ui.notify` or claiming that all external notifications enter history.
- Existing history mutation locks do not prove atomic semantic dedup across processes. Test append/read/clear/rotation interleavings separately; any required storage-concurrency fix needs its own accepted scope. Two cmux sessions sharing one project must never suppress each other's events. Conversely, two independent processes handling the same event may both alert until B is explicitly owned.

Surface boundaries for this retention policy:

| Surface | Retention and freshness boundary |
| --- | --- |
| Native TUI | Existing 500-entry disk history plus the proposed process-local dedup budget. Current attention comes from D03, not from disk unread state. |
| Desktop, cmux/OSC and one-way remote | Local adapter attempt flags share that process budget. No assumed receiver-side persistence, receipt, synchronization or platform notification-center retention. Restart does not resend history. |
| Bell | An opt-in attention effect, not another lifecycle event or durable destination. It follows the same local event identity and preference decision. |
| VS Code extension, if adopted | Separate owning process/binding and separately bounded local policy. Reuse its activity lifecycle model and connection-generation fences; do not assume access to native store state. No cross-process suppression promise. |
| Interactive remote question | Existing prompt record and owner-defined timeout/resolution remain authoritative. Dedup retention cannot shorten or extend the request lifetime. |

## Presentation and ownership boundaries

Reuse the existing history overlay and footer notification slot. Do not turn unread count into an action count: it can become zero while attention remains pending. Reuse D03's attention destination rather than implementing a second blocker list. Proposed labels below are wireframes, not shipped commands or counts.

```text
Wide:   Attention 2 [Open attention]   Notifications [History]
        Export complete · Recording warning [Details]
Narrow: Attention 2 [Open]
        Latest: Export complete [History]
Detail: Origin session / subject / attempt / outcome
        Recording or review conclusion / freshness / existing destination
```

At 40 terminal columns or a 240px panel, keep attention and history keyboard reachable. Opening/closing details restores focus to the trigger. Incoming updates never focus, approve or activate controls. Announce each new actionable identity once while retained; cosmetic updates stay silent. Provide text labels, not color-only urgency. Stale/unknown details must not expose a live action for the wrong session. D03 owns the target of three-or-fewer-keystroke attention navigation; D05 must not imply that it already exists.

Focus detection is unverified. Unknown focus means use the existing preference-controlled delivery behavior, not inferred foreground suppression. Maintainers must choose whether reliably focused hosts suppress optional FYI external alerts; action-needed visibility is never removed. Respect current independent remote policy, desktop kind preferences and opt-in bell behavior until an explicit policy change is accepted. Do not leak additional session metadata, raw logs or secrets into remote payloads merely to carry local identity.

| Owner/dependency | Decision needed before implementation |
| --- | --- |
| D01 [#2933](https://github.com/open-gsd/gsd-pi/issues/2933) | Approve identity namespace, origin attribution, binding lifetime, worktree move/reopen handling and stale-generation rules. Native TUI, cmux, integrated terminal, extension RPC process and external MCP client are not implicitly one session. |
| D03 [#2932](https://github.com/open-gsd/gsd-pi/issues/2932) | Owns the read-only attention-presentation contract and verified navigation. Existing request/blocker producers and owner-controlled APIs retain lifecycle, resolution, freshness and authorization authority. Viewing consent is not granting it. |
| D02 [#2936](https://github.com/open-gsd/gsd-pi/issues/2936) | Consume independent assistant/tools/jobs/attention facets; agree count ownership and layout. Never infer workflow idle from notification silence or assistant idle. |
| Notification producer and adapter maintainers | Accept A/B/C per producer, exact identity/transition ledger, urgency mapping, 256/30-minute limits, overflow order, preference/focus policy, replay boundary and honest result vocabulary. Name owners for missing identity propagation. |
| O04 #2928, O05 #2930, O07 #2926, O08 #2927, O06 #2929 | Coordinate report discoverability, host lifecycle, cmux ownership, failure distinctions and semantic emphasis. #2930 is closed; its existing activity model must be reused, not relabeled missing. |
| Umbrella maintainers | Record design approved/revise/hold, selected surfaces, owner/date/source revision, producer prerequisites and a separately authorized implementation claim. Core/API changes require the contribution-policy RFC gate. |

Recommended first implementation slice, **after those decisions**: one proven native producer plus an additive identity carrier, store projection and local dispatch adapter. Extend to remaining known producers only after their ledger rows are verified. No protocol-wide schema, cross-host dedup or speculative retry engine. Keep a gap list for each unadopted producer/surface; do not advertise global notification dedup from one passing adapter.

## Fixture and test plan

These are required assertions, **not executed tests**. Capture redacted real producer envelopes before turning fixtures into executable expectations. Mock clocks, disk and dispatch at unit level; a mock transport cannot establish actual host behavior.

| Fixture | Sequence | Required assertion |
| --- | --- | --- |
| R01: duplicate/fan-out race | Deliver the same proven completion 100 times, including concurrent callbacks and rephrased prose | One retained history transition and at most one external attempt per eligible local surface; no duplicate launch while an attempt is pending. |
| R02: distinct requests | Two approvals with identical wording, then ordinary input, all within one invocation | Three distinct identities/destinations; distinct wording by category; none auto-answered. Delivery duplicates may coalesce, but all requests remain reachable. |
| R03: execution retry | Attempt A fails, retry ticks arrive, attempt B fails terminally | Attempt boundaries and both outcomes remain distinguishable; no progress spam, no mistaken session end, no suppression of B by A. |
| R04: repeated wait | Wait → resume → wait within one attempt; replay the first wait | A new wait occurrence is not suppressed; replay cannot resurrect its resolved request or overwrite the later state. |
| R05: reconnect/replay ordering | Disconnect during work; reconnect receives duplicate and out-of-order transitions | Unknown/disconnected is not failure; stable replay coalesces while retained. Owner revision fences prevent stale request/action regression. |
| R06: session isolation | Two cmux sessions share one workspace and emit identical text/kind/scope; switch session during dispatch | Distinct events both survive. Old completion retains original attribution; late callbacks cannot target or mutate the new session. |
| R07: independent lifecycle facts | Success plus recording warning; failed test conclusion; read/dismiss/clear history | Outcome and conclusions remain separate. Notification actions never grant approval, resolve a blocker or manufacture a passing test. |
| R08: pending attention retention | Keep a pending request through overlay open/refresh, cache expiry, clear and history rotation | History read count can change independently; D03 still exposes the actual unresolved request. Expiry is not acknowledgement. |
| R09: activity composition | Assistant ends while two jobs continue; jobs then finish independently | No global-idle/completed shortcut; distinct job outcomes and report destinations survive notification dismissal. |
| R10: transport failure | Disable each surface; fail cmux CLI, OSC/native path or remote dispatch; reject async dispatch | No false receipt; current native fallback/remote preference behavior is accounted for. Failure cannot remove history/attention or suppress an independent surface. No recursive notification storm. |
| R11: bounded overflow/restart | Burst 257+ fresh identities, then 500+ history rows; advance clock; restart process | Cache never exceeds 256, callbacks/flags included; age is non-sliding and monotonic. Rotation targets 500 history entries. Permitted FYI repeats do not lose authoritative attention. Startup does not resend history. |
| R12: malformed/missing identity | Missing session/attempt, tuple delimiter collisions, contradictory attribution, legacy JSONL row | No text-based suppression or guessed action binding; canonical identity encoding distinguishes tuples; legacy history remains readable as unknown provenance. |
| R13: persistence interleavings | Append failure followed by replay; append concurrent with mark-read, clear or rotation | Failed persistence is not recorded as success; no silent lost request. Any storage race is reported as a prerequisite, not masked by the delivery cache. |
| R14: focus/accessibility | Focused editor receives new attention, cosmetic updates and FYIs at narrow width | No focus steal; action/history reachable; close restores focus; new identity announced once while retained; text urgency works without color. |

Existing test locations to extend selectively: `src/resources/extensions/gsd/tests/notification-store.test.ts`, `notification-overlay.test.ts`, `notification-widget.test.ts`, `notifications.test.ts`, `auto-stop-notification.test.ts` and `cmux.test.ts`; background behavior has `src/resources/extensions/subagent/tests/background-batch.test.ts`. VS Code's current model and lifecycle tests should remain the authority for its settlement behavior; add D05 adapter coverage only for accepted extension changes.

A proposed `src/resources/extensions/gsd/tests/notification-policy.test.ts` would be new, not an existing harness. After implementation and with prerequisites already available on an authorized runner, a targeted existing-suite invocation is:

```sh
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/notification-store.test.ts \
  src/resources/extensions/gsd/tests/notifications.test.ts
```

The resolver redirects imports to built artifacts, so source SHA alone is insufficient to identify what it tests. VS Code's package test script is `node --experimental-strip-types --test "test/*.test.ts"`; use its package workflow only if that surface changes. No tests, installs, builds or runtime experiments were performed for this proposal.

## Required host evidence and approval receipt

Before implementation acceptance, the responsible owners must provide evidence for each affected surface, with unsupported/unavailable cells explicitly marked as gaps:

- Native terminal: narrow/normal/wide widths, light/dark themes, keyboard history/drill-down, focus restoration, pending attention after clear/rotation and the real session-switch path.
- cmux: two distinct sessions sharing a workspace, CLI enabled/disabled/failure, OSC fallback and native-desktop interaction. Record command/escape attempts separately from observed visible alerts; duplicates across fallback channels must not be hidden by a claimed receipt.
- Native desktop: actual platform/backend, enabled/disabled preference cases, terminal focused/unfocused/unknown. A macOS observation is not Linux or Windows evidence.
- Remote: an approved test destination, independent preference behavior, question forwarding versus one-way alerts, delivery failure and redacted prompt correlation. No production credentials or prompt contents in evidence.
- VS Code, if changed: actual Extension Development Host, extension artifact and RPC-process identity, narrow panel, reconnect/rebind and late events. An integrated terminal screenshot does not validate the extension process. External MCP clients require separate evidence if claimed supported; otherwise list them as unverified, not equivalent to native TUI.

Each record must identify source SHA, built/installed artifact and activation path, host/app/version, OS/terminal, configuration, originating session/run/attempt/transition correlation (safely redacted), reproduction steps, expected/observed result, notification attempt versus visible receipt, and evidence location. Include a keyboard trace or focused host recording, not only renderer snapshots. Record failures and unavailable adapters alongside passes. No proposed fixture or command above is real-host evidence.

The design receipt must explicitly select the option, urgency mappings, identity/attempt sources, retention/focus policy, supported surfaces and prerequisite owners. Stop for ambiguous lifecycle or identity ownership, a conflicting accepted design, or a proposed new global authority. Maintainer approval of this document remains separate from permission to implement and from later test/host acceptance.
