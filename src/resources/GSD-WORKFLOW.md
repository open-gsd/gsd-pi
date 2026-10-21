# GSD Workflow — Manual Bootstrap Protocol

> This document teaches you how to operate the GSD planning methodology manually using files on disk.
>
> **When to read this:** At the start of any session working on GSD-managed work, or when loaded by `/gsd`.
>
> **After reading this, always read `.gsd/STATE.md` to find out what's next.**
> If the milestone has a `NN-CONTEXT.md`, read that too. If the active slice has an `NN-MM-CONTEXT.md`, read that as well — these files contain project-specific decisions, reference paths, and implementation guidance that this generic methodology doc does not.

In a DB-backed gsd-pi project, these files are readable projections and context,
not workflow authority. Persist lifecycle changes through the GSD tools so the
database commits first and the projections refresh afterward. Manual edits are
draft or explicit import input; changing a checkbox does not change runtime
state.

---

## Quick Start: "What's next?"

Read these files in order and act on what they say:

1. **`.gsd/STATE.md`** — Where are we? What's the next action?
2. **`.gsd/phases/<NN-slug>/<NN>-ROADMAP.md`** — What's the plan? Which slices are done? (`STATE.md` tells you which milestone is active)
3. **`.gsd/phases/<NN-slug>/<NN>-CONTEXT.md`** — Milestone-level project decisions, reference paths, constraints. Read this before doing implementation work.
4. If a slice is active and has one, read **`<NN>-<MM>-CONTEXT.md`** — Slice-specific decisions and constraints.
5. If a slice is active, read its **`<NN>-<MM>-PLAN.md`** — Which tasks exist? Which are done?
6. If `.gsd/CODEBASE.md` exists, skim it for fast structural orientation before broad code exploration.
7. If a task was interrupted, check for **`continue.md`** in the active slice directory — Resume from there.

Then do the thing `STATE.md` says to do next.

---

## The Hierarchy

```
Milestone  →  a shippable version (1-10 slices, sized to the work)
  Slice    →  one demoable vertical capability (1-7 tasks)
    Task   →  one context-window-sized unit of work (fits in one session)
```

**The iron rule:** A task MUST fit in one context window. If it can't, it's two tasks.

---

## File Locations

All artifacts live in `.gsd/` at the project root:

```
.gsd/
  STATE.md                                  # Dashboard — always read first (derived cache; runtime, gitignored)
  DECISIONS.md                              # Append-only decisions register
  CODEBASE.md                               # Generated codebase map cache (auto-refreshed by GSD)
  phases/
    01-foundation/
      01-ROADMAP.md                         # Milestone plan (checkboxes project DB state)
      01-CONTEXT.md                         # Optional: user decisions from discuss phase
      01-RESEARCH.md                        # Optional: codebase/tech research
      01-SUMMARY.md                         # Milestone completion projection
      01-01-PLAN.md                         # Task decomposition for the first slice
      01-01-CONTEXT.md                      # Optional: slice-level user decisions
      01-01-RESEARCH.md                     # Optional: slice-level research
      01-01-SUMMARY.md                      # Slice summary (written on completion)
      01-01-UAT.md                          # Non-blocking human test script (written on completion)
      01-01-CONTINUE.md                     # Ephemeral: resume point if interrupted
```

---

## File Format Reference

### `ROADMAP.md`

```markdown
# M001: Title of the Milestone

**Vision:** One paragraph describing what this milestone delivers.

**Success Criteria:**
- Observable outcome 1
- Observable outcome 2

---

## Slices

- [ ] **S01: Slice Title** `risk:low` `depends:[]`
  > After this: what the user can demo when this slice is done.

- [ ] **S02: Another Slice** `risk:medium` `depends:[S01]`
  > After this: demo sentence.

- [x] **S03: Completed Slice** `risk:low` `depends:[S01]`
  > After this: demo sentence.
```

**Parsing rules:** `- [x]` = done, `- [ ]` = not done. The `risk:` and `depends:[]` tags are inline metadata parsed from the line. `depends:[]` lists slice IDs this slice requires to be complete first.

**Boundary Map** (required section in ROADMAP.md):

After the slices section, include a `## Boundary Map` that shows what each slice produces and consumes:

```markdown
## Boundary Map

### S01 → S02
Produces:
  types.ts → User, Session, AuthToken (interfaces)
  auth.ts  → generateToken(), verifyToken(), refreshToken()

Consumes: nothing (leaf node)

### S02 → S03
Produces:
  api/auth/login.ts  → POST handler
  api/auth/signup.ts → POST handler
  middleware.ts       → authMiddleware()

Consumes from S01:
  auth.ts → generateToken(), verifyToken()
```

The boundary map is a **planning artifact** — not runnable code. It:
- Forces upfront thinking about slice boundaries before implementation
- Gives downstream slices a concrete target to code against
- Enables deterministic verification that slices actually connect
- Gets updated during slice planning if new interfaces emerge

### `<NN>-<MM>-PLAN.md` (slice-level, with embedded task planning)

```markdown
# S01: Slice Title

**Goal:** What this slice achieves.
**Demo:** What the user can see/do when this is done.

## Must-Haves
- Observable outcome 1 (used for verification)
- Observable outcome 2

## Tasks

- [ ] **T01: Task Title**
  Why this task matters, what to change, and what "done" means.
  - Files: `src/path/to/file.ts`
  - Verify: `npm test`
  - Must-haves:
    - Observable behavior that must be true when this task is done
    - Files or wiring that must exist with real implementation

- [ ] **T02: Another Task**
  Why / Do / Done-when detail for the next task.

## Files Likely Touched
- path/to/file.ts
- path/to/another.ts
```

Task plan content lives inside the slice plan. There is no standalone task-level PLAN file in the flat-phase layout; layout-aware task PLAN paths resolve to the owning `<NN>-<MM>-PLAN.md`.

**Must-haves are what make verification mechanically checkable.** Truths are checked by running commands or reading output. Artifacts are checked by confirming files exist with real content. Key links are checked by confirming imports/references actually connect the pieces.

### `STATE.md`

```markdown
# GSD State

**Active Milestone:** M001 — Title
**Active Slice:** S02 — Slice Title
**Active Task:** T01 — Task Title
**Phase:** Executing

## Recent Decisions
- Decision 1
- Decision 2

## Blockers
- None (or list blockers)

## Next Action
Exact next thing to do.
```

### `CONTEXT.md` / `S##-CONTEXT.md` (from discuss phase)

```markdown
# M001: Milestone or Slice Title — Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

## Implementation Decisions
- Decision on gray area 1
- Decision on gray area 2

## Agent's Discretion
- Areas where the user said "you decide"

## Deferred Ideas
- Ideas that came up but belong in other slices
```

### `DECISIONS.md` (append-only register)

```markdown
# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | library | Validation library | Zod | Type inference, already in deps | No |
| D002 | M001/S01 | arch | Session storage | HTTP-only cookies | Security, SSR compat | Yes — if mobile added |
| D003 | M001/S02 | api | API versioning | URL prefix /v1 | Simple, fits scale | Yes |
| D004 | M001/S03 | convention | Error format | RFC 7807 | Standard, client-friendly | No |
| D005 | M002/S01 | arch | Session storage | JWT in Authorization header | Mobile client needs it (supersedes D002) | No |
```

**Rules:**
- **Append-only** — rows are never edited or removed. To reverse a decision, add a new row that supersedes it (reference the old ID).
- **#** — Sequential ID (`D001`, `D002`, ...), never reused.
- **When** — Where the decision was made: `M001`, `M001/S01`, or `M001/S01/T02`.
- **Scope** — Category tag: `arch`, `pattern`, `library`, `data`, `api`, `scope`, `convention`.
- **Revisable?** — `No`, or `Yes — trigger condition`.

**When to read:** At the start of any planning or research phase.
**When to write:** During discussion (seed from context), during planning (structural choices), during task execution (if an architectural choice was made), and during slice completion (catch-all for missed decisions).

---

## The Phases

Work flows through these phases. Each phase produces a file.

### Phase 1: Discuss (Optional)

**Purpose:** Capture user decisions on gray areas before planning.
**Produces:** `CONTEXT.md` for milestone-level discussion or `S##-CONTEXT.md` for slice-level discussion.
**When to use:** When the scope has ambiguities the user should weigh in on.
**When to skip:** When the user already knows exactly what they want, or told you to just go.

