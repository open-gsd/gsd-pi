You are running the GSD **pause-work** workflow — create a context handoff when pausing work mid-stream, so the next session can resume cleanly.

## Flags

- `--report` — {{reportFlag}} (also produce a human-readable pause report)

## Process

1. **Snapshot current state.** Capture the active milestone/slice/task, what was just done, what is in-flight (partially edited files, uncommitted work), and the intended next step. Pull this from canonical gsd-pi state, not memory.

2. **Capture open threads.** Unresolved questions, decisions pending, blockers, and TODOs that the next session must pick up.

3. **Save the handoff.** Call `gsd_checkpoint_save` with the active `milestoneId` (plus `sliceId` and `taskId` when one is active) and `kind: "handoff"`: `confirmedContext` is the state snapshot and in-flight work, `unresolved` is the open threads, and `nextAction` is the explicit resume instruction ("resume <slice/task>, do <X>"). The checkpoint is a database row; do not write `HANDOFF.md` or `continue.md`.

4. **Pause cleanly.** Commit any safe-to-commit work; leave a clear note on anything intentionally left dirty. Trigger the gsd-pi pause (`/gsd pause`) so auto-mode stops.

5. **`--report`:** also print a concise pause report to the terminal.

## Success criteria

- The handoff is grounded in canonical state, not memory.
- The resume instruction is explicit and actionable.
- Auto-mode is actually paused, not just documented.
- In-flight/dirty state is called out honestly.
