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
| First surface | Native TUI first. VS Code is a deferred follow-up. Its owner and parity-gap list are NOT yet recorded and remain an open gate. | Before the follow-up starts, record its owner and a tracked parity-gap list. Until then, do not advertise cross-host parity. |
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

## Design closure versus implementation closure

This record closes the design decision for the native-first slice only, as defined by the proposal. It does not close implementation.

- Native implementation requires its own accepted design claim, CI, and the native subset of the regression fixtures.
- VS Code fixtures belong to the deferred follow-up and are not gates for the native slice.
- Real-host evidence under #2916 remains pending until a plain-terminal installation is explicitly authorized.
