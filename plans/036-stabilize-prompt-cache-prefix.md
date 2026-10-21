# Plan 036: Stabilize the prompt-cache prefix and surface cache retention

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 43033bb9..HEAD -- src/resources/extensions/gsd/context-masker.ts src/resources/extensions/gsd/provider-payload-policy.ts packages/pi-ai/src/providers/anthropic.ts packages/pi-agent-core/src/harness/agent-harness.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (land before plan 037 — both touch `provider-payload-policy.ts` adjacency)
- **Category**: perf (LLM token usage)
- **Planned at**: commit `43033bb9`, 2026-07-08

## Why this matters

Anthropic (and OpenAI's automatic) prompt caching bill cached prefix tokens at
~10% of the fresh rate — but the cache invalidates from the first changed byte
onward. GSD's auto-mode payload policy rewrites history **inside** the
previously cached prefix every turn: observation masking replaces the content
of every maskable message older than the last 8 turns, and that boundary
advances ~1 message per turn, so most turns flip one message from real content
to a placeholder and force a full cache re-write of everything after it. This
recurs per turn and is worst exactly where caching matters most: long
auto-mode sessions. Separately, the cache TTL setting (`cacheRetention`) is
dead config — nothing in the coding agent sets it, so every session uses the
5-minute TTL and pays full re-writes after any >5-minute gap — and the OAuth
path spends one of Anthropic's four cache breakpoints on a ~10-token constant
string. Three fixes, one theme: stop paying cache-write prices for content
that didn't meaningfully change.

## Current state

Files and their roles:

- `src/resources/extensions/gsd/context-masker.ts` — `createObservationMask`
  (lines 96–110) masks old tool results; the boundary moves every turn.
- `src/resources/extensions/gsd/provider-payload-policy.ts` —
  `applyObservationBudget` (lines ~87–101) applies the mask in the
  `before_provider_request` path when auto-mode is active;
  `DEFAULT_OBSERVATION_MASK_TURNS` and `DEFAULT_TOOL_RESULT_MAX_CHARS = 800`
  live at the top (~line 26).
- `packages/pi-ai/src/providers/anthropic.ts` — `resolveCacheRetention`
  (lines ~49–57), `getCacheControl` (~59–72), system-prompt breakpoints
  (~947–971), tools breakpoint (~984, ~1269), moving last-message breakpoint
  (~1212–1234).
- `packages/pi-agent-core/src/harness/agent-harness.ts` — threads
  `turnState.streamOptions.cacheRetention` (~line 368) but nothing populates it.

Excerpt — `src/resources/extensions/gsd/context-masker.ts:96-110`:

```ts
export function createObservationMask(keepRecentTurns: number = 8) {
  return (messages: MaskableMessage[]): MaskableMessage[] => {
    const boundary = findTurnBoundary(messages, keepRecentTurns);
    if (boundary === 0) return messages;

    return messages.map((m, i) => {
      if (i >= boundary) return m;
      if (isMaskableMessage(m)) {
        // Content may be string or array of content blocks — always replace with array
        return { ...m, content: MASK_CONTENT_BLOCK };
      }
      return m;
    });
  };
}
```

Excerpt — `packages/pi-ai/src/providers/anthropic.ts:49-57` (dead-config TTL):

```ts
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}
```

Excerpt — `packages/pi-ai/src/providers/anthropic.ts:947-961` (OAuth double
system breakpoint; the first is a ~10-token constant):

```ts
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	}
```

Known accepted cost (do NOT fix here): `applySourceContextBlock`
(`provider-payload-policy.ts:117-127` + `source-observations.ts:267-294`)
strips last turn's source-context message and appends a fresh one — this
invalidates only the final turn's worth of cache and fixing it buys little;
recorded in `plans/README.md` as considered/deferred.

Conventions: `packages/pi-ai` and `pi-agent-core` are **vendored** from
upstream pi — changes there must pass `pnpm run verify:pi-boundary` and
`pnpm run verify:pi-patches`. Tabs + double quotes in pi-ai; 2-space + double
quotes in the gsd extension. Masking behavior is tested in
`src/resources/extensions/gsd/tests/context-masker.test.ts` and
`before-provider-context-management.test.ts` — extend those, don't fork new
patterns.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck extensions | `pnpm run typecheck:extensions` | exit 0 |
| Masker tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/context-masker.test.ts src/resources/extensions/gsd/tests/before-provider-context-management.test.ts` | all pass |
| pi-ai tests | `cd packages/pi-ai && pnpm test` (vitest) | all pass |
| pi boundary gates | `pnpm run verify:pi-boundary && pnpm run verify:pi-patches` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/resources/extensions/gsd/context-masker.ts`
- `src/resources/extensions/gsd/provider-payload-policy.ts` (only if the
  quantization knob needs config plumbing)
- `src/resources/extensions/gsd/tests/context-masker.test.ts`
- `packages/pi-ai/src/providers/anthropic.ts` (OAuth breakpoint only)
- Cache-retention plumbing: `packages/gsd-agent-core/src/agent-session.ts`
  (or wherever streamOptions are assembled — locate via
  `grep -rn "streamOptions" packages/gsd-agent-core/src`) and the GSD
  preference surface it reads from
- Corresponding test files

**Out of scope** (do NOT touch, even though they look related):

- `source-observations.ts` strip-and-append behavior (accepted cost, above).
- The moving last-message breakpoint and tools breakpoint in `anthropic.ts` —
  correct as-is. Adding a second mid-conversation anchor (CACHE-05) is
  deferred; don't attempt it here.
- `openai-completions.ts` / `amazon-bedrock.ts` — they inherit the fix via
  the shared masking path; no direct edits.
- Tool scoping (`register-hooks.ts` `setActiveTools`) — investigate-only
  finding, separate.

## Git workflow

- Branch: `advisor/036-stabilize-prompt-cache-prefix`
- Conventional Commits, e.g. `perf(gsd): quantize observation-mask boundary to preserve prompt-cache prefix`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Quantize the observation-mask boundary

In `context-masker.ts`, change `createObservationMask` so the boundary only
advances in blocks of `keepRecentTurns` (i.e. it is byte-stable for
`keepRecentTurns` consecutive turns, then jumps): compute the raw boundary as
today, then round it DOWN to the previous multiple of the quantization step
measured in *turn boundaries*, not message indexes. Concretely: find all turn
boundaries (reuse `findTurnBoundary`'s helpers), and instead of "keep last N
turns", keep "last N + (turnCount mod N)" turns so the masked region only
grows when a full block of N new turns has accumulated.

Invariants that must hold (assert in tests):
- At least `keepRecentTurns` most-recent turns are always unmasked.
- At most `2 * keepRecentTurns - 1` turns are unmasked (bounded memory cost).
- For a fixed conversation prefix, adding one new turn does NOT change the
  masked/unmasked status of any message in the prefix except at block
  rollover (once every `keepRecentTurns` turns).

Apply the same quantization to `createResponsesInputObservationMask` (the
Responses-API twin in the same file).

**Verify**: masker tests command → all pass, including the three new invariant tests (written in step 2).

### Step 2: Extend masker tests

In `src/resources/extensions/gsd/tests/context-masker.test.ts`, add cases for
the three invariants above, plus a regression test simulating turn-by-turn
growth: build a message list, apply the mask, append one turn, apply again,
and assert the serialized prefix (JSON of messages up to the old length) is
byte-identical between applications except at rollover turns.

**Verify**: same command → all pass.

### Step 3: Drop the wasted OAuth cache breakpoint

In `packages/pi-ai/src/providers/anthropic.ts:947-961`, remove the
`cache_control` spread from the FIRST system block (the constant
"You are Claude Code…" string) **only when** a second block (the real system
prompt) follows and carries the breakpoint — the constant is then still
cached under the second breakpoint's prefix. If `context.systemPrompt` is
absent, keep the breakpoint on the constant block.

**Verify**: `cd packages/pi-ai && pnpm test` → all pass; add/extend a unit
test if `anthropic` conversion has one (grep `cache_control` under
`packages/pi-ai/test/`) asserting: OAuth + systemPrompt → exactly one system
block has `cache_control`; OAuth without systemPrompt → the single block has it.

### Step 4: Surface `cacheRetention` as a real setting

1. Locate where `streamOptions` are populated for the session
   (`grep -rn "streamOptions" packages/gsd-agent-core/src packages/pi-coding-agent/src`).
2. Add a `cacheRetention` passthrough sourced from settings: follow the
   existing settings pattern in `packages/pi-coding-agent/src/core/settings-manager.ts`
   (find a nearby optional model-behavior setting as the exemplar).
3. Default: leave the provider default (`"short"`) unchanged. When GSD
   auto-mode is active, set `"long"` (models that lack
   `supportsLongCacheRetention` degrade gracefully — `getCacheControl`
   already guards the TTL). Auto-mode activation is visible from the GSD
   extension; if wiring auto-mode detection into gsd-agent-core is not clean
   within the session/streamOptions seam, fall back to a plain setting +
   documented recommendation, and note the deviation.
4. Document the tradeoff where the setting is defined: 1h retention has a
   higher cache-write price; it pays off for sessions with >5-minute gaps.

**Verify**: `pnpm run typecheck:extensions` → exit 0;
`cd packages/gsd-agent-core && pnpm test` → pass; a new unit test asserts the
setting reaches `streamOptions.cacheRetention`.

### Step 5: Boundary gates and full pass

**Verify**:
- `pnpm run verify:pi-boundary && pnpm run verify:pi-patches` → exit 0
- `pnpm run typecheck:extensions` → exit 0
- `node scripts/verify-changed-src-tests.mjs` → pass

## Test plan

- New invariant + byte-stability tests in `context-masker.test.ts` (pattern:
  the existing tests in that file).
- pi-ai conversion test for single-breakpoint OAuth system array (pattern:
  existing vitest tests under `packages/pi-ai/test/`).
- Settings-passthrough test for `cacheRetention` (pattern: nearest
  streamOptions/settings test in `gsd-agent-core`).

## Done criteria

- [x] `pnpm run typecheck:extensions` exits 0
- [x] Masker tests incl. byte-stability regression pass
- [x] `cd packages/pi-ai && pnpm test` passes (pre-existing unrelated failures in
      `google-shared-gemini3-unsigned-tool-call.test.ts` and `lazy-module-load.test.ts`
      confirmed present on the base commit via `git stash`)
- [x] `pnpm run verify:pi-boundary && pnpm run verify:pi-patches` exit 0
- [x] `grep -n "cache_control" packages/pi-ai/src/providers/anthropic.ts` shows the OAuth constant block no longer unconditionally carries it
- [x] `cacheRetention` is settable without `PI_CACHE_RETENTION` and reaches the provider (test proves it, both at the `Agent`→`streamFn` layer and the `SettingsManager` persistence layer)
- [ ] No files outside the in-scope list are modified — **deviation, operator-approved**: step 4's real seam turned out to be `packages/pi-agent-core/src/agent.ts` (not `harness/agent-harness.ts`, which is unused by `gsd-agent-core`). Hit the plan's STOP condition, reported it, and the operator explicitly chose "make the passthrough edit in agent.ts". Also touched: `packages/pi-agent-core/test/agent.test.ts`, `packages/pi-coding-agent/src/core/settings-manager.ts` (+ its test), `packages/gsd-agent-core/src/sdk.ts`, `scripts/pi-upstream.json`, `docs/dev/pi-upstream.md` (vendor-patch allowlist/doc entries for the above).
- [x] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `findTurnBoundary`'s semantics don't match the "turns" model this plan
  assumes (e.g. it counts messages, not user-turns) — report what it actually
  counts before redesigning the quantization.
- `verify:pi-patches` rejects the anthropic.ts change (vendor-patch policy
  conflict) — report; the OAuth-breakpoint fix may need to go upstream instead.
- The streamOptions seam for step 4 requires modifying `pi-agent-core`
  harness code beyond adding a passthrough — that's upstream-vendored
  territory; report the exact seam you found.
- Masking tests reveal the mask boundary is load-bearing for context-window
  math elsewhere (search hits for `observation_mask_turns` you can't account for).

## Maintenance notes

- Future work that reorders messages, injects mid-history content, or rewrites
  old messages in `before_provider_request` will silently re-break cache
  stability — the byte-stability regression test from step 2 is the guard;
  keep it.
- Reviewers should scrutinize the block-rollover math (off-by-one at the
  quantization edge) and confirm the worst-case unmasked window
  (`2*keepRecentTurns-1`) is acceptable for context size.
- Deferred: a second stable mid-conversation cache anchor (CACHE-05) and
  active-tool-set churn measurement (CACHE-06) — see `plans/README.md`.
