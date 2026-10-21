# Browser Tools V2 Proposal

## Purpose

This document proposes a comprehensive evolution of `agent/extensions/browser-tools/` from a strong set of browser-control primitives into a world-class AI-native browser device for:

- autonomous verification
- end-to-end testing
- GSD slice validation
- debugging and observability
- general internet task execution
- low-token, high-reliability browser interaction

The goal is not just to let the agent click around in a browser. The goal is to give the agent **hands, eyes, memory, verification, and local judgment** in a way that is:

- context-efficient
- fast
- deterministic where possible
- observable when things fail
- composable for larger workflows
- optimized for LLM use, not human scripting ergonomics

---

## Executive Summary

The current browser tools already make several unusually good architectural choices:

- accessibility-first inspection instead of screenshot-first browsing
- deterministic versioned element refs
- compact post-action summaries instead of full DOM spam
- buffered observability surfaces for console, network, and dialogs
- lightweight success verification after actions
- adaptive settling instead of blindly waiting for `networkidle`

Those choices align well with March 2026 best practices in AI browser automation.

However, the current system still operates mostly as a **toolbox of action primitives**. To become a truly elite AI-native browser device, it should evolve in six major directions:

1. **Assertions over prose** — explicit PASS/FAIL verification tools
2. **Composite actions over chatty primitive loops** — batch, form fill, goal-oriented flows
3. **Diffs over full resnapshots** — tell the agent what changed, not just what exists now
4. **Stateful browser modeling** — tabs, frames, forms, dialogs, refs, action history
5. **Failure artifacts and observability** — traces, bundles, structured debug evidence
6. **Intent-aware semantic helpers** — find the best next element/action for a goal

If implemented well, these changes would make browser-tools materially better for both:

- **GSD automatic verification and UAT generation**
- **general-purpose agentic browser use on arbitrary websites and apps**

---

## Current State: What Browser Tools Already Does Well

The existing extension in `agent/extensions/browser-tools/index.ts` already gets several important things right.

### 1. Accessibility-first state representation

The system already prefers:

- `browser_get_accessibility_tree`
- `browser_find`
- `browser_snapshot_refs`

This is the correct strategic direction. Accessibility snapshots are usually far more token-efficient and reliable than:

- full HTML dumps
- screenshot-only operation
- coordinate-based automation

### 2. Deterministic element references

The versioned ref system (`@vN:e1`) is one of the strongest parts of the current design.

It provides:

- compact handles for later actions
- stale-ref detection
- lower repeated selector verbosity
- less guesswork for the model

This aligns closely with current agent-browser and Playwright MCP design patterns.

### 3. Compact post-action summaries

The `postActionSummary()` helper is a strong design decision.

It gives the agent:

- title
- URL
- high-level element counts
- important headings
- focus state
- dialog hints

without flooding context.

### 4. Pull-based observability

Buffered logs for:

- console
- network
- dialogs

are exactly the right pattern.

This prevents every tool call from becoming noisy while still preserving rich debugging when needed.

### 5. Built-in self-verification on interactions

The current tools already attempt to verify success through signals like:

- URL changes
- hash changes
- target ARIA state changes
- value changes
- focus changes
- dialog count changes

This is much better than blind action execution.

### 6. Adaptive settling

The mutation counter plus pending-critical-request model is clever and practical.

It is better than:

- fixed sleeps everywhere
- hard dependence on `networkidle`
- no settle logic at all

### 7. Sensible visual fallback strategy

The extension already uses screenshots as:

- navigation-time context
- explicit inspection output
- failure debugging evidence

That is good. Screenshots should support semantics, not replace them.

---

## Core Diagnosis

### What the current system is

Right now, browser-tools is primarily a **semantic browser control toolkit**.

That is already useful and better than many browser agent stacks.

### What it should become

It should become an **AI-native browser operating layer** that gives the model:

- reliable control
- compact semantic state
- explicit verification
- efficient action composition
- better local reasoning support
- durable debugging artifacts

### The central gap

The biggest gap is that the extension currently optimizes for **individual actions** more than **successful browser tasks**.

That difference matters.

An elite browser device for AI should optimize for:

- “did the task succeed?”
- “what changed?”
- “what should I do next?”
- “can I verify this automatically?”
- “if it failed, what evidence do I have?”

not just:

- “did the click happen?”
- “here is the current page summary”

---

## Design Principles for V2

The proposed system should follow these principles.

### 1. Semantics first, vision second

Preferred order of understanding:

1. structured semantic state
2. scoped accessibility/tree snapshots
3. ranked semantic refs
4. DOM or JS inspection when needed
5. screenshots only when semantics are insufficient or visual truth matters

### 2. Assertions are first-class

Every serious verification system needs explicit assertions.

Tool outputs should prefer structured verification objects over prose.

### 3. Minimize round trips

The fastest tool call is the one the model does not need to make.

Obvious action sequences should be batchable.

### 4. Model the browser as state, not just a stream of actions

The extension should internally track:

- pages/tabs
- frames
- dialogs
- form structures
- refs
- last known page summaries
- diffs across actions
- recent action outcomes

### 5. Tell the agent what changed

State deltas are often more useful than fresh full state.

### 6. Heavy artifacts belong on disk, not in context

Trace files, HAR data, visual diffs, and debug bundles should generally be persisted and summarized, not inlined.

### 7. Optimize for GSD verification

The browser device should be excellent at producing:

- deterministic pass/fail checks
- concise verification summaries
- debug artifacts on failure
- machine-usable evidence for slice/task summaries and UAT

---

## Proposed Changes

# 1. Add a First-Class Assertion System

## Proposal

Add a `browser_assert` tool and a small assertion language built around common browser verification needs.

## Why it matters

This is the single most important missing capability for GSD and autonomous QA.

Today the agent must infer correctness from prose and heuristics. That is weaker than explicit pass/fail evaluation.

## What it enables

- deterministic verification
- clean GSD artifact generation
- structured failure reporting
- simpler agent reasoning
- less repeated browser inspection

## Suggested assertion kinds

### Page state assertions
- `url_contains`
- `url_equals`
- `title_contains`
- `page_ready`
- `page_has_dialog`
- `page_has_alert`

### Element assertions
- `selector_visible`
- `selector_hidden`
- `ref_visible`
- `ref_enabled`
- `text_visible`
- `text_not_visible`
- `focused_matches`
- `value_equals`
- `value_contains`
- `checked_equals`
- `count_equals`
- `count_at_least`

### Accessibility assertions
- `aria_snapshot_contains`
- `aria_snapshot_matches`
- `role_name_exists`
- `dialog_open`
- `alert_visible`

### Observability assertions
- `no_console_errors`
- `network_request_seen`
- `response_status_seen`
- `no_failed_requests`
- `dialog_seen`

### Visual assertions
- `screenshot_changed`
- `element_visually_changed`
- `layout_breakpoint_ok`

## Suggested output shape

```json
{
  "verified": true,
  "checks": [
    {
      "name": "url_contains",
      "passed": true,
      "actual": "http://localhost:3000/dashboard",
      "expected": "/dashboard"
    },
    {
      "name": "no_console_errors",
      "passed": true,
      "actual": 0
    }
  ],
  "summary": "PASS (2/2 checks)",
  "agent_hint": "Dashboard loaded without browser-side errors"
}
```

## Additional recommendation

Support both:

- single assertions
- multi-check assertions in one call

This keeps verification compact and expressive.

---

# 2. Add `browser_batch` for Composite Action Execution

## Proposal

Add a batch or transaction-style tool that executes multiple browser steps in a single tool call.

## Why it matters

This is one of the highest-ROI speed and token-efficiency improvements.

Many browser tasks currently require a chatty loop:

- find
- click
- type
- wait
- inspect
- verify

A batch tool collapses obvious sequential actions into one round trip.

## What it enables

- fewer tool invocations
- lower latency
- lower schema overhead
- less repetitive page-summary generation
- more deterministic execution of known action sequences

## Example

```json
{
  "steps": [
    { "action": "click_ref", "ref": "@v3:e2" },
    { "action": "fill_ref", "ref": "@v3:e5", "text": "lex@example.com" },
    { "action": "fill_ref", "ref": "@v3:e6", "text": "password123" },
    { "action": "click_ref", "ref": "@v3:e7" },
    { "action": "wait_for", "condition": "url_contains", "value": "/dashboard" },
    { "action": "assert", "kind": "text_visible", "text": "Dashboard" }
  ],
  "stopOnFailure": true,
  "finalSummaryOnly": true
}
```

