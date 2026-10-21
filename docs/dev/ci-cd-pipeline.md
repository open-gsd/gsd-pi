# CI/CD Pipeline Guide

## Overview

**There is no publish pipeline that runs on merge.** `ci.yml` gates PRs and
pushes to `main`, and that is where automation stops. Every npm publish —
`@dev`, `@next`, and `@latest` — is a human running the **NPM Publish**
(`npm-publish.yml`) workflow by `workflow_dispatch`.

```
PR merged to main
        │
        ▼
   ci.yml (build, test, typecheck)   ← the merge gate
        │
        ├──▶ pipeline.yml            ← rebuilds the GHCR CI builder image only
        │                              (no npm publish, no dist-tag changes)
        │
        └──▶ (nothing else happens until a maintainer acts)

Maintainer runs NPM Publish (workflow_dispatch) with channel = dev | next | latest
        │
        ├── channel=dev    → publish + verify @dev from main
        ├── channel=next   → publish + verify @next from the next branch
        └── channel=latest → publish + verify @dev from main FIRST,
                             then plan release + build native binaries,
                             then WAIT for the `prod` environment approval,
                             then publish @latest, tag, GitHub Release, Docker
```

A merged PR sits on `main` unpublished until someone dispatches that workflow.
Do not wait for a dist-tag to move on its own — it will not.

## For Contributors: Testing Your PR Before It Ships

### Install a Published Build

The dist-tags below only advance when a maintainer runs **NPM Publish**, so a
tag can lag `main` by any amount of time:

```bash
# Most recent manually published dev build
npx @opengsd/gsd-pi@dev

# Most recent manually published next build
npx @opengsd/gsd-pi@next

# Stable production release
npx @opengsd/gsd-pi@latest    # or just: npx @opengsd/gsd-pi
```

### Using Docker

Only `:latest` and `:<version>` are pushed (by the `prod-release` job):

```bash
# Stable
docker run --rm -v $(pwd):/workspace ghcr.io/open-gsd/gsd-pi:latest --version

# A specific release
docker run --rm -v $(pwd):/workspace ghcr.io/open-gsd/gsd-pi:<version> --version
```

### Checking if a Fix Landed

1. Confirm the PR merged to `main` — that alone does **not** publish anything.
2. Check the current dist-tags: `npm view @opengsd/gsd-pi dist-tags`
3. If your fix is not in the version those tags point at, it has not been
   published yet. Ask a maintainer to run **NPM Publish** for the channel you
   need.

## For Maintainers

### Pipeline Workflows

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| CI | `ci.yml` | PR + push to `main`/`dev`/`test`/`hotfix/**` (+ manual dispatch) | Build, test, typecheck — **the merge gate** |
| NPM Publish | `npm-publish.yml` | `workflow_dispatch` only | **The only workflow that publishes to npm.** Publishes `@dev` or `@next`; for `@latest`, publishes and verifies `@dev` first, then waits for `prod` approval |
| Builder Image | `pipeline.yml` | After CI completes on `main`, or manual dispatch | Rebuilds `ghcr.io/open-gsd/gsd-ci-builder:latest` when `Dockerfile`, `package.json`, or `pipeline.yml` changed. Publishes nothing to npm |
| Native Binaries | `build-native.yml` | `workflow_dispatch` only | Cross-compile platform binaries; optional token-auth bootstrap publish |
| Dev Cleanup | `cleanup-dev-versions.yml` | Weekly (Monday 06:00 UTC) | Unpublish `-dev.` versions older than 30 days |
| Agent Workflow Guard | `agent-workflow-guard.yml` | PR changes to workflow files | Blocks workflow diffs that expand `allowed_non_write_users` |
| AI Triage | `ai-triage.yml` | Issues: opened/edited/reopened; PRs: opened/reopened; trusted `issue_comment` with `/rerun-triage` | Automated classification (not on every push) |
| Issue Dedupe | `issue-dedupe.yml` | Opened/edited/reopened issues + manual dispatch | Posts likely duplicate candidates once per issue |
| Issue Lifecycle | `issue-lifecycle.yml` | Label changes + schedule + manual dispatch | Adds lifecycle guidance comments and sweeps stale `needs-info` issues |

**CI optimization:** GitHub Actions minutes were reduced ~60-70% (~10k → ~3-4k/month) through workflow consolidation and caching improvements.

**CI refactor (2026-05):** Single `fast-gates` job, Linux build/test consolidation, path-gated Windows/Docker checks, and coverage moved out of the core CI path. Local parity: `verify:fast`, `verify:pr` (fast loop), **`verify:merge`** (PR blocking). See [Test confidence stack](./test-confidence-stack.md).

