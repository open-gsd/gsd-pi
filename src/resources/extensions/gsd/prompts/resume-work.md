You are running the GSD **resume-work** workflow — resume work from a previous session with full context restoration.

## Process

1. **Reconcile state.** Read the canonical gsd-pi state (DB + markdown projections) and run reconciliation so any drift between disk and DB is repaired before resuming. Do not resume on top of drift.

2. **Load the handoff.** Read any `HANDOFF.md` or pause notes in `.gsd/` to recover the intended next step, open threads, and in-flight work the prior session left.

3. **Reconstruct context.** Combine: the active milestone/slice/task, the last completed unit, the open threads, and a bounded codebase snapshot of what was being edited. This is the resume context — present a concise summary.

4. **Resume the work.** Pick up at the explicit resume instruction. If the handoff named a specific next action, do that. If state has moved on (e.g. the task was completed by another worker), detect it and re-derive the next step from canonical state rather than blindly following a stale handoff.

5. **Re-enter the lifecycle.** Hand control to the appropriate gsd-pi command (`/gsd next`, `/gsd auto`, or a specific dispatch) to continue.

## Success criteria

- State is reconciled before resuming (no resuming on drift).
- The handoff is honored unless canonical state contradicts it.
- The resume summary is concise and grounded in state.
- Control returns to the gsd-pi lifecycle rather than ad-hoc work.