**How to do it manually:**
1. Read the roadmap to understand the scope.
2. Identify 3-5 gray areas — implementation decisions the user cares about.
3. Use `ask_user_questions` to discuss each area, one round at a time. Never fabricate user input; wait for the user's actual response before the next round.
4. Write decisions to the appropriate context file (`CONTEXT.md` or `S##-CONTEXT.md`).
5. Do NOT discuss how to implement — only what the user wants.

### Phase 2: Research (Optional)

**Purpose:** Scout the codebase and relevant docs before planning.
**Produces:** `M###-RESEARCH.md` at milestone level or `S##-RESEARCH.md` at slice level.
**When to use:** When working in unfamiliar code, with unfamiliar libraries, or on complex integrations.
**When to skip:** When the codebase is familiar and the work is straightforward.

**How to do it manually:**
1. Read `CONTEXT.md` and/or `S##-CONTEXT.md` if they exist — know what decisions are locked.
2. Scout relevant code: `rg`, `find`, read key files.
3. Use `resolve_library` / `get_library_docs` if needed.
4. Write findings to `research.md` with these sections:

```markdown
# S01: Slice Title — Research

**Researched:** 2026-03-07
**Domain:** Primary technology/problem domain
**Confidence:** HIGH/MEDIUM/LOW

## Summary
2-3 paragraph executive summary. Primary recommendation.

## Don't Hand-Roll
| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
Problems that look simple but have existing solutions.

## Common Pitfalls
### Pitfall 1: Name
**What goes wrong:** ...
**Why it happens:** ...
**How to avoid:** ...
**Warning signs:** ...

## Relevant Code
Existing files, patterns, reusable assets, integration points.

## Sources
- Context7: /library/id — topics fetched (HIGH confidence)
- WebSearch: finding — verified against docs (MEDIUM confidence)
```

The **Don't Hand-Roll** and **Common Pitfalls** sections prevent the most expensive mistakes.

### Phase 3: Plan

**Purpose:** Decompose work into context-window-sized tasks with must-haves.
**Produces:** `<NN>-<MM>-PLAN.md` with task planning embedded in the slice plan.

**For a milestone (roadmap):**
1. Read `CONTEXT.md`, `M###-RESEARCH.md`, and `.gsd/DECISIONS.md` if they exist.
2. Decompose the vision into 1-10 demoable vertical slices. Prefer one slice for tiny, single-file, or static work unless the request clearly spans independent capabilities.
3. Order by risk (high-risk first to validate feasibility early).
4. Write `ROADMAP.md` with checkboxes, risk levels, dependencies, demo sentences.
5. **Write the boundary map** — for each slice, specify what it produces (functions, types, interfaces, endpoints) and what it consumes from upstream slices. This forces interface thinking before implementation and enables deterministic verification that slices actually connect.

**For a slice (task decomposition):**
1. Read the slice's entry in `ROADMAP.md` **and its boundary map section** — know what interfaces this slice must produce and consume.
2. Read `CONTEXT.md`, `S##-CONTEXT.md`, `M###-RESEARCH.md`, `S##-RESEARCH.md`, and `.gsd/DECISIONS.md` if they exist for this slice.
3. Read summaries from dependency slices (check `depends:[]` in roadmap).
4. Verify that upstream slices' actual outputs match what the boundary map says this slice consumes. If they diverge, update the boundary map.
5. Decompose into 1-7 tasks, each fitting one context window.
6. Each task needs: title, description, steps (3-10), must-haves (observable verification criteria).
7. Must-haves should reference boundary map contracts — e.g. "exports `generateToken()` as specified in boundary map S01→S02".
8. Write `<NN>-<MM>-PLAN.md` with the slice contract and embedded task planning. Do not write standalone task plan files.

### Phase 4: Execute

**Purpose:** Do the work for one task.
**Produces:** Code changes + `[DONE:n]` markers.

