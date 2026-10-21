# Evidence — codebase

<!-- Written by the codebase mapper during $gsd-path-onboard. Read by the grill
     (brownfield mode), researchers (fifth standard dimension), the planner
     (conventions are binding), and reviewers. -->

Repo root: /Users/jeremymcspadden/github/open-gsd/gsd-pi
Scanned: 2026-08-01 (clean HEAD `ade9db0e4cb7c69440000fa81630091f56dbdcd1`, via disposable worktree `.worktrees/onboard-codebase`)
Updated: 2026-08-10 to remove retired legacy remote-product surfaces from the current-state map.
Checks run (all inside the disposable worktree at clean HEAD):
- `pnpm install --frozen-lockfile --ignore-scripts` → success in 10.1s (lockfile 9.0, pnpm 10.12.1)
- `npx tsc --noEmit -p tsconfig.json` → exit 0, zero errors
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/parse-cli-args.test.ts` → 45/45 pass, 0 fail
- `node --experimental-strip-types src/loader.ts --version` → fails `ERR_MODULE_NOT_FOUND` for `./app-paths.js` — src uses compiled `.js` import specifiers, so direct TS execution needs the repo's `resolve-ts.mjs` import hook or a `tsc` build; not a defect
- Full test suite (`pnpm test`) → `unverifiable` within budget (compiles 1347+ test files plus integration/e2e tiers); spot checks above only

## Map

- **Stack**: TypeScript 5.9.3 (strict, NodeNext/ES2022, ESM `"type": "module"`) on Node >= 22.18.0 (engines; dev/CI run Node 24, `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` in `.github/workflows/ci.yml:24`). pnpm 10.12.1 monorepo (`pnpm-workspace.yaml`: `packages/*`, `extensions/*`, `web`). Rust 2021 workspace (`native/Cargo.toml`, crates `ast`, `engine`, `grep`) built to platform binaries shipped as optional npm deps `@opengsd/engine-{darwin,linux,win32}-*` v1.11.0. Next.js 16.2.11 + React 19 + Radix web app (`web/package.json`). Electron 41 + React 19 in `studio/` (outside workspace). Drizzle ORM + neon-http stub in `packages/db`. Test runner: Node built-in `node --test` with `--experimental-strip-types` and a custom `resolve-ts.mjs` import hook — no Jest; vitest appears exactly once (`test:pi-claude-schemas` for one pi-ai file). Coverage via c8 with low floors (statements/lines 40, branches/functions 20 — `package.json:95`).
- **Entry points**: CLI binaries `gsd` / `gsd-cli` → `dist/loader.js` (source `src/loader.ts`, fast-paths `--version`/`--help` before heavy imports, runtime Node/git checks), `gsd-pi` → `scripts/install.js`. `src/cli.ts` lazy-loads `@gsd/pi-coding-agent`, `@gsd/agent-core`, `@gsd/agent-modes` (interactive / print / rpc modes). Retained service bins are `gsd-daemon` (`packages/daemon`) and `gsd-mcp-server` (`packages/mcp-server`). Web surface via `gsd --web` → `src/cli-web-branch.ts` → `web/` Next.js standalone (`scripts/stage-web-standalone.cjs`). Rust engine loaded via `@gsd/native`.
- **Architecture**: Four concentric layers. (1) Vendored upstream agent runtime in `packages/pi-*` (`pi-coding-agent`, `pi-ai` providers for Anthropic/OpenAI/Google/Mistral/Bedrock/Vertex, `pi-tui`, `pi-agent-core`) — vendored from `earendil-works/pi`. (2) GSD wrappers in `packages/gsd-agent-core`, `gsd-agent-modes`, `contracts`, `rpc-client`, `mcp-server`, and `daemon`. (3) The actual GSD product: a bundled extension at `src/resources/extensions/gsd` (29 MB, 2214 files) implementing milestones/slices/tasks, auto mode, worktree lifecycle, and a SQLite (sql.js) DB-authoritative project state (`db-*.ts` schema files) projected to `.gsd/`. (4) Root `src/` CLI shell (loader, cli, headless mode, web branch, worktree CLI) plus 20+ other bundled extensions under `src/resources/extensions/`. Run flow: `gsd` → loader → cli → resource loader discovers bundled/user extensions → agent-modes interactive TUI (or headless/RPC/web) → gsd extension drives plan/implement/verify loops, mutating the state DB and git worktrees.
- **Conventions**: Conventional Commits (`fix(scope):`, `feat(scope):`, `test:`, `chore:`) plus a repo-specific `no-mistakes(scope):` prefix (36 in last 2 weeks) tied to the 'no mistakes' skill in AGENTS.md. Tests are colocated `*.test.ts` run directly from TypeScript via the strip-types hook; a compile-to-`dist-test` tier exists for the full unit suite (`test:compile`). Numbered plan files in `plans/` (`plans/032-lean-mean-cleanup.md`) AND a second tracked `.plans/` dir; ADRs in `docs/dev/ADR-*.md`; single 67 KB `CONTEXT.md` at root as the canonical context doc (per `docs/agents/domain.md`). Numbered scripts over npm abstractions — 108 entries in `scripts/` plus `scripts/archive/`. Baseline/gate scripts (`baseline:refactor:gate`, `gate:semantic-shadow-no-cutover`, `legacy:cleanup:gate`) encode in-flight refactor invariants as runnable checks. VISION.md explicitly forbids DI containers, framework swaps, cosmetic refactors — "extension-first", "simplicity over abstraction".
- **Maturity**: Actively shipped product: v1.11.0 on npm as `@opengsd/gsd-pi` with provenance, Docker images, Discord release automation, ~21 GitHub workflows. Root typecheck is clean at HEAD and the spot-checked unit file passes 45/45. Test surface is very large (1347 `*.test.ts` under `src/` including 1106 in the gsd extension alone; 388 in `packages/`; separate `tests/{smoke,live,live-regression,live-workflow,e2e}` tiers) but enforced coverage floors are low (40/40/20/20). Scaffolding/half-built: `studio/` (Electron, v0.0.0, not in workspace), `packages/db` (no package.json, self-described "stub for Phase 1"), `gsd-orchestrator/` (markdown-only skill bundle), `integrations/hermes` (Python plugin).
- **Recent activity**: Last ~30 commits (through 2026-07-31) cluster on: prompt-size reduction and `system.md` prompt contract repairs (schema sanitization across pi-ai providers), cursor-cli stream-adapter echo filtering, headless `--bare` RPC child fix, a "lean cleanup" dead-code/dependency purge (#1580), verification-gate and gsd_task_complete issue fixes (#1566–#1572), and standalone mcp-server npm install. I.e. maintenance/fix density on the gsd extension and CLI shell, not new-feature greenfield.

## Finding: The repo's center of gravity is inverted — the product is a bundled "extension", not the packages

- **Claim**: The GSD domain logic (milestones, auto mode, worktree automation, state DB) lives in `src/resources/extensions/gsd` — 29 MB, 2214 files, 1106 test files, 100+ `db-*.ts` schema modules — while `packages/` holds the vendored generic agent runtime.
- **Source**: `du -sh src/resources/extensions/gsd` → 29M; `find src/resources/extensions/gsd -type f | wc -l` → 2214; `find src/resources/extensions/gsd -name '*.test.*' | wc -l` → 1106; `packages/pi-coding-agent/package.json:3` → "Coding agent CLI (vendored from earendil-works/pi)"; boundary guards `verify:pi-boundary` / `verify:pi-patches` in `package.json:91-92`.
- **Confidence**: high
- **Why it matters here**: A planner reading the monorepo layout would assign new behavior to `packages/`; nearly all product behavior actually belongs in the extension tree, which has its own conventions (DB-authoritative state, projection, gate baselines). Editing `packages/pi-*` also trips upstream-sync boundary checks.

## Finding: Tests run straight from TypeScript via Node's strip-types and a custom resolver hook

- **Claim**: The entire main suite uses `node --test --experimental-strip-types` with `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs` to resolve `.js` specifiers to `.ts` sources; running any TS file directly without that hook fails with `ERR_MODULE_NOT_FOUND`.
- **Source**: `package.json:84,96` (test scripts); observed failure of `node --experimental-strip-types src/loader.ts --version` → `Cannot find module '.../src/app-paths.js'`; success of the same pattern with the hook → 45/45 pass in `src/tests/parse-cli-args.test.ts`.
- **Confidence**: high
- **Why it matters here**: Any new test, script, or automation that invokes TS files must replicate the hook import or it breaks confusingly; CI and agents must copy this invocation exactly.

## Finding: packages/db is a consumerless stub for a cloud state mirror

- **Claim**: `packages/db` contains a Drizzle ORM + neon-http client and GSD-state mirror schema marked "stub for Phase 1, expanded in Phase 2", has no `package.json` (so it is not a pnpm workspace package despite matching `packages/*`), and has no importers anywhere in the repo.
- **Source**: `packages/db/src/schema/gsd-state.ts:1` ("stub for Phase 1"); `packages/db/src/client.ts:1-27`; `ls packages/db` → only `src`, `tests`; grep for `packages/db` / `@opengsd/db` across `*.ts`/`*.mjs` → no consumers; recent commits `e71db0d0d`/`e9b4832b6` still maintain it.
- **Confidence**: high (stub + unwired); medium (intended future role)
- **Why it matters here**: Classic half-built area — a planner could either build on it assuming it's live, or delete it assuming it's dead. Only the user can say which phase it's actually in.

## Finding: The published package still ships a `@glittercowboy/gsd` shim from the abandoned upstream

- **Claim**: Root `package.json` `files` includes `pkg/`, and `pkg/package.json` is named `@glittercowboy/gsd` v1.11.0 — the original pre-fork maintainer's npm scope — while the real package is `@opengsd/gsd-pi`.
- **Source**: `package.json:26` (`"pkg"` in files), `pkg/package.json:2` (`"name": "@glittercowboy/gsd"`), `package.json:2` (`"@opengsd/gsd-pi"`); VISION.md documents the fork after the original maintainer abandoned the project.
- **Confidence**: high (fact); medium (that it's a deliberate upgrade/migration alias — likely tied to `src/pi-migration.ts`, inference)
- **Why it matters here**: Release/packaging work (`prepack`, `postpack`, `validate-pack`) must keep this alias in sync; someone "cleaning up" the old name could break upgrades for legacy installs.

## Finding: Extension modularization is mid-flight — google-search exists twice

- **Claim**: The working google-search extension moved to the workspace package `extensions/google-search` (`@gsd-extensions/google-search`), while the bundled copy at `src/resources/extensions/google-search/index.ts` is now a one-line deprecation stub; the two files differ.
- **Source**: `diff extensions/google-search/index.ts src/resources/extensions/google-search/index.ts` → stub comment "Deprecation stub for google-search (moved to @gsd-extensions/google-search)"; `extensions/google-search/package.json` name field; ADR-006-extension-modularization in `docs/dev/`.
- **Confidence**: high
- **Why it matters here**: Shows the migration direction (bundled `src/resources/extensions/*` → workspace `extensions/*`) is incomplete; a planner must know which of the two copies of any extension is authoritative before editing.

## Finding: An in-flight refactor is enforced by executable baseline/gate scripts

- **Claim**: The repo carries runnable gates — `baseline:refactor:gate`, `baseline:refactor:phase0`, `gate:semantic-shadow-no-cutover`, `legacy:cleanup:gate`, `audit:test-confidence/gaps/matrix` — plus `docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md`, indicating a long-running refactor (state-DB cutover, legacy cleanup) whose invariants are encoded as scripts.
- **Source**: `package.json:75-83,129-131`; `docs/dev/` listing; `scripts/refactor-baseline.mjs`, `scripts/semantic-shadow-no-cutover-gate.mjs` exist.
- **Confidence**: high (gates exist and are wired into scripts); medium (current phase status)
- **Why it matters here**: Changes near state/projection/legacy surfaces can fail these gates in ways ordinary tests won't reveal; the planner should treat the gate scripts as binding constraints and learn the refactor's current phase from the user.

## Finding: studio/ (Electron desktop app) is outside the workspace and CI

- **Claim**: `studio/` is an Electron 41 + React 19 + Tailwind 4 app at v0.0.0 with its own test script, but it is not in `pnpm-workspace.yaml` (only `packages/*`, `extensions/*`, `web`) and no root script or CI workflow references it.
- **Source**: `pnpm-workspace.yaml:1-4`; `studio/package.json:1-12`; grep for `studio` in root `package.json` and `.github/workflows/` → no matches.
- **Confidence**: high
- **Why it matters here**: A "desktop app" assumption would be wrong — it's unscaffolded-but-unwired; dependency installs and tests there don't run in the normal flow, and its relationship to `web/` (the shipped UI) is undefined.

## Finding: Multiple parallel plan/docs trees coexist

- **Claim**: Three documentation systems (`docs/`, `gitbook/`, `mintlify-docs/`) and two tracked plan directories (`plans/` with 33 files, `.plans/` with 23+ files) are all committed; `.planning/` exists locally but is untracked.
- **Source**: `ls docs gitbook mintlify-docs`; `git ls-files plans | wc -l` → 33; `git ls-files .plans` → tracked entries (e.g. `.plans/issue-524-git2-migration.md`); `git ls-files .planning | wc -l` → 0.
- **Confidence**: high
- **Why it matters here**: The planner must know which tree is authoritative (AGENTS.md says `CONTEXT.md` + `docs/dev/`) or documentation updates will land in the wrong place and plan files will fork.

## Finding: Coverage enforcement is nominal relative to test volume

- **Claim**: Despite ~1700+ test files and dedicated coverage jobs, the enforced thresholds are statements 40 / lines 40 / branches 20 / functions 20.
- **Source**: `package.json:95` (`--check-coverage --statements=40 --lines=40 --branches=20 --functions=20`); counts from `find src -name '*.test.ts'` → 1347, `find packages -name '*.test.ts'` → 388.
- **Confidence**: high
- **Why it matters here**: "Has many tests" ≠ "coverage gate will catch regressions"; reviewers and the planner should rely on colocated test intent (per AGENTS.md rule 9) rather than assuming the coverage gate is a safety net.

## Finding: Recent history is heavily machine-authored

- **Claim**: In the last 3 months, commit authors include `Cursor Agent` (365), `Flux Labs` (319), `PatchDeck` (219), `Claude` (15) alongside `Jeremy McSpadden`/`jeremymcs` (2449), and PR-titled fix commits referencing issue numbers dominate (`fix(issue): ... (#1566)`).
- **Source**: `git log --since='3 months ago' --format='%an' | sort | uniq -c | sort -rn`; `git log --oneline -30`.
- **Confidence**: high
- **Why it matters here**: Explains the repo's process artifacts (no-mistakes commits, gate scripts, AGENTS.md rules about AI behavior) — this codebase is actively developed by agent loops, so onboarding guidance and conventions are written for agent consumers, not just humans.

## Apparent intent

<!-- Inference, clearly flagged — what the project seems to be becoming. -->

- gsd-pi is a **multi-surface agent orchestration platform** rather than only a CLI: terminal, headless/RPC, MCP, daemon, and web surfaces are active; `studio/` remains dormant and `packages/db` remains a hosted-state stub.
- The project is **migrating bundled extensions out of `src/resources/extensions/` into workspace packages** (`extensions/*`) and simultaneously **migrating project state from filesystem to a DB-authoritative model with file projection** ("semantic-shadow-no-cutover" gate, `db-*-schema.ts` modules, single-writer-invariant tests) — based on the google-search stub, ADR-006, and gate scripts. Both migrations are incomplete.
- It intends to keep **tracking upstream `earendil-works/pi`** as a vendored base with enforced patch boundaries rather than fork-and-forget — based on `verify:pi-boundary`, `verify:pi-patches`, and the "vendored from" package descriptions.

## Open questions for the grill

<!-- What only the user can settle about this codebase. -->

- Is `packages/db` (Drizzle/neon) still the planned hosted-state path, or superseded — should new work build on it or ignore it?
- Which plan directory is authoritative for new work: `plans/`, `.plans/`, or local `.planning/` — and should the others be consolidated?
- What is the intended fate of `studio/` (Electron): active next surface, paused experiment, or dead scaffolding to remove?
- What is the current phase of the long-running state-DB refactor (`refactor-baseline`, `semantic-shadow-no-cutover` gate) — which surfaces are frozen vs. safe to change?
- Is the `@glittercowboy/gsd` pkg shim a permanent upgrade alias for legacy installs, and does it need version sync on every release?
- For extensions present in both `src/resources/extensions/` and `extensions/`, which copy is authoritative during the modularization migration, and which extensions migrate next?
- Are the low c8 coverage floors (40/40/20/20) deliberate policy, or debt to raise?

## Blocked areas

<!-- What could not be inspected and why. "none" if clean. -->

- Full test suite (`pnpm test`) — not run: it compiles and executes 1300+ test files plus integration/e2e tiers; beyond the disposable-worktree time budget. Spot checks (typecheck clean, one unit file 45/45) only.
- `native/` Rust build — not run: requires cargo toolchain and platform build; verified statically via `native/Cargo.toml` and crate layout only.
- `web/` and `studio/` builds — not run: separate toolchains (Next build and electron-vite) outside the core verification gate.
- `.gsd` symlink target (`/Users/jeremymcspadden/.gsd/projects/d311c3f098d1`) — not inspected: external live state directory outside the repo (per ADR-002), read-only scope is the repo itself.