## Recommended options

- `stopOnFailure`
- `captureIntermediateState`
- `includeIntermediateDiagnostics`
- `finalSummaryOnly`
- `returnStepResults`

## Design note

This should not replace primitive tools. It should sit above them.

---

# 3. Add `browser_diff` to Report What Changed

## Proposal

Add a diff tool that compares two browser states or the pre/post state around an action.

## Why it matters

The model frequently needs to answer:

- did the click do anything?
- what changed after submit?
- what new UI appeared?
- what should I inspect next?

A change summary is usually more useful than a fresh full snapshot.

## What it enables

- faster reasoning after actions
- better success detection
- lower token usage
- easier failure diagnosis
- improved “next action” selection

## Suggested diff dimensions

- URL change
- title change
- focus change
- dialog open/close
- heading additions/removals
- new alerts/errors/toasts
- interactive element count changes
- text changes in scoped region
- ARIA subtree changes
- validation error changes
- scroll position changes
- form state changes

## Example output

```json
{
  "changed": true,
  "changes": [
    { "type": "url", "before": "/login", "after": "/dashboard" },
    { "type": "dialog_closed", "value": "Sign in" },
    { "type": "new_heading", "value": "Dashboard" }
  ],
  "summary": "Navigation completed and login modal closed",
  "agent_hint": "Authentication likely succeeded"
}
```

## Implementation note

A lightweight internal state snapshot should be stored after major actions so diffs are cheap.

---

# 4. Add Form Intelligence

## Proposal

Add form-specific analysis and fill tools.

### New tools
- `browser_analyze_form`
- `browser_fill_form`

## Why it matters

A large percentage of browser tasks are fundamentally form tasks:

- sign in
- sign up
- checkout
- onboarding
- search
- settings
- admin actions
- content publishing

Forms are one of the highest-leverage abstractions in browser automation.

## What it enables

- fewer calls for common flows
- stronger semantic mapping between labels and inputs
- automatic handling of required fields and validation messages
- better submit targeting
- more robust GSD verification of user flows

## `browser_analyze_form` should return

- form purpose inference
- fields and labels
- field types
- required status
- current values
- current validation errors
- submit controls
- grouped sections
- likely primary action

## `browser_fill_form` should support

```json
{
  "selector": "form",
  "values": {
    "email": "lex@example.com",
    "password": "hunter2"
  },
  "submit": true,
  "strict": false
}
```

## Important design behavior

It should map values by:

- label text
- accessible name
- field name
- placeholder when needed
- form-local semantic inference

## Recommended output

- matched fields
- unmatched requested values
- fields skipped
- validation state after fill
- submit result summary

---

# 5. Add Intent-Ranked Element Retrieval

## Proposal

Add a smarter semantic finder, such as `browser_find_best`.

## Why it matters

The current `browser_find` is useful but still fairly literal. Agents often need a ranked answer to questions like:

- what is the primary CTA?
- which button submits this form?
- which textbox is the email field?
- what element most likely advances login?
- which visible error is most relevant right now?

## What it enables

- better action selection
- fewer failed clicks
- less token spent interpreting noisy candidate lists
- more autonomous local decisions

## Example

```json
{
  "intent": "submit login form",
  "candidates": [
    {
      "ref": "@v5:e7",
      "score": 0.93,
      "reason": "button in same form as email and password fields named Sign in"
    },
    {
      "ref": "@v5:e9",
      "score": 0.41,
      "reason": "secondary link outside form"
    }
  ]
}
```

## Suggested intents

- submit form
- primary CTA
- close dialog
- search field
- next step
- destructive action
- auth action
- error surface
- back navigation
- menu trigger

## Design recommendation

This should be deterministic heuristic ranking first, not a hidden LLM.

---

# 6. Upgrade the Ref System

## Proposal

Keep versioned refs, but evolve them into a richer semantic reference system.

## Why it matters

Refs are the backbone of efficient browser interaction. The current system is good; the next step is to make refs more resilient, more semantic, and more useful across changing DOMs.

## What it enables

- lower selector dependence
- better recovery from DOM churn
- more compact instructions
- clearer reasoning for the agent

## Proposed upgrades

### A. Snapshot modes
Allow specialized snapshot modes:

