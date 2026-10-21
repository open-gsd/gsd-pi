You are running the GSD **pause-work** workflow — create a context handoff when pausing work mid-stream, so the next session can resume cleanly.

## Flags

- `--report` — {{reportFlag}} (also produce a human-readable pause report)

## Process

1. **Snapshot current state.** Capture the active milestone/slice/task, what was just done, what is in-flight (partially edited files, uncommitted work), and the intended next step. Pull this from canonical gsd-pi state, not memory.

2. **Capture open threads.** Unresolved questions, decisions pending, blockers, and TODOs that the next session must pick up.

3. **Write the handoff.** Persist a `HANDOFF.md` (or append to the slice's running notes) in `.gsd/` with: state snapshot, in-flight work, open threads, and the explicit resume instruction ("next: resume <slice/task>, do <X>").

4. **Pause cleanly.** Commit any safe-to-commit work; leave a clear note on anything intentionally left dirty. Trigger the gsd-pi pause (`/gsd pause`) so auto-mode stops.

5. **`--report`:** also print a concise pause report to the terminal.

## Success criteria

- The handoff is grounded in canonical state, not memory.
- The resume instruction is explicit and actionable.
- Auto-mode is actually paused, not just documented.
- In-flight/dirty state is called out honestly.
