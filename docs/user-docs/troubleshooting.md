# Troubleshooting

## `/gsd doctor`

The built-in diagnostic tool validates `.gsd/` integrity:

```
/gsd doctor
```

It checks:
- File structure and naming conventions
- Roadmap ↔ slice ↔ task referential integrity
- Completion state consistency
- Database artifact rows whose rendered files are missing on disk, including warning-only diagnostics for missing user-authored context and research files
- Git worktree health (worktree and branch modes only — skipped in none mode)
- Workflow database availability and lock-holder diagnosis
- Stale DB-backed runtime records and orphaned runtime files
- Disk-only orphan milestone stub directories
- Preference parse and validation diagnostics (malformed `PREFERENCES.md` frontmatter or invalid settings)

## Common Issues

### Upgrade from older gsd-pi installs

**Symptoms:** `gsd` exits with a version or managed-resource mismatch, or an old global `gsd-pi` install still shadows the new package.

**Fix:** Clear stale local update/resource state, then install the scoped package:

macOS / Linux:

```bash
sudo npm uninstall -g gsd-pi
rm -f ~/.gsd/.update-check ~/.gsd/agent/managed-resources.json
sudo npm install -g @opengsd/gsd-pi@latest
```

To move from the old npm global package to a pnpm global install:

```bash
npm uninstall -g gsd-pi @opengsd/gsd-pi
rm -f ~/.gsd/.update-check ~/.gsd/agent/managed-resources.json
pnpm setup
exec $SHELL -l
pnpm add -g @opengsd/gsd-pi@latest
command -v gsd
gsd --version
```

If the old npm package was installed with `sudo`, use `sudo npm uninstall -g gsd-pi` for that first uninstall step. pnpm can only remove packages that pnpm installed.

Windows PowerShell:

```powershell
Remove-Item "$env:USERPROFILE\.gsd\.update-check" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.gsd\agent\managed-resources.json" -Force -ErrorAction SilentlyContinue
npm install -g @opengsd/gsd-pi@latest
```

Windows Command Prompt:

```bat
del "%USERPROFILE%\.gsd\.update-check" 2>nul
del "%USERPROFILE%\.gsd\agent\managed-resources.json" 2>nul
npm install -g @opengsd/gsd-pi@latest
```

Or run the installer from the new package on any OS:

```bash
npx @opengsd/gsd-pi@latest
```

After that, routine upgrades use `gsd upgrade`, `gsd update`, or `/gsd update` in a session.

### pnpm says the global bin directory is not in PATH

**Symptoms:** `pnpm add -g`, `pnpm remove -g`, or another pnpm global command fails with `The configured global bin directory ... is not in PATH`.

**Cause:** pnpm refuses global package operations until its global bin directory is configured in your shell.

**Fix:**

```bash
pnpm setup
exec $SHELL -l
pnpm remove -g @opengsd/gsd-pi
```

For a one-terminal workaround on macOS/Linux, add the directory from the error to `PATH` before retrying:

```bash
export PATH="/path/from/pnpm-error:$PATH"
pnpm remove -g @opengsd/gsd-pi
```

Replace the path with the exact global bin directory from your pnpm error message.

### Auto mode loops on the same unit

**Symptoms:** The same unit (e.g., `research-slice` or `plan-slice`) dispatches repeatedly, then auto mode pauses with an "Artifact still missing..." error after 3 artifact verification retries.

**Causes:**
- Stale cache after a crash — the in-memory file listing doesn't reflect new artifacts
- The LLM didn't produce the expected artifact file

**Fix:** Run `/gsd doctor` to repair state, then resume with `/gsd auto`. If the issue persists, check that the expected artifact file exists on disk.

### Auto mode reports that `gsd.db` is locked

**Symptoms:** Auto mode stops before dispatch with a message that the workflow database is locked by another GSD process, possibly including one or more PIDs. `/gsd doctor` reports the `db_locked` error instead of the general `db_unavailable` warning.

**Cause:** Another process still holds `.gsd/gsd.db`, its write-ahead log, or its shared-memory file. This is commonly an orphaned GSD process left behind after a crash. GSD blocks auto mode because the database-backed liveness checks are unavailable while the lock remains.

**Automatic recovery on macOS and Linux:** Run `/gsd doctor --fix` from the project root. Doctor sends `SIGTERM` only when it can prove that a holder is safe to terminate: the process belongs to the current user, is a recognized GSD process, has been sleeping or idle for at least five minutes, matches a stale local worker record whose heartbeat is at least five minutes old, and still has the same process-start identity immediately before signaling. Doctor must also be able to open the database read-only. It then retries the database open and reports the PIDs it released.

If any of those checks fail, doctor leaves the process running and continues to report `db_locked`. This protects active GSD sessions, processes owned by other users, and unrelated processes from automatic termination.

**Manual PID recovery on macOS and Linux:** Inspect every PID printed by auto mode or doctor before stopping it:

```bash
ps -p <PID> -o pid,etime,state,command
kill <PID>
/gsd doctor
```

Stop the process through its terminal or service manager when possible. Use `kill <PID>` only after confirming it is the stale holder, then rerun `/gsd doctor` and `/gsd auto`. If doctor cannot discover a PID, use `lsof` (macOS/Linux) or `fuser` (Linux) against `.gsd/gsd.db`, `.gsd/gsd.db-wal`, and `.gsd/gsd.db-shm`. Do not delete these database files to clear the lock.

**Windows limitation:** Automatic holder discovery and termination are unavailable, so `/gsd doctor --fix` cannot release `db_locked`. Open Resource Monitor, search **Associated Handles** for `gsd.db`, confirm the owning process is a stale GSD instance, and stop that process manually. Then rerun `/gsd doctor` and `/gsd auto`.