- `interactive`
- `form`
- `dialog`
- `navigation`
- `errors`
- `headings`
- `visible_only`

This reduces token waste and improves relevance.

### B. Better internal fingerprints
Track more stable descriptors:

- role
- accessible name
- type
- href
- form ownership
- ancestry signature
- relative region
- label association
- nearby headings

This helps ref remapping across light DOM changes.

### C. Semantic aliases
Potentially expose alias-like labels such as:

- primary submit
- close dialog
- current tab
- email field
- password field

Even if these remain derived rather than canonical, they can improve action clarity.

### D. Scoped ref groups
Allow refs generated per region:

- within dialog
- within main
- within form
- within sidebar

This helps reduce ambiguity.

---

# 7. Add Browser Session Modeling: Tabs, Pages, Frames

## Proposal

Promote the internal browser model from “single active page” to a real page registry.

### New tools
- `browser_list_pages`
- `browser_switch_page`
- `browser_close_page`
- `browser_list_frames`
- `browser_select_frame`

## Why it matters

Real browser flows often involve:

- popups
- auth redirects
- payment tabs
- docs tabs
- embedded auth iframes
- admin consoles with frames

A single global `page` pointer does not scale well.

## What it enables

- more reliable multi-tab flows
- less hidden state confusion
- better popup handling
- frame-aware automation
- clearer debugging when navigation opens a new surface

## Recommended session model

Track:

- page id
- opener relationship
- title
- URL
- last active time
- frame inventory
- whether page was auto-opened or explicitly targeted

## Design recommendation

Auto-switching to a newly opened page is still useful, but should be visible and inspectable.

---

# 8. Add Tracing and Failure Artifacts

## Proposal

Add explicit debug artifact tools.

### New tools
- `browser_trace_start`
- `browser_trace_stop`
- `browser_export_har`
- `browser_debug_bundle`
- `browser_timeline`
- `browser_session_summary`

## Why it matters

For GSD and for hard UI debugging, you need failure evidence that survives the current context window.

## What it enables

- durable debugging artifacts
- post-failure inspection without replaying everything
- easier handoff across sessions or agents
- structured evidence for summaries and UAT docs

## `browser_debug_bundle` should ideally include

- current URL/title
- viewport
- recent actions
- compact recent warnings
- recent console errors
- recent failed/important requests
- active dialogs
- screenshot path or inline thumbnail
- scoped AX snapshot near likely failure area
- trace path if enabled
- concise failure hypothesis

## Artifact policy

Heavy artifacts should be written to disk and summarized in tool output.

Example return:

```json
{
  "bundlePath": ".artifacts/browser/failure-2026-03-09T15-22-10Z/",
  "files": ["trace.zip", "screenshot.jpg", "summary.json", "ax.md"],
  "summary": "Submit button click did not change URL or form state; network returned 422"
}
```

---

# 9. Add Goal-Oriented Composite Tools

## Proposal

Add tools that operate one level above raw browser actions.

### Candidate tools
- `browser_act`
- `browser_run_task`
- `browser_recommend_next`
- `browser_verify_flow`

## Why it matters

The model should not have to fully re-solve every local browser decision through multiple turns if the browser device can cheaply reason about obvious next steps.

## What it enables

- reduced local decision overhead
- more agent autonomy
- bounded browser-side loops for repetitive UI micro-tasks
- cleaner higher-level orchestration

## Suggested roles

### `browser_recommend_next`
Given a goal and current page state, return the best next 3 actions with confidence and reasons.

### `browser_act`
Perform one higher-level semantic action like:

- open login dialog
- submit current form
- close active modal
- click primary CTA
- expand navigation menu

### `browser_verify_flow`
Run a bounded set of assertions for a named flow such as:

- logged in
- signed out
- item created
- toast appeared
- navigation completed

### `browser_run_task`
Frontier tool: perform a bounded internal action loop toward a clear goal.

## Safety recommendations

These tools must be bounded by:

- max step count
- allowed action categories
- destructive action restrictions
- explicit halt conditions

---

# 10. Add Better Waits and Reactive Predicates

## Proposal

Replace or augment `browser_wait_for` with a richer `browser_wait_until`.

## Why it matters

Generic waiting is weaker than intent-aware waiting. The best wait is waiting for the expected outcome.

## What it enables

- higher reliability
- fewer arbitrary delays
- better async app support
- less flakiness in SPA and real-time UIs

