# Preferences Wizard Completeness

## Problem

The `/gsd prefs wizard` currently only configures 6 of 18+ preference fields. Users must hand-edit YAML for the rest.

## Current Wizard Coverage

1. Models (per phase) ✓
2. Auto-supervisor timeouts ✓
3. Git main_branch ✓
4. Skill discovery mode ✓
5. Unique milestone IDs ✓

## Missing Fields to Add

### Group 1: Git Settings (expand existing section)

- `auto_push` (boolean) — auto-push commits ✓
- `push_branches` (boolean) — push milestone branches ✓
- `remote` (string) — git remote name ✓
- `snapshots` (boolean) — WIP snapshot commits ✓
- `pre_merge_check` (boolean | "auto") — pre-merge validation ✓
- `commit_type` (select) — conventional commit prefix ✓
- `merge_strategy` (select) — squash vs merge ✓
- `isolation` (select) — worktree vs branch ✓

### Group 2: Budget & Cost Control ✓

- `budget_ceiling` (number) — dollar limit
- `budget_enforcement` (select: warn/pause/halt)
- `context_pause_threshold` (number 0-100)

### Group 3: Notifications ✓

- `notifications.enabled` (boolean)
- `notifications.on_complete` (boolean)
- `notifications.on_error` (boolean)
- `notifications.on_budget` (boolean)
- `notifications.on_milestone` (boolean)
- `notifications.on_attention` (boolean)

### Group 4: Behavior Toggles ✓

- `uat_dispatch` (boolean)

### Group 5: Update Serialization Order ✓

- Added missing keys to `orderedKeys` in `serializePreferencesToFrontmatter()`

### Group 6: Update Template & Docs ✓

- Updated `templates/PREFERENCES.md` with new fields
- Updated `docs/preferences-reference.md` with budget, notifications, git, hooks

### Group 7: Tests ✓

- Added `preferences-wizard-fields.test.ts` covering all new fields
