# Headless Milestone Creation

You are creating a GSD milestone from a provided specification document. This is a **headless** flow: do NOT ask the user questions. Wherever the interactive flow would ask, make your best judgment and document it as an assumption.

## Provided Specification

{{seedContext}}

## Reflection Step

Summarize your concrete understanding of the specification:

1. What is being built, in your own words.
2. Honest size read: rough milestone count and first-milestone slice count.
3. Scope honesty: "Here's what I'm reading from the spec:" plus major capability bullets.
4. Ambiguities, gaps, or vague areas.

Print this reflection in chat. Do not skip this step.

## Vision Mapping

Decide the approach based on the actual scope:

**If the work spans multiple milestones:** map the landscape:

1. Propose milestone names, one-line intents, and rough dependencies.
2. Print this as the working milestone sequence.

**If the work fits in a single milestone:** Proceed directly to investigation.

**Anti-reduction rule:** If the spec describes a big vision, plan it. Do not reduce scope; phase complex/risky work into later milestones. Sequence intelligently instead of shrinking ambition.

## Mandatory Investigation

Investigate before making decisions:

1. Scout relevant code with `ls`, `find`, `rg`, or `scout`.
2. Check mentioned tech with `resolve_library` / `get_library_docs`.
3. Use `search-the-web`, `fetch_page`, or `search_and_read` only for current external facts.

Budget searches across investigation and focused research. Prefer library docs and one-shot `search_and_read`; avoid repeat queries. Decisions must reflect codebase and ecosystem evidence.

## Autonomous Decision-Making

For every ambiguous, vague, or silent area, apply the depth checklist, make the smallest sound judgment from spec intent, codebase patterns, domain conventions, and investigation findings, and Document every assumption in CONTEXT.md under "Assumptions": what the spec said or omitted, what you decided, and why.

### Depth Checklist

Resolve all of these from the spec and investigation before writing artifacts:

- [ ] **What is being built** — concrete enough to explain to a stranger
- [ ] **Why it needs to exist** — the problem it solves or the desire it fulfills
- [ ] **Who it's for** — even if just the spec author
- [ ] **What "done" looks like** — observable outcomes
- [ ] **The biggest technical unknowns / risks** — what could fail, what hasn't been proven
- [ ] **What external systems/services this touches** — APIs, databases, third-party services, hardware

If the spec leaves any of these unresolved, make your best-judgment call and document it.

## Depth Verification

Print a structured depth summary in chat covering:

- What you understood the spec to describe
- Key technical findings from investigation
- Assumptions you made and why
- Areas where you're least confident

This is the audit trail. Print it.

## Focused Research

Do focused research before roadmap creation. Research is advisory, not auto-binding. Use the spec plus investigation to identify table stakes, implied domain-standard behavior, likely omissions, scope traps, and differentiators. For multi-milestone visions, research the full landscape because findings may affect milestone sequencing. Apply judgment instead of asking; include aligned findings, defer or mark tangential expansion out of scope, and document reasoning.

## Capability Contract

Before writing a roadmap, produce `.gsd/REQUIREMENTS.md`.

Use it as the project's explicit capability contract.

Requirements must be organized into Active, Validated, Deferred, Out of Scope, and Traceability.

Each requirement includes stable ID (`R###`), title, class, status, description, why it matters, source (`spec`, `inferred`, `research`, or `execution`), primary owning slice, supporting slices, validation status, and notes.

Rules:

- Keep requirements capability-oriented, not a feature inventory
- Every Active requirement must either be mapped to a roadmap owner, explicitly deferred, blocked with reason, or moved out of scope
- Product-facing work should capture launchability, primary user loop, continuity, and failure visibility when relevant
- Later milestones may have provisional ownership, but the first planned milestone should map requirements to concrete slices wherever possible

For multi-milestone projects, requirements span the full vision. Later milestones get provisional ownership; milestones sequence scope, not shrink it.

**Print the requirements in chat before writing the roadmap.** Print a markdown table with columns: ID, Title, Status, Owner, Source. Group by status (Active, Deferred, Out of Scope).

## Scope Assessment

Confirm the reflection size estimate still holds. If investigation/research changes scope significantly, adjust milestone and slice counts.

## Output Phase

### Roadmap Preview

Before writing files, **print the planned roadmap in chat**: markdown table with Slice, Title, Risk, Depends, Demo. Below it, print milestone definition of done bullets. This is the user's TUI audit trail; do not skip it.

### Naming Convention

Directories use bare IDs. Files use ID-SUFFIX format. Titles live inside content, not names. Milestone dir: `.gsd/milestones/{{milestoneId}}/`; files: `{{milestoneId}}-CONTEXT.md`, `{{milestoneId}}-ROADMAP.md`; slice dirs: `S01/`, `S02/`, etc.

### Single Milestone

In a single pass:

1. `mkdir -p .gsd/milestones/{{milestoneId}}/slices`
2. Call `gsd_summary_save` with `artifact_type: "PROJECT"` and full Project template content. The tool persists the DB-backed PROJECT artifact and renders `.gsd/PROJECT.md`. Describe what the project is, its current state, and list the milestone sequence.
3. Persist requirements with `gsd_requirement_save` or `gsd_requirement_update`, then call `gsd_summary_save` with `artifact_type: "REQUIREMENTS"` so the tool renders `.gsd/REQUIREMENTS.md` from DB rows. Confirm states, ownership, and traceability before roadmap creation.

**Depth-Preservation Guidance for context.md:** Preserve the specification's exact terminology, emphasis, and framing. Do not flatten domain-specific language into generics. CONTEXT.md is downstream agents' only window into this spec.

4. Call `gsd_summary_save` with `milestone_id: {{milestoneId}}`, `artifact_type: "CONTEXT"`, and full context markdown as `content`; the tool writes `{{contextPath}}` and persists to DB. A direct file write does not register the context. Use the **Context** template. Preserve risks, unknowns, codebase constraints, integration points, relevant requirements, and an "Assumptions" section.

**gsd_plan_milestone tool shape (NON-BYPASSABLE):** NEVER call `gsd_plan_milestone` with only `milestoneId` and `sliceId` — that is the `gsd_plan_slice` tool. Required fields: `milestoneId`, `title`, `vision`, `slices[]` (each slice needs `sliceId`, `title`, `risk`, `depends`, `demo`, `goal`). Build `slices[]` from the Roadmap Preview table you printed in chat.

5. Call `gsd_plan_milestone` to create demoable vertical slices with risk, depends, demo, proof strategy, verification classes, definition of done, requirement coverage, and boundary map. If crossing runtime boundaries, include a final end-to-end integration slice. Use the **Roadmap** output template below.
6. For each architectural or pattern decision, call `gsd_decision_save` — the tool auto-assigns IDs and regenerates `.gsd/DECISIONS.md` automatically.
7. {{commitInstruction}}

### Ready-phrase pre-condition (NON-BYPASSABLE)

Before emitting the ready phrase, verify in the CURRENT turn that you have:

- [ ] Called `gsd_summary_save` for the PROJECT artifact (step 2)
- [ ] Persisted requirements and called `gsd_summary_save` for the REQUIREMENTS artifact (step 3)
- [ ] Called `gsd_summary_save` for the CONTEXT artifact at `{{contextPath}}` (step 4)
- [ ] Called `gsd_plan_milestone` (step 5)

If ANY box is unchecked, **STOP**. Do NOT emit the ready phrase. Emit the missing tool calls in this same turn. The system detects missing artifacts and will reject premature ready signals — you will be asked again and retries are capped.

Do not announce the ready phrase as something you are "about to" do. The ready phrase is a post-write signal, not an intent signal.

After completing steps 1–7 above, end with this concise user-facing handoff:

```
Milestone {{milestoneId}} ready.

Next steps:
- Run `/gsd auto` to start execution if it does not begin automatically.
- Use `/gsd status` or `/gsd visualize` to inspect the roadmap.
- Use `/gsd notifications` to review or configure delivery alerts.
```

### Multi-Milestone

#### Phase 1: Shared artifacts

1. For each milestone, call `gsd_milestone_generate_id`; never invent IDs. Then `mkdir -p .gsd/milestones/<ID>/slices`.
2. Call `gsd_summary_save` with `artifact_type: "PROJECT"` and full Project template content so the tool persists the DB-backed PROJECT artifact and renders `.gsd/PROJECT.md`.
3. Persist requirements with `gsd_requirement_save` or `gsd_requirement_update`, then call `gsd_summary_save` with `artifact_type: "REQUIREMENTS"` so the tool renders `.gsd/REQUIREMENTS.md` from DB rows. Capture Active, Deferred, Out of Scope, and any already Validated requirements. Later milestones may have provisional ownership where slice plans do not exist yet.
4. For any architectural or pattern decisions, call `gsd_decision_save` — the tool auto-assigns IDs and regenerates `.gsd/DECISIONS.md` automatically.

#### Phase 2: Primary milestone

5. Call `gsd_summary_save` with the primary milestone's `milestone_id` (the first in sequence), `artifact_type: "CONTEXT"`, and full context markdown as `content`; the tool writes `CONTEXT.md` and persists to DB. A direct file write does not register the context. Include an "Assumptions" section.

**gsd_plan_milestone tool shape (NON-BYPASSABLE):** NEVER call `gsd_plan_milestone` with only `milestoneId` and `sliceId` — that is the `gsd_plan_slice` tool. Required fields: `milestoneId`, `title`, `vision`, `slices[]` (each slice needs `sliceId`, `title`, `risk`, `depends`, `demo`, `goal`). Build `slices[]` from the Roadmap Preview table you printed in chat.

6. Call `gsd_plan_milestone` for **only the primary milestone**; detail-planning later milestones now is waste because the codebase will change. Include requirement coverage and definition of done.

#### MANDATORY: Milestone dependencies

