# Truthful activity composition

Status: design proposal; not accepted for implementation.

Scope: [#2936](https://github.com/open-gsd/gsd-pi/issues/2936), under
[#2913](https://github.com/open-gsd/gsd-pi/issues/2913).

Initial source inspection: upstream main at
`f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19`. Follow-up review on 2026-11-02
rechecked the relevant current-source claims against live main at
`52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`.

## Problem and recommendation

An assistant turn can end while a background command or subagent continues. A
workflow can pause for a question while another job runs. A successful tool can
leave an unresolved prerequisite or evidence-recording warning. None of these
situations has one truthful global `running` or `done` value.

Recommend option A from #2936: show separate **workflow, assistant, foreground
tools, background jobs, attention, and last outcome** facets. Compose existing
observations for display; do not create a lifecycle authority. Show what each
owner knows, for which scope, and how current that observation is. Missing input
is visible uncertainty, not an empty inventory.

This proposal does not claim that a composed surface already exists, that all
producers expose a host-consumable inventory, or that issue closure proves
real-host acceptance. Implementation requires a separately accepted design and
claim, preserving the existing pickup lane in
[#2936's input-mapping comment](https://github.com/open-gsd/gsd-pi/issues/2936#issuecomment-6304486009).

## Review baseline and delivered semantics

The current issue bodies and comments were re-read, including #2913, #2936,
#2932, #2933 and the four closed reference issues below. Their handoff source
baseline is `b09bdf3fc770309deb60aa373f184febed3c739a`; this document uses the
newer source revision above. Historical comments describing an open PR or a
missing implementation are not current delivery authority.

| Closed reference | Merged implementation present in this baseline | Semantics to preserve |
| --- | --- | --- |
| [#2925](https://github.com/open-gsd/gsd-pi/issues/2925) | [#2937](https://github.com/open-gsd/gsd-pi/pull/2937), `2bc28833b3da58f5a5958d02a2b7e0cf202b60ac` | Count active tool invocations separately from retained transcript components. Idempotent terminal removal and turn/session cleanup are not background-job completion. |
| [#2926](https://github.com/open-gsd/gsd-pi/issues/2926) | [#2942](https://github.com/open-gsd/gsd-pi/pull/2942), `dcf4b53452767982b9eeb20c6ad35330173846f2` | cmux status ownership is session-scoped; shared progress folds live registered members. `completing-milestone` is finalization, not authoritative `complete`. |
| [#2928](https://github.com/open-gsd/gsd-pi/issues/2928) | [#2938](https://github.com/open-gsd/gsd-pi/pull/2938), `ebcabb8589898ede5785ae2147c051219cbecb99` | Authored background subagent reports render as Markdown. Lifecycle facts and raw diagnostics remain distinct from authored report content. |
| [#2930](https://github.com/open-gsd/gsd-pi/issues/2930) | [#2940](https://github.com/open-gsd/gsd-pi/pull/2940), `cd58aa6cd71e6fad07953b065366bb8bf3edb610` | VS Code starts use active roles, not passed roles. Unfinished rows settle on disconnect/rebind as interrupted with outcome unknown; unmatched late agent ends do not fabricate completion. |

All four merge commits are ancestors of the reviewed source. Do not reopen or
reimplement these scopes. Their regression tests are foundations, not proof
that this new composition or the umbrella's host-evidence gate has passed.
[#2916](https://github.com/open-gsd/gsd-pi/issues/2916) is the linked real-host
acceptance concern; this design does not close #2913.

## Existing inputs and their boundaries

Paths below are repository-relative and refer to the pinned source. Producer
state, host event streams, transcript rows and extension status strings are
not interchangeable inventories.

| Facet | Existing input and owner | What the composition may say | Boundary or gap |
| --- | --- | --- | --- |
| Workflow | `src/resources/extensions/gsd/auto/session.ts` owns `AutoSession`; `src/resources/extensions/gsd/auto.ts` orchestrates it. `src/resources/extensions/gsd/auto-dashboard.ts` builds the progress payload and runtime-health copy. `packages/contracts/src/rpc.ts` defines `ProjectSnapshot` and `workflow_outcome`. | Owner-reported phase, scope, progress and health; distinguish executing, paused/blocked, recovering, finalizing and complete when supplied. | Runtime activity and persisted project progress answer different questions. Do not infer completion from an inactive auto session, full counts, elapsed time or a missing widget. Preserve snapshot provenance. |
| Assistant | Native session `isStreaming` is passed by `packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts`; `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts` handles agent boundaries. `src/resources/extensions/gsd/turn-status.ts` owns the `gsd-turn` status. | Assistant active, idle, waiting on a question/gate, or retrying when the owning input establishes it. | `TurnStatusTracker` explicitly treats `willRetry` as non-completion and keeps waiting until its predicate clears. Its brief `turn done` flash is not workflow success. Do not parse footer text into a new state machine. |
| Foreground tools | Native `activeToolInvocations`, keyed by `toolCallId`, feeds widget/footer counts. VS Code has its own stream-scoped `ActivityModel` in `vscode-extension/src/activity-model.ts`. | Current invocations in that host/session; retained cards remain available as history. | `pendingTools.size` is not a running count. Native external `tool_result_end` and normal `tool_execution_end` have distinct cleanup paths. Host cleanup ends tracking, not necessarily execution outside the host. |
| Background jobs | `src/resources/extensions/async-jobs/job-manager.ts` owns identified jobs (`running`, `completed`, `failed`, `cancelled`) and offers inventory methods; `src/resources/extensions/async-jobs/index.ts` owns session wiring. `src/resources/extensions/subagent/run-store.ts` owns identified runs (`queued`, `running`, `succeeded`, `failed`, `interrupted`), used by `src/resources/extensions/subagent/index.ts`. `src/resources/extensions/bg-shell/process-manager.ts` and `src/resources/extensions/bg-shell/bg-shell-lifecycle.ts` own their separate process inventory/lifecycle. | Provider-labelled observations such as `Async jobs: 2 running`, or an identified subagent's status and report. | No single verified cross-host inventory is established here. An extension-local manager or persisted record is not automatically a fresh RPC snapshot. Async jobs cancel running jobs before a session switch and shut down their manager on shutdown; preserve those actual rules rather than promising universal survival. |
| Attention/blockers | `ProjectSnapshot.blockers` and `openQuestions` in `packages/contracts/src/rpc.ts`; existing question/gate predicates in `src/resources/extensions/gsd/bootstrap/register-hooks.ts`; extension UI requests where supported. | Source-backed reason, affected scope, resolution owner and next action, coordinated with #2932. | Unread notifications, errors and silence do not prove an approval request. Not every blocker is actionable by the current user or host. |
| Last outcome | Tool terminal events, identified job/run records, VS Code `ActivityModel` outcomes, and typed `RpcWorkflowOutcomeEvent`, each within its own scope. | `Last tool: succeeded`, `Job X: failed`, or an owner-reported workflow outcome, with origin and freshness. | An `agent_end` is not a background-job terminal or proof of recorded workflow completion. Execution success, evidence recording, validation and workflow acceptance remain separate claims. |

The `zz-notifications` chip in `src/resources/extensions/gsd/notification-widget.ts` reports unread
notifications, not live jobs or unresolved blockers. `gsd-step`, `gsd-fast` and
`gsd-turn` remain independent publishers. The composition must not overwrite
those slots, duplicate their lifecycle logic, or use their rendered strings as
an authority API.

`src/resources/extensions/cmux/index.ts` receives existing sidebar events and projects workflow state;
it is not a job registry. Its `src/resources/extensions/cmux/progress-registry.ts` coordination must not be
reused as a global execution counter. A dead member being pruned proves neither
successful completion nor a known outcome for its former work.

## Presentation contract

### A read-only projection, not a lifecycle engine

The proposed renderer takes observations from existing owners and produces
labels, details and navigation. Any local bookkeeping is limited to display
correlation, subscription lifetime, freshness and deduplication. It must not
write workflow rows, advance units, retry jobs, acknowledge approvals, cancel
work, or persist a second lifecycle ledger.

The following are design requirements, **not new wire fields or an implemented
adapter API**:

- Associate each observation with its producer, verified scope, provenance and
  observation time. Retain the producer's identity and terminal semantics.
- Keep availability/freshness separate from the observed value. A stale running
  observation is `last seen running`, not confirmed running now.
- Treat a count as exact only for an available, complete inventory in its stated
  scope. An event-only stream with missed history cannot establish zero.
- Never sum tools, subagents, async jobs and background shells into a `work`
  total. A foreground tool may launch or await a background job; a batch and its
  children may describe overlapping work. Show provider counts separately until
  identities and disjointness are proven.
- A valid terminal affects only its identified item/scope. It cannot clear a
  sibling provider, blocker or outcome. Duplicate terminals are idempotent;
  unmatched terminals do not decrement a count or manufacture a start/end pair.
- Keep active observations, unresolved attention and scoped outcome history
  separate. A success must not erase a sibling failure or recording warning.
  A previous failure remains discoverable while a new attempt is active.
- If inputs disagree, expose the bounded disagreement with origin/freshness in
  details. Do not elect the newest timestamp across unrelated authorities.

The existing native tool tracker and VS Code feed keep their own presentation
cleanup. In particular, native `agent_end` clears invocation tracking, and the
VS Code model marks orphaned running tool rows interrupted/outcome unknown.
Neither behavior authorizes ending an independently identified background job.
The VS Code feed's run-outcome classification remains its own bounded history
semantics; do not reinterpret a green agent row as project acceptance.

### State-to-copy rules

These labels are proposed UI copy, not additions to producer state enums.

| Observation | Proposed copy | Must not imply |
| --- | --- | --- |
| Assistant ended; two fresh identified async jobs still run | `Assistant idle · Async jobs: 2 running` | Global idle, all work complete, or cancellation of the jobs |
| Retryable agent end | `Assistant retrying` when the retry owner confirms it | Turn success or an invented retry action |
| Existing question predicate/request remains pending | `Input needed — <source-backed action>` | Approval granted or a generic failure |
| Source explicitly identifies a pending approval request | `Approval needed — <source-backed action>` | Every gate is an approval request or is user-resolvable |
| Structured workflow blocker | `Workflow blocked — <reason>; <requested action>` | Other jobs are stopped; retry is permitted |
| Workflow `completing-milestone` | `Workflow finalizing` | Complete, validated or recorded |
| One job fails while a sibling runs | `Jobs: 1 running · Job X failed` within the stated provider/scope | A global failed/stopped state |
| Tool succeeded; recording failed or warned | `Tool succeeded · Recording warning` with separate details | Recorded evidence or workflow acceptance |
| Fresh complete provider inventory is empty | `<Provider>: 0 running` | No jobs in other providers/sessions |
| No supported inventory or subscription not initialized | `<Provider> status unavailable` | Zero jobs, idle or completed |
| Disconnected host/stream | `Disconnected · <facet> status unknown` | Remote work stopped or failed |
| Prior observation is no longer current | `<Facet>: last seen <value> · stale` | Fresh activity or a terminal conclusion |
| Attention known but reason/action unclassified | `Attention needed — details unavailable` | Approval, a safe retry or a guessed resolution |

No overall success check, global busy spinner or global `done` badge accompanies
this composition. A spinner belongs to a facet with current activity evidence.
Use text as well as semantic roles/icons; finalization, interruption, failure,
waiting and completed outcomes must remain distinguishable without color.

### Surface and width behavior

Proposed wide native view, assuming the labelled inventories are actually
available:

```text
Workflow executing <unit> | Assistant idle | Tools 0 | Async jobs 2 running
Attention: input needed — answer question | Last tool: succeeded
```

Proposed narrow native view:

```text
Input needed — answer question
Assistant idle · Async jobs 2 running
Workflow/tools/outcomes: details
```

At minimum width retain an attention/action label and a visible route to
additional facets. Do not truncate `status unavailable` into a numeric zero or
remove the qualifier from `last seen running`. Wrap by terminal display cells,
not string length. Details expose scope, provider, freshness, all unresolved
items and scoped outcomes; do not silently discard the second blocker or job.

For VS Code, propose the same meanings in a compact summary plus expandable
details alongside the existing activity history. Its independently spawned RPC
session is not presumed to be a mirror of a terminal session. Keep the existing
feed model and its disconnect behavior. Missing job telemetry must appear as
unavailable, not be reconstructed from tool cards or notification counts.

Use the existing host's keyboard navigation patterns, with a visible focus
indicator and explicit details/action destinations. Background refresh never
moves focus, opens details, scrolls the transcript, or repeatedly announces an
unchanged state. Coalesce routine updates; announce a newly actionable change
once per correlated item, without treating that announcement as acknowledgement.
Exact commands/keybindings and live-region behavior require host review before
implementation; none are claimed to exist here.

## Identity, blockers and freshness coordination

### #2933: identity is a prerequisite for attribution

Coordinate with [#2933](https://github.com/open-gsd/gsd-pi/issues/2933) rather than
inventing an activity-specific identity subsystem. Separate project/worktree,
execution/session, host/connection and navigation destination. Existing
`RpcSessionState.sessionId`, snapshot `authority` and provider item IDs supply
some inputs; a cwd, session name or matching folder is not proof of shared
execution identity. A cmux surface ID and an RPC session ID are not implicitly
the same namespace.

On session rebind, unsubscribe/invalidate the old display scope before attaching
the new one. Do not reuse item keys across provider/session boundaries. Late
old-scope events cannot change the current summary; old outcomes may remain in
explicitly labelled history. `agent_start` has no wire run identifier in the
VS Code activity model, which tracks a pending run within one stream; its
numeric row ID is not a cross-host execution identity. `GsdClient` already
rejects output from replaced child processes. Preserve those guards, but do
not claim they solve cross-host attribution.

If a producer cannot supply a stable association, show it in an explicitly
unattributed/provider-local scope or mark the facet unavailable. Capturing real
envelopes and agreeing the smallest missing identity adapter is a prerequisite,
not permission to infer correlation from arrival order.

### #2932: attention is source-backed and independently resolved

Coordinate copy, categorization and destinations with
[#2932](https://github.com/open-gsd/gsd-pi/issues/2932). Its input-mapping comment
points to structured blockers, recovery policy and existing UI requests; use
those sources, not keyword matching in an error message. The current snapshot
blocker includes `blockerId`, `blockerKind`, `resolutionOwner`, `description`,
`requestedAction`, `openedAt` and `openedProjectRevision`.

Show input, approval, failed prerequisite, external dependency and unclassified
attention distinctly only when established by a mapped source. Correlate any
permitted action with the existing request/blocker and current scope. Prefer
navigation to the existing owner surface; do not add approve/retry/cancel
controls without its existing authorization contract. A retry or unrelated
success does not resolve a blocker. Absence from a fresh, complete, same-scope
authoritative open-blocker snapshot establishes only that it is no longer
reported open. A resolved/dismissed disposition or successful outcome requires
an explicit owner-supplied result. The same blocker shown in multiple inputs
counts once only with proven identity; otherwise avoid a misleading exact
attention total.

### Unknown, disconnected and stale

- **Unknown:** initial subscription, unsupported provider, incomplete inventory,
  unclassified reason or missing identity. Describe the missing knowledge. Do
  not reuse `idle` as a fallback enum value.
- **Disconnected:** immediately downgrade affected live claims. Retain last
  observations with origin/time; preserve #2930's interrupted/outcome-unknown
  history settlement. Do not alter unrelated local owners or issue cancellation.
- **Stale:** show when and from whom a value was last observed. Runtime health
  from `formatRuntimeHealthSignal()` uses `lastProgressAt` to describe recovery
  or provider idleness; it does not prove death or completion. Repeated idle
  polls do not renew the underlying progress timestamp.
- **Reconnect:** obtain a current scoped snapshot where an owner supports one,
  then reconcile by its identities and semantics. Reconnecting alone does not
  restore freshness, resurrect interrupted rows, or replay a success. Without
  a snapshot/replay contract, keep the affected inventory unknown.
- **Read failure/projection fallback:** preserve explicit provenance and the
  previous observation as stale if useful. Never replace a failed read with an
  empty successful result. Historical outcomes may remain known while current
  activity is unknown; their age must remain apparent.

Transport liveness, observation freshness and progress freshness are different.
This design does not invent a universal timeout. Maintainers must choose
per-source freshness policies before shipping adapters; elapsed time alone
never creates a terminal state.

## Maintainer decisions required

| Decision | Recommendation | Acceptance condition |
| --- | --- | --- |
| Composition | A: separate facets. Reject B's single work total for now. | No global running/done bit; no unproven sum of overlapping inventories. |
| First surface | Native-first is a possible delivery slice (option C), with an explicitly owned VS Code follow-up. | Record chosen surfaces, owner and parity gaps; do not advertise cross-host parity prematurely. |
| Identity | Consume #2933's agreed scope/connection mapping. | Real envelopes demonstrate attribution, rebind and rejection of late old-scope events. |
| Attention | Consume #2932's reason/action contract. | Each actionable label has an authoritative source, identity, resolution rule and valid destination. |
| Telemetry | Start with individually verified providers; unsupported facets remain unavailable. | Document inventory completeness, subscription/teardown and reconnect contracts per provider. Any missing producer API is a separate prerequisite, not guessed fields. |
| Freshness/history | Per-source freshness and bounded, scoped outcome retention. | Agree stale thresholds where needed, event ordering/deduplication and history eviction without hiding unresolved attention. |
| Interaction | Details/navigation first; no new lifecycle controls. | Keyboard and accessibility review at the widths below; no focus stealing. |

Record the decision, reviewer, date and source revision before implementation.
An architectural change still needs the upstream RFC/approval process; accepting
these labels is not permission to build a state engine.

## Regression and host-evidence plan

All scenarios below are **future acceptance fixtures**, not tests run or host
observations made by this proposal. Bind fixtures to captured existing events
and snapshots. Job-start, approval and reconnect adapters are proposed seams
until their real envelopes and owner contracts are recorded; do not invent a
shared `job_started` or approval schema to make a test pass.

| Fixture | Input sequence | Required assertion |
| --- | --- | --- |
| D02-R01 | `agent_start`; two identified background jobs start; `agent_end` | Assistant idle where established; jobs remain active. Native foreground cleanup and VS Code orphan-row settlement do not end those jobs. |
| D02-R02 | Pending approval; later an ordinary input request | Distinct labels/destinations; neither inferred from idleness. Prior request resolves only by its owner. |
| D02-R03 | Failed prerequisite; retry starts/ends | Blocker persists until authoritative resolution; no inferred permission or global recovery success. |
| D02-R04 | Disconnect; reconnect; current scoped snapshot | Unknown/stale during the gap; reconcile only after authoritative refresh. Reconnect without a snapshot stays unknown. |
| D02-R05 | Identified job terminal; duplicate terminal; late tool terminal | One scoped outcome; no negative count, duplicate decrement or manufactured completion. |
| D02-R06 | Session A replaced by B; delayed A event | B unchanged; A history labelled or discarded under the agreed history policy. |
| D02-R07 | Execution success; recording warning/failure | Execution success survives; recording warning remains separate. No evidence/validation claim. |
| D02-R08 | Focus in details; repeated background updates | Focus/scroll unchanged; unchanged attention is not repeatedly announced. |
| D02-R09 | Two jobs; one fails while the other runs | Failure visible alongside remaining activity; no global failed/done bit. |
| Foundation: tools | Retained completed cards, duplicate starts/ends, external `tool_result_end`, abort/timeout and session teardown | Preserve #2925 counts and transcript rebuilding; historical replay never restarts tracking. |
| Foundation: cmux | Sessions A/B share a workspace; A clears/exits while B updates; finalization then complete | Preserve #2926 per-session rows, live-member progress fold and distinct finalization visuals. No cross-session cleanup. |
| Foundation: reports | Completed/running background report with Markdown and raw diagnostics | Preserve #2928 authored report rendering without deriving lifecycle facts from prose. |
| Foundation: VS Code | Agent error/abort, clear history while active, disconnect/rebind, late duplicate end | Preserve #2930 outcome roles and bounded late-event safety, not a new global status. |
| Knowledge boundaries | Missing provider, failed read, incomplete inventory, stale progress, empty complete inventory | Unavailable/unknown/stale differ from exact zero. No terminal inferred from silence. |
| Overlap | Foreground await tool plus its background job; batch plus children | Facets stay separate; no inflated aggregate work count. |

### Existing regression anchors

Read and extend the appropriate existing harness during an authorized
implementation, rather than replacing delivered transition rules:

- `packages/gsd-agent-modes/src/modes/interactive/controllers/active-tool-count.test.ts`
- `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.test.ts`
- `packages/gsd-agent-modes/src/modes/interactive/components/gsd-status-widget.test.ts`
- `src/resources/extensions/gsd/tests/turn-status.test.ts`
- `src/resources/extensions/gsd/tests/cmux-progress-ownership.test.ts`
- `src/resources/extensions/subagent/tests/background-report-markdown.test.ts`
- `vscode-extension/test/activity-model.test.ts`

A future pure-projection test should exercise the composition matrix without
loading a host. Existing tests alone do not cover the new composed UI. For
example, the cmux ownership harness uses a fake CLI and a cross-process liveness
case; it does not replace a real cmux observation.

Example targeted commands for that later, authorized verification, from the
repository root with the repository toolchain/dependencies already available:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test packages/gsd-agent-modes/src/modes/interactive/controllers/active-tool-count.test.ts
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/cmux-progress-ownership.test.ts
(cd vscode-extension && node --experimental-strip-types --test test/activity-model.test.ts)
```

These are planned commands, not passing results. Source/tests, built packages,
globally installed CLI and the loaded VS Code extension are separate layers.
A later implementation must run its targeted checks and the applicable upstream
verification gates against its actual changed revision, not this design-only
baseline.

### Required real-host evidence

For native TUI and cmux, capture narrow/normal/wide terminals at 40/80/120
columns. For the VS Code surface, capture 240/400px sidebar widths. Cover
assistant-idle/jobs-active, waiting versus approval, sibling failure, finalizing
versus complete, disconnect/rebind and stale/unavailable inputs. Include a
keyboard-only details/action trace and a focus-preservation trace; screenshots
alone cannot establish those behaviors or screen-reader announcements.

Each evidence record must identify:

- Tested source SHA and dirty changes; exact executable/build/extension artifact
  actually loaded, not just repository HEAD.
- OS, terminal/cmux/VS Code versions, dimensions, configuration and enabled
  producers; independently identified sessions/hosts and destinations.
- Real event/snapshot provenance, completeness and timestamps, including the
  disconnect/reconnect interval; redact secrets and private paths.
- Steps, expected/observed facet labels, durable capture/log paths, test command
  exit codes where applicable, and explicit unobserved scenarios.

Host unavailability is a named gap, not a pass. Evidence must not be borrowed
from another source SHA, installed runtime or unrelated CI run. Maintainers
must separately accept host evidence and remaining gaps before claiming the
relevant #2913/#2916 acceptance; a Markdown design review is not that evidence.

## Non-goals and stop conditions

No source implementation, lifecycle authority, global running/done state,
global progress percentage, job scheduler, event bus, cross-host identity
service, database schema, recovery policy, approval acknowledgement or new
execution controls. No notification-system redesign (#2935), session attachment
protocol (#2933), blocker-policy replacement (#2932), or report-rendering
rewrite (#2928).

Stop implementation planning at an undocumented producer, missing stable
identity, unresolved authority conflict, missing reconnect inventory contract or
unmapped action. Keep the facet unavailable/unclassified and assign the smallest
prerequisite to its owner. Do not conceal the gap with a guessed status or a
second state machine.

This change is documentation only. No regression suite, build, install or
real-host scenario was executed as acceptance evidence for this proposal.
