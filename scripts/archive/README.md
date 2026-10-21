# scripts/archive

Completed one-off migration, verification, benchmark, and demo tools from past
development phases. Nothing here is referenced by `package.json` (root or
`packages/*`), `.github/workflows/`, `.github/actions/`, `Dockerfile`,
`docker/`, `docs/`, `gitbook/`, `mintlify-docs/`, `CONTRIBUTING.md`,
`AGENTS.md`, `README.md`, `src/`, `tests/`, or by any script that remains at
`scripts/` top level.

Evidence per file (searches run: `git grep` for the full filename, for
`scripts/<name>` path tokens, and for the basename without extension across
all tracked files excluding `CHANGELOG.md`; plus a relative-import scan of
`require('./…')` / `import './…'` among kept scripts):

- `migrate-pi-clean-seam.cjs` — one-time migration helper that moved GSD code
  from pi-coding-agent into gsd-agent-core / gsd-agent-modes per ADR-010.
  Zero references anywhere outside its own file.
- `parallel-monitor.mjs` — zero-dependency ANSI TUI dashboard for monitoring
  parallel GSD auto-mode workers during a past swarm phase. Zero references
  outside its own file.
- `rtk-benchmark.mjs` — benchmark harness for the managed RTK binary. Zero
  references outside its own file.
- `summarize-prompt-context.cjs` — CLI that summarizes prompt-context debug
  events from GSD debug logs. Referenced only by its own regression test
  (archived beside it in `__tests__/`); no other references.
- `__tests__/summarize-prompt-context.test.cjs` — regression tests for
  `summarize-prompt-context.cjs`. Archived with its subject; the relative
  `require("../summarize-prompt-context.cjs")` still resolves, and the
  `scripts/__tests__/*` fast-gates glob no longer picks it up.
- `sync-agent-core-upstream.cjs` — one-time refresh of the gsd-agent-core
  session layer from upstream v0.75.5. Zero references outside its own file.
- `tui-open-surface-demo.mjs` — visual harness for ADR-019 rendering migrated
  TUI surfaces for copy-testing. Zero references outside its own file.
  (Package-relative imports adjusted `../packages/…` → `../../packages/…`
  so it still runs from its new location.)
- `verify-s03.sh` — one-off S03 milestone verification (first-run optional
  tool key wizard). Zero references outside its own file.
- `verify-s04.sh` — one-off S04 milestone verification (npm pack tarball
  install smoke test). Zero references outside its own file.
- `live-regression-benchmark.ts` — manual quick-command idle-timer
  benchmark. `test:live-regression` now runs `tests/live-regression/run.ts`.
  Zero references outside its own file and the 032a/045 audit notes.

Kept despite looking stale (referenced, so not eligible to move):

- `scripts/base64-scan.sh` — spawned by `scripts/ci-fast-gates.sh:26`
  (CI fast gates); its test stays in `scripts/__tests__/`.
- `scripts/ci_monitor.md` — zero inbound references, but it is the usage doc
  for `scripts/ci_monitor.cjs`, which is referenced by the shipped skill
  `src/resources/skills/github-workflows/SKILL.md`.
- `scripts/recover-gsd-{1364,1668}.{sh,ps1}`, `scripts/validate-pack.sh`,
  `scripts/watch-resources.js`, `scripts/preview-dashboard.ts` — referenced
  by `docs/dev/FILE-SYSTEM-MAP.md`.
- `scripts/m003-s07-*`, `scripts/semantic-shadow-no-cutover-gate.mjs`,
  `scripts/workflow-authority-baseline.mjs` — referenced by `docs/dev/`
  M003-S07 research/runbook documents.
- The pi vendoring chain (`vendor-pi*.cjs`, `apply-seam.cjs`,
  `apply-gsd-pi-package-json.cjs`, `normalize-pi-imports.cjs`,
  `restore-pi-tsconfig.cjs`, `generate-pi-coding-agent-index.cjs`,
  `trim-pi-coding-agent-index.cjs`, `pi-seam.json`, `pi-upstream.json`) —
  referenced by `docs/dev/pi-upstream.md` and spawned via `execSync` by the
  kept vendor scripts.
- `scripts/baselines/` — `scripts/auto-dispatch-baseline.mjs` (package.json
  script) reads/writes `scripts/baselines/auto-dispatch-<sha>.json`.
