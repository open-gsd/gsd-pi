**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory. For `.gsd` files in this prompt, use absolute paths rooted at `{{workingDirectory}}` instead of discovering them with Glob.

Configure project workflow preferences. This stage runs ONCE per project, early in deep-mode bootstrap, before `discuss-project`. It applies a small set of recommended workflow defaults and persists them to the YAML frontmatter of `.gsd/PREFERENCES.md` (the same file the runtime reads its preferences from).

This is a **default-writing** stage — do NOT ask the user questions. Write the recommended defaults, then end. No follow-ups, no research, no opinion.

---

## Stage Banner

Print this banner verbatim in chat as your first action:

• WORKFLOW PREFERENCES

Then say: "Quick setup — applying recommended workflow defaults."

---

## Default Set

Use these recommended defaults without asking:

- `uat_dispatch: true` — verification runs automatically; failures pause execution

Note: the project research decision is a database record, not a preference key. Do not write a `research` key into `PREFERENCES.md`; `gsd_research_decision_save` records it later.

---

## Output

Apply the defaults:

1. Read `{{workingDirectory}}/.gsd/PREFERENCES.md` if it exists. The file is YAML frontmatter (between `---` lines) followed by an optional markdown body. Parse the existing frontmatter so you can preserve unrelated keys (e.g. `planning_depth`).
2. Merge the defaults into the frontmatter under these keys, preserving any existing explicit value:
   - top-level `uat_dispatch: true`
3. Write `{{workingDirectory}}/.gsd/PREFERENCES.md` back, changing ONLY the keys listed above. Edit the frontmatter surgically: keep every existing key, value, and `#` comment exactly as written, and keep the original body unchanged. Frontmatter delimiters are exactly `---` on their own lines.
4. Print a concise summary in chat: each key on its own line, format `key: value`. Include `uat_dispatch`.
5. Say exactly: `"Workflow preferences saved."` — nothing else.

Do NOT write to `.gsd/config.json`; runtime preferences load from `PREFERENCES.md`.

---

## Critical rules

- Do NOT ask any questions. Defaults only, write file, done.
- Do NOT call `ask_user_questions`, `AskUserQuestion`, or any other interactive user-input tool in this stage.
- Do NOT change any keys other than the frontmatter keys specified. The research decision is recorded in the database by `gsd_research_decision_save`, NOT in `PREFERENCES.md`.
- Preserve existing explicit values for `uat_dispatch`; only fill the value if it is missing.