### Reactive execute writes `S##-REACTIVE-BLOCKER.md`

**Symptoms:** A parallel `reactive-execute` batch finishes with a warning that GSD wrote a reactive blocker and advanced.

**Cause:** The batch exhausted artifact verification retries while one or more dispatched tasks were still missing task summaries. Instead of re-dispatching the same parallel batch forever, GSD writes `S##-REACTIVE-BLOCKER.md` as a diagnostic that records summary-present and summary-missing tasks. The blocker is not lifecycle authority; follow-up task state comes from the canonical database Attempt/recovery records.

**Fix:** Inspect the blocker file and `/gsd status`. If work is still required, use the appropriate explicit recovery path such as retrying the failed Attempt, reopening a terminal task, or replanning the task before depending on later slice or milestone artifacts.

### Auto mode stops with a liveness wedge

**Symptoms:** Auto mode reports a wedge id, the guard that blocked, and a sanctioned recovery command. Re-running `/gsd auto` prints the same notice instead of entering the loop. This can also follow repeated `already-active` dispatch-claim skips.

**Cause:** The same guard or non-advancing outcome read byte-identical inputs twice. The wedge is stored in the workflow database, so interleaved dispatches and process restarts do not clear it.

**Fix:** Apply the sanctioned recovery printed in the wedge notice. For an `already-active` claim, resolve the underlying active-claim or worker state, usually with `/gsd doctor` or `/gsd doctor fix`. Then run the exact `/gsd auto --resume-wedge <id>` command from the notice; the ID must name the currently open wedge. GSD rechecks the originating guard and resumes only after its blocker clears. If the recovery is incomplete, the wedge and counter are preserved and auto mode remains stopped; if the re-entry probe still reads the unchanged blocker, the same wedge reopens immediately.

### Auto mode pauses after a timeout or finalize failure