**How to do it manually:**
1. Read the active slice's `<NN>-<MM>-PLAN.md` and use the selected task entry as the task plan.
2. Read relevant summaries from prior tasks (for context on what's already built).
3. Execute each step. Mark progress with `[DONE:n]` in responses.
4. If you made an architectural, pattern, or library decision, append it to `.gsd/DECISIONS.md`.
5. If interrupted or context is getting full, write `continue.md` (see below).

### Phase 5: Verify

**Purpose:** Check that the task's must-haves are actually met.
**Produces:** Pass/fail determination.

**Verification ladder — use the strongest tier you can reach:**
1. **Static:** Files exist, exports present, wiring connected, not stubs.
2. **Command:** Tests pass, build succeeds, lint clean, blocked command works.
3. **Behavioral:** Browser flows work, API responses correct.
4. **Human:** Ask the user only when you genuinely can't verify yourself.

**The rule:** "All steps done" is NOT verification. Check the actual outcomes.

**Verification report format** (written into the summary or surfaced on failure):

```
### Observable Truths
| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can sign up | ✓ PASS | POST /api/auth/signup returns 201 |
| 2 | Login returns JWT | ✗ FAIL | Returns 500 — missing env var |

### Artifacts
| File | Expected | Status | Evidence |
|------|----------|--------|---------|
| src/lib/auth.ts | JWT helpers, min 30 lines | ✓ SUBSTANTIVE | 87 lines, exports generateTokens |
| src/lib/email.ts | Email sending | ✗ STUB | 8 lines, console.log instead of sending |

### Key Links
| From | To | Via | Status |
|------|----|----|--------|
| login/route.ts | auth.ts | import generateTokens | ✓ WIRED |
| email.ts | Resend API | resend.emails.send() | ✗ NOT WIRED |

### Anti-Patterns Found
| File | Line | Pattern | Severity |
|------|------|---------|----------|
| src/lib/email.ts | 5 | console.log stub | 🛑 Blocker |
```

When verification finds gaps, include a **Gaps** section with what's missing, impact, and suggested fix.

### Phase 6: Summarize

**Purpose:** Record what happened for downstream tasks.
**Produces:** `S##-T##-SUMMARY.md` in flat-phase projects, and when slice completes, `S##-SUMMARY.md`. Legacy flat `T##-SUMMARY.md` task summaries are still readable.

**Task summary format:**
```markdown
---
id: T01
parent: S01
milestone: M001
provides:
  - What this task built (~5 items)
requires:
  - slice: S00
    provides: What that prior slice built that this task used
affects: [S02, S03]
key_files:
  - path/to/important/file.ts
key_decisions:
  - "Decision made: reasoning"
patterns_established:
  - "Pattern name and where it lives"
drill_down_paths:
  - .gsd/phases/01-foundation/01-01-PLAN.md
duration: 15min
verification_result: pass
completed_at: 2026-03-07T16:00:00Z
---

# T01: Task Title

**Substantive one-liner — NOT "task complete" but what actually shipped**

## What Happened

Concise prose narrative of what was built, why key decisions were made,
and what matters for future work.

## Deviations
What differed from the plan and why (or "None").

## Files Created/Modified
- `path/to/file.ts` — What it does
```

The one-liner must be substantive: "JWT auth with refresh rotation using jose" not "Authentication implemented."

When `key_files` or `key_decisions` are empty, render them as empty YAML lists:

```yaml
key_files: []
key_decisions: []
```

**Slice summary:** Written when all tasks in a slice complete. Compresses all task summaries. Includes `drill_down_paths` to each task summary. During slice completion, review task summaries for `key_decisions` and ensure any significant ones are captured in `.gsd/DECISIONS.md`.

**Milestone summary:** Updated each time a slice completes. Compresses all slice summaries. This is what gets injected into later slice planning instead of loading many individual summaries.

### Phase 7: Advance

**Purpose:** Mark work done and move to the next thing.

**After a task completes:**
1. Persist completion through the DB-backed Task completion path; it refreshes the `<NN>-<MM>-PLAN.md` checkbox projection.
2. Check if there's a next task in the slice → execute it.
3. If the slice is complete → run the Slice completion path.

**After a slice completes:**
1. Persist Slice completion through `gsd_slice_complete`; it records the authoritative state and renders `S##-SUMMARY.md`, `S##-UAT.md`, ROADMAP, and STATE projections.
2. Continue to the next slice immediately. UAT can run after Slice completion; automatic Milestone closure requires current source-bound validation and any required UAT evidence.
3. If UAT is missing or non-PASS at Milestone closeout, run `/gsd dispatch uat`, request a Slice-specific UAT rerun when needed, or create remediation work with `/gsd dispatch reassess`.
4. When every Slice is terminal, validate through `gsd_validate_milestone` and complete through `gsd_complete_milestone`; the latter commits the Milestone lifecycle and renders `M###-SUMMARY.md`.

---

## Continue-Here Protocol

**When to write `continue.md`:**
- You're about to lose context (compaction, session end, Ctrl+C).
- The current task isn't done yet.
- You want to pause and come back later.

**What to capture:**
```markdown
---
milestone: M001
slice: S01
task: T02
step: 3
total_steps: 7
saved_at: 2026-03-07T15:30:00Z
---

## Completed Work
- What's already done in this task and prior tasks in the slice.

## Remaining Work
- What steps remain, with enough detail to resume.

## Decisions Made
- Key decisions and WHY (so next session doesn't re-debate).

## Context
The "vibe" — what you were thinking, what's tricky, what to watch out for.

## Next Action
The EXACT first thing to do when resuming. Not vague. Specific.
```

**How to resume:**
1. Read `continue.md`.
2. Delete `continue.md` (it's consumed, not permanent).
3. Pick up from "Next Action".

---

## State Management

### `STATE.md` is a derived cache

It is NOT the source of truth. It's a convenience dashboard.

**Authority and review surfaces:**
- The project database owns runtime hierarchy, lifecycle, validation, and queue state.
- `ROADMAP.md` and `<NN>-<MM>-PLAN.md` project planned work and current checkbox status for review.
- `S##-T##-SUMMARY.md` records the readable Task outcome in flat-phase projects (legacy `T##-SUMMARY.md` is still readable).
- `S##-SUMMARY.md` and `M###-SUMMARY.md` project compressed Slice and Milestone outcomes.

**Refresh `STATE.md` through the workflow** after every significant action so it projects:
- Active milestone/slice/task
- Recent decisions (last 3-5)
- Blockers
- Next action (most important — this is what a fresh session reads first)

### Reconciliation

If files disagree with the database, keep database authority and rebuild the
Markdown projections. Do not infer lifecycle state from a checked box or a
missing summary. Use explicit recovery/import only when the database itself is
lost or invalid and the project satisfies the recovery command's adoption
guards.

Other stale-file cleanup remains mechanical:

- Continue file exists for completed task → delete continue file
- State points to nonexistent slice/task → rebuild the STATE projection from the database

---

## Git Strategy: Sequential Commits with Optional Milestone Isolation

**Principle:** GSD keeps work atomic and recoverable. By default, work happens on the current branch. If `git.isolation` is set to `worktree` or `branch`, a milestone branch is used and merged back to the recorded integration branch when the milestone completes. The user never runs a git command — the agent handles everything.

### Isolation Modes

| Mode | Where work happens | Branch behavior |
|------|--------------------|-----------------|
| `none` (default) | Project root | Current branch, no isolation branch |
| `worktree` | `.gsd/worktrees/<MID>/` | `milestone/<MID>` branch in a git worktree |
| `branch` | Project root | `milestone/<MID>` branch checked out in place |

In all modes, slices and tasks commit sequentially on the active branch; there are no per-slice branches. The integration branch is captured when the milestone starts, so stale `git.main_branch` preferences do not redirect merge-back.

### Milestone Lifecycle

1. **Milestone starts** → capture the current integration branch.
2. **Optional isolation** → create `milestone/M001` only when `git.isolation` is `worktree` or `branch`.
3. **Per-task commits** — atomic, descriptive, bisectable, and published only after execute-task verification passes.
4. **Slice completes** → write slice summary, UAT script, roadmap checkbox, and milestone summary.
5. **Milestone completes** → if isolated, squash-merge the milestone branch back to the captured integration branch and clean up the worktree/branch.

### What History Looks Like

```
feat: core type definitions
feat: markdown parser for plan files
fix: handle empty state rebuild
```

In `none` mode these commits land directly on the current branch. In isolated modes they land on `milestone/<MID>` and are squashed back at milestone completion.

Execute-task closeout is fail-closed: the system writes verification evidence first, defers the task commit or snapshot until verification passes, and pauses instead of publishing changes when verification fails or cannot complete.

### Commit Conventions

| When | Format | Example |
|------|--------|---------|
| Task completed | `{type}: <one-liner from summary>` | Type inferred from title (`feat`, `fix`, `test`, etc.) |
| State rebuild | `chore: auto-commit after state-rebuild` | Bookkeeping only |
| Milestone squash | `{type}: <milestone title>` | Type inferred from title |

The system reads the task summary after execution and builds a meaningful commit message:
- **Subject**: `{type}: {one-liner}` — the one-liner from the summary frontmatter, sanitized to one line
- **Type**: Inferred from the task title and one-liner (`feat`, `fix`, `test`, `refactor`, `docs`, `perf`, `chore`)
- **Body**: Key files from the summary frontmatter (up to 8 files listed)
- **Trailers**: `GSD-Task: S##/T##`; if GitHub sync linked an issue, `Resolves #N`

Commit types: `feat`, `fix`, `test`, `refactor`, `docs`, `perf`, `chore`

### Rollback

| Problem | Fix |
|---------|-----|
| Bad task | Revert the task commit on the active branch |
| Bad milestone squash | Revert the squash commit on the integration branch |
| UAT missing or non-PASS at closeout | Run `/gsd dispatch uat`, request a slice-specific UAT rerun when needed, or create remediation work with `/gsd dispatch reassess` |
| UAT failure after merge | Create follow-up fix tasks in the current or next milestone |

---

## Summary Injection for Downstream Tasks

When planning or executing a task, load relevant prior context:

1. Check the current slice's `depends:[]` in `ROADMAP.md`.
2. Load summaries from those dependency slices.
3. Start with the **highest available level** — milestone `M###-SUMMARY.md` first.
4. Only drill down to slice/task summaries if you need specific detail.
5. Stay within **~2500 tokens** of total injected summary context.
6. If the dependency chain is too large, drop the oldest/least-relevant summaries first.

**Aim for:**
- ~5 provides per summary
- ~10 key_files per summary
- ~5 key_decisions per summary
- ~3 patterns_established per summary

These are soft caps — exceed them when genuinely needed, but don't let summaries become essays.

---

## Project-Specific Context

This methodology doc is generic. Project-specific guidance belongs in the milestone and slice context files:

- **`.gsd/phases/<NN-slug>/<NN>-CONTEXT.md`** — milestone-level architecture decisions, reference file paths, and implementation constraints
- **`.gsd/phases/<NN-slug>/<NN>-<MM>-CONTEXT.md`** — slice-level decisions, edge cases, and narrow implementation guidance when present

**Always read the active milestone's `<NN>-CONTEXT.md` before starting implementation work.** If the active slice also has `<NN>-<MM>-CONTEXT.md`, read that too. These files tell you what decisions are locked, what files to reference, and how to verify your work in this specific project.

---

## Checklist for a Fresh Session

1. Read `.gsd/STATE.md` — what's the next action?
2. Check for `continue.md` in the active slice — is there interrupted work?
3. If resuming: read `continue.md`, delete it, pick up from "Next Action".
4. If starting fresh: read the active slice's `<NN>-<MM>-PLAN.md`, find the next incomplete task.
5. If in a planning or research phase, read `.gsd/DECISIONS.md` — respect existing decisions.
6. Read relevant summaries from prior tasks/slices for context.
7. Do the work.
8. Verify the must-haves.
9. Write the summary.
10. Mark done, update `STATE.md`, advance.
11. If context is getting full or you're done for now: write `continue.md` if mid-task, or update `STATE.md` with next action if between tasks.

## When Context Gets Large

If you sense context pressure (many files read, long execution, lots of tool output):

1. **If mid-task:** Write `continue.md` with exact resume state. Tell the user: "Context is getting full. I've saved progress to continue.md. Start a new session and run `/gsd` to pick up where you left off, or `/gsd auto` to resume in auto-execution mode."
2. **If between tasks:** Just update `STATE.md` with the next action. No continue file needed — the next session will read STATE.md and pick up the next task cleanly.
3. **Don't fight it.** The whole system is designed for this. A fresh session with the right files loaded is better than a stale session with degraded reasoning.
