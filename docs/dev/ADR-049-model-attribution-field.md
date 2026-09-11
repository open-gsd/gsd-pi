# ADR-049: Effective model and routing attribution on `AssistantMessage`

- **Status:** Accepted
- **Date:** 2026-09-09
- **Driver:** [#2208](https://github.com/open-gsd/gsd-pi/issues/2208), umbrella decision on [#2078](https://github.com/open-gsd/gsd-pi/issues/2078), sibling slice [#2207](https://github.com/open-gsd/gsd-pi/issues/2207)
- **Verified against:** `main` `53b6821b9` (v1.19.0)

## Context

The #2078 umbrella pass blessed a two-slice split: #2207 (live AUTO-strip model
indicator) first, #2208 (historical assistant headers) second. Slice #2208 adds
an optional field to `AssistantMessage` in `packages/pi-ai/src/types.ts`, which
is the shared message contract for every provider, transport, and session
consumer. Per the umbrella decision, that contract change needs a short ADR
before the slice starts.

What the transcript cannot answer today (all verified at HEAD):

1. **Dynamic routing is held in mutable session state.** The per-unit routing
   decision lives in `AutoSession.currentUnitRouting` (`{ tier,
   modelDowngraded }`, `src/resources/extensions/gsd/auto/session.ts:44-47` and
   `:163`), a plain mutable field overwritten at each unit start. Once the next
   unit begins, no historical response explains which model or tier produced
   it. Reload, branch review, and model-quality comparison are ambiguous.
2. **Provider-reported routing is stored but never shown.** `AssistantMessage.responseModel`
   (`packages/pi-ai/src/types.ts:329`) carries the concrete `chunk.model` when
   it differs from the requested `model` (today only the OpenAI Completions
   path populates it — e.g. OpenRouter `auto` resolving to a concrete upstream
   model). The header renders only `lastMessage.model` and a timestamp
   (`packages/gsd-agent-modes/src/modes/interactive/components/assistant-message.ts:293-297`).
3. **One hook point exists.** The GSD extension registers a single message
   lifecycle handler, `message_end`
   (`src/resources/extensions/gsd/bootstrap/register-hooks.ts:1435-1442`),
   which currently only suppresses terminal deleted-worktree messages and
   sanitizes premature closeout text. A snapshot captured at message start
   requires registering a `message_start` handler (the event type exists in
   the platform; nothing in GSD uses it yet).

## Decision

Add one additive, optional field to `AssistantMessage` that captures the
routing provenance in effect when the response was produced, attach it at the
message lifecycle boundary, and render it when present. Absent field means
legacy behavior.

### Field contract

```ts
modelRouting?: {
  source: "gsd-dynamic";
  tier: "light" | "standard" | "heavy";
  modelDowngraded: boolean;
};
```

- Provider-neutral and narrow: it records only GSD pre-request routing.
  Provider-side routing is already represented by `responseModel` and is not
  duplicated here; neither is the requested or effective model id.
- `tier` and `modelDowngraded` are copied as values from
  `currentUnitRouting` at capture time — never read later from session state.
  The unit makes its routing decision once; the snapshot preserves that
  decision for the messages produced under it.
- The exported type name may follow repository conventions; at HEAD
  `UnitRouting.tier` is a plain `string` (`auto/session.ts:44-47`), so the new
  field's type may narrow it — that is a typing decision, not a semantic one.
- The field is optional, so direct responses, non-auto sessions, and every
  existing session file remain valid without migration.

### Model display contract (unchanged semantics)

- Requested transport model: `message.model` — never overwritten.
- Provider-reported concrete model: `message.responseModel`, when non-empty
  and different.
- Effective header model: `responseModel ?? model`. Model ids are opaque
  strings; do not prepend `provider` (a value may already be qualified).

### Capture point

- On assistant `message_start`, while auto mode is active and
  `currentUnitRouting` is set, copy its primitive fields into extension-local
  pending state. Capture at start is required: reading the mutable field only
  at end (or at render time) can attribute a unit transition that happened
  mid-stream to the wrong response. A `WeakMap` keyed by message identity is
  not safe — the streaming start and finalized end objects are not guaranteed
  to be the same object. Agent assistant lifecycles are serialized, so a
  single pending snapshot with explicit boundary cleanup suffices.
- On the matching assistant `message_end`, return the same-role replacement
  carrying the snapshot, preserving the existing sanitation behavior
  (suppress terminal deleted-worktree message, premature-closeout sanitize —
  `register-hooks.ts:1435-1442`). This slice adds the `message_start`
  registration; it does not change `message_end`'s existing duties.
- Clear pending state after consumption and on session switch/reset/end
  boundaries. Never decorate user, tool-result, or assistant messages that
  started without dynamic-routing state.
- No custom session entry: custom entries are excluded from normal rendering
  and have no durable one-to-one association with a message. The optional
  message field serializes and rehydrates through the existing JSONL path
  without a schema-version migration.

### Rendering

Rendered from the stored message only, when the field is present; absent
field renders exactly today's header. Intended shapes:

```text
╭─ GSD · gpt-5.6-luna · 2026-09-07 10:37                              (legacy / direct)
╭─ GSD · gpt-5.6-luna (dynamic/light) · 2026-09-07 10:38              (dynamic routing)
╭─ GSD · anthropic/claude-opus-4.7 ← openrouter/auto (dynamic/heavy) · 2026-09-07 10:39
```

Effective model first; requested model retained in a compact
`effective ← requested` form only when `responseModel` differs; tier always
shown when `modelRouting` exists (classification provenance occurred even
without a downgrade); any downgrade marker stays secondary and readable
without color, aligned with the #2207 strip style.

## Alternatives considered

- **Session-scoped snapshot only (render-time read of current routing).**
  Rejected: relabels history after the next unit starts, which is exactly the
  bug; state is lost on reload; live state is already #2207's scope.
- **Render-time reconstruction from the dispatch ledger / database.**
  Rejected: couples TUI rendering to DB availability, covers auto sessions
  but not direct ones, and the ledger records dispatches — not per-message
  attribution — so the mapping is heuristic.
- **Store routing in a custom session entry keyed by turn.** Rejected: custom
  entries do not render with messages and have no durable one-to-one
  association with an assistant message.
- **Duplicate model ids inside the routing object.** Rejected:
  `model`/`responseModel` already own identity; a copy drifts.

## Consequences and compatibility

- **Old transcripts:** field absent → unchanged header, no migration, no
  backfill. Historical turns are never relabeled.
- **Serialization/replay:** additive optional field survives the
  message_end replacement round-trip (extension runner, agent-session event
  path, session JSONL) unchanged. The slice must add a round-trip test and
  confirm older builds tolerate the unknown field per existing message
  parsing behavior.
- **Contract surface:** `packages/pi-ai/src/types.ts` is shared; any consumer
  that reconstructs `AssistantMessage` objects must preserve the field. The
  change is additive and optional, so no provider behavior changes and no
  first-party provider is required to start reporting `responseModel` (the
  effective-vs-requested display only differs where a provider reports it).
- **Cost:** one small object per assistant message in session JSONL; one
  additional hook registration in the GSD bootstrap.

## Open questions

1. Narrow `tier` to the `light | standard | heavy` union in the new exported
   type, or keep it aligned with the loose `string` in `UnitRouting`?
2. Exact downgrade marker in the header (and reuse of #2207 strip styling) —
   deferred to slice implementation review.

## Approval

Accepting this ADR authorizes the #2208 slice: the additive
`AssistantMessage` field, the `message_start` snapshot + `message_end`
attachment in the GSD bootstrap, and header rendering from the stored
message. Normal review and testing gates apply.
