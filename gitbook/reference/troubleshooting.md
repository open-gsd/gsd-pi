# Troubleshooting

## `/gsd doctor`

The built-in diagnostic tool validates `.gsd/` integrity:

```
/gsd doctor
```

It checks file structure, roadmap ↔ slice ↔ task consistency, completion state, git health, stale locks, orphaned records, and disk-only milestone stubs.

## Common Issues

### Upgrade from older gsd-pi installs

An old global `gsd-pi` install can shadow the new scoped package.

**npm fix:**
```bash
npm uninstall -g gsd-pi
rm -f ~/.gsd/.update-check ~/.gsd/agent/managed-resources.json
npm install -g @opengsd/gsd-pi@latest
```

**Move from old npm to pnpm:**
```bash
npm uninstall -g gsd-pi @opengsd/gsd-pi
rm -f ~/.gsd/.update-check ~/.gsd/agent/managed-resources.json
pnpm setup
exec $SHELL -l
pnpm add -g @opengsd/gsd-pi@latest
command -v gsd
gsd --version
```

If the old package was installed with `sudo npm install -g`, use `sudo npm uninstall -g gsd-pi` first. pnpm can only remove packages that pnpm installed.

### Startup refuses a newer database schema

GSD exits before startup with an error like:

```text
gsd.db schema is v30, newer than the v29 this gsd-pi supports. Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.
```

The version numbers may differ. This means `.gsd/gsd.db` was already opened or migrated by a newer `gsd-pi` binary, and the running binary is too old to safely read or write that database.

**Fix:** Upgrade the `gsd` binary that will open this project, then retry from the project root:

```bash
npm install -g @opengsd/gsd-pi@latest
gsd --version
```

If you use pnpm globals, run:

```bash
pnpm add -g @opengsd/gsd-pi@latest
gsd --version
```

Do not delete `.gsd/gsd.db` to bypass this refusal. If `gsd --version` still shows an old version, check `command -v gsd` for a stale global install or PATH shadowing, then remove the old install as described above.

### pnpm global bin directory is not in PATH

pnpm global commands fail with `The configured global bin directory ... is not in PATH`.

**Fix:**
```bash
pnpm setup
exec $SHELL -l
pnpm remove -g @opengsd/gsd-pi
```

For a one-terminal workaround on macOS/Linux:
```bash
export PATH="/path/from/pnpm-error:$PATH"
pnpm remove -g @opengsd/gsd-pi
```

Replace the path with the exact global bin directory from your pnpm error message.

### Auto mode loops on the same unit

The same unit dispatches repeatedly.

**Fix:** Run `/gsd doctor` to repair state, then `/gsd auto`. If it persists, check that the expected artifact file exists on disk.

### Reactive execute writes `S##-REACTIVE-BLOCKER.md`

A parallel `reactive-execute` batch exhausted artifact retries while one or more dispatched tasks were still missing task summaries. GSD writes `S##-REACTIVE-BLOCKER.md` as a diagnostic that records summary-present and summary-missing tasks.

**Fix:** Inspect `S##-REACTIVE-BLOCKER.md` and `/gsd status`. The blocker prevents another reactive batch for that slice, but task statuses stay under canonical database Attempt/recovery control; use the appropriate explicit retry, reopen, or replan path for any remaining work.

### Auto mode stops with "Loop detected"

A unit failed to produce its expected artifact twice.

**Fix:** Check the task plan for clarity. Refine it manually, then `/gsd auto`.

### Auto mode retries or pauses after a commit hook rejects task changes

After an `execute-task` unit passes verification, GSD commits the task when `uok.gitops.turn_action: commit` is active. If a pre-commit or other commit hook rejects the staged content, GSD classifies the failure as `hook-content`, injects the hook output into task remediation, and retries up to 2 times.

**Fix:** Inspect `.gsd/git-action-failures.log`, fix the hook-reported lint/format/secret/policy failure or hook configuration, then resume with `/gsd auto`. If a parent workspace partially committed one repository before another repository's hook failed, reconcile the already-committed repository manually before resuming; GSD pauses that case instead of re-running the task.

