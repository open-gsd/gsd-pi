# Actionable blockers: source-driven attention without new authority

## Status and scope

- **Disposition:** proposed design for maintainer review; implementation on hold.
- **Initial source inspection:** upstream main at `f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19`; follow-up review on 2026-11-02 rechecked the relevant current-source claims against live main at `52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`.
- **Tracking:** [#2932](https://github.com/open-gsd/gsd-pi/issues/2932), design child of [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). Both were open when reviewed. Body links do not establish native GitHub hierarchy or an implementation assignment.
- **Audience:** maintainers deciding the presentation contract and contributors preparing a separately authorized implementation and fixture plan.

This proposal defines how to explain a blocker, identify the affected work, and reach an existing supported surface. It does not create permissions, resolve blockers, approve requests, retry work, or change execution policy. No implementation authority, accepted design, runtime observation, test pass, or accessibility compliance is claimed.

The review used current issue bodies and comments, including [#2932's source-mapping comment](https://github.com/open-gsd/gsd-pi/issues/2932#issuecomment-6304544281) and [#2913's earlier delivery comment](https://github.com/open-gsd/gsd-pi/issues/2913#issuecomment-6296659298). Those comments describe older revisions; source findings below supersede their assumptions for this proposal, not their ownership or approval gates. The issue handoff's `b09bdf3fc770309deb60aa373f184febed3c739a` is historical, not the reviewed source.

## Problem and recommended boundary

A person must be able to answer:

1. What needs attention, and which work does it affect?
2. Who owns the next step?
3. What is known now, versus historical, disconnected, or unknown?
4. Where can I inspect or act using an existing authorized flow?

“Blocked,” “Recovery,” a red error, or assistant inactivity cannot answer all four. An idle assistant can coexist with running jobs and multiple requests. A failed operation, a pending human decision, a cancelled run, and an unavailable connection are different facts.

**Recommend option A from #2932:** a persistent attention summary, a keyboard-reachable list, and read-only details with verified navigation destinations. Inline approval/retry/resolve controls are excluded from the first presentation slice. Opening a destination is not performing its action.

| Option | Benefit | Cost and gate |
| --- | --- | --- |
| A: summary plus list/details and navigation | Visible causes; reuses existing authority surfaces | Maintainers must accept surfaces and verify each destination/binding |
| B: inline mutation controls | Fewer steps | Separate producer/action contract, native approval, confirmation, fencing, and implementation review required; not proposed for this slice |
| C: details list only | Smallest presentation change | Less discoverable; maintainers must explicitly accept slower triage |

## Verified producers and limits at the reviewed revision

Paths are repository-relative. These are source findings, not claims that every host already exposes them.

| Producer or consumer | Existing contract | What it does not establish |
| --- | --- | --- |
| `src/resources/extensions/gsd/db-lifecycle-foundation-schema.ts` | `workflow_blockers` has a checked kind vocabulary, `user`/`external` resolution owner, `open`/`resolved`/`dismissed` status, project/lifecycle association, description, requested action, and opening revision/authority epoch/operation | A UI action capability or an approval-request join |
| `src/resources/extensions/gsd/db/queries.ts` | `getOpenBlockers()` returns typed fields, ordered by opening revision then blocker ID | Its projected row omits lifecycle ID, opening epoch and status; an empty result without a DB is not proof of no blockers |
| `src/resources/extensions/gsd/state/project-snapshot.ts` | DB snapshot has project authority revision/epoch, open blockers and `blockersTruncated`; the open-item limit is 50 | A complete list when truncated, or permission to act on a row |
| `src/resources/extensions/gsd/state/progress-from-db.ts`; `packages/contracts/src/rpc.ts` | Progress can include `blockerRows`; legacy `blockers: string[]` remains. `ProjectSnapshotBlocker` exposes ID, kind, owner, description, requested action, opened time and opening revision | RPC kind/owner fields are strings, not validated enum capabilities. `blockerRows` absence can mean an older or projection producer, not an empty canonical list |
| `src/resources/extensions/gsd/pause-blocker-domain-operation.ts`; `db-auto-pause-blocker-schema.ts` | Human pause/blocker association and fenced operations exist. `auto_pauses.blocker_id` links a pause to a blocker | A generic resolution path for every blocker; opening can fail to find the required lifecycle association |
| `src/resources/extensions/gsd/commands-blocker.ts`; `pause-blocker-inspection.ts` | `/gsd blocker inspect <id>` provides bounded read-only context. Clear-only resolution is limited to eligible auto-pause associations, native human approval, evidence, and existing writable checkout/authority prerequisites | Clearing is not repair, Task success, verification, retry authorization, dispatch, or completion. Inspection eligibility alone is not write permission; epoch-zero prerequisites remain enforced |
| `src/resources/extensions/gsd/recovery-policy.ts`; `commands-task-recovery.ts` | Recovery has typed ownership/actions and budgets. `/gsd recover <recoveryActionId>` checks eligibility and asks for repair information before authorizing a repaired continuation | A general Retry button, or permission inferred from a failed result |
| `src/resources/extensions/gsd/auto-recovery-authorization.ts`; `auto-recovery-options.ts`; `auto.ts` | Existing native-approved bounded mechanical recovery is separate from human blockers. A flag is not consent; the authorization is run/project/revision/epoch-bound and expiring. Consumption does not close a pause or blocker | New or broader recovery authorization from this proposal; permission to bypass human gates or replenish budgets |
| `packages/contracts/src/rpc.ts`; `vscode-extension/src/gsd-client.ts` | `extension_ui_request` has request IDs and distinct select/confirm/input/editor methods; the client responds through those existing flows. `McpPendingBlocker` carries a request event | That every confirm is workflow consent, every input is a canonical blocker, or a request ID equals a blocker ID |
| `packages/contracts/src/rpc.ts` | `workflow_outcome` distinguishes completed/error/timeout/blocked/cancelled, with optional reason | A structured blocker reason or retry permission from its human-readable reason; cancellation is not failure |
| `packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts`; `components/gsd-status-widget.ts` in that directory | Widget receives `lastBlockingError` as `lastError`, expands on it, and can display “Recovery”/“blocked” | A typed approval schema, canonical blocker list, or current action permission |
| `src/resources/extensions/gsd/auto-dashboard.ts`; `vscode-extension/src/sidebar.ts` | Dashboard can show status/reason; sidebar progress renders phase/counts/next action | An implemented category-specific blocker/action list |

### Corrections to the older design input

- The DB vocabulary is typed, but the public blocker row's kind and owner are strings. Unknown values require an explicit fallback, not an unchecked cast.
- The DB stores opening epoch and lifecycle identity; `ProjectSnapshotBlocker` does not expose them. A proposed `(sessionId, blockerId, openedAuthorityEpoch)` key cannot simply be read from today's row.
- `openedProjectRevision` records when a blocker opened. It normally differs from a later valid snapshot revision. **Inequality is not evidence that the blocker is stale.** Likewise, an old opening epoch is not, by itself, the owner's resolution decision.
- No verified canonical blocker-to-pending-request join was found in the contracts inspected. A suggested join on `McpPendingBlocker` remains a producer prerequisite, not an implemented guarantee.
- Existing native clear-only resolution and bounded mechanical recovery must be preserved. Neither may be replaced by a generic confirm dialog or described as missing infrastructure.
- `out-of-surface-blocker.ts` includes a legacy prose category extractor for routing. Its existence does not authorize a new presentation parser to infer permissions from prose.

## Proposed typed presentation contract

This is a read-only adapter contract, not a new DB schema, RPC API, state machine, or authority service. Preserve producer identity and provenance; do not overwrite source reasons with a guessed diagnosis.

### Canonical reason vocabulary

Recognize the seven current canonical `blocker_kind` values exactly. Labels describe attention, not permissions.

| Authoritative kind | Suggested label | Supported explanation and next step |
| --- | --- | --- |
| `missing_authority` | Authority needed | Show the owner's reason; inspect the authority prerequisite. Never offer to grant authority from this view |
| `missing_access` | Access needed | Show which prerequisite the producer identifies; direct to existing inspection, without exposing credentials or offering automatic privilege changes |
| `external_dependency` | Waiting on dependency | State that an external party/system owns the next step; do not promise a retry will fix it |
| `consent` | Consent needed | Show the request context. “Review request” only with a verified current destination; viewing never grants consent |
| `ambiguous_intent` | Clarification needed | Show the unresolved question; “View question” only when the exact question surface is known |
| `subjective_uat` | Human acceptance needed | Reach the existing acceptance surface when identified; never auto-accept or substitute objective test success |
| `user_limit` | User limit reached | Show the producer's requested action; do not assume the limit may be increased or that ordinary input clears it |

Do not map “missing input” to `user_limit`, “failed prerequisite” to `missing_access`, or “approval” to `consent` by matching text. Only a producer's typed value supplies that classification.

Keep other typed sources distinct:

- A select/input/editor request is a pending interaction, not necessarily a workflow blocker. A confirm request is a confirmation request unless the producer supplies more specific semantics.
- `AutoPauseBlockerKind` also contains `user_request` and `machine_fixable`. Do not cast either into the seven canonical human kinds. A user pause does not imply a human blocker row; mechanical recovery retains its separate owner and policy.
- Outcome status, recovery status, recording warnings, and connection status are separate dimensions. A connection loss is not a new `workflow_blockers` row.
- Unknown/new kind, legacy prose-only reason, or missing structured source becomes **Unclassified attention**. Keep the original text as explanatory data; offer inspection only, never inferred approval/retry controls.

### Required fields and honest absence

| Field group | Requirement |
| --- | --- |
| Provenance | Producer/surface, canonical versus projection/legacy origin, and the snapshot or connection generation that supplied it |
| Identity | Project and verified host/session/run binding from #2933; exact source namespace and blocker/request/recovery ID. Missing components stay missing |
| Reason | Raw typed kind plus known presentation category, or explicitly unclassified; description and requested action remain text |
| Ownership | Canonical resolution owner where supplied. “User” does not identify a particular actor or grant the viewer that actor's role |
| Freshness | Snapshot read revision/authority epoch, observed connection state/generation and opened time/revision when available. Opening metadata is historical context, not an action fence |
| Scope | Exact affected lifecycle/unit if independently available; otherwise say “Affected unit unavailable.” Do not silently attribute a project blocker to the current Task |
| Destination | An exact existing read-only inspection destination, or a verified link to an existing owner-controlled action surface. Missing destination means explanatory copy, not a fabricated command |

There is no presentation-level `canRetry` or `canApprove` derived from `requestedAction`, `nextAction`, error text, severity, owner, or a cached row. Those strings may explain a requested step; they are not executable instructions or capabilities.

Keep canonical blockers and pending interactions as separate groups unless the producer supplies a validated association. Deduplicate only within a source identity. Never merge by matching titles, paths, message text, or timestamps. Where overlap is unknown, show separate group counts rather than inventing a total of unique requests. A truncated snapshot says “50 shown; more available,” not “50 total”; a complete-list destination is a prerequisite for promising access to all items.

## Authority and action rules

| Presentation affordance | Allowed effect | Authority retained by |
| --- | --- | --- |
| Open attention list/details | Read bounded context; preserve original identity | Current read source; no lifecycle mutation |
| Inspect blocker | Navigate to, or explain, `/gsd blocker inspect <id>` for the exact known project/blocker | Existing read-only inspection path; no implicit DB opening/adoption |
| Review request / View question | Open the exact still-pending existing interaction, if supported by that host | Request owner and existing response channel; the link sends no response |
| View recovery | Open existing recovery context for an exact recovery action; otherwise explain that the association is unavailable | Recovery policy, eligibility, repair evidence and existing resume path |
| Clear-only resolution | No inline control in this slice; details may explain the existing eligible native flow | Existing native approval, evidence, checkout binding, revision/epoch and association guards |
| Retry / approve / resume / cancel / dismiss | Not synthesized by this view | Existing owner APIs and host-specific permission/confirmation rules only |

Mandatory invariants:

1. **Never infer retry or approve permission from prose or stale UI.** This includes commands embedded in errors and a previously enabled button. A known kind is also insufficient.
2. Navigation never acknowledges, grants, resolves, dismisses, retries, resumes, cancels, dispatches, adopts a database, or changes budgets. Closing details is not dismissing a canonical blocker. Opening a notification is not consent.
3. A destination must preserve project, actor/role, session/run and request boundaries. If an exact destination is unavailable, state the missing prerequisite and keep inspection available where safe.
4. The owner revalidates any subsequent mutation at submission. Where `WorkflowCommandIdentity` applies, `expectedRevision` is the current snapshot revision, not the opening revision; idempotency keys identify one action. These fields are not a universal permission contract and do not replace epoch, native-host, identity, eligibility or budget checks.
5. Cancellation is explicit and owner-controlled. A cancelled request/run is not “approved,” “resolved successfully,” or “retryable.” Cancelling a dialog must not clear its associated blocker or trigger work.
6. Existing recovery remains authoritative, including agent budgets and the separately approved bounded mechanical-recovery path. A new attention item neither consumes nor replenishes authorization. Failure and `retry_end` alone never clear a canonical blocker.

## Freshness, reconciliation and failure behavior

- **Current read:** classify canonical rows from a coherent authoritative snapshot. “Current” means observed in that read, not guaranteed unchanged until a click. A newer unrelated project revision does not invalidate an open blocker merely because it opened earlier.
- **Disconnect:** retain the last observed cause with “Disconnected — status not refreshed.” Suspend action navigation that cannot verify its target. Do not mark the remote run failed, cancelled, approved, or complete.
- **Reconnect:** obtain current authority and identity before rebinding anything. If the owner cannot establish that an old request is still pending in the same scope, keep it unknown/history, not actionable.
- **Switch/restart:** bind new state to #2933's identity contract. Late old-session events may update only their original history, never clear or retarget the current session's item. A connection generation helps reject stale transport events; it is not itself workflow authority.
- **Resolution:** remove an open canonical item only after authoritative refresh confirms its absence/resolution for the same scope. Absence from a truncated/failed/projection read is not confirmation. Pending interactions follow their own owner lifecycle; do not silently resolve a separate canonical blocker with them.
- **Missing or conflicting truth:** display “Status unavailable” or “Source conflict — inspect current state.” Do not fall back from a failed canonical read to an authoritative-looking empty list or use last-error text to repair state.
- **Refused navigation/action:** retain context and the owner's refusal reason. Never rebind to the newest similarly named request, silently drop a revision fence, or repeat a mutating operation automatically.

## Presentation and keyboard contract

Use text and a semantic icon; color is supplementary. Keep reason, affected work, ownership, freshness and consequence distinguishable. Use existing theme roles rather than introduce a palette redesign.

Illustrative layout, not an assertion that navigation APIs already exist:

```text
Wide
Attention | Blockers (2) | Pending interactions (1)
Consent needed · Blocker B1 · Project P · user
[Inspect] [Review request: only if linked] [All attention]

Narrow
Attention: 2 blockers
Consent needed · B1
Status: current read
[Inspect] [All attention]

Details
Reason: <producer description>
Affected work: <verified identity, or unavailable>
Owner: user
Requested step: <producer text, not an executable action>
Observed: <snapshot revision / connection state>
Opened: <historical opening metadata>
Destination: <verified existing surface, or missing prerequisite>
```

- At 40/80/120 terminal columns and 240/400px sidebar widths, wrap content without horizontal scrolling. Retain the count/coverage qualifier, first unresolved item, and route to the list. Long IDs/paths may shorten in summary, but full identity must be readable/copyable in details.
- Do not steal editor focus on attention updates. Announce a new identity/state transition once; duplicate delivery or rerender does not repeat the announcement. Important information remains visible without notifications or color.
- List entry, detail inspection, and available destination must be reachable within three keyboard activations from the attention summary. Choose exact bindings with maintainers; this is a future acceptance target, not a measured result.
- Closing details restores focus to its invoker. If that item disappeared, return to the list/summary, not another request's action. Reconciliation must not move focus onto a different approval.
- Native TUI, VS Code, and MCP are different hosts. An inspect-only or text-only host explains the supported next step; it must not pretend to provide a native approval surface.
- Escape/control characters and untrusted text must not become terminal controls, HTML, shell commands, or action identifiers. Preserve existing escaping/redaction; do not show secrets, raw request payloads or unrelated runtime metadata just to make a detail view richer.

## Dependencies and non-duplication

| Work | Relationship and boundary |
| --- | --- |
| [#2933: identity](https://github.com/open-gsd/gsd-pi/issues/2933) | Shared project/session/run/host binding and reconnect semantics are prerequisites for cross-surface action links. Existing safe inspection may remain useful without a new identity subsystem. Unknown identity blocks the link, not unrelated work |
| [#2936: composed activity](https://github.com/open-gsd/gsd-pi/issues/2936) | Reuse its separation of workflow, assistant, jobs, pending interactions and freshness. Blocker presentation consumes facts; it does not redefine active-job counts or equate assistant idle with done |
| [#2927: diagnostics](https://github.com/open-gsd/gsd-pi/issues/2927) | Closed; use as regression/evidence reference only. Linked [PR #2943](https://github.com/open-gsd/gsd-pi/pull/2943) merged as `11781590e18304efb02f4d42b1e1e9dd096b9c92`, an ancestor of the reviewed source. Preserve failure diagnostics and independent recording warnings; do not reopen or rebuild this lane |
| [#2935: notifications](https://github.com/open-gsd/gsd-pi/issues/2935) | Share request identity/dedup rules. Delivery/click is not acknowledgement or approval; notification policy is separate |
| [#2930: connection](https://github.com/open-gsd/gsd-pi/issues/2930), [#2929: semantic presentation](https://github.com/open-gsd/gsd-pi/issues/2929) | Consume existing lifecycle/freshness/theme work; do not reopen closed work or assume issue state proves runtime behavior |

The umbrella's older delivery comments are not current merge authority. Read-only PR inspection found [#2917](https://github.com/open-gsd/gsd-pi/pull/2917) merged as `5b71b60a46dc6f75b36e2bc31c7c96930baf1531`, alongside the earlier merged [#2922](https://github.com/open-gsd/gsd-pi/pull/2922) and [#2923](https://github.com/open-gsd/gsd-pi/pull/2923). This does not close #2913, satisfy real-host acceptance, or authorize blocker implementation. No CI-success claim is made here.

## Maintainer decisions and producer prerequisites

Record an explicit decision receipt before implementation: chosen option, target hosts/surfaces, identity source, supported destinations, unknown-state copy, producer owner, reviewed revision, and disposition **approve / revise / hold**. This document's recommendation is not that receipt.

1. Accept A, B or C and the smallest host scope. Name the presentation owner and coordinate with the existing #2932 commenter; no competing implementation is assigned here.
2. Confirm #2933's binding and authority contract. Decide whether existing inspection is sufficient or a separately reviewed producer change must expose lifecycle/epoch or another safe lookup. Do not require invented fields from today's RPC row.
3. Confirm whether and how canonical blockers relate to pending interactions/recovery actions. Until a producer proves the association and destination, show the missing link explicitly. No join by message similarity.
4. Confirm list completeness/pagination or an existing complete inspection destination. Decide count wording for legacy, partial and cross-source data. Do not promise every request is reachable if the producer truncates without a continuation path.
5. Choose exact keyboard bindings, announcement behavior, host-specific destinations and privacy allowlist. Preserve native-only approval requirements; do not replace them with generic `confirm`.
6. Approve a fixture/test plan and decide which independently owned producer prerequisites require separate issues/RFC review. Protocol/schema changes, inline mutations, and policy changes are not silently included in a presentation slice.

**Stop conditions:** unresolved identity or permission contract; conflicting authoritative lifecycle sources; a proposed reconnect action that binds to a successor request; missing complete-list path; or any requirement to infer permission from prose. Mark the affected affordance unavailable and seek maintainer direction. Do not “repair” authority to make the view work.

## Regression and failure acceptance plan

These are future fixtures and assertions, not tests run by this proposal. Bind each to actual producer payloads at the eventual implementation revision; synthetic semantic labels alone are insufficient.

| Fixture | Sequence | Required assertion |
| --- | --- | --- |
| D03-R01 | Consent and verified request arrive; notification opens | Exact request opens; no response, grant or acknowledgement is sent |
| D03-R02 | Input/select request without workflow consent | “Input/selection needed,” never “Approve”; no invented canonical association |
| D03-R03 | Prerequisite failure while assistant becomes idle | Typed cause/owner stays visible with safe inspection or an explicit missing destination; idle does not clear it |
| D03-R04 | Disconnect during approval; reconnect | Last observation is marked stale/unknown; exact current owner revalidation precedes a link; no speculative resolution |
| D03-R05 | Failure, retry start, retry end | No premature clear; canonical resolution follows authoritative refresh, not transport/activity events |
| D03-R06 | Duplicate request/event/snapshot | One item per source identity; no repeat announcement; unrelated equal-text requests remain separate |
| D03-R07 | Session/worktree switch; late old resolution | New scope is unchanged; old action never rebinds to successor session/request |
| D03-R08 | Successful execution, failed recording | Execution success and recording warning remain separate; no fabricated execution failure or automatic rerun |
| D03-R09 | Editor focused during blocker update | No focus steal; one bounded announcement; keyboard inspection and focus restoration work |
| D03-R10 | Idle assistant, two running jobs, two pending requests | Both requests remain reachable; jobs stay running; no single misleading “done” or “blocked everything” state |
| D03-F01 | Every known kind; unknown kind/owner; legacy prose only | Exact typed categories or explicit unclassified/unknown; malformed values never unlock an action |
| D03-F02 | Unrelated revision advances while blocker stays open | Blocker remains current after authoritative read; opening-revision inequality does not mark it stale |
| D03-F03 | Changed authority, expired request, missing actor binding, wrong checkout or epoch zero | Existing guards refuse mutation; view does not adopt/bind/repair authority, drop fences or retry |
| D03-F04 | Cancel dialog/run; close details; clear-only resolution | Dialog cancel/details close do not mutate blockers; cancellation remains distinct; clear-only never dispatches, repairs or completes work |
| D03-F05 | Empty/failed DB read, old producer, truncated list, conflicting sources | No authoritative-looking “all clear”; coverage/freshness limitations visible; incomplete list cannot erase unseen items |
| D03-F06 | Failed execution with successful evidence recording | Failure remains failure; recorded evidence is not execution success. Preserve #2927's stderr diagnostics, including timeout/cancellation cases |
| D03-F07 | Long/multiline/empty text, hostile control/HTML text, long IDs, narrow layout | Safe escaping/redaction and bounded summaries; complete permitted detail; no text-to-command conversion |
| D03-F08 | Native-approved mechanical recovery, expired authorization, exhausted budget, user pause | Existing eligibility, expiry, run identity and budgets unchanged; no new consent or authorization from the view |

Future proof seams:

- Contract tests at the snapshot/progress/row adapters: source vocabulary, optional fields, completeness, revision semantics and unknown fallback.
- Native widget tests in `packages/gsd-agent-modes/src/modes/interactive/components/gsd-status-widget.test.ts`, alongside focused navigation/focus fixtures for the selected host.
- Existing blocker-inspection/resolution, Task recovery and mechanical-recovery tests: no broadened mutation surface, preserved native gates and refusal behavior. Test double-click/replay at the owner boundary, not by weakening its idempotency semantics.
- Renderer regression around `src/resources/extensions/gsd/tools/exec-tool-renderer.ts`: diagnostics, successful-stderr cases and recording warnings remain independent of blocker classification.
- Real-host keyboard/layout checks at the widths above, with reconnect/switch/late-event evidence. MCP acceptance verifies honest text-only/native-boundary behavior, not a simulated native approval.

For any future evidence, record exact source/artifact revision, producer payload provenance, host/environment, command, exit result and remaining gaps. Implementation completion requires the accepted fixtures plus separately authorized repository verification and real-host acceptance; design completion is only the reviewable proposal and identified prerequisites.

## Accuracy and change boundary

All implementation statements above refer to the pinned source, not a globally installed runtime. Current GitHub state was read for context; historic comments, closed issues and merge metadata are not test evidence. Only this proposal is added. No source, generated resource, governance register, runtime, approval state or GitHub record is changed, and no installs, builds or tests are claimed.