**Publish workflow hardening:**
- **Shallow clones** — downstream jobs use shallow checkout + shared build artifacts
- **pnpm cache** — the prerelease publish, prerelease verify, and production release jobs in `npm-publish.yml` use `cache: pnpm` on `setup-node`, saving ~1-2 min per job on repeat runs
- **Exponential backoff** — npm registry propagation waits use exponential backoff (10s → 20s → 40s → 60s cap in `npm-publish.yml`; 5s → 30s cap for native package verification) instead of fixed sleeps
- **Concurrent-publish guard** — every `npm publish` step treats "cannot publish over the previously published version" as an idempotent skip, but only after re-reading the dist-tag; if the tag does not point at the expected version the job fails loudly
- **dist-tag mutation is not automated** — npm trusted publishing authenticates `npm publish`, not dist-tag moves. When a version already exists and the tag points elsewhere, the workflow stops and prints the manual escape hatch: `npm dist-tag add @opengsd/gsd-pi@<version> <channel>`
- **Security hardening** — `${{ }}` expressions are passed through `env:` variables rather than interpolated directly into `run:` blocks, to prevent command injection vectors
- **Merge-queue PR uses `RELEASE_PAT`** — `GITHUB_TOKEN` cannot create PRs on this repo. The GitHub Release is created after the tag and before that PR so a PR-create failure cannot leave npm published with no GitHub Release

### CI job tiers

See [Test confidence stack](./test-confidence-stack.md) for the code-area → runner → local command map.

| Tier | Job(s) | When | Blocks merge? |
|------|--------|------|---------------|
| Fast gates | `fast-gates` | Every PR/push (secrets, docs injection, skill refs, PR policy, tier-map drift) | Yes |
| Build + Linux tests | `build` | `heavy-code-changed=true` — compile, package validation, unit/package/integration/e2e tests with one install | Yes |
| Coverage | `Coverage report` workflow | Manual, weekly schedule, or PR labeled `coverage` | Separate workflow |
| Platform | Docker e2e step in `build`, `windows-portability` | Path-gated; Docker runs only when `docker-changed=true`, Windows runs only when portability paths change | Yes when triggered |
| Platform (warn) | Windows e2e smoke step inside `windows-portability` | `windows-e2e-changed=true` | **No** (`continue-on-error: true`) |

**Local before review:** run `npm run verify:merge:needed -- --base upstream/main` first. If it reports `heavy-code-changed=true`, then run `npm run verify:merge` for sequential parity with the PR-blocking Linux jobs above (except path-gated platform jobs). If not, `verify:fast` plus targeted checks is usually sufficient.

**Branch protection:** Required checks should include `fast-gates` and `build` for full Linux merge confidence. Keep `windows-portability` required only if GitHub branch protection is configured to handle skipped path-gated checks correctly.

### Build-Relevant Change Detection

`scripts/ci-classify-changes.sh` (run inside `fast-gates`) classifies the diff before expensive jobs run.

- **Skipped when doc/metadata only:** `build`, Linux test steps, Docker e2e, `windows-portability`
- **Still runs:** `fast-gates` (all security and policy scans)
- **`web-changed`:** reserved for future path gating (web host always builds in `build` because `validate-pack` requires `dist/web/standalone/server.js`)

### Prompt Injection Scan

`fast-gates` runs `scripts/docs-prompt-injection-scan.sh` against the PR merge base (`CI_DIFF_REF`, not hardcoded `origin/main`). It scans documentation prose (excluding fenced code blocks) for patterns that could manipulate LLM behavior when docs are ingested as context:

- **System prompt markers** — `<system-prompt>`, `<|im_start|>system`, `[SYSTEM]:`
- **Role/instruction overrides** — `ignore previous instructions`, `you are now`, `new instructions:`
- **Hidden HTML directives** — `<!-- PROMPT:`, `<!-- INSTRUCTION:`
- **Tool call injection** — `<tool_call>`, `<function_call>`, `<invoke`
- **Invisible Unicode** — zero-width character sequences that hide directives