For every milestone that depends on others, call `gsd_milestone_set_dependencies` with its `milestoneId` and the full `dependsOn` list (for example `dependsOn: ["M001", "M002"]`). The database is the only source of execution order; without this call, milestones may run out of order or in parallel. Do NOT put `depends_on` in CONTEXT.md, QUEUE.md or PROJECT.md; those files are rendered from the database and are never read back.

#### Phase 3: Remaining milestones

For each remaining milestone, in dependency order, autonomously decide the readiness mode:

- **Write full context** — if the spec provides enough detail and investigation confirms feasibility. Save full context with `gsd_summary_save` (that milestone's `milestone_id`, `artifact_type: "CONTEXT"`), with technical assumptions verified against actual code.
- **Write draft for later** — if the spec has seed material but the milestone needs its own investigation/research in a future session. Call `gsd_summary_save` with that milestone's `milestone_id` and `artifact_type: "CONTEXT-DRAFT"`, capturing seed material, key ideas, provisional scope, and open questions. **Downstream:** Auto-mode pauses at this milestone and prompts the user to discuss.
- **Just queue it** — if the milestone is identified but the spec provides no actionable detail. No context file written. **Downstream:** Auto-mode pauses and starts a full discussion from scratch.

**Default to writing full context** when the spec is detailed enough, draft when mentioned but vague, and queue when implied but not described.

**Technical Assumption Verification is still MANDATORY** for full-context milestones:

1. Read actual code for every referenced file or module.
2. Check stale assumptions against current behavior.
3. Print findings before writing each milestone's CONTEXT.md.

Each full or draft context must let a future agent understand intent, constraints, dependencies, unlocks, and done criteria without this session.

#### Milestone Gate Tracking (MANDATORY for multi-milestone)

Every readiness decision is a database row. Record it immediately after the decision, not at the end:

- **Write full context** — the `gsd_summary_save` call with `artifact_type: "CONTEXT"` is the record.
- **Write draft for later** — the `gsd_summary_save` call with `artifact_type: "CONTEXT-DRAFT"` is the record.
- **Just queue it** — call `gsd_checkpoint_save` with that milestone's `milestoneId`, `kind: "handoff"`, `confirmedContext` (what is known about the milestone and that it is queued without discussion), and `nextAction` (for example "Discuss M003 from scratch before planning").

The system reads these rows before auto-mode and BLOCKS auto-start while a milestone of this discussion has no record. Do NOT write `.gsd/DISCUSSION-MANIFEST.json`; it is not read.

#### Phase 4: Finalize

7. {{multiMilestoneCommitInstruction}}

### Ready-phrase pre-condition (NON-BYPASSABLE)

Before emitting the ready phrase, verify in the CURRENT turn that you have:

- [ ] Called `gsd_summary_save` for the PROJECT artifact
- [ ] Persisted requirements and called `gsd_summary_save` for the REQUIREMENTS artifact
- [ ] Called `gsd_summary_save` for the primary milestone CONTEXT artifact
- [ ] Called `gsd_plan_milestone` for the primary milestone
- [ ] Recorded a readiness decision for every remaining milestone: CONTEXT, CONTEXT-DRAFT, or `gsd_checkpoint_save`

If ANY box is unchecked, **STOP**. Do NOT emit the ready phrase. Emit the missing tool calls in this same turn. The system detects missing artifacts and will reject premature ready signals — you will be asked again and retries are capped.

Do not announce the ready phrase as something you are "about to" do. The ready phrase is a post-write signal, not an intent signal.

After completing every step above, end with this concise user-facing handoff:

```
Milestone {{milestoneId}} ready.

Next steps:
- Run `/gsd auto` to start execution if it does not begin automatically.
- Use `/gsd status` or `/gsd visualize` to inspect the roadmap.
- Use `/gsd notifications` to review or configure delivery alerts.
```

## Critical Rules

- **DO NOT ask the user any questions** — this is headless mode. Make judgment calls and document them.
- **Preserve the specification's terminology** — don't paraphrase domain-specific language
- **Document assumptions** — every judgment call gets noted in CONTEXT.md under "Assumptions" with reasoning
- **Investigate thoroughly** — scout codebase, check library docs, and web search with the same rigor as interactive mode.
- **Do focused research** — identify table stakes, domain standards, omissions, and scope traps.
- **Use proper tools** — `gsd_plan_milestone` for roadmaps, `gsd_decision_save` for decisions, `gsd_milestone_generate_id` for IDs
- **Print artifacts in chat** — requirements table, roadmap preview, depth summary. The TUI scrollback is the user's audit trail.
- **Use `gsd_milestone_set_dependencies`** for multi-milestone sequences
- **Anti-reduction rule** — if the spec describes a big vision, plan it. Phase complexity; do not cut it.
- **Naming convention** — always use `gsd_milestone_generate_id` for IDs. Directories use bare IDs, files use ID-SUFFIX format.
- **End with "Milestone {{milestoneId}} ready."** — this triggers auto-start detection

{{inlinedTemplates}}
