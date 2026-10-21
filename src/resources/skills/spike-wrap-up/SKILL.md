---
name: spike-wrap-up
description: Package findings from a completed spike into a durable project-local skill that auto-loads on future similar work. Reads the latest `.gsd/workflows/spikes/` dir, interviews the user on what's reusable, then writes `.agents/skills/<name>/SKILL.md`. Use when asked to "wrap up the spike", "package this as a skill", "make this reusable", "turn findings into a skill", or at the synthesize phase of `/gsd start spike`.
---

<objective>
Convert the output of a research spike (`SCOPE.md`, `research/*.md`, `RECOMMENDATION.md`) into a project-local skill under `.agents/skills/` so that the next time a similar task comes up, the agent loads the skill automatically. This is how throwaway spikes become durable capital.
</objective>

<context>
GSD's spike workflow (`src/resources/extensions/gsd/workflow-templates/spike.md`) produces documents in `.gsd/workflows/spikes/<slug>/`. Those documents are useful once and then forgotten unless something packages them for reuse.

GSD already watches `.agents/skills/` (and `.claude/skills/` as a legacy compat path) at both user and project levels — see `src/resources/extensions/gsd/skill-discovery.ts`. Any skill written there is picked up on the next session without further wiring. This skill is the bridge from "spike done" to "skill available."

Invocation points:
- End of Phase 3 (synthesize) in `/gsd start spike` — prompt suggests running this skill
- User has a spike directory and wants to harvest it
- Pre-existing `RECOMMENDATION.md` that deserves a permanent home
</context>

<core_principle>
**NOT EVERY SPIKE DESERVES A SKILL.** If the recommendation was "don't do X," there may be no reusable guidance. Ask the user first; exit without writing if the answer is no.

**PROJECT-LOCAL, NOT USER-GLOBAL.** Write to `.agents/skills/` in the project root, not `~/.agents/skills/`. The skill encodes project-specific choices that should not leak into unrelated projects.

**DESCRIPTION IS THE DISCOVERABILITY SIGNAL.** The `description` field in frontmatter is the primary signal the agent uses to judge relevance and decide whether to load the skill — it is a heuristic, not a deterministic trigger. Write it as keywords the future agent will plausibly encounter, not a summary.
</core_principle>

<process>

## Step 1: Find the spike

1. List directories under `.gsd/workflows/spikes/` — sort by mtime, newest first.
2. If multiple exist, ask the user which to wrap up. Default: the most recent.
3. If none exist, tell the user and stop. This skill requires a completed spike.

Read the core files:
- `<spike>/SCOPE.md` — the question that was asked
- `<spike>/research/*.md` — the angles investigated
- `<spike>/RECOMMENDATION.md` — the conclusion

## Step 2: Decide if it deserves a skill

Ask the user — one round:

1. **Is the conclusion reusable on future work, or was it specific to one decision?**
   Recommendation: packaging is worth it if the findings include repeatable guidance (how to evaluate X, a pattern to follow, a library's gotchas). If the spike ended in "we chose library Y, end of story," it probably belongs in `.gsd/DECISIONS.md` instead.

2. **What is the trigger?** When should a future agent load this skill? Give concrete keywords — "adding a new webhook handler", "writing a SQL migration", etc.

If the user says it's not worth packaging, offer instead to append a summary to `.gsd/DECISIONS.md` and stop.

## Step 3: Design the skill

Before writing, sketch in the conversation:

- **Name:** kebab-case, short, unambiguous. Prefix with the project's domain when helpful (`auth-webhook-setup`, not `webhook`).
- **Description (frontmatter):** one sentence, 120–1024 chars, keyword-rich. Must state when the agent should load it. Rewrite at least twice before settling.
- **Objective:** one paragraph — what the skill does and what artifact it produces.
- **Process:** numbered steps. Reference the spike's findings as the source, but the skill itself should be executable without reading the spike.
- **Anti-patterns:** gotchas the spike surfaced — things that looked right but didn't work.
- **Success criteria:** checklist the skill's user can confirm against.

Show this sketch to the user. One round of feedback. Iterate.

## Step 4: Write the skill

Write to `.agents/skills/<name>/SKILL.md` (create the directory). Match the frontmatter + XML-tag structure used by other bundled skills — see `src/resources/skills/review/SKILL.md` for the canonical shape.

Minimum structure:

```markdown
---
name: <skill-name>
description: <one sentence with trigger keywords>
---

<objective>
<one paragraph — what this skill does>
</objective>

<context>
<when to invoke, what produced it (cite the spike), assumptions>
</context>

<process>
## Step 1: <action>
<instructions>

## Step 2: <action>
<instructions>
</process>

<anti_patterns>
- <gotcha from the spike>
- <another gotcha>
</anti_patterns>

<success_criteria>
- [ ] <observable confirmation>
- [ ] <observable confirmation>
</success_criteria>
```

If the spike produced a reusable template (a config file, a starter script), copy it into `.agents/skills/<name>/templates/` or `.agents/skills/<name>/references/` and reference it from the skill body.

## Step 5: Archive the spike, link from the skill

1. In the new SKILL.md, reference the originating spike: "Derived from `.gsd/workflows/spikes/<slug>/RECOMMENDATION.md` (dated YYYY-MM-DD)."
2. Do NOT delete the spike directory — spikes are research artifacts and retain value for forensics.
3. Append one line to `.gsd/DECISIONS.md`: `- YYYY-MM-DD [spike]: packaged "<slug>" findings as skill <name>`.

## Step 6: Confirm pickup

Tell the user the skill will be surfaced on the next session via `skill-discovery.ts`. If they want to use it immediately, they can `Read .agents/skills/<name>/SKILL.md` now.

</process>

<anti_patterns>

- **Writing to `~/.claude/skills/` or `.claude/skills/`.** These are legacy Claude Code compatibility paths. Write project skills to `.agents/skills/` in the project root instead.
- **Verbose frontmatter description.** The description is an index entry, not a tutorial. Keywords over prose.
- **Packaging every spike.** If the outcome was "we decided X once," append to DECISIONS.md and move on.
- **Copy-pasting the spike verbatim into the skill.** The spike is research; the skill is executable guidance. Re-author.
- **Deleting the source spike.** Research artifacts should persist.

</anti_patterns>

<success_criteria>

- [ ] A new `.agents/skills/<name>/SKILL.md` exists with well-formed frontmatter.
- [ ] The `description` field uses keywords that will plausibly match future agent work.
- [ ] The skill body is executable on its own without re-reading the originating spike.
- [ ] The originating spike is referenced from the skill.
- [ ] `.gsd/DECISIONS.md` has a one-line entry recording the packaging.
- [ ] The spike directory itself is untouched.

</success_criteria>
