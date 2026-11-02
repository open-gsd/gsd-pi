# Authored report prose width

Status: **Design proposal only; implementation requires separate maintainer agreement.**

Related: [#2931](https://github.com/open-gsd/gsd-pi/issues/2931) (D04),
[#2913](https://github.com/open-gsd/gsd-pi/issues/2913) (umbrella), and
[#2928](https://github.com/open-gsd/gsd-pi/issues/2928) (authored-report boundary).

## Review basis and authority

Initial inspection targeted upstream source at
`f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19`; the follow-up review on 2026-11-02
rechecked the relevant width/content claims against live main at
`52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`. Issue bodies and comments were
consulted on 2026-11-02. #2931 and #2913 remain open; #2931 explicitly requests a
design and fixture plan, not an implementation. No accepted width constant,
setting, host behavior, or implementation approval is inferred here.

The #2931 scoping comment describes the older `b09bdf3fc` source, where #2928 was
still a prerequisite. That prerequisite is now delivered: #2928 is closed and
[PR #2938](https://github.com/open-gsd/gsd-pi/pull/2938) merged at
`ebcabb8589898ede5785ae2147c051219cbecb99`. The target source contains its authored
Markdown path and regression tests. Do not reopen or reimplement that work.
Its completion establishes a content boundary, not a readable-width policy.

Historical issue comments are not current implementation or CI evidence. The
related execution PRs [#2922](https://github.com/open-gsd/gsd-pi/pull/2922) and
[#2917](https://github.com/open-gsd/gsd-pi/pull/2917) are now merged; that does not
approve this proposal or prove its host behavior. Issue links alone also do not
prove native parent/subissue attachment.

Upstream main had advanced to `52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6` at the
read-only remote check. This document deliberately retains the requested
`f76d1d0` source baseline; implementation pickup must recheck main, issue
ownership, linked work, and maintainer decisions. No builds, installs, tests, or
host acceptance observations were performed for this proposal.

## Problem and scope

A report paragraph spanning a wide terminal can be difficult to scan. Reducing
the entire tool frame would also squeeze code, paths, diagnostics, and evidence.
The proposed improvement is a shorter **visual measure for explicitly authored
report prose**, while preserving report order and host width for protected
content.

Initial scope is the existing subagent authored-report presentation paths:

- Ordinary subagent result bodies already rendered as Markdown.
- Authored child output in the background `action: "status"` report view,
  including partial output accompanied by outcome diagnostics.
- No new eligibility for source reads, execution output, lifecycle facts,
  arbitrary assistant messages, or all Markdown documents. Planning/spec/summary
  viewers need separate agreement before joining this policy.

This is not a global terminal width, theme setting, new report renderer, content
formatter, or transport change. It does not change model prompts, transcripts,
run records, tool result content, persisted Markdown, or execution/log budgets.
It does not add horizontal scrolling, a copy button, or a persisted preference.

## Current rendering and width ownership

Paths in this section refer to the target source revision.

| Layer | Current contract | Consequence for this proposal |
| --- | --- | --- |
| `src/resources/extensions/subagent/index.ts`: `formatRunRecord`, status action, `renderRunRecordReport`, `renderResult` | Status content remains the model-facing record dump; `details.runRecord` supplies the structured TUI view. Lifecycle facts and diagnostics use `Text`; nonempty authored `child.output` uses `Markdown`. | Opt in at the authored report boundary, not by inspecting the formatted record dump. Preserve the missing-details `Text` fallback. |
| Same file: `renderRunRecordReport` | `.trim()` checks emptiness, but the original `child.output` is passed to Markdown. Status reports remain inspectable both collapsed and expanded. | Preserve leading indentation, report visibility, identity, failure facts, and resume/session handles. Do not introduce a second truncation policy. |
| Same file: ordinary `renderResult` branches | Expanded report bodies already use themed Markdown; some pass trimmed final output. | Share the width policy with those existing Markdown paths without broadening this task into output normalization. |
| `packages/pi-coding-agent/src/theme/theme.ts`: `getMarkdownTheme` | Supplies Markdown styling. | Theme styling is not a width source; do not hide a universal measure in the theme. |
| `packages/pi-tui/src/terminal.ts`: `ProcessTerminal.columns` | Uses `process.stdout.columns`, then numeric `COLUMNS`, then 80. | This is a terminal-host fallback chain, not permission for a report renderer to query global stdout. |
| `packages/pi-tui/src/tui.ts`: `TUI.render`, `Container.render` | TUI obtains terminal columns; containers pass their supplied width to children. | Consume the component's actual `render(width)` allocation. A nested component need not own the whole terminal. |
| `packages/pi-tui/src/components/box.ts`: `Box.render` | Subtracts horizontal padding before rendering children. | Account for frame padding once, not again in a guessed terminal-width calculation. |
| `packages/gsd-agent-modes/src/modes/interactive/components/tool-execution.ts`: `render` | Uses an existing 20-cell frame floor and renders the body through the host frame. | Do not narrow the frame/header, or silently change its narrow-host floor here. |
| `packages/gsd-agent-modes/src/modes/interactive/components/assistant-message.ts`: `render` | Uses a width/version render cache and an existing frame floor. | Resize and cache ownership belong to the host component, not a stored report width. |
| `packages/pi-tui/src/components/markdown.ts`: `Markdown.render`, `renderToken`, `renderList`, `renderTable` | Caches by text and width, subtracts its padding, lexes Markdown, and finally wraps rendered lines with `wrapTextWithAnsi`. Tables and nested blocks have their own layout. | Passing a smaller width to the whole Markdown component would also narrow code and tables. Block-aware handling must survive nested layout and the final wrap pass. |

Current Markdown rendering is not a byte-for-byte source viewer: for example,
its render path replaces tabs with spaces and styles code, and its final wrap
can visually split code lines at the available host width. “Preserve” below
means **no new prose constraint or source mutation**, not a claim that existing
rendered pixels or terminal selections reproduce original bytes.

### Host partitions

| Host | Width authority and proposed behavior |
| --- | --- |
| Native TUI | Use the allocated display-cell width passed through the component tree, after applicable frame/prefix/padding deductions. Reflow when that allocation changes. |
| cmux terminal pane | Treat pane PTY dimensions as terminal-host input. A split pane can be narrower than the window. `src/resources/extensions/cmux/index.ts` manages sidebar/status/progress integration, not report layout; do not use sidebar metadata or workspace size as the report measure. |
| Web terminal | `web/components/gsd/main-session-terminal.tsx` fits xterm and submits columns/rows; `web/app/api/terminal/resize/route.ts` delegates to `web/lib/pty-manager.ts`. The PTY/TUI allocation remains authoritative, not browser window pixels. Font loading, initial attachment, and resize need observations. |
| VS Code extension WebView/chat | Not the native component tree. `vscode-extension/src/conversation-history.ts` escapes text and uses container CSS (`white-space: pre-wrap`, `word-break: break-word`); `chat-participant.ts` streams Markdown through VS Code's chat API. Neither is proof that subagent `renderResult` runs there. Retain current behavior until an explicit authored-content path and host-owned container-width contract are demonstrated. |

Do not derive terminal columns from CSS pixels, impose native cell counts on
WebView typography, or claim a native TUI observation as acceptance for cmux or
VS Code. An unsupported or unclassified host retains current host-width
rendering. A later DOM implementation would need its own container-relative
measure and protected-block overflow/copy contract.

## Content boundary

Eligibility is decided by the producer/presentation path, then by Markdown
block structure. It must not depend on line length, terminal width, keywords,
or whether raw data happens to contain Markdown punctuation.

| Content inside an eligible report | Proposed treatment |
| --- | --- |
| Authored paragraphs and headings | Readable measure; preserve inline emphasis and links. |
| Authored list-item prose | Readable measure including marker and nesting indentation. Continuations align under the item's text; do not renumber or flatten lists. |
| Authored blockquote prose | Readable measure including quote prefixes. A quote containing protected content retains that content's protection. |
| Fenced or indented code, commands, patches, diffs, log excerpts, JSON and other structured payloads | Protected: retain existing host-width rendering, highlighting, whitespace semantics, and overflow behavior. A fence's language label is not required for protection. |
| Tables | Protected as a whole, including prose-looking cells. Retain existing table layout and narrow-width fallback rather than introduce a second cap on its columns. |
| Paths, URLs, identifiers, inline code and other source-bearing spans | Never insert hard breaks, ellipses, hyphens, or changed escaping into the underlying value. If an intact span cannot fit the prose measure, render the containing prose block at host width rather than newly split the span at the cap. Existing host-boundary wrapping may still apply. |
| Raw HTML, malformed/unknown blocks, ambiguous unfenced structured content | No speculative reformatting or new HTML interpretation. Retain current host-width behavior where eligibility cannot be established. |
| Lifecycle facts, error messages, stderr, source reads, tool results and raw logs outside the authored body | Ineligible even if they look like Markdown. Preserve existing rendering and budgets. |

Bare paths or JSON are not reliably distinguishable from prose by a Markdown
lexer. Explicit code/fence/source provenance is the reliable boundary. This
proposal does **not** solve that gap by regex classification: ambiguous blocks
must fall back to host width. Maintainers must agree how the authored path
expresses sufficient provenance, or retain host-width rendering for that path.
Do not require rewriting old reports to gain a safe fallback.

Protected descendants do not lose protection because a parent is a list or
blockquote. Keep source order: prose, code, prose remains prose, code, prose;
do not move evidence into another panel or hide it behind expansion controls.

## Options and recommendation

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| A: keep host-width rendering | No new policy or fidelity risk; safe fallback. | Wide prose remains hard to scan. |
| B: opt-in, block-aware readable measure | Improves authored prose without constraining the whole report. | Needs explicit eligibility, protected-span handling, and nested-block/final-wrap tests. |
| C: user-selectable host/readable mode | Accommodates reader preference. | Adds discovery, persistence, settings scope, and host-parity decisions not justified by this design alone. |

Recommend **B conditionally**, with A as the fallback wherever eligibility or
host support is not demonstrated. Do not implement B by calling the existing
Markdown renderer once with a smaller width, wrapping the final report string,
or creating an independent Markdown parser. Extend the existing render path
only after maintainers accept the boundary and layout contract. If safe
block/span handling requires a larger parser or provenance redesign, return to
A and seek that design separately.

An **88-display-cell** cap is an illustrative fixture parameter, not a validated
optimum, accepted default, or existing setting. Compare it with host width in
representative layouts before choosing a value. This proposal recommends no
new persisted preference; C remains a maintainer decision.

### Proposed layout contract

Let `W` be the report's host allocation after frame/Markdown padding but before
list/quote prefixes. Let `M` be the chosen prose measure and `P` the display-cell
width consumed by the applicable ancestor prefixes. An eligible prose body gets
`min(W, M) - P` cells; a protected body gets `W - P`. Thus prefixes count toward
the prose measure rather than extending it. If no usable body width remains,
retain the existing host fallback instead of forcing this formula. Do not
subtract the same prefix or padding twice.

- Use existing ANSI/Unicode display-width primitives, not JavaScript string
  length. Styling must not count as cells. Exercise CJK, emoji and combining
  characters against the renderer's actual width rules.
- Left-align prose with existing report content. Leave unused space on the
  right; do not center individual paragraphs or shrink the status/tool frame.
- Preserve Markdown hard-break semantics and existing spacing. Add visual rows
  only; never join or insert newlines in the stored or model-facing source.
- A long source-bearing span can make its containing prose block use host
  width. Do not crop it or introduce horizontal scrolling as an incidental fix.
- The final host-width safety wrap may still protect terminal bounds. It must
  not apply the prose cap to protected lines or undo nested-block decisions.
- Recompute on allocation changes. Any new cached layout must also depend on
  measure, policy, content revision, and nesting context as applicable. A cache
  keyed only by unchanged text and width would be stale after a policy change.
- If width/measure is unavailable or invalid, retain the established host
  fallback path rather than invent a global width. Physical widths below the
  current frame floor need explicit host-level evidence, not a promise that
  this report-local change fixes them.

Proposed wireframes, not runtime captures (`M = 88` is illustrative):

```text
Wide host, B
| status / identity / tool frame: existing host allocation             |
| Report heading                                                     |
| authored paragraph ends at readable measure | unused space          |
| - nested prose uses remaining measure       |                       |
| code / diff / JSON / table: existing host-width layout               |
| raw diagnostics and resume handles: unchanged                       |

40-cell host, B
| prose uses available content cells    |
| protected blocks retain current policy|

A: prose fills the allocated host width.
C: a proposed Host / Readable control, only if separately agreed.
```

## Failure and fidelity requirements

- Missing details or an unavailable run record: retain the current `Text`
  fallback; never guess that the formatted dump is authored Markdown.
- Empty/whitespace-only output: retain lifecycle facts, with no empty readable
  frame. Running, failed, interrupted, resumed, and partially successful runs
  retain their status, diagnostics, and identity independently of report prose.
- A partial authored report must not swallow its accompanying error. This
  preserves #2928 behavior; completion status alone is not the eligibility test.
- Malformed fences, unknown tokens, mixed source/prose and insufficient prefix
  space: use host-width fallback for the affected block; do not silently drop,
  crop, or reorder content. Establish parser behavior with fixtures first.
- Resize during streaming or inspection: invalidate layout deterministically;
  preserve logical order and test scrolling/selection stability. Exact viewport
  position is a host concern and must not be promised without observations.
- Preserve original data in tool content, run-store records, persisted files and
  source-backed copy/export paths. Native terminal selection copies rendered
  rows and may include soft-wrap artifacts; it is not proof of byte fidelity.
  If exact copy requires a new affordance, request separate approval rather
  than claiming an existing one.
- Avoid a second parse pipeline or repeated full-report rendering on every
  frame. Measure large reports, deeply nested lists and wide tables; fall back
  without losing inspectability rather than silently truncating for speed.

## Fixture and verification plan

These are proposed checks, **not executed results**. Use deterministic inputs:

- A: a fixed 240-word paragraph with heading, nested ordered/unordered lists,
  link, inline code and strong text.
- B: prose surrounding a 110-cell code line, a diff, raw log and JSON fences,
  an indented code block, and an eight-column table; repeat inside lists/quotes.
- C: identical Markdown-looking text presented as an authored report, raw source
  read, stderr, and execution output. Only the authored path may opt in.
- D: original bytes containing tabs, leading indentation, blank lines, Unicode,
  long paths/URLs and Markdown hard breaks, plus malformed/unfinished fences.

| Case | Expected acceptance evidence |
| --- | --- |
| D04-R01: 160-cell host | Eligible prose uses the selected measure; report frame and protected blocks keep host allocation; stored text has no added newlines. |
| D04-R02: 40-cell host | Prose clamps to actual content width after prefixes/padding; no cap-induced overflow. Separately observe widths below the current 20-cell frame floor. |
| D04-R03: resize 160 → 40 → 160 | Deterministic reflow, no stale cache, omissions or duplicates; inspect scrolling and selection. Repeat during partial output updates. |
| D04-R04: nested lists/quotes | Stable numbering, prefix accounting and hanging indents; nested code/table descendants remain protected. |
| D04-R05: heading/link/strong/code spans | Styling and link targets preserved; source-bearing spans trigger the documented block fallback when necessary. |
| D04-R06: long URL/path and wide Unicode | Cell-aware bounds and no value mutation; host-boundary wrapping is distinguished from prose-cap behavior. |
| D04-R07: code/diff/log/JSON/table | No additional prose-width constraint or new cropping; compare protected rendering with the existing host-width baseline. |
| D04-R08: raw source/tool/log | No new eligibility, cap, reinterpretation, persisted rewrite or change to existing budgets. |
| D04-R09: copy/export | Exact original bytes in source-backed paths, including whitespace. Record terminal selection behavior separately; do not compare rendered row strings as source bytes. |
| D04-R10: empty/failure/interruption/resume | Existing facts and fallback remain visible in collapsed and expanded status views; partial prose cannot hide errors or resume handles. |
| Unsupported/invalid policy or host | Existing rendering remains available; no stdout-derived width inside the report renderer. |
| Large/deep/streaming report | Record render cost and cache behavior against the baseline; no unbounded extra parsing or hidden truncation. |

Start implementation verification with the existing
`src/resources/extensions/subagent/tests/background-report-markdown.test.ts`:
its cases cover completed/collapsed reports, empty/running states, stderr/error
source treatment, partial/interrupted/resumed runs, accompanying diagnostics,
whitespace-only output and unchanged leading indentation. Add boundary and
no-mutation assertions there rather than replacing those regressions.

Extend `packages/pi-tui/test/markdown.test.ts` for opt-in block/span widths,
nesting, tables, ANSI/Unicode and resize/cache behavior. Cover default behavior
unchanged when the policy is absent. Host framing integration belongs alongside
`packages/pi-coding-agent/test/tool-execution-component.test.ts`; execution
renderer fidelity should remain unchanged in
`src/resources/extensions/gsd/tools/exec-tool-renderer.ts`.

After an accepted design, use the then-current repository test/toolchain
instructions and targeted gates; this proposal does not assert an unverified
lint or test command. Runtime evidence must identify the exact tested source
SHA, build/runtime artifact actually loaded, host/editor version, dimensions,
font/theme, normal/narrow layout, and durable evidence reference. Record native
TUI, cmux, web terminal and VS Code partitions separately, including keyboard
navigation and selection. A mockup, passing source test, or issue closure is not
host acceptance. Any unsupported partition must remain an explicit gap with
host-width fallback.

## Decisions requested from maintainers

1. Accept B's block-aware opt-in boundary, retain A, or request C? Confirm whether
   initial scope is only the existing subagent authored Markdown paths.
2. Agree on the measure and evidence needed to select it. Is it fixed or
   configurable? If configurable, who owns discovery, scope, persistence and
   invalid-value fallback? No new setting is assumed here.
3. Approve left alignment, protected tables, nested-prefix accounting and
   host-width fallback for overlong source spans and ambiguous blocks. Is more
   explicit producer provenance needed before B is feasible?
4. Confirm that existing code/table overflow remains unchanged. Any horizontal
   scroll or exact-copy affordance requires its own host/accessibility decision.
5. Agree where the opt-in policy lives in the existing Markdown renderer and
   how protected descendants survive its final wrap. Do not approve a global
   Markdown cap or a parallel renderer by implication.
6. Confirm supported host partitions and required observation evidence. Keep
   unsupported paths unchanged rather than claim cross-host parity.
7. Confirm task decomposition and ownership with #2928's delivered boundary,
   #2929's separate emphasis work, and related #2933/#2936/#2932/#2935/#2934
   designs. Any new provenance, preference or copy work needs explicit scope.

Approval of this document, an implementation claim, source changes, verification,
and host acceptance are separate gates. This proposal claims none of them.
