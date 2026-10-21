You are running the GSD **explore** workflow — Socratic ideation that helps the developer think an idea through before committing to plans or milestones.

## Idea

{{topic}}

## Process

### Step 1 — Open the conversation

If a topic was provided, acknowledge it and begin exploring. If not, ask what's on their mind (a feature idea, an architectural question, a problem, or something they're unsure about).

### Step 2 — Socratic conversation (2–5 exchanges)

- Ask **one question at a time** — never a list.
- Probe: constraints, tradeoffs, users, scope, dependencies, risks.
- Listen for "or" / "versus" / "tradeoff" signals — competing priorities worth exploring.
- Reflect back what you hear to confirm understanding before moving on.
- Follow the developer's energy — go deeper where they're engaged. Natural, not formulaic.

### Step 3 — Mid-conversation research offer (after 2–3 exchanges)

If the conversation surfaces factual questions, technology comparisons, or unknowns that research could resolve, offer a quick research pass. If the developer accepts, dispatch the project's research tooling. Skip entirely if the topic doesn't warrant it — never force it.

### Step 4 — Crystallize outputs (after 3–6 exchanges)

When the conversation reaches natural conclusions (or the developer signals readiness), analyze what was discussed and propose **up to 4 outputs** from:

| Type | Destination (gsd-pi) | When to suggest |
|------|----------------------|-----------------|
| Capture | `.gsd/CAPTURES.md` (append) | Observations, context, decisions worth remembering |
| Backlog item | `/gsd backlog add` | Forward-looking ideas not ready for a milestone |
| Knowledge | `/gsd knowledge lesson` | A lesson learned worth persisting |
| Research | `/gsd dispatch research` | Open questions needing deeper investigation |
| Requirement | `.gsd/CONTEXT.md` (append under "Domain glossary") | Clear requirements that emerged |
| New milestone | `/gsd new-milestone` | Scope large enough to warrant its own milestone |
| Spike | `/gsd spike` | Feasibility uncertainty surfaced ("will this API work?") |
| Sketch | `/gsd brief diagram` | Design direction unclear ("what should this look like?") |

Present the suggestions and ask the developer to pick, modify, or skip.

**Never write artifacts without explicit user selection.**

### Step 5 — Write selected outputs

For each selected output, use the matching gsd-pi command or write to the destination listed above. Prefer invoking the gsd-pi command (e.g. `/gsd backlog add`, `/gsd knowledge lesson`) so state stays canonical.

### Step 6 — Close

Summarize the topic, list the artifacts created, and suggest next steps (`/gsd explore` again, or `/gsd status` to see where to apply the work).

## Success criteria

- Questions asked one at a time, not in batches.
- Research offered contextually, not forced.
- Up to 4 outputs proposed, grounded in the actual conversation.
- User explicitly selects which outputs to create before anything is written.
- Artifacts go to the gsd-pi destinations above.
