# Working in Teams

GSD supports multi-user workflows where several developers work on the same repository concurrently.

## Setup

### 1. Set Team Mode

The simplest way to configure GSD for team use is to set `mode: team` in your project preferences. This enables unique milestone IDs, push branches, and pre-merge checks in one setting:

```yaml
# .gsd/PREFERENCES.md (project-level, committed to git)
---
version: 1
mode: team
---
```

This is equivalent to manually setting `unique_milestone_ids: true`, `git.push_branches: true`, `git.pre_merge_check: true`, and other team-appropriate defaults. You can still override individual settings — for example, adding `git.auto_push: true` on top of `mode: team` if your team prefers auto-push.

Alternatively, you can configure each setting individually without using a mode (see [Git Strategy](git-strategy.md) for details).

### 2. Know What Is Shared

The workflow database (`gsd.db`) is the only authority for milestones, slices, tasks, decisions, and requirements. It is never committed. Every checkout has its own database:

- The database records the checkout root it belongs to. A second clone that resolves to the same state directory (for example two clones of one remote on one machine) is refused with `checkout-unbound`. Give the second clone its own state with `GSD_PROJECT_ID`, or, when the old checkout was moved or deleted, run `/gsd db bind` in the new one.
- A `gsd.db` copied from another checkout is refused the same way.

Markdown under `.gsd/` (PROJECT.md, REQUIREMENTS.md, DECISIONS.md, `phases/`, `milestones/`) is a projection of the database: an export for reading and review, not shared authority. By default `.gsd` lives outside the repository and is ignored, so nothing is committed.

If your team commits the `.gsd/` markdown (a real `.gsd/` directory with tracked files), GSD keeps its runtime files out of git for you: it adds them to `.gitignore` and leaves them out of its own commits. This includes the database, the render baseline `.gsd/.compat.json`, and `.gsd/quarantine/`.

### 3. Commit the Preferences

```bash
git add .gsd/PREFERENCES.md
git commit -m "chore: enable GSD team workflow"
```

## Importing Committed Planning Changes

Committed markdown enters your database only through an explicit import:

- **Fresh clone.** A clone that has tracked `.gsd/` milestone markdown and no database, or an empty one, is refused with `authority-missing` in auto, guided, headless, and MCP writes. Run `/gsd recover` to review the Import Preview and apply it. GSD never starts an empty database beside existing milestone projections on its own.
- **Pull, merge, rebase, or branch switch.** When a tracked projection changes outside GSD, auto mode stops before the next dispatch with one "Projection files changed outside GSD" message. Choose one:
  - keep the change: review it, then run `/gsd recover` to import it through Import Preview;
  - discard the change: run `/gsd rebuild markdown`. The changed bytes are kept under `.gsd/quarantine/`.

No dispatch runs on the old database content until you choose.

## Migrating an Existing Project

If you have an existing project with `.gsd/` blanket-ignored:

1. Ensure no milestones are in progress (clean state)
2. Stop ignoring the `.gsd/` markdown you want to share; GSD keeps its runtime files ignored
3. Add `unique_milestone_ids: true` to `.gsd/PREFERENCES.md`
4. Optionally rename existing milestones to use unique IDs:

   ```
   I have turned on unique milestone ids, please update all old milestone
   ids to use this new format e.g. M001-abc123 where abc123 is a random
   6 char lowercase alpha numeric string. Update all references in all
   .gsd file contents, file names and directory names. Validate your work
   once done to ensure referential integrity.
   ```

5. Commit

## Plan Review Workflow

Teams configured to track planning artifacts in git (i.e. with `mode: team` and `.gsd/phases/` not gitignored) can use a two-PR cycle to get plan approval before any code is written:

1. **Plan PR** — developer runs `/gsd discuss` on `main`, which writes flat-phase planning artifacts to `.gsd/phases/<NN-slug>/` (phase files `<NN>-CONTEXT.md` and `<NN>-ROADMAP.md`) and updates the top-level `.gsd/REQUIREMENTS.md` and `.gsd/DECISIONS.md`. Legacy projects may still resolve to `.gsd/milestones/<MID>/<MID>-*.md` until migration. The developer commits these and opens a docs-only PR.
2. **Review** — the team reviews scope, risks, slice breakdown, and definition of done directly in GitHub. No code to review yet, just the plan.
3. **Code PR** — after the plan PR is merged, the developer pulls `main`, imports the approved plan with `/gsd recover` (see [Importing Committed Planning Changes](#importing-committed-planning-changes)), and runs `/gsd auto`. GSD creates a worktree and executes against the imported plan. The result is a second PR with the actual implementation.

`/gsd discuss` does not auto-commit — the developer controls when and how planning artifacts are committed.

### What reviewers should look for

- **`<NN>-CONTEXT.md`** — is the scope well-defined? Are constraints and non-goals clear?
- **`<NN>-ROADMAP.md`** — does the slice breakdown make sense? Are slices ordered by dependency?
- **`.gsd/DECISIONS.md`** — are the architectural choices justified?

### Steering during execution

If the developer uses `/gsd steer` from within the auto-mode worktree, those adjustments remain local to that worktree and write to `.gsd/OVERRIDES.md` in the worktree — they don't modify the approved plan docs on `main`. These changes will appear in the code PR diff alongside the implementation. Running `/gsd steer` outside the worktree modifies whichever checkout it is run from.

### Automated gates

For teams that want a required discussion checkpoint before each slice (not just the milestone), add `require_slice_discussion: true` to preferences:

```yaml
phases:
  require_slice_discussion: true
```

This pauses auto-mode when a slice is missing its slice `CONTEXT` file and requires the developer to run `/gsd discuss` for that slice before proceeding.

## Parallel Development

Multiple developers can run auto mode simultaneously on different milestones. Each developer:

- Gets their own worktree (`.gsd-worktrees/<MID>/`, gitignored)
- Works on a unique `milestone/<MID>` branch
- Squash-merges to main independently

Milestone dependencies can be declared in the phase context frontmatter:

```yaml
---
depends_on: [M001-eh88as]
---
```

GSD enforces that dependent milestones complete before starting downstream work.
