# Decision record for #2936 native truthful activity

> Status: decision record for the native-first slice. It accepts design direction only. It does not authorize a cross-host parity claim, a new workflow state engine, a runtime install, or host acceptance under #2916.

This record resolves the "Maintainer decisions required" table in [2936-truthful-activity.md](2936-truthful-activity.md) for the first delivery slice.

## Decision source

- Reviewer and decision owner: the repository maintainer, via an interactive `ask_user_questions` answer on 2026-11-07.
- Chosen option: native-first with facets kept separate; a VS Code follow-up is a separate, later slice behind the same acceptance gates.
- Source revision the decision applies to: upstream `main` at `6a2b39eb0f2f5693c511eb5e16e9aa67319f58ec` (after PR #3134).

## Decisions

| Decision | Recorded choice | Acceptance condition carried forward |
| --- | --- | --- |
| Composition | Option A: separate facets (workflow, assistant, foreground tool, async job, subagent, attention, availability, freshness). Option B's single work total is rejected. | No global running/done bit. No sum of overlapping inventories unless identities are proven disjoint. |
| First surface | Native TUI first. VS Code is a deferred follow-up. Owner: @pimmink (scope and decision owner, recorded 2026-11-07 on the maintainer's delegation to agent review). Parity-gap list G1-G7 is recorded below. | Parity claims stay blocked until the gaps below are closed or explicitly accepted. Do not advertise cross-host parity. |
| Identity | Consume the scope/connection mapping agreed in #2933. | Real envelopes show attribution, rebind, and rejection of late events from an old scope. |
| Attention | Consume the reason/action contract from #2932. | Every actionable label has an authoritative source, identity, resolution rule and a valid destination. |
| Telemetry | Start with individually verified providers. Unsupported facets stay unavailable. | Each provider documents inventory completeness, subscription/teardown and reconnect behaviour. A missing producer API is a separate prerequisite, not a guessed field. |
| Freshness and history | Per-source freshness, bounded and scoped outcome retention. | Stale thresholds, event ordering and deduplication are agreed. History eviction never hides unresolved attention. |
| Interaction | Details and navigation first. No new lifecycle controls. | Keyboard and accessibility review at the widths in the proposal. No focus stealing. |

## Boundaries that remain

- An architectural change still follows the upstream RFC and approval process. This record does not replace that process; it records the maintainer's choice for the native-first slice.
- Missing inventories are shown as unavailable, never as zero.
- Unknown and stale states remain representable. Nothing here adds a state engine.
- The optional log-context proposal (#2934) and the security boundary plan (#2933 pairing and grants) are not expanded by this record.

## VS Code parity-gap list (recorded)

Source basis: an independent read-only architecture review of the VS Code client at upstream `6f356d6a`. The native `projectActivityFacets` has test consumers only; no production or RPC integration is demonstrated. Native `asyncJobs` and `subagents` are explicitly unavailable, never zero.

| Gap | Facet | What is missing for parity |
| --- | --- | --- |
| G1 | assistant | No native-equivalent states idle, working, waiting-question, waiting-gate and done with source availability. A select/input/confirm dialog is not an assistant waiting facet. |
| G2 | workers | No worker inventory or count in the VS Code presentation. Project or task progress is not a worker inventory. Needs producer-owned count, availability and lifecycle. |
| G3 | asyncJobs | No job ID, running background inventory, or follow-up status after the tool call ends. Tool success does not prove job completion. Blocked on a producer read contract. |
| G4 | subagents | No child run identity, live inventory or per-subagent lifecycle. Persisted run records must not be treated as live inventory. |
| G5 | transport | RPC emits setStatus, setWidget and extension_ui_snapshot. The VS Code client routes only select, confirm, input and notify; other methods fall into a default cancel route, and the activity feed ignores unknown events. |
| G6 | availability and scope | Feed rows have no per-facet availability, staleness or scope identity. Existing old-process rejection and disconnect settlement protect lifecycle but are not full scoped facet parity. |
| G7 | acceptance evidence | Existing tests check the presentation event model without a VS Code host. No four-facet integration and no VS Code host fixtures exist. |

G1-G4 are facet gaps. G5-G6 are transport and scope gaps and block any parity claim. G7 blocks closure of the VS Code follow-up.

## Design closure versus implementation closure

This record closes the design decision for the native-first slice only, as defined by the proposal. It does not close implementation.

- Native implementation requires its own accepted design claim, CI, and the native subset of the regression fixtures.
- VS Code fixtures belong to the deferred follow-up and are not gates for the native slice.
- Real-host evidence under #2916 remains pending until a plain-terminal installation is explicitly authorized.
