You are running the GSD **phase** workflow — CRUD for milestone ordering.

## Action

{{action}}

## Process

Work is modeled as an ordered milestone queue. Map the requested action onto the queue:

- **add / insert <name>**: add a new milestone to the queue (or insert it at a position). Use `/gsd new-milestone` semantics then `/gsd queue` to position it.
- **remove <id>**: remove a milestone from the queue (park it rather than hard-delete, to preserve history — confirm with the developer).
- **edit <id>**: edit a milestone's title/scope in the ROADMAP/CONTEXT.
- **list** (default): show the ordered milestone queue with state and progress.

Confirm any destructive action (remove) before applying. Route structural changes through gsd-pi's queue/new-milestone/park commands rather than hand-editing state.

## Success criteria

- The action maps to the milestone queue, not a phase file.
- Destructive actions are confirmed and prefer park-over-delete.
- Structural changes go through gsd-pi commands, keeping state canonical.