### `command not found: gsd` after install

npm's global bin directory isn't in `$PATH`.

For pnpm installs, use `pnpm setup`, restart your shell, and retry the pnpm command.

**Fix:**
```bash
npm prefix -g
# Add the bin dir to PATH:
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Common causes:**
- **Homebrew Node** — `/opt/homebrew/bin` missing from PATH
- **Version manager (nvm, fnm, mise)** — global bin is version-specific
- **oh-my-zsh** — `gitfast` plugin aliases `gsd` to `git svn dcommit`; check with `alias gsd`

### Provider errors during auto mode

| Error Type | Auto-Resume? | Delay |
|-----------|-------------|-------|
| Rate limit (429) | Yes | 60s or retry-after header |
| Server error (500, 502, 503) | Yes | 30s |
| Auth/billing ("unauthorized") | No | Manual resume required |

For permanent errors, configure fallback models:

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

### Budget ceiling reached

Auto mode pauses with "Budget ceiling reached."

**Fix:** Increase `budget_ceiling` in preferences, or switch to `budget` token profile, then `/gsd auto`.

### Stale lock file

Auto mode won't start, says another session is running.

**Fix:** GSD auto-detects stale locks (dead PID = auto cleanup). If automatic recovery fails:

```bash
rm -f .gsd/auto.lock
rm -rf "$(dirname .gsd)/.gsd.lock"
```

### Git merge conflicts

Worktree merge fails on `.gsd/` files.

**Fix:** `.gsd/` conflicts are auto-resolved. Code conflicts get an AI fix attempt; if that fails, resolve manually.

### Work stranded in a worktree after an interrupted session

Auto mode was paused, stopped, or crashed mid-milestone, and the work is still on the `milestone/<MID>` branch in `.gsd/worktrees/<MID>/` — never merged back to main. Next session reports the milestone as incomplete or behaving inconsistently.

**Fix:** As of GSD 2.78, `/gsd auto` bootstrap automatically detects this condition and surfaces a warning naming the branch, commit count, and worktree location. Run `/gsd auto` to re-enter the worktree and resume. If the worktree must be resolved manually, merge salvageable work with `/gsd worktree merge <MID>` or remove a stale worktree with `/gsd worktree remove <MID>`, then run `/gsd doctor fix`.

**Diagnose:** Run `/gsd forensics` and look at the **Worktree Telemetry** section:
- `Orphans detected > 0` with reason `in-progress-unmerged` confirms the condition
- `Unmerged exits > 0` on the producer side confirms which exit type caused it

**Prevent recurrence:** If your milestones are large or sessions are frequently interrupted, consider setting `git.collapse_cadence: "slice"` in preferences — validated slices merge to main immediately, shrinking the orphan window from milestone-size to slice-size. See [Git & Worktrees](../configuration/git-settings.md#collapse-cadence).

### Forced worktree removal created a quarantine

When `/gsd worktree remove <MID> --force` finds uncommitted files, GSD preserves them under `.gsd/quarantine/worktrees/<name>-<timestamp>/` instead of deleting them. The quarantine contains a `.gsd-quarantine.json` file with the original worktree path, branch, timestamp, and `git status --porcelain` output.

**Fix:** Inspect the quarantined files and copy or merge anything you still need. The milestone branch is preserved, so you can also recover from the branch if needed. Delete the quarantine directory only after you have confirmed there is nothing else to salvage.

### Milestone entry blocked by degraded worktree isolation

Auto mode fails milestone entry with an isolation-degraded warning, often after a previous worktree cleanup or create problem on Windows.

**Fix:** Close editors, terminals, antivirus tools, or Git clients that may be locking `.gsd/worktrees/*` paths. Merge salvageable work with `/gsd worktree merge <MID>` or remove a stale worktree with `/gsd worktree remove <MID>`, then run `/gsd doctor fix` and retry `/gsd auto`. If fallback already succeeded, work continues on `milestone/<MID>` in the project root for that milestone.

### Startup fails during flat-phase migration

GSD exits during startup with `flat-phase migration failed` or `flat-phase migration required but the workflow database could not be opened`.

**Cause:** The project still has the legacy nested `.gsd/milestones/` layout. Startup must migrate it to flat `.gsd/phases/` before path resolvers and state checks run. If the SQLite database cannot be opened, filesystem backup/rename/delete work fails, or the rendered projection cannot be verified, GSD stops instead of continuing against mixed disk state.

**Fix:** Start GSD from the project root and make sure `.gsd/gsd.db*`, `.gsd/`, and `.gsd-backups/` are readable and writable on local disk. Close editors, terminals, sync tools, antivirus/indexers, or other processes that may be locking `.gsd/milestones/`, `.gsd/milestones.migrating/`, `.gsd/phases/`, or `.gsd-backups/`. If the database is damaged or missing, restore it from backup when available; for explicit markdown import, follow the [authoritative recovery contract](../../docs/user-docs/migration.md#post-migration). Retry by starting GSD again; interrupted migrations resume from `.gsd/milestones.migrating/`, and `.gsd-backups/migrate-*` snapshots should be kept until startup succeeds and `/gsd doctor` passes.

### `orphan_milestone_dir` doctor warning

`/gsd doctor` can report `orphan_milestone_dir` when `.gsd/milestones/<MID>/` exists on disk but has no DB row, no matching `.gsd/worktrees/<MID>/` worktree, and no milestone content files. This is a disk-only stub, not stranded work, and it can skew future milestone ID generation.

**Fix:** Run `/gsd doctor fix` to remove the orphan stub directory automatically. The fix only removes these empty disk-only milestone stubs; populated milestone directories and in-flight worktree-only milestones are preserved.

### Notifications not appearing on macOS

**Fix:** Install `terminal-notifier`:

```bash
brew install terminal-notifier
```

See [Notifications](../configuration/notifications.md) for details.

## MCP Issues

### No servers configured

**Fix:** Add server to `.mcp.json` or `.gsd/mcp.json`, verify JSON is valid, run `mcp_servers(refresh=true)`.

### Server discovery times out

**Fix:** Run the configured command outside GSD to confirm it starts. Check that backend services are reachable.

### Server connection closed immediately

**Fix:** Verify `command` and `args` paths are correct and absolute. Run the command manually to catch errors.

### GSD workflow tool surface not ready

**Fix:** Run `/gsd mcp init` from the project root, restart Claude Code, and check `/gsd mcp status`. Manual configs should set `GSD_WORKFLOW_PROJECT_ROOT` to the canonical project root. If stale process cleanup is involved, inspect `$GSD_HOME/mcp-instances.json` and remove only dead `gsd-mcp-server` entries.

## Recovery Procedures

### Reset auto mode state

```bash
rm .gsd/auto.lock
rm .gsd/completed-units.json
```

Then `/gsd auto` to restart from current state.

### Reset routing history

```bash
rm .gsd/routing-history.json
```

### Refresh rendered state

```
/gsd doctor
```

Checks the authoritative database, refreshes `STATE.md` from derived database state, and fixes projection or runtime-file inconsistencies.

### Recover database hierarchy from markdown

Follow the [authoritative recovery contract](../../docs/user-docs/migration.md#post-migration) when markdown is the source you intentionally want to import into a missing or damaged database.

## Getting Help

- **GitHub Issues:** [github.com/open-gsd/gsd-pi/issues](https://github.com/open-gsd/gsd-pi/issues)
- **Dashboard:** `Ctrl+Alt+G` or `/gsd status`
- **Forensics:** `/gsd forensics` for post-mortem analysis
- **Session logs:** `.gsd/activity/` contains JSONL session dumps

## Platform-Specific Issues

### iTerm2

`Ctrl+Alt` shortcuts trigger wrong actions → Set **Profiles → Keys → General → Left Option Key** to **Esc+**.

### Windows

- LSP ENOENT on MSYS2/Git Bash → Fixed in v2.29+, upgrade
- EBUSY errors during builds → Close browser extension, or change output directory
- Transient EBUSY/EPERM on `.gsd/` files → Retry; close file-locking tools if persistent
