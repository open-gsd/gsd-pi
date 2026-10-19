# Multi-Repository Parent Workspace

Many products span more than one git repository — a `frontend/`, a `backend/`, maybe `workers/` or `infra/` — each with its own `.git`. GSD's **parent workspace** mode lets one `.gsd/` directory plan, verify, and commit across all of them as a single coordinated project, instead of running a separate GSD instance per repo.

## When to use it

Use parent workspace mode when:

- One milestone's work naturally touches more than one repository (e.g. an API contract change that updates both `backend` and `frontend`).
- You want a shared roadmap, shared requirements, and dependency ordering across repos.
- You want per-repository verification commands and commit policies (e.g. verify `infra` but never auto-commit it).

If your project is a single git repository (or a monorepo with one `.git`), you do **not** need this — the default `project` mode is correct and parent mode adds nothing.

## Layout requirement

Parent workspace mode requires child repositories to be **nested inside the project root**. Sibling-repo layouts are not supported.

```text
my-product/              ← run GSD here (the project root)
├── .gsd/                ← single GSD state directory
├── frontend/            ← child repo (its own .git)
├── backend/             ← child repo (its own .git)
└── workers/             ← child repo (its own .git)
```

This is a deliberate safety guard: declared repository roots back the task path-scope allowlist that `plan-slice` enforces, so paths must stay under the project root. To coordinate sibling repos, nest them under a common parent and run GSD from that parent.

## Setup

### Option A: via the wizard (`/gsd prefs`)

1. Run `/gsd prefs` and choose **Workspace**.
2. Set **Workspace mode** to `parent`.
3. Use **Add repository** for each child repo — give it an id (e.g. `frontend`), its path relative to the project root (e.g. `frontend`), and optionally a role, verification commands, and a commit policy (`auto` or `skip`).
4. Choose **Done**, then **Save & Exit**.

The `project` repository is always available implicitly (it points at the project root) and cannot be redefined.

### Option B: by hand

Create or edit `.gsd/PREFERENCES.md` at the project root:

```yaml
---
version: 1
workspace:
  mode: parent
  repositories:
    frontend:
      path: frontend
      role: web UI
      verification:
        - npm test
        - npm run lint
      commit_policy: auto
    backend:
      path: ./backend
      role: API server
      verification:
        - go test ./...
      commit_policy: auto
    infra:
      path: infra
      role: deployment
      commit_policy: skip        # plan + verify, but never auto-commit
---
```

Validation rules: repository ids must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `project` is reserved; paths must be relative, unique, and resolve inside the project root; `mode: parent` requires at least one repository. See [configuration.md](./configuration.md#workspace) for the full schema.

## Doctor and preference warnings

Run `/gsd doctor` after changing parent-workspace preferences. In `workspace.mode: parent`, doctor checks each declared child repository path:

| Issue code | What it means | Remediation |
|------------|---------------|-------------|
| `workspace_repo_path_missing` | The configured child repository path does not exist on disk. | Create or clone the child repository at that path, or fix the `workspace.repositories.<id>.path` value. |
| `workspace_repo_not_a_repo` | The path exists, but it is not a git repository at its own root. A plain directory nested inside the parent repo is not enough. | Clone the child repo into that directory, run `git init` there if it should be a new repo, or point the preference at the actual child repo root. |

GSD also warns when the effective merged preferences combine `mode: team` with `workspace.mode: parent`. Team branch-push and PR behavior still resolves at the project root, so it will not push child repositories. Keep using parent workspace mode for coordinated planning, verification, and commits, but push or open PRs for child repos manually, or use `mode: solo` if team branch automation is not needed.

## How it behaves

Once configured, parent mode changes four things — all of which default to single-repo behavior when `mode` is `project` (the default):

- **Repository targeting.** When a slice or task omits `targetRepositories`, GSD defaults to the declared child repositories rather than the root, so work is attributed to the repo it touches. The planner is prompted to assign `targetRepositories` per task from the declared list.
- **Codebase map.** `CODEBASE.md` enumerates tracked files per declared repository and renders a unified, repo-labelled map, so planning context spans the whole workspace.
- **Per-repository verification.** Each repo's `verification` commands run with that repo's directory as the working directory.
- **Per-repository commits.** Closeout commits honor each repo's `commit_policy` — `auto` commits in that repo, `skip` plans and verifies but leaves the repo untouched.

For runtime coordination, place a [project-local runtime contract](./local-runtime-contract.md) at the parent root. Subagents launched into nested child repositories inherit that authority, providing one documented startup and teardown path for the workspace.

## What is not yet supported

Parent workspace mode is being completed incrementally. The following are tracked as separate pieces of work and are **not** yet wired:

- **Per-repository git isolation** (worktree/branch per child repo). Isolation still operates at the project root; see ADR-044 for the design.
- **Per-repository push policy.** Push is resolved at the project root.

For the current status of each piece, see the parent-workspace epic ([#818](https://github.com/open-gsd/gsd-pi/issues/818)).
