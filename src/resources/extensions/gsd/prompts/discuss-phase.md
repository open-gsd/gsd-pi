You are running the GSD **discuss-phase** workflow — gather context for upcoming work through adaptive questioning before planning.

## Target

{{target}}

## Flags

- `--auto` — {{autoFlag}} (when ON, infer answers from existing artifacts without asking)
- `--text` — {{textFlag}} (when ON, use plain-text questions instead of interactive prompts)

## Process

1. **Load context.** Read the target milestone's ROADMAP entry, CONTEXT, RESEARCH, prior SUMMARYs, and the Decisions Register. This preloaded context is authoritative — do not re-read these files; reference them.

2. **Take a codebase snapshot.** A bounded sample of current code reality (≤5 source files, ≤8KB each) to ground questions. Read a specific file only when a question's answer hinges on it.

3. **Ask grounded questions, one at a time.** Questions must be grounded in the preloaded context + snapshot — never an open-ended survey of the codebase before the first round. Probe: scope boundaries, success criteria, risks, unknowns, integration points.

4. **`--auto` mode:** infer answers from the artifacts rather than asking, and record the inferences as assumptions to be confirmed later.

5. **Record outcomes.** When the discussion settles, capture: decisions (to the Decisions Register via `/gsd knowledge rule` where durable), refined scope (to the milestone CONTEXT), open questions (to RESEARCH or `/gsd dispatch research`), and assumptions. Mark the milestone/slice as "Discussion Complete, Planning Pending".

6. **Route.** Recommend the next step: `/gsd dispatch plan` to plan the milestone/slice, or `/gsd dispatch research` if open questions dominate.

## Success criteria

- Questions are grounded and asked one at a time — no upfront survey.
- The preloaded context is treated as authoritative (not re-read).
- Outcomes land in the right gsd-pi artifacts.
- The recommended next step matches where the milestone now sits.