## Suggested predicates

- text appears/disappears
- ref state changes
- element count changes
- request matching pattern completes
- response with status seen
- toast appears
- dialog opens/closes
- loading spinner disappears
- route transition completes
- region stops changing
- focus reaches expected element

## Design note

This should integrate with the same state/diff infrastructure proposed above.

---

# 11. Make Screenshots More Selective and More Useful

## Proposal

Keep screenshots, but use them more surgically.

### New tools or behaviors
- `browser_screenshot_diff`
- `browser_capture_region`
- `browser_inspect_visual`

## Why it matters

Screenshots are valuable when:

- the UI is canvas-based
- layout quality matters
- icon-only controls are ambiguous
- a visual regression is suspected
- CSS behavior matters
- semantic state is insufficient

But screenshots are often too expensive and too noisy to be the default state transport.

## What it enables

- better visual debugging when actually needed
- less token waste than full-page screenshots
- pairing visual evidence with semantic evidence

## Recommended direction

- make screenshots scoped and purposeful
- prefer element/region crops over full-page captures
- pair screenshot outputs with semantic context and diffs
- support perceptual diff summaries instead of raw image-only comparisons

---

# 12. Add Structured Network and Console Assertions

## Proposal

Evolve buffered observability from passive retrieval into active verification and querying.

## Why it matters

Modern web apps often fail in ways only visible through:

- fetch/XHR failures
- console errors
- CSP/CORS issues
- React hydration errors
- auth-related 401/403s

These should be easy for the agent to test explicitly.

## What it enables

- stronger root-cause detection
- better end-to-end verification
- fewer false positives where UI looked okay but requests failed

## Suggested additions

- filter by request URL pattern
- filter by method/resource type/status range
- query logs since action id or timestamp
- assert request happened
- assert response status seen
- assert no console errors of severity >= error
- assert no failed XHR/fetch during flow

---

# 13. Add an Action Timeline and Action IDs

## Proposal

Assign every browser action an internal action id and keep a lightweight action timeline.

## Why it matters

This makes the system far more debuggable and composable.

## What it enables

- diff since action N
- logs since action N
- request correlation
- failure bundle generation
- concise flow summaries
- better GSD verification records

## Suggested stored fields per action

- action id
- tool name
- params summary
- page id
- timestamp start/end
- verification outcome
- detected changes
- relevant warnings

---

# 14. Tighten Tool Descriptions and Prompt Guidance

## Proposal

Refine tool descriptions so the model understands exactly what each tool returns and when to use it.

## Why it matters

A surprising amount of agent inefficiency comes from slightly misleading tool expectations.

## Current issue

Some tools describe outputs in terms like “returns accessibility snapshot” when they more accurately return a compact page summary.

## What it enables

- better tool selection
- fewer redundant follow-up calls
- less confusion about when to use full AX vs compact find vs summaries

## Recommended prompt guidance hierarchy

For state inspection, teach the model to prefer:

1. `browser_find`
2. `browser_snapshot_refs`
3. `browser_assert`
4. `browser_diff`
5. `browser_get_accessibility_tree`
6. `browser_get_page_source`
7. `browser_evaluate`

This keeps common browsing token-efficient.

---

# 15. Add Browser-Side State Compression and Delta Reporting

## Proposal

Internally maintain a compact page model and expose only deltas unless the agent asks for full detail.

## Why it matters

This is one of the biggest long-term wins for context efficiency.

## What it enables

- state reuse across tool calls
- lower repeated summaries
- cheaper comparison after actions
- better change detection
- smarter internal recommendations

## Internal state could include

- last summary
- heading set
- visible alerts
- dialog inventory
- interactive ref list
- form inventory
- last screenshot hash
- last AX signatures for key scopes

## Output policy

The default response should prefer:

- what changed
- what likely matters
- what the agent might want next

rather than always restating the whole page summary.

---

# 16. Add GSD-Native Verification Outputs

## Proposal

Make browser-tools able to emit outputs that directly support GSD slice/task completion.

## Why it matters

You explicitly want browser tools to power automatic verification and testing during `@agent/extensions/gsd/` use.

## What it enables

- easier automatic generation of `Sxx-UAT.md` content
- deterministic slice verification evidence
- less ad hoc summarization by the agent
- clearer “done/not done” boundaries