Content inside fenced code blocks (` ``` `) is excluded — patterns in code examples are expected and legitimate.

**False positives:** Add exceptions to `.prompt-injection-scanignore` using the same format as `.secretscanignore` (one pattern per line, `file:regex` for file-scoped exceptions).

### Gating Tests

`ci.yml` is the merge gate. Key gating tests include:

- **Unit tests** (`npm run test:unit`) — includes `auto-session-encapsulation.test.ts` which enforces that all auto-mode state is encapsulated in `AutoSession`, plus dispatch loop regression tests that exercise the full `deriveState → resolveDispatch → idempotency` chain without an LLM. Any PR adding module-level mutable state to `auto.ts` will fail CI.
- **Integration tests** (`npm run test:integration`)
- **E2E tests** (`npm run test:e2e`)
- **Extension typecheck** (`npm run typecheck:extensions`)
- **Package validation** (`npm run validate-pack`)

`npm-publish.yml` re-runs its own gates on every dispatch, because
`npm publish --ignore-scripts` skips the `prepublishOnly` hook:

- **Extension typecheck** (`npm run typecheck:extensions`) and **version sync** (`npm run verify:version-sync`) — `prepublishOnly` parity, run after version stamping
- **Smoke tests** (`npm run test:smoke`) — against the freshly built `dist/loader.js`, then again in `prerelease-verify` against the globally installed published package
- **Native platform packages** (`npm run verify:native-platform-packages`) and **package validation** (`npm run validate-pack`)
- **Live regression tests** (`npm run test:live-regression`) — against the installed prerelease binary, and again against the release build in `prod-release`
- **Auto-mode acceptance bed** (`npm run test:auto-acceptance`) — a blocking `prerelease-verify` gate against the globally installed published binary; `channel=latest` must pass this gate on `@dev` before production release planning can begin
- **Live LLM tests** (`npm run test:live`, `npm run test:live-workflow`) — `prod-release` only, `continue-on-error: true` (non-blocking warnings)
- **Release verification** (`node scripts/verify-npm-release.mjs <version>`) — final gate confirming the main, engine, and workspace packages are all on npm at the release version before the tag is pushed

### Publishing a Prerelease (`@dev` / `@next`)

1. In GitHub Actions, run **NPM Publish**.
2. Set `channel` to `dev` or `next`. `dev` defaults to the `main` branch and `next` defaults to the `next` branch; override with the `ref` input for a standalone publish from another branch or SHA.
3. Leave `publish_auth` at `trusted` (OIDC) unless you are bootstrapping a package that does not exist on npm yet — see [First-time packages](#first-time-packages-bootstrap-with-token).
4. `prerelease-publish` builds, stamps the prerelease version, runs the gates, publishes with `--tag <channel>`, and polls npm until the version installs. `prerelease-verify` then installs the published package globally and runs the installed-binary gates listed above.

Nothing moves to `@latest` as a side effect of this. A production release is a separate dispatch.

### Publishing a Production Release (`@latest`)

1. In GitHub Actions, run **NPM Publish** with `channel=latest`. This always uses `main`, ignoring the `ref` input.
2. The workflow publishes and verifies `@dev` from `main` first (the same `prerelease-publish` + `prerelease-verify` jobs), then `prod-release-plan` generates the changelog and computes the version, and `prod-native-build` builds all five native binaries.
3. `prod-release` targets the `prod` environment and shows "Waiting for review". Click **Review deployments** → select `prod` → **Approve**.
4. After approval the workflow re-checks that `main` has not moved, bumps and commits the version, publishes the matching `@opengsd/engine-*` packages, verifies they are visible on npm, publishes the `@opengsd` workspace packages, publishes `@opengsd/gsd-pi@latest`, runs `verify-npm-release.mjs`, pushes the release commit and `v<version>` tag, creates the GitHub Release, pushes the Docker images, and opens a back-merge PR from `main` into `next` if needed.

If a step fails after the version is already on npm, the dist-tag may be left behind — trusted publishing cannot move it. Move it by hand:

```bash
npm dist-tag add @opengsd/gsd-pi@<version> <channel>
```

### Rolling Back a Release

If a broken version reaches production:

```bash
# Roll back npm
npm dist-tag add @opengsd/gsd-pi@<previous-good-version> latest

# Roll back Docker
docker pull ghcr.io/open-gsd/gsd-pi:<previous-good-version>
docker tag ghcr.io/open-gsd/gsd-pi:<previous-good-version> ghcr.io/open-gsd/gsd-pi:latest
docker push ghcr.io/open-gsd/gsd-pi:latest
```

For `@dev` or `@next`, roll back the same way (`npm dist-tag add`) or re-run **NPM Publish** for that channel from a good ref. Nothing overwrites those tags on its own.

### GitHub Configuration Required

| Setting | Value |
|---------|-------|
| npm Trusted Publisher workflow filename | `npm-publish.yml` (for every package in the release set) |
| Environment: `dev` | No protection rules (used by `channel=dev`, and by the `@dev` leg of `channel=latest`) |
| Environment: `next` | No protection rules (used by `channel=next`) |
| Environment: `prod` | Required reviewers: maintainers — this is the approval gate for `@latest` |
| Secret: `NPM_TOKEN` | Not required for trusted publishing; set for token-fallback bootstrap/manual native publishes (`publish_auth=token`) |
| Secret: `RELEASE_PAT` | Prod release checkout, tag push, and the merge-queue version-bump PR when branch rules reject a direct push to `main`. `GITHUB_TOKEN` cannot create PRs on this repo. |
| Secret: `ANTHROPIC_API_KEY` | Prod environment only (non-blocking live LLM tests) |
| Secret: `OPENAI_API_KEY` | Prod environment only (non-blocking live LLM tests) |
| Secret: `DISCORD_CHANGELOG_WEBHOOK` | Optional — release announcement; the step tolerates a missing webhook |
| GHCR | Enabled for the `open-gsd` org |

### npm Trusted Publishing (all packages)

npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) binds each package to a single GitHub Actions workflow filename. It can only be configured **after** a package already exists on npm — you cannot set it up for packages that return 404.

#### First-time packages (bootstrap with token)

Use this when any `@opengsd/engine-*` package is missing from npm (today: `@opengsd/engine-darwin-x64`, `@opengsd/engine-linux-x64-gnu`).

1. Create an npm [automation token](https://www.npmjs.com/settings/opengsd/tokens) with **Publish** access to the `@opengsd` scope (must be allowed to create new packages under the org).
2. Add the token as repository secret **`NPM_TOKEN`** (GitHub → repo → Settings → Secrets and variables → Actions).
3. Run [Build Native Binaries](https://github.com/open-gsd/gsd-pi/actions/workflows/build-native.yml):
   - `publish`: **true**
   - `platform_packages_only`: **true**
   - `publish_auth`: **token** ← required for packages that do not exist yet
4. Confirm all five packages resolve: `npm view @opengsd/engine-darwin-x64 version` (and the other four).
5. **Then** configure trusted publishing on each package as described below.
6. Re-run **NPM Publish** with the desired channel.

The publish step skips packages already on npm and attempts all five platforms before failing, so one error does not leave the rest unpublished.

#### Trusted publishing (after first publish)

Configure **every** package on [npm package settings](https://www.npmjs.com/settings/opengsd/packages) → package → **Publishing access** → **Trusted Publisher**. Use `npm-publish.yml` for the root package, every native engine package, and every publishable workspace package returned by `node scripts/lib/npm-release-packages.cjs`; that script is the authoritative release-set inventory.

For all packages: repository **`open-gsd/gsd-pi`**, environment **(none)**.

After trusted publishing is configured, use **NPM Publish** with `channel=latest` and `publish_auth=trusted` (default) for routine production publishes. The standalone **Build Native Binaries** workflow remains useful for manual binary builds and token-based bootstrap publishes, but trusted production native package publishing belongs to `npm-publish.yml` so the prod workflow can publish a single coherent version end to end.

### Docker Images

| Image | Base | Purpose | Tags |
|-------|------|---------|------|
| `ghcr.io/open-gsd/gsd-ci-builder` | `node:24-bookworm` | CI build environment with Rust toolchain | `:latest`, `:<date>` |
| `ghcr.io/open-gsd/gsd-pi` | `node:24-slim` | User-facing runtime | `:latest`, `:<version>` |

The runtime image is built and pushed only by the `prod-release` job in `npm-publish.yml`, so it exists only for approved `@latest` releases. There is no `:next` runtime tag.

The CI builder image is rebuilt by `pipeline.yml` when `Dockerfile`, `package.json`, or `pipeline.yml` changes on `main` (or on manual dispatch). It eliminates ~3-5 min of toolchain setup per CI run, and `npm-publish.yml` runs its prerelease job inside it.

## Live Test Suites

There is no recorded-fixture replay system. The suites that exercise a real binary are:

```bash
npm run test:smoke             # tests/smoke — CLI smoke tests against GSD_SMOKE_BINARY
npm run test:live-regression   # tests/live-regression — runtime regressions against an installed binary
npm run test:auto-acceptance   # tests/acceptance-bed — auto milestone flow against an installed binary
npm run test:live              # tests/live — real provider calls, needs API keys (GSD_LIVE_TESTS=1)
npm run test:live-workflow     # tests/live-workflow — real end-to-end workflow run
```

`test:smoke`, `test:live-regression`, and `test:auto-acceptance` read `GSD_SMOKE_BINARY` — point it at
`dist/loader.js` for a local build or at `$(which gsd)` for an installed
package, exactly as `npm-publish.yml` does.

## Version Strategy

| Tag | Published | Format | Who uses it |
|-----|-----------|--------|-------------|
| `@dev` | Manual **NPM Publish** with `channel=dev` (from `main`) | `2.27.0-dev.a3f2c1b` | Developers verifying fixes |
| `@next` | Manual **NPM Publish** with `channel=next` (from `next`) | Prerelease stamp | Early adopters, beta testers |
| `@latest` | Manual **NPM Publish** with `channel=latest` + `prod` environment approval | `2.27.0` | Production users |

The prerelease version stamp is produced by `npm run pipeline:version-stamp`;
platform package versions are synced by `npm run sync-platform-versions`.

Old `-dev.` versions are removed weekly by `cleanup-dev-versions.yml` (30-day retention).
