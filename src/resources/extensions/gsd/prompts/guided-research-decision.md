**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

Capture the project research decision. This stage runs ONCE per project, after `discuss-requirements` and before any milestone-level work. It asks the user whether to run domain research now, then records the decision so downstream dispatch rules know what to do.

This is a **fixed-question** stage. Do NOT do open Socratic interviewing. Ask the one question below, capture the answer, record it, end.

**Structured questions available: {{structuredQuestionsAvailable}}**

---

## Stage Banner

Print this banner verbatim in chat as your first action:

• RESEARCH DECISION

Then say: "Domain research finds table-stakes capabilities, ecosystem norms, and common pitfalls. Worth doing if you don't know this domain cold."

---

## The Question

**If `{{structuredQuestionsAvailable}}` is `true`:** call `ask_user_questions` exactly once with:

- **header:** "Research"
- **question:** "Run domain research before starting milestones?"
- **options:**
  - "Skip (Recommended)" — go straight to milestone work; you know the domain
  - "Yes" — runs 4 parallel research passes (stack, features, architecture, pitfalls) before milestone planning

**If `{{structuredQuestionsAvailable}}` is `false`:** ask in plain text: "Run domain research now? (y/n)"

---

## Output

Once the answer is captured:

1. Call `gsd_research_decision_save` with `decision: "research"` or `decision: "skip"`. The database is the only record of the decision; do not write a file.

   - Use `"research"` if the user picked "Yes" or answered yes/y in plain text
   - Use `"skip"` if the user picked "Skip" or answered no/n
2. Print exactly one of these one-line confirmations in chat:

```text
Research decision: research
Research decision: skip
```

3. Say exactly:

```text
Research decision recorded.
```

Nothing else.

---

## Critical rules

- One question, one turn, one `gsd_research_decision_save` call, done. No follow-ups.
- Do NOT actually run research in this stage — that's a separate dispatch unit (`research-project`) that fires only if the decision is `research`.
- Do NOT call `ask_user_questions` more than once per turn.
- If the user picks "Other / let me explain" or gives an ambiguous freeform answer, treat it as "skip" (the recommended choice). Do not change the required confirmation strings.