## Suggested additions

### `browser_verify_flow`
Return:

- named flow
- steps attempted
- checks passed/failed
- evidence links/paths
- final verdict

### `browser_export_verification_report`
Write a markdown or JSON artifact summarizing:

- environment
- URL(s)
- viewport(s)
- actions
- assertions
- outcome
- diagnostics

This is especially useful for GSD artifacts.

---

## Proposed Roadmap

## Phase 1 — Highest-ROI Near-Term Upgrades

These are the best immediate improvements.

### 1. `browser_assert`
Highest priority.

### 2. `browser_batch`
Highest priority.

### 3. `browser_diff`
Highest priority.

### 4. `browser_analyze_form`
Very high priority.

### 5. `browser_fill_form`
Very high priority.

### 6. Tighten tool descriptions and prompt guidance
Low risk, immediate value.

### 7. Action timeline / action ids
Important enabling infrastructure.

---

## Phase 2 — Strong Maturity Upgrades

### 8. Multi-page/tab/frame model
### 9. Richer wait predicates
### 10. Structured network/console assertions
### 11. Ref snapshot modes and better ref fingerprints
### 12. Debug bundle and trace export

---

## Phase 3 — Frontier AI-Native Capabilities

### 13. `browser_find_best`
### 14. `browser_recommend_next`
### 15. `browser_act`
### 16. `browser_verify_flow`
### 17. `browser_run_task`
### 18. hybrid semantic + visual fallback targeting

These are the ideas that move the extension from excellent tooling into a genuinely mind-blowing browser device for agents.

---

## Detailed Impact Summary

## Biggest wins for context efficiency

1. `browser_batch`
2. `browser_diff`
3. snapshot modes for refs
4. assertion outputs instead of prose
5. browser-side state compression/deltas
6. form-level tools replacing many small actions

## Biggest wins for reliability

1. `browser_assert`
2. richer waits
3. multi-page/frame awareness
4. structured network/console assertions
5. failure bundles and trace export
6. smarter ref remapping

## Biggest wins for agent autonomy

1. `browser_assert`
2. `browser_recommend_next`
3. `browser_find_best`
4. `browser_fill_form`
5. `browser_verify_flow`
6. `browser_run_task`

## Biggest wins for GSD

1. explicit verification outputs
2. debug bundles on failure
3. flow verification reports
4. assertion-based PASS/FAIL summaries
5. durable artifact export

---

## What Should Remain True in V2

As the extension evolves, it should preserve its best current qualities.

### Keep these principles
- accessibility-first browsing
- deterministic refs
- compact summaries
- pull-based diagnostics
- verification after action
- screenshots as support, not default state transport
- adaptive settling

### Avoid these regressions
- screenshot-first browsing as the normal path
- giant raw DOM dumps as default output
- excessive prose instead of structured results
- hidden nondeterminism in action selection
- too many tool calls for common flows
- flaky fixed waits replacing intent-aware checks

---

## Recommended Implementation Order

If the goal is maximum practical value with strong architectural compounding, implement in this order:

1. `browser_assert`
2. action timeline / action ids
3. `browser_batch`
4. `browser_diff`
5. `browser_analyze_form`
6. `browser_fill_form`
7. structured network/console assertions
8. multi-page and frame model
9. trace/debug bundle tools
10. ref snapshot modes and richer fingerprints
11. `browser_find_best`
12. `browser_recommend_next`
13. `browser_verify_flow`
14. `browser_run_task`

This order gives immediate value while laying down the right primitives for more ambitious features.

---

## Final Recommendation

The current browser-tools extension is already on the right side of the 2026 design curve. It has made several choices that are smarter than many contemporary AI browser stacks.

The next leap is to shift from:

- a browser control toolkit

into:

- a browser execution and verification device purpose-built for agents

The most important changes are:

- first-class assertions
- batch execution
- state diffs
- form intelligence
- session/page/frame modeling
- durable debug artifacts
- intent-aware semantic helpers

If these are implemented well, browser-tools can become not just a useful extension, but a foundational AI-native capability for both:

- **agentic browser use across the web**
- **automatic verification inside GSD workflows**

---

## File Added

This proposal is stored at:

`agent/extensions/browser-tools/BROWSER-TOOLS-V2-PROPOSAL.md`