**Symptoms:** Auto mode reports a unit hard timeout, a finalize timeout, or a post-unit closeout failure. For `failed finalize twice with identical inputs`, follow [Repeated Finalize Failures](auto-mode.md#repeated-finalize-failures).

**What to inspect:**
- `.gsd/runtime/<unit-type>/<unit-id>.json` shows the latest runtime phase, timeout timestamp, recovery attempts, and progress marker. Timeout recovery uses progress kinds such as `idle-recovery-retry`, `hard-recovery-retry`, `finalize-pre-timeout`, `finalize-post-timeout`, and `finalize-success`.
- `.gsd/journal/` shows the ordered loop events. Look for `unit-end`, then `post-unit-finalize-start`, `post-unit-finalize-end`, and `iteration-end`.
- `post-unit-finalize-end.status` tells you whether closeout completed, retried, stopped, or failed. `iteration-end.status` and `iteration-end.reason` show the final loop outcome that caused auto mode to continue, retry, pause, or stop.
- `.gsd/git-action-failures.log` appends each failed post-unit git action with timestamp and action mode (`commit` or `merge`) so you can inspect the exact git error that paused auto mode.

**Fix:** If the runtime record shows fresh recovery progress, resume with `/gsd auto`; the failsafe defers cancellation while recovery is actively producing durable output. If the journal shows a stopped finalize reason such as a git closeout failure or repeated finalize timeout, inspect `.gsd/git-action-failures.log`, resolve the underlying git issue, then resume.

### Auto mode retries or pauses after a commit hook rejects task changes

**Symptoms:** After an `execute-task` unit passes verification, auto mode reports `Git commit failed... Retrying task remediation (attempt 1/2)` or later reports that git commit failed after 2 remediation attempts and pauses. `.gsd/git-action-failures.log` contains the full hook output.

**Cause:** The post-task `git commit` was rejected by hook-owned content, commonly a pre-commit lint, formatting, secret, or policy check. GSD classifies this path as `hook-content`, injects the hook output into a bounded task remediation retry, and gives the agent up to 2 attempts to fix the committed content. This is separate from transient git lock failures, which use the short git retry path instead.

**Fix:** Inspect `.gsd/git-action-failures.log` and the hook output, fix the failing content or hook configuration, then resume with `/gsd auto`. In parent workspaces, if some repositories already committed before another repository's hook failed, reconcile the partially committed state manually before resuming; GSD pauses that case instead of re-running the task so it does not duplicate already-committed work.

### Wrong files in worktree

**Symptoms:** Planning artifacts or code appear in the wrong directory.

**Cause:** The LLM wrote to the main repo instead of the worktree.

**Fix:** This was fixed in a recent release. If you're on an older version, update. The dispatch prompt now includes explicit working directory instructions.

### Milestone entry blocked by degraded worktree isolation

**Symptoms:** Auto mode fails milestone entry with an isolation-degraded warning, often after a previous worktree cleanup/create problem on Windows.

**Current behavior:** When isolation is configured as `worktree`, GSD now attempts a safe fallback to milestone `branch` mode instead of hard-failing immediately. Bootstrap also surfaces a specific isolation-degraded notification so the cause is visible.

**Fix:**
- Close editors, terminals, or antivirus tools that may be locking `.gsd-worktrees/*` paths.
- If the old worktree has salvageable changes, merge it with `/gsd worktree merge <MID>`.
- If the old worktree is stale and should be discarded, remove it with `/gsd worktree remove <MID>`.
- Run `/gsd doctor fix`, then retry `/gsd auto`. If fallback already succeeded, work continues on `milestone/<MID>` in the project root for that milestone.

### Forced worktree removal created a quarantine

**Symptoms:** `/gsd worktree remove <MID> --force` reports that dirty worktree contents were quarantined under `.gsd/quarantine/worktrees/<name>-<timestamp>/`.

**Current behavior:** GSD preserves uncommitted files instead of deleting them. The quarantine contains `.gsd-quarantine.json` with the original worktree path, branch, timestamp, and `git status --porcelain` output. The milestone branch is preserved, so recovery can use either the quarantined files or the branch.

**Fix:** Inspect the quarantine and copy or merge anything you still need. Delete the quarantine directory only after confirming there is nothing left to salvage.

### Windows `EPERM` / `EBUSY` while removing stale worktree directories

**Symptoms:** Startup or milestone entry fails during stale worktree cleanup with `EPERM` or `EBUSY` from directory removal.

**Cause:** A process still holds a handle under an old worktree path, preventing cleanup.

**Current behavior:** GSD now fails with a targeted error explaining that file locks blocked cleanup and advising you to close locking tools before retrying.

**Fix:**
- Close apps that might hold file locks (editors, shells in old worktree paths, antivirus/indexers).
- Retry the command after a short delay.

### Startup fails during flat-phase migration

**Symptoms:** GSD exits during startup with a message like `flat-phase migration failed` or `flat-phase migration required but the workflow database could not be opened`.

**Cause:** The project still has the legacy nested `.gsd/milestones/` layout. On startup, GSD must migrate it to the flat `.gsd/phases/` layout before path resolvers and state checks run. Markdown for milestone, slice, and task identities already known to the database is archived in the migration backup and re-rendered from database authority; it is not imported during startup. An unknown or ambiguous identity, a database hierarchy gap, an unavailable database, a backup/rename/delete failure, or an unverifiable flat-phase render stops startup before GSD can continue against mixed or invented state.

**Fix:**
- Make sure you are starting GSD from the project root and that `.gsd/gsd.db*`, `.gsd/`, and `.gsd-backups/` are readable and writable on local disk.
- Close editors, shells, sync tools, antivirus/indexers, or other processes that may be locking `.gsd/milestones/`, `.gsd/milestones.migrating/`, `.gsd/phases/`, or `.gsd-backups/`.
- If the database is damaged or missing and rendered markdown is the state you intentionally want to import, use `/gsd recover` after database access is restored, then approve its exact Preview hash. It preserves existing rows absent from markdown and retains a verified pre-import backup; see [Migration from v1](./migration.md#post-migration) for the recovery contract.
- Start GSD again after fixing the underlying issue. The migration retries on the next startup and can resume an interrupted run from `.gsd/milestones.migrating/`; keep `.gsd-backups/migrate-*` snapshots until the project starts successfully and `/gsd doctor` passes.

### `command not found: gsd` after install

**Symptoms:** `npm install -g @opengsd/gsd-pi@latest` succeeds but `gsd` isn't found.

**Cause:** npm's global bin directory isn't in your shell's `$PATH`.

**Prevention:** The guided installer (`npx @opengsd/gsd-pi@latest`) checks PATH during setup and warns before you hit this error.

**Fix:**

```bash
# Find where npm installed the binary
npm prefix -g
# Output: /opt/homebrew (Apple Silicon) or /usr/local (Intel Mac)

# Add the bin directory to your PATH if missing
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Workaround:** Run `npx @opengsd/gsd-pi@latest` or `$(npm prefix -g)/bin/gsd` directly.

**Common causes:**
- **Homebrew Node** — `/opt/homebrew/bin` should be in PATH but sometimes isn't if Homebrew init is missing from your shell profile
- **Version manager (nvm, fnm, mise)** — global bin is version-specific; ensure your version manager initializes in your shell config
- **oh-my-zsh** — the `gitfast` plugin aliases `gsd` to `git svn dcommit`. Check with `alias gsd` and unalias if needed

### `npm install -g @opengsd/gsd-pi@latest` fails

**Common causes:**
- Missing workspace packages — fixed in a recent release
- `postinstall` hangs on Linux (Playwright `--with-deps` triggering sudo) — fixed in a recent release
- Node.js version too old — requires ≥ 22.18.0
- `ETARGET: No matching version found` / `notarget` — the `@opengsd/gsd-pi` package has not been published to the npm registry yet for the requested version (see below)

**If you see `ETARGET` or `notarget` (package not found on npm):**

The `@opengsd/gsd-pi` package is published to npm from tagged releases. If a release is in progress or you are on a pre-release branch, the package may not yet be available on the public npm registry.

Options:

1. **Wait and retry** — check [npm for @opengsd/gsd-pi](https://www.npmjs.com/package/@opengsd/gsd-pi) to confirm whether a release has landed, then retry.

2. **Use `npx` instead of a global install** — `npx @opengsd/gsd-pi@latest` fetches the package on demand and may pick up the most recently published version without a local cache:
   ```bash
   npx @opengsd/gsd-pi@latest
   ```

3. **Build from source** — clone the repository and build locally:
   ```bash
   git clone https://github.com/open-gsd/gsd-pi.git
   cd gsd-pi
   pnpm install --frozen-lockfile
   pnpm run build
   npm install -g .
   ```
   Requires Node.js ≥ 22.18.0 and pnpm. If `pnpm` is not installed: `npm install -g pnpm`.

### Provider errors during auto mode

**Symptoms:** Auto mode pauses with a provider error (rate limit, server error, auth failure).

**How GSD handles it:**

| Error type | Auto-resume? | Delay |
|-----------|-------------|-------|
| Rate limit (429, "too many requests") | ✅ Yes | retry-after header or 60s |
| Server error (500, 502, 503, "overloaded") | ✅ Yes | 30s |
| Auth/billing ("unauthorized", "invalid key") | ❌ No | Manual resume |

For transient errors, GSD pauses briefly and resumes automatically. For permanent errors, configure fallback models:

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

**Headless mode:** `gsd headless auto` auto-restarts the entire process on crash (default 3 attempts with exponential backoff). Combined with provider error auto-resume, this enables true overnight unattended execution.

For common provider setup issues (role errors, streaming errors, model ID mismatches), see the [Provider Setup Guide — Common Pitfalls](./providers.md#common-pitfalls).

### Budget ceiling reached

**Symptoms:** Auto mode pauses with "Budget ceiling reached."

**Fix:** Increase `budget_ceiling` in preferences, or switch to `budget` token profile to reduce per-unit cost, then resume with `/gsd auto`.

### Preferences file ignored or settings not taking effect

**Symptoms:** On session start, `/gsd doctor`, or when starting auto mode, GSD reports a warning or error like `GSD project preferences error: .gsd/PREFERENCES.md could not be parsed.` or `GSD global preferences warning: ~/.gsd/PREFERENCES.md contains invalid settings.` Settings from the file appear to have no effect.

**Cause:** The preferences file has malformed YAML frontmatter (for example a missing closing `---` delimiter or a YAML syntax error) or contains invalid settings. Parse failures cause the whole file to be ignored — GSD normally falls back to a valid global or legacy preferences file. Invalid individual settings are sanitized or dropped while the rest of the file still applies. Preferences never throw; the diagnostics make the problem visible instead of failing silently. A malformed project file that attempts to configure `runtime.contract` is the safety exception: GSD preserves an invalid-contract marker so runtime operations fail closed rather than using another contract.

**Fix:** Run `/gsd doctor` to see the file path, the parse/validation message, and (for YAML errors) the line and column. Fix the reported issue in the named file, then rerun the command. Auto-mode re-surfaces these diagnostics at preflight so they are visible before long-running automation proceeds.

### Parent workspace repository warnings

**Symptoms:** `/gsd doctor` reports `workspace_repo_path_missing` or `workspace_repo_not_a_repo` for a repository declared under `workspace.repositories` in `.gsd/PREFERENCES.md`.

**What it means:** In `workspace.mode: parent`, each declared child path must exist and be a git repository at its own root. A typo such as `frontned` produces `workspace_repo_path_missing`; an ordinary directory inside the parent repo produces `workspace_repo_not_a_repo`.

**Fix:** Create or clone the child repository at the configured path, initialize git in that directory if it should become a repository, or update `workspace.repositories.<id>.path` to the actual child repo root. Parent workspace paths must still resolve inside the project root; sibling paths such as `../frontend` are rejected by preference validation.

If preferences combine `mode: team` with `workspace.mode: parent`, GSD also warns that team branch-push and PR behavior is still root-scoped and will not push child repositories. Push or open PRs for child repos manually, or switch to `mode: solo` when team branch automation is not needed.

### Auto mode says another session is running

**Symptoms:** Auto mode won't start, says another session is running.

**Fix:** GSD now derives active-session ownership from DB-backed worker and dispatch state, not from `auto.lock` or `runtime/paused-session.json`. In most cases `/gsd doctor fix` clears stale runtime rows and the next `/gsd auto` re-acquires ownership automatically.

If recovery still fails, repair runtime state instead of manually deleting individual lock files:

```bash
/gsd doctor fix
```

### Git merge conflicts

**Symptoms:** `/gsd` commands are blocked, or auto mode pauses/stops with unresolved Git conflicts.

**What happens:** Before most `/gsd` commands run, GSD probes the project root (and the active milestone worktree when present) for unmerged paths, conflict markers (`git diff --check`), and stale merge/rebase state. It auto-heals safe paths (`.gsd/` runtime files and build artifacts), aborts stale merge state when there are no unmerged paths, then blocks if product code conflicts remain.

**Fix:**
- Resolve remaining conflicts in your source files, then run `/gsd doctor`.
- While conflicts remain, these commands still run: `/gsd doctor`, `/gsd closeout …`, and `/gsd dispatch complete-milestone …`.
- Re-run your original command after `git status` is clean.

Auto mode **pauses** on product conflicts after heal; it **stops** when Git state cannot be verified (fail-closed probe).

### Auto mode stops before merge with preflight conflict/overlap errors

**Symptoms:** Auto mode stops with a pre-merge reason like unresolved Git conflicts or dirty working tree overlap.

**What it means:** Milestone merge preflight now fail-closes before merge when either:
- the repo already has unresolved conflict stages (`git diff --name-only --diff-filter=U` is non-empty), or
- local dirty files overlap files modified by the milestone branch.

In these states GSD does not auto-stash and does not auto-fix; it stops so you can resolve safely.

**Fix:**
- Resolve conflict markers and stage the resolved files.
- Commit, stash, or discard overlapping local edits outside GSD.
- Re-run `/gsd auto` after `git status` is clean (or at least free of overlapping/conflicted paths).

### Auto mode stops after merge with postflight stash recovery

**Symptoms:** Auto mode reports `Post-merge stash restore failed for milestone <MID>` or `postflight-stash-restore-failed`.

**What it means:** The milestone merge itself completed, but GSD could not automatically restore the pre-merge stash of local user changes. GSD records the merge as complete before stopping, so resuming auto mode will not rerun the already completed milestone merge.

**Fix:** Inspect `git status` and the named stash, manually recover or drop the stashed local changes, then rerun `/gsd auto`.

### Pre-dispatch says the milestone integration branch no longer exists

**Symptoms:** Auto mode or `/gsd doctor` reports that a milestone recorded an integration branch that no longer exists in git.

**What it means:** The milestone's `.gsd/milestones/<MID>/<MID>-META.json` still points at the branch that was active when the milestone started, but that branch has since been renamed or deleted.

**Current behavior:**
- If GSD can deterministically recover to a safe branch, it no longer hard-stops auto mode.
- Safe fallbacks are:
  - explicit `git.main_branch` when configured and present
  - the repo's detected default integration branch (for example `main` or `master`)
- In that case `/gsd doctor` reports a warning and `/gsd doctor fix` rewrites the stale metadata to the effective branch.
- GSD still blocks when no safe fallback branch can be determined.

**Fix:**
- Run `/gsd doctor fix` to rewrite the stale milestone metadata automatically when the fallback is obvious.
- If GSD still blocks, recreate the missing branch or update your git preferences so `git.main_branch` points at a real branch.

### `/gsd doctor` reports `orphan_milestone_dir`

**Symptoms:** `/gsd doctor` shows a warning like `Orphan milestone directory: M003` with issue code `orphan_milestone_dir`.

**What it means:** `.gsd/milestones/<MID>/` exists on disk, but GSD cannot find a DB milestone row, a matching `.gsd-worktrees/<MID>/` worktree, or any milestone content files. These disk-only stub directories can be left behind by interrupted or stale forward references and can skew the next milestone ID that GSD generates.

**Fix:** Run `/gsd doctor fix` to remove the orphan milestone stub directory automatically. The auto-fix only targets disk-only stubs with no DB row, no worktree, and no content files; populated milestone directories and in-flight worktree-only milestones are not removed.

### `/gsd doctor` reports `artifact_file_missing`

**Symptoms:** `/gsd doctor` shows an error with issue code `artifact_file_missing`, a scope such as `project`, `milestone`, `slice`, or `task`, and a file path like `phases/01-foundation/01-CONTEXT.md` or `milestones/M001/M001-ROADMAP.md`.

**What it means:** The canonical database has an `artifacts` row for that path, but the rendered markdown file is missing from disk. In worktree mode, doctor checks both the active worktree-local `.gsd/` projection root and the project `.gsd/` root before reporting the issue, so the error usually means the artifact was deleted, skipped during a failed write, or left dangling by an interrupted migration/rebuild.

**Fix:** If the database is still the source of truth, run `/gsd rebuild markdown` to re-render missing artifact projections from the DB, then rerun `/gsd doctor`. If the file represented work that should still exist but rebuild cannot recreate it, restore the file from git/backups or rerun the GSD workflow that generates that artifact. Use `/gsd recover` and its exact Preview-hash approval only when the database is lost or corrupt and the markdown on disk is the source you intentionally want to import; it is not the normal fix for a dangling artifact reference. See [Migration from v1](./migration.md#post-migration) for the recovery contract.

### `/gsd doctor` reports `artifact_db_status_divergence`

**Symptoms:** `/gsd doctor` shows an error with issue code `artifact_db_status_divergence` for a completion artifact such as `S01-T01-SUMMARY.md` (or legacy `T01-SUMMARY.md` in older flat projects), while the database still shows that task as open or missing.

**What it means:** Runtime will not silently trust an open-task SUMMARY as task completion. After `gsd_task_complete` stages a result, an `in_progress` task's SUMMARY is considered a current staged projection only when its milestone, slice, and task identity and canonical path match; its disk and artifact content are byte-identical; its stamp-stripped content matches the task's database summary; and the latest Attempt is settled and successful at `verify`, or at `route` after a current non-passing host verdict. A mismatched, disk-only, missing-task, missing-Attempt, or failed-executor SUMMARY remains fail-closed and produces this diagnostic.

**Fix:** Review the divergent SUMMARY, then run `/gsd rebuild markdown` to quarantine stale projections and re-render from the authoritative database. Use `/gsd recover` with its exact Preview approval only when markdown should repopulate a lost or corrupt database. Otherwise, repair or rerun the task and rerun `/gsd doctor`.

### `/gsd doctor` reports `artifact_user_content_missing`

**Symptoms:** `/gsd doctor` shows a warning with issue code `artifact_user_content_missing` for a missing `CONTEXT` or `RESEARCH` file, such as `milestones/M001/M001-CONTEXT.md` or `milestones/M001/M001-RESEARCH.md`. When `/gsd doctor fix` is running, it reports that the user-authored artifact was skipped instead of recreating a placeholder.

**What it means:** The database remembers that the user-authored artifact should exist, but doctor cannot reconstruct its real content from structured DB rows. These warnings are separate from blocking `artifact_file_missing` projection errors because rebuilding from the DB would risk replacing user decisions or research with incomplete content.

**Fix:** Re-run the workflow that authors the missing file in that milestone or slice. Use `/gsd discuss` for missing `CONTEXT` artifacts and `/gsd auto` for missing `RESEARCH` artifacts, then rerun `/gsd doctor`.

### Startup warns that memory consolidation is incomplete

**Symptoms:** On startup, GSD shows a warning like `Memory consolidation: ... not yet in memories table. Run /doctor for details.`

**What it means:** The ADR-013 memory-store consolidation preflight scanner found legacy knowledge that is not yet represented in the canonical `memories` table. It checks active `decisions` rows for matching `structured_fields.sourceDecisionId` markers and `.gsd/KNOWLEDGE.md` table rows for matching `sourceKnowledgeId` markers. The scanner is read-only and is intended to block destructive cutover until migration coverage is visible.

**Fix:** Run `/gsd doctor` to inspect the counts and sample rows. Before cutover, complete the decisions or KNOWLEDGE.md backfill so the affected rows exist in `memories`; do not delete legacy `DECISIONS.md`, `KNOWLEDGE.md`, or database rows just to silence the warning.

### Transient `EBUSY` / `EPERM` / `EACCES` while writing `.gsd/` files

**Symptoms:** On Windows, auto mode or doctor occasionally fails while updating `.gsd/` files with errors like `EBUSY`, `EPERM`, or `EACCES`.

**Cause:** Antivirus, indexers, editors, or filesystem watchers can briefly lock the destination or temp file just as GSD performs the atomic rename.

**Current behavior:** GSD now retries those transient rename failures with a short bounded backoff before surfacing an error. The retry is intentionally limited so genuine filesystem problems still fail loudly instead of hanging forever.

Native projection-root operations on Windows also identify `ERROR_SHARING_VIOLATION` (`os error 32`) as transient. Auto mode routes that typed failure through its existing transient-execution retry budget; other projection failures are not reclassified, and sustained handle contention still surfaces as an error after the budget is exhausted.

**Fix:**
- Re-run the operation; most transient lock races clear quickly.
- If the error persists, close tools that may be holding the file open and then retry.
- If repeated failures continue, run `/gsd doctor` to confirm the repo state is still healthy and report the exact path + error code.

### Node v24 web boot failure

**Symptoms:** `gsd --web` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on Node v24.

**Cause:** Node v24 changed type-stripping behavior for `node_modules`, breaking the Next.js web build.

**Fix:** Fixed in a recent release. Upgrade to the latest version.

### Orphan web server process

**Symptoms:** `gsd --web` fails because port 3000 is already in use, even though no GSD session is running.

**Cause:** A previous web server process was not cleaned up on exit.

**Fix:** Fixed in a recent release. GSD now cleans up stale web server processes automatically. If you're on an older version, kill the orphan process manually: `lsof -ti:3000 | xargs kill`.

### Non-JS project blocked by worktree health check

**Symptoms:** Worktree health check fails or blocks auto-mode in projects that don't use Node.js (e.g., Rust, Go, Python).

**Cause:** The worktree health check only recognized JavaScript ecosystems in older releases.

**Fix:** Fixed in a recent release. The health check now supports 17+ ecosystems. Upgrade to the latest version.

### German/non-English locale git errors

**Symptoms:** Git commands fail or produce unexpected results when the system locale is non-English (e.g., German).

**Cause:** GSD parsed git output assuming English locale strings.

**Fix:** Fixed in a recent release. All git commands now force `LC_ALL=C` to ensure consistent English output regardless of system locale.

## MCP Client Issues

### `mcp_servers` shows no configured servers

**Symptoms:** `mcp_servers` reports no servers configured.

**Common causes:**
- No `.mcp.json` or `.gsd/mcp.json` file exists in the current project
- The config file is malformed JSON
- The server is configured in a different project directory than the one where you launched GSD

**Fix:**
- Add the server to `.mcp.json` or `.gsd/mcp.json`
- Verify the file parses as JSON
- Re-run `mcp_servers(refresh=true)`

### `mcp_discover` times out

**Symptoms:** `mcp_discover` fails with a timeout.

**Common causes:**
- The server process starts but never completes the MCP handshake
- The configured command points to a script that hangs on startup
- The server is waiting on an unavailable dependency or backend service

**Fix:**
- Run the configured command directly outside GSD and confirm the server actually starts
- Check that any backend URLs or required services are reachable
- For local custom servers, verify the implementation is using an MCP SDK or a correct stdio protocol implementation

### `mcp_discover` reports connection closed

**Symptoms:** `mcp_discover` fails immediately with a connection-closed error.

**Common causes:**
- Wrong executable path
- Wrong script path
- Missing runtime dependency
- The server crashes before responding

**Fix:**
- Verify `command` and `args` paths are correct and absolute
- Run the command manually to catch import/runtime errors
- Check that the configured interpreter or runtime exists on the machine

### GSD workflow tool surface not ready

**Symptoms:** A Claude Code-backed unit aborts before the first model turn with `workflow tool surface not ready`, often mentioning `gsd-workflow` as `pending`, `failed`, `disabled`, absent, or missing a required `gsd_*` tool.

**Common causes:**
- Claude Code has not connected the `gsd-workflow` MCP server yet
- The server's workflow bridge failed during startup
- `GSD_WORKFLOW_PROJECT_ROOT` points at the wrong project
- A stale MCP server process is still registered for the project

**Fix:**
- Run `/gsd mcp init` from the project root, restart Claude Code, and retry the unit.
- Check `/gsd mcp status` and confirm `gsd-workflow` is connected with workflow tools listed.
- If you maintain MCP config manually, set `GSD_WORKFLOW_PROJECT_ROOT` to the canonical project root and rebuild or reinstall `gsd-mcp-server` after local package changes.
- If startup still reports stale process cleanup problems, inspect `$GSD_HOME/mcp-instances.json` and remove only entries for dead `gsd-mcp-server` processes.
- Background MCP probes (`/gsd mcp status`, guided-flow warm-up, preflight checks) use `GSD_MCP_PROBE=1` and do not compete with Claude Code's live `gsd-workflow` server. If you maintain a custom MCP launch path, ensure only the Claude Code child session registers in `mcp-instances.json`.

### `mcp_call` fails because required arguments are missing

**Symptoms:** A discovered MCP tool exists, but calling it fails validation because required fields are missing.

**Common causes:**
- The call shape is wrong
- The target server's tool schema changed
- You're calling a stale server definition or stale branch build

**Fix:**
- Re-run `mcp_discover(server="name")` and confirm the exact required argument names
- Call the tool with `mcp_call(server="name", tool="tool_name", args={...})`
- If you're developing GSD itself, rebuild after schema changes with `npm run build`

### Local stdio server works manually but not in GSD

**Symptoms:** Running the server command manually seems fine, but GSD can't connect.

**Common causes:**
- The server depends on shell state that GSD doesn't inherit
- Relative paths only work from a different working directory
- Required environment variables exist in your shell but not in the MCP config

**Fix:**
- Use absolute paths for `command` and script arguments
- Set required environment variables in the MCP config's `env` block
- If needed, set `cwd` explicitly in the server definition

### Session lock stolen by `/gsd` in another terminal

**Symptoms:** Running `/gsd` (step mode) in a second terminal causes a running auto-mode session to lose its lock.

**Fix:** Fixed in a recent release. Bare `/gsd` no longer steals the session lock from a running auto-mode session. Upgrade to the latest version.

### Worktree commits landing on main instead of milestone branch

**Symptoms:** Auto-mode commits in a worktree end up on `main` instead of the `milestone/<MID>` branch.

**Fix:** Fixed in a recent release. CWD is now realigned before dispatch and stale merge state is cleaned on failure. Upgrade to the latest version.

### Extension loader fails with subpath export error

**Symptoms:** Extension fails to load with a `Cannot find module` error referencing npm subpath exports.

**Cause:** Dynamic imports in the extension loader didn't resolve npm subpath exports (e.g., `@pkg/foo/bar`).

**Fix:** Fixed in a recent release. The extension loader now auto-resolves npm subpath exports and creates a `node_modules` symlink for dynamic import resolution. Upgrade to the latest version.

## Recovery Procedures

### Reset auto mode state

```bash
rm .gsd/completed-units.json
```

Then run `/gsd doctor` to refresh projections and `/gsd auto` to restart from current DB-backed state.

### Reset routing history

If adaptive model routing is producing bad results, clear the routing history:

```bash
rm .gsd/routing-history.json
```

### Refresh rendered state

```
/gsd doctor
```

Doctor checks the authoritative database, refreshes `STATE.md` from derived database state, and fixes detected projection or runtime-file inconsistencies.

### Recover database hierarchy from markdown

Use this only when the database is missing, damaged, or known to be stale but the rendered milestone, slice, and task markdown on disk is the best available source:

```
/gsd recover
# Then re-run with the exact --preview=<sha256> printed by the command.
```

`/gsd recover` prints a sealed legacy Preview; its `--preview=<sha256>` follow-up applies that unchanged preview through a verified, backed-up Import Application and preserves database rows absent from markdown. It then assesses whether the retained backup may still be restored or whether later canonical work requires Forward Repair. Follow the exact evidence-bound action printed by the command; see [Migration from v1](./migration.md#post-migration) for the authoritative recovery contract. Normal runtime does not silently import markdown projections, and worktree markdown is not synced back as authoritative state.

For non-TTY environments (CI, cron, scripted automation), `gsd headless recover` has the same semantics without an interactive prompt. See the [commands reference](./commands.md#gsd-headless-recover) for evidence-bound restore and Forward Repair flags.

## Getting Help

- **GitHub Issues:** [github.com/open-gsd/gsd-pi/issues](https://github.com/open-gsd/gsd-pi/issues)
- **Dashboard:** `Ctrl+Alt+G` or `/gsd status` for real-time diagnostics
- **Forensics:** `/gsd forensics` for structured post-mortem analysis of auto-mode failures
- **Session logs:** `.gsd/activity/` contains JSONL session dumps for crash forensics

## iTerm2-Specific Issues

### Ctrl+Alt shortcuts trigger the wrong action (e.g., Ctrl+Alt+G opens external editor instead of GSD dashboard)

**Symptoms:** Pressing Ctrl+Alt+G opens the external editor prompt (Ctrl+G) instead of the GSD dashboard. Other Ctrl+Alt shortcuts behave as their Ctrl-only counterparts.

**Cause:** iTerm2's default Left Option Key setting is "Normal", which swallows the Alt modifier for Ctrl+Alt key combinations. The terminal receives only the Ctrl key, so Ctrl+Alt+G arrives as Ctrl+G.

**Fix:** In iTerm2, go to **Profiles → Keys → General** and set **Left Option Key** to **Esc+**. This makes Alt/Option send an escape prefix that terminal applications can detect, enabling Ctrl+Alt shortcuts to work correctly.

## Windows-Specific Issues

### LSP returns ENOENT on Windows (MSYS2/Git Bash)

**Symptoms:** LSP initialization fails with `ENOENT` or resolves POSIX-style paths like `/c/Users/...` instead of `C:\Users\...`.

**Cause:** The `which` command in MSYS2/Git Bash returns POSIX paths that Node.js `spawn()` can't resolve.

**Fix:** Updated recently to use `where.exe` on Windows. Upgrade to the latest version.

### EBUSY errors during WXT/extension builds

**Symptoms:** `EBUSY: resource busy or locked, rmdir .output/chrome-mv3` when building browser extensions.

**Cause:** A Chromium browser has the extension loaded from the build output directory, preventing deletion.

**Fix:** Close the browser extension, or set a different `outDirTemplate` in your WXT config to avoid the locked directory.

## Database Issues

### "GSD database is not available"

**Symptoms:** `gsd_decision_save` (or its alias `gsd_save_decision`), `gsd_requirement_update` (or `gsd_update_requirement`), or `gsd_summary_save` (or `gsd_save_summary`) fail with this error.

**Cause:** The SQLite database was not initialized or could not be opened. Runtime state derivation will not silently fall back to markdown projections.

**Fix:** Upgrade to the latest version, then run a GSD command from the project root to initialize or open the database. Use `/gsd inspect` for database diagnostics. If the database was lost or corrupted and markdown artifacts are the state you intentionally want to import, run `/gsd recover` after GSD has opened the database and approve its exact Preview hash. Follow its verified backup assessment and exact evidence-bound recovery action; see [Migration from v1](./migration.md#post-migration).

## Verification Issues

### Verification gate fails with shell syntax error

**Symptoms:** `stderr: /bin/sh: 1: Syntax error: "(" unexpected` during verification checks.

**Cause:** A description-like string (e.g., `All 10 checks pass (build, lint)`) was treated as a shell command. This can happen when task plans have `verify:` fields with prose instead of actual commands.

**Fix:** Updated recently to filter preference commands through `isLikelyCommand()`. Ensure `verification_commands` in preferences contains only valid shell commands, not descriptions.

### Verification command is rejected as unsafe or non-runnable

**Symptoms:** Pre-execution checks fail with `Unsafe or non-runnable Verify command`, often for a command that works in an interactive shell.

**Cause:** GSD only accepts mechanically executable verification commands. Single shell pipelines with `|` are supported, but logical OR fallbacks (`||`), redirects (`>` or `<`), semicolons, backticks, and command substitution (`$(...)`) are rejected so verification cannot hide failures or run arbitrary shell programs.

**Fix:** Put a direct check or single pipeline in the verify field or `verification_commands`. For example, `python3 -m pytest tests -q --tb=short | tail -5` is valid, but `python3 -m pytest tests -q --tb=short 2>&1 | tail -5` is rejected because it uses a redirect.

## LSP (Language Server Protocol)

### "LSP isn't available in this workspace"

GSD auto-detects language servers based on project files (e.g. `package.json` → TypeScript, `Cargo.toml` → Rust, `go.mod` → Go). If no servers are detected, the agent skips LSP features.

**Check status:**
```
lsp status
```

This shows which servers are active and, if none are found, diagnoses why — including which project markers were detected but which server commands are missing.

**Common fixes:**

| Project type | Install command |
|-------------|-----------------|
| TypeScript/JavaScript | `npm install -g typescript-language-server typescript` |
| Python | `pip install pyright` or `pip install python-lsp-server` |
| Rust | `rustup component add rust-analyzer` |
| Go | `go install golang.org/x/tools/gopls@latest` |

After installing, run `lsp reload` to restart detection without restarting GSD.

## Notifications

### Notifications not appearing on macOS

**Symptoms:** `notifications.enabled: true` in preferences, but no desktop notifications appear during auto-mode (no milestone complete alerts, no budget warnings, no error notifications). No error messages logged.

**Cause:** GSD uses `osascript display notification` as a fallback on macOS. This command is attributed to your terminal app (Ghostty, iTerm2, Alacritty, Kitty, Warp, etc.). If that app doesn't have notification permissions in System Settings → Notifications, macOS silently drops the notification — `osascript` exits 0 with no error.

Most terminal apps don't appear in the Notifications settings panel until they've successfully delivered at least one notification, creating a chicken-and-egg problem.

**Fix (recommended):** Install `terminal-notifier`, which registers as its own Notification Center app:

```bash
brew install terminal-notifier
```

GSD automatically prefers `terminal-notifier` when available. On first use, macOS will prompt you to allow notifications — this is the expected behavior.

**Fix (alternative):** Go to **System Settings → Notifications** and enable notifications for your terminal app. If your terminal doesn't appear in the list, try sending a test notification from Terminal.app first to register "Script Editor":

```bash
osascript -e 'display notification "test" with title "GSD"'
```

**Verify:** After applying either fix, test with:

```bash
terminal-notifier -title "GSD" -message "working!" -sound Glass
```

### Telegram notifications not arriving

**Symptoms:** Auto-mode is running, Telegram is configured as the remote channel, but milestone completions, budget alerts, and other informational notifications are not appearing in the Telegram chat.

**Causes and fixes:**

- **`notifications.enabled` is not set** — ensure `notifications.enabled: true` is present in preferences alongside the `remote_questions` configuration. Informational notifications require both to be set.
- **Bot token is incorrect or expired** — run `/gsd remote status` to confirm the configuration is saved, then `/gsd remote telegram` to re-run setup and re-validate the token.
- **Bot is not a member of the target chat** — the bot must be added to the group chat (or the configured chat ID must match a private chat with the bot). Send `/help` directly to the bot in Telegram to confirm it is reachable.
- **Wrong `channel_id`** — verify the chat ID in `~/.gsd/PREFERENCES.md` matches the chat where you expect notifications. For group chats, the ID is typically a negative number (e.g., `-1001234567890`).
- **Network or firewall issue** — GSD must be able to reach `api.telegram.org`. Test with `curl https://api.telegram.org` from the machine running GSD.

### Telegram commands not responding

**Symptoms:** Sending `/status`, `/pause`, or other Telegram commands to the bot produces no response.

**Causes and fixes:**

- **Auto-mode is not running** — background polling only operates while auto-mode is active. Start auto-mode with `/gsd auto` and then retry the command.
- **Wrong chat** — commands are only processed from the chat configured in `remote_questions.channel_id`. Confirm you are sending from the correct chat.
- **Bot token mismatch** — the `TELEGRAM_BOT_TOKEN` environment variable or the token in `~/.gsd/PREFERENCES.md` may not match the bot you are messaging. Run `/gsd remote status` to confirm which bot token is active.
- **Polling not started** — if GSD was already running when the Telegram configuration was added, restart auto-mode (`/gsd stop`, then `/gsd auto`) so polling initializes with the new configuration.
- **Send `/help` first** — if the bot responds to `/help`, polling is working correctly. If a specific command like `/pause` does not respond, check for typos (commands are case-sensitive).
