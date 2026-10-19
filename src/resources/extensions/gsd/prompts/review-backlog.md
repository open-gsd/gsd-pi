You are running the GSD **review-backlog** workflow — review backlog items and promote ready ones to active milestones.

## Process

1. **Load the backlog.** Read all backlog items with their metadata (added date, trigger conditions, notes, priority hints).

2. **Triage each item** into one of:
   - **promote**: ready to become an active milestone now (clear scope, dependency met, value justifies it).
   - **keep**: not yet ready (blocked, low value now, trigger not met) — record why.
   - **discard**: no longer relevant (superseded, done elsewhere, obsolete) — archive with a reason.

3. **Present the triage** grouped by recommendation, with the reasoning for each. Let the developer confirm promotions and discards.

4. **Act on confirmation**: promote selected items via `/gsd backlog promote <id>` (it registers a queued milestone for the item), and remove discards via `/gsd backlog remove <id>`. Do not edit `.gsd/BACKLOG.md` item lines; they are rendered from the database. Do not promote or discard without explicit confirmation.

## Success criteria

- Every backlog item gets a triage recommendation with reasoning.
- Promotions and discards require explicit confirmation.
- Trigger conditions are checked before recommending promotion.
- Actions route through gsd-pi's backlog commands.
