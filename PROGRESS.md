# gsd-pi progress

## FTM upstream sync automation (2026-10-12)

Added `scripts/ftm-sync-upstream.sh`, weekly
`.github/workflows/ftm-sync-upstream.yml`, `scripts/ftm-deploy-local.sh`, and
`docs/FTM-UPSTREAM-SYNC.md`. Pin source is the latest GitHub release on
`open-gsd/gsd-pi`. When planned, fork was on **1.21.1** while upstream had
released **v1.22.0** (same day). Gate is `build:web-host` only; conflicts open
a human PR. Local deploy rebuilds standalone and restarts
`raidnight-gsd-staging` only when the coding slot is idle.

### sync/upstream-v1.22.0 conflict resolution

WIP merge `a8b1c69b` had markers in `auto-timers.ts`, `verification-gate.ts`,
and two verification tests. Resolution: keep FTM `host-check-runner` path +
`abortSignal`/`logDir`; import both `shouldRefuseNewWork` and
`getCurrentTurnGeneration` in auto-timers; take upstream `withRtkDisabled`
restore helper + event-loop verify test. Script now requires real GitHub CLI
(`gh version`), not a conda/browser `gh` shim, and rebuilds
`pi-coding-agent` + `agent-core` before `build:web-host`. Gate passed after
that rebuild.

## FTM in-place hotfixes (2026-10-12)

Applied `TEMP/gsd-pi-ftm-inplace-hotfixes.patch`: allow auto-mode compaction
via core thresholds; reset abandoned destructive-confirmation at `agent_end`;
estimate full history when local usage tokens are zero; run `checkCompaction`
from `prepareNextTurn` between tool turns. `@gsd/agent-core` build OK. See
`TEMP/gsd-pi-ftm-inplace-hotfixes-notes.md` (gitignored under `TEMP/`).

## Phase C orphan recover cleanup (2026-10-12)

Idle recover cancels sibling `recovery_required` ops on the same job
(`native-commands.ts` `reconcileIdleRecovery`); startup cancels orphans whose
`recovery_id` is already applied (`control.ts`). Tests added in
`c06-native.test.ts`. Rebuilt via `pnpm run build:web-host`; restarted
`raidnight-gsd-staging` once with coding slot idle. Cleared live orphan
`27ab9fa9` so `quake-smoke:M001` could project `completed`.
Authoritative acceptance write-up:
`/home/blasky/Projects/FirstTracks/raid-night/docs/migration/reports/CONSOLIDATION-2026-10-12.md`.

R5 save-point: a paused resume clears the cancellation flag before the loop, and recover releases a start that never created a worker when the slot is idle. Resume `22b934a8` is reconciled. Start `f79ce0bc` is in `validate-milestone`. Do not bundle `auto-dispatch` into the Next host.

Save-point for future agents. This is the GSD fork worktree
(`migration/raidnight-native`) used for RaidNight native migration.
Do not write raid-night, product, or quake-cockpit from a gsd-pi C07
session unless the prompt names that repo.

## C16-R5 staging acceptance (2026-09-24)

Execute-task dispatch now adopts the milestone and slice canonical lifecycles that slice completion requires, then claims the running Attempt. Staging was restarted onto the compiled resource. C17 was not started.

## C16-R4 direct backend qualification (2026-09-23)

R5 was not started. The packaged worker still loads source `packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts` through `resolve-ts.mjs`. That file now drains both the compiled host-check runner and the source runner, and it starts the contract validator only when `GSD_R4_CONTRACT_VALIDATOR=1`. SHA-256 `45296b66bd7d9267d46dd6544cfda9f462717d56669b992d065f8c8147e81acc`. Standalone `server.js` and chunk `2896.js` were not rebuilt; their hashes match the R3 report. Live results are in `raid-night/docs/migration/reports/C16-R4.md`. This drain commit is `80bee99d`, not pushed.

## C16-R3 native control truth (2026-09-22)

R4 was not started. Staging was not started. No live generation.

`bindNativeDispatch` still registers `publishNativeReviewFindings` and `replanNativeMilestone`. Review and replan stay `running` with the lease held until that promise settles. The extension session in `native-workflow-session.ts` writes `.gsd/reviews/<milestone>.json` on `agent_end` and `.gsd/runtime/native-replan.json` after `gsd_replan_slice` persists a plan that still contains the snapshotted completed task ids. `answerMatchesOwner` accepts `daemon:<jobId>` only for the active question and the lease owner. Runtime chunk `dist/web/standalone/.next/server/chunks/2896.js` SHA-256 `1d49aa461711b704b84b2c0a71b9b8c0f59bd9ca7103184b89b8458f8694bc17`. Node `native-truth.test.ts` and `c06-native.test.ts`: 27 passed. `admission.test.ts`: 12 passed. The earlier fail-closed commit `2642dfad22c070128e5b4ca80e2c58b43283517f` was not pushed. This integration is `dc3236b016b626b281433b964a4574e839648649`, also not pushed.

## C16-R2 staging retirement (2026-09-22)

`src/runtime-control/tests/state-isolation.test.ts` passed. A replacement state root does not read the retired operation ids. Reopening a root that still has the false-success and the running start still refuses admission and does not mark that start succeeded. The live `state/staging` receipts were not rewritten by that test.

## C16-R2 close-out (2026-09-22)

HEAD before this close-out was `33c08e09fe6453dcb3efe10b9ae2326d63a06a52`. Close-out commit `843f1d97de68675e2cfc27e479256d5d3cc0333c` was not pushed. R3 was not started. Staging was not started.

`hasReconciliation` now reads the decision. An empty file, malformed JSON, a different operation id, a mismatched cancel id, or slot observations without `is_processing: false` and numeric `n_ctx` leave the false-success in force. Model-producing admission also refuses a `running`, `cancelling`, `recovery_required`, or interrupted `accepted` operation that the lease does not already name. That does not mark the operation succeeded and does not clear the lease.

`src/runtime-control/tests/worker-cancel.test.ts` passed 10 tests. The live `3ef0e645` decision still validates. `79648da8` was not given a reconciliation file. `fba0f3be` was not opened on the live store. The rebuilt admission chunk is `dist/web/standalone/.next/server/chunks/1612.js` SHA-256 `b9a3d8967bf6138dc32154fea2b351a567b95bce7bb2c09e2dffbb05d7a43bbd`. Pre-existing untracked `packages/pi-coding-agent/src/*.js` is still not what the runtime loads.

## C16-R2 worker cancel and historical reconciliation (2026-09-22)

Not committed. HEAD remains `33c08e09fe6453dcb3efe10b9ae2326d63a06a52`.

`lookupProjectBridgeServiceForCwd` does not create a worker.
`abortOwnedWorker` is registered beside `sendBridgeInput` in
`web/app/api/runtime/v1/_shared.ts`. Cleanup requires the three
acknowledgement flags plus a matching operation, job, session, and
worker generation. Idle is probed only after that, on the stored
binding, inside the 10s/5s teardown window. Cancel and recover skip
policy readiness. Model-producing admission refuses an unbound
succeeded cancel that has no reconciliation file.

`executeCancel` is the same module instance as that registration.
`@gsd/agent-modes` resolves to source under the test loader so the RPC
worker emits the cleanup receipt. `src/runtime-control/tests/worker-cancel.test.ts`
passed 7 tests. The packaged proof is in raid-night, 11 passed.

The live append for `3ef0e645-ebca-4f7a-a87f-574676ab766d` did not
construct `RuntimeControl` and did not rewrite `fba0f3be`. R3 was not
started. Pre-existing untracked `packages/pi-coding-agent/src/*.js` is
still not what the runtime loads.

## C16-R1 backend binding (2026-09-22)

No source commit. HEAD remains
`19fee9f3647a08ae5c07a8b07e19076bed28e588`.

`src/runtime-control/backend-binding.ts` seals version 1 and the
SHA-256 digest. Registration derives `backend_idle_probe` from
`slot_probe_url`. Model-producing admission copies the binding onto
`StoredOperation` and the lease. The runtime-v1 `Operation` stays
protocol 1. A digest change is rejected while a lease is held.
Unreadable `lease.json` is unknown ownership and blocks admission.
Managed idle is `/slots` only: HTTP success, boolean `is_processing`,
and bound slot id, count, and `n_ctx`. Cancel and recover probe the
stored operation binding. Unbound receipts stay `recovery_required`.

`llama-cpp` no longer implies buffered completions. Explicit
`model.compat.acceptBufferedChatCompletion` still opts in. The coding
schema accepts that field. Local `packages/pi-ai` and
`pi-coding-agent` dists were rebuilt, then `build:web-host` so
standalone chunk `4246.js` is
`111219ead425771bbb83d51f6bc804c06f80467613d101d5e4bed0090bd10a04`.
`dist/web/standalone/server.js` is still
`e427b981d7845b4d67659f82035f0444e3a70cdb1e5ede7150ad125d5fddd4c8`
and does not identify this build. Provider dist
`openai-completions.js` is
`8685bfc1a35fefac0a5c1eda11739ef37a45c88fcbf3849ba7b5d31a44b7047d`.
Model registry dist is
`9b94f039e7374cca0594de39bceccf1ae3f64fee43285127246c23b0177113ab`.
Chunk `1274.js` is
`8d10510e68a96d8cfe8c4c8f156b3a635a9d9fbdd59f0f40effaf88b4329a021`.

Focused node tests: 62 passed. Buffered vitest: 8 passed. Commit
`886992584b8476db2acff1fea753f62b76f5c372`. RaidNight commit
`6482055e66b36b0c8f1e28c104c9d917efc161f3`. Do not start staging.
R2 still reconciles operation
`3ef0e645-ebca-4f7a-a87f-574676ab766d`.

## C16-R0 containment (2026-09-21)

No source commit. HEAD remains
`19fee9f3647a08ae5c07a8b07e19076bed28e588`. Untracked
`packages/pi-coding-agent/src/*.js` and `.d.ts` are emit beside the
tracked TypeScript. The staging process loaded `src` `.ts` through
`resolve-ts.mjs`, not those `.js` files. Do not commit them.

The live cancel of `3ef0e645-ebca-4f7a-a87f-574676ab766d` stored
`succeeded` and released the lease from the `:8082` idle probe while
both RPC workers were still in the staging cgroup. That is the
known-wrong probe. R2 reconciles. Do not rebuild or start staging
from this note.

## C16 repair (2026-09-21)

Working tree only. No commit. llama-cpp buffered JSON completions are
mapped in `packages/pi-ai` (`openai-completions.js`
`26a33c8dc2d743ffe860e92098c30c3292e15a1d489ec8d93f6d3a3df2bfec3f`).
`idle-probe.ts` accepts both slot shapes. Packaged recover logic is
chunk `4246.js`
`13d17bfc009d4095ba85da4e451ed4945440e04881f8ea67db7ee9e087dc12a5`,
staged at `dist/web/standalone/.next/server/chunks/4246.js`. The live
repeat stayed BLOCKED: the gateway keeps generating on `llamacpp-ha`
after AbortSignal. That is recorded in raid-night `C16.md`. Do not
start C17.

## C15L reopen (2026-09-21)

`build:core`, `typecheck:extensions`, `copy-resources`, and `build:web-host`
pass. C06 TS6059/TS5097 closed via non-literal imports and
`runtime-control-load`. Packaged host binds in-process `sendBridgeInput`
for native auto; daemon children omit `GSD_WEB_BRIDGE_TUI`.

Packaged auto bootstrap/pending-input close:
- Copied `$GSD_HOME` extensions resolve `runtime-control` and
  `pending-bridge` via `GSD_WEB_PACKAGE_ROOT`.
- `evaluateCompulsoryPolicy` hydrates daemon bindings from
  `GSD_RUNTIME_REGISTRATION` and loads `GSD_REQUIRED_POLICY_MODULE`.
- Packaged RPC `dist/loader.js` now gets `--import resolve-ts.mjs` and
  strip-types so `.ts` FTM/C14 policy loads in the worker.
- Interactive wizard abort is recorded in
  `runtime-control/bootstrap-abort.json`.

Do not start C16 from this session. No real inference.

## C14 / C06 native auto dispatch (2026-09-20)

Narrow C06 correction used by C14's real packaged daemon. Starting HEAD
`e4944a632990c5654c8ff1b8444cc7881c24c9b3`. Schema unchanged.

- `defaultStart` still sets `GSD_MILESTONE_LOCK` and returns immediately.
  When `GSD_WEB_DAEMON_MODE=1` it fire-and-forgets existing native `/gsd auto`
  through `sendBridgeInput` (`native-auto-dispatch.ts`, webpackIgnore +
  `GSD_WEB_PACKAGE_ROOT`). HTTP admission does not await generation.
- Tests inject `registerNativeAutoDispatchForTest`. Unit tests without daemon
  mode do not spawn a worker. `c06-native.test.ts` plus focused C05/C07
  regressions: 48 passed.
- Do not start C15, live llama.cpp, or production services from this tree.

## C14 / C03 required-policy module loader (2026-09-20)


Narrow C03 correction used by C14's real packaged daemon. Starting HEAD
`7d875980b7a63b68cb1dd01b69618483a36cbd87`. Schema unchanged.

- `GSD_REQUIRED_POLICY_MODULE` is loaded once in `ensureRuntimeControl()` and
  the exported default `RequiredPolicy` is registered into the in-process Map.
  Unset or missing file fail-closes (`policy_ready=false`). `--import` side
  effects are not required.
- Runtime-v1 routes `await control()` so capabilities/commands see the loaded
  policy. Barrel splits avoid webpack pulling `cancel.ts` -> MCP CLI URL.
- Cancel loads `src/runtime-control/cancel.ts` from `GSD_WEB_PACKAGE_ROOT`
  (owner C06 wiring) because `webpackIgnore` of `./cancel.ts` resolved a
  missing chunk path in `dist/web/standalone`.
- Tests: `required-policy-module.test.ts` plus focused admission/http-routes/
  entry-guard/c06-native/c07-events. `pnpm run build:web-host` produces
  `dist/web/standalone/server.js` (gitignored).
- Do not start C15, live llama.cpp, or production services from this tree.

## C07 snapshots and events (2026-09-20)

Portable C07 in worktree `migration/raidnight-native` starting at
`374e0440db55adcf614d29189c99ce2f92ed59f3` (C06). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
unchanged. No schema edits. Proceeded under the Mac addendum portable
C01-C15 exception: C00/C02/C06 remain overall BLOCKED (Linux/RDKit).
Those are allowed deferrals and are not C07 failures. C07 AT-E01-E05
are portable; overall status PASS.

- Report: `docs/migration/reports/C07.md` Status PASS; development_status READY; acceptance_status PASS
- Projections: `src/runtime-control/snapshots.ts`
  - GET `/projects/{id}/jobs` and GET `/jobs/{id}` from native snapshot/progress plus JobCatalog/operations
  - `readMetadata` db-authoritative vs projection-fallback; fallback cannot claim `completed`/`SIGNED_OFF`
  - No model calls on any read; `project_snapshots` and `event_history` true
  - Durations, turns, log refs null when unavailable; no cloud prices
- Events: R9 journal/SSE/history
  - Journal under GSD state root, 50 MiB / five segments, cursor `epochN:sequenceM`
  - Translator reuses BridgeService/native identities; message_id joins deltas/finals
  - `completed` only from canonical verified milestone, never agent_end/execution_complete
  - stream_gap on unknown cursor (`job_id=null`); heartbeat 15s; history default 100 max 500
- Deep links: `pending_input.url` is `/?project=<cwd>&session=&question=` so the existing GSD web UI reuses the same worker
- Tests: AT-E01, AT-E02, AT-E03, AT-E04, AT-E05 plus C05/C06 regressions
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0
  Targeted node tests: 44 + 118 passed
- Next portable task: C08 FTM native extension. Do not start C08, C09, live
  GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C07 session.
- C00/C02/C06 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel; C06 kernel RO-bind). Those are not C07 portable failures.

## C06 native commands and workspace (2026-09-20)


Portable C06 in worktree `migration/raidnight-native` starting at
`6ed641dce9ac6797cd28ef5cbe08b1ad9010ba9f` (C05). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
unchanged. No schema edits. Proceeded under the Mac addendum portable
C01-C15 exception: C00/C02 remain overall BLOCKED (Linux/RDKit). Those
are allowed deferrals. C06 overall is BLOCKED only for Linux AT-W01/W02
kernel RO-bind; `development_status` is READY.

- Report: `docs/migration/reports/C06.md` Status BLOCKED; development_status READY; acceptance_status BLOCKED
- Native handlers: `src/runtime-control/native-commands.ts`
  - prepare uses existing resolveDispatch policy; research/plan only; halt before execute-task; validatePlan; product files unchanged
  - review succeeds on typed findings only; workspace plan/review makes product RO
  - replan uses DomainOperationResult writers plus `replan-evidence.ts` (does not delete evidence)
  - start/resume set `GSD_MILESTONE_LOCK`; dispatch-guard refuses other milestones
  - cancel: immediate cancelling, stop/abort, C03 TERM 10s / KILL 5s budgets, idle-probe-before-lease-release
  - recover: explicit `recovery_id` from diagnostics; never auto-replay shell
  - Production default is native; C05 tests still inject `registerCommandHandlerForTest`
- Import: POST `/projects/{id}/jobs` (`import-jobs.ts`). JobImport is not `applyLegacyImport` (markdown Import Application). Identity is insertMilestone plus `.gsd/imports/<digest>/` and durable `jobs.json`. Same digest+payload is idempotent; changed data is 409 and requires replan. No model lease.
- Answers: POST `/jobs/{id}/answers`. Scope, request-id, epoch/revision; duplicate same value returns receipt; no second lease.
- S6 workspace: `workspace-profile.ts`. Canonical write guard on write/edit; bwrap wrap on bash/exec/host-check; Darwin fail-closed; trusted Git host ops; post-exec contract diff rejects without delete. `milestone_scope` and `readonly_references` true. Snapshots/history still false (C07).
- Tests: AT-C05, AT-C06, AT-C07, AT-C08, AT-W01, AT-W02 plus C05 AT-C01-C04.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Targeted node tests: 38 + 34 + 84 passed (runtime-control, dispatch-guard/required-policy, exec-sandbox/post-execution).
- Linux kernel RO-bind of neighbours: NOT_RUN. Do not label Mac fail-closed as that host verification.
- Next portable task: C07 snapshots/SSE/history. Do not start C08 FTM chemistry,
  live GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C06 session.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C06 portable failures.

## C05 HTTP admission (2026-09-20)

Portable C05 in worktree `migration/raidnight-native` starting at
`7dacd57a2f641c9571067c9b321e0ef911abcba5` (C04). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
copied verbatim into `packages/contracts/runtime-v1/` and hash-verified.
No schema edits. Proceeded under the Mac addendum portable C01-C15
exception: C00/C02 remain overall BLOCKED (Linux/RDKit). Those are
allowed deferrals and are not C05 failures.

- Report: `docs/migration/reports/C05.md` Status PASS; development_status READY; acceptance_status PASS
- Runtime control: `src/runtime-control/`
  - Read-only registration from `GSD_RUNTIME_REGISTRATION`; IDs and realpaths allowlisted
  - Durable operations: atomic JSON files plus request-id index; single writer; startup reconcile
  - R3-R5: fingerprint before revision rejection; 202 after durable admit; no LLM wait
  - One global model lease across registered projects for prepare/review/replan/start/resume
  - Cancel/recover do not take the lease; GET/read-only RPC does not
  - Production handlers: not-ready (`runtime_unavailable`) until C06; test-only inject via `registerCommandHandlerForTest`
  - Crash after dispatch intent: `recovery_required`, not auto-replayed
- HTTP: `web/app/api/runtime/v1/` capabilities, projects, commands, operation lookup
  - Import/answers/snapshots/events/history return 503 not-ready (C06/C07)
  - Existing bearer proxy covers `/api/runtime/v1`
- Entry guards: registered FTM `POST /api/session/command` model RPC and managed `gsd` PTY starts check `isRequiredPolicyReady` and the model lease. Unregistered cwd stays general-purpose GSD.
- Tests: AT-C01, AT-C02, AT-C03, AT-C04 plus contracts manifest verify and C03 required-policy regression.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Contracts package tests: 8 passed. Targeted node tests: 32 passed.
- C05 implementation and this report are on `migration/raidnight-native`.
- Next portable task: C06 native commands and workspace. Do not start C06, C07, C08,
  live GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C05 session.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C05 failures.

## C04 required liveness (2026-09-20)

Portable C04 in worktree `migration/raidnight-native` starting at
`ef842340fa64bb72acb0d139add255013294a3df` (C03). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
unchanged. No schema edits. Proceeded under the Mac addendum portable
C01-C15 exception: C00/C02 remain overall BLOCKED (Linux/RDKit). Those
are allowed deferrals and are not C04 failures.

- Report: `docs/migration/reports/C04.md` Status PASS; development_status READY; acceptance_status PASS
- Useful progress: `src/resources/extensions/gsd/useful-progress.ts`
  - Content identity = Git HEAD + SHA256 of relevant dirty/untracked files
  - Compared with previous identity on the unit runtime record
  - Excludes `.gsd/runtime/**`, journals, heartbeats, `.gsd/evidence/**`, host-check logs
  - Cached for the idle-watchdog period (15s); mtime/size invalidate file hashes but are not the identity
- Idle watchdog (`auto-timers.ts`): `lastProgressAt` rearms only on identity change or in-budget tool/input exemptions. Token/stream writes `lastTransportAt` / `lastTransportKind` and does not rearm idle.
- Diagnostics on `AutoUnitRuntimeRecord` (version 1, additive): lastSourceIdentity, lastSourceChangeAt, lastTransportAt/Kind, activeTool, pendingInput, cancellationPhase.
- Cancellation: `auto-cancellation.ts` plus `stopAuto` sets `cancellationRequested` immediately, aborts the model turn, and refuses retry/compaction/continuation/dispatch. `publishVerifiedTaskCompletion` rejects PASS from cancelled attempts.
- Host-check runner: terminateProcessGroup always SIGKILLs remaining group members after parent exit (child-held stdout). Wait on process `exit`, not stdout `close`.
- Supervisor defaults unchanged: soft 20 / idle 10 / hard 30 / stalled-tool 5 minutes. No max-token/turn caps.
- Tests: AT-L02, AT-L03, AT-L04, AT-L05 plus token-churn, stop/compact/late-PASS, and existing idle/host-check/verification regressions.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Targeted node test batches: 21 + 13 + 206 + 7 passed.
- C04 implementation and this report are on `migration/raidnight-native`.
- Next portable task: C05 HTTP admission. Do not start C05, C08 FTM chemistry,
  live GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C04 session.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C04 failures.

## C03 required verification (2026-09-20)

Committed on this branch as `ef842340fa64bb72acb0d139add255013294a3df`.
Report: `docs/migration/reports/C03.md` Status PASS; development_status READY;
acceptance_status PASS. Host-owned required-policy registry plus async
process-group runner. Test-only policy `test-policy/v1`. Real FTM chemistry is C08.

## Predecessor pins (do not rewrite)

- C00 gsd-pi pin remains `fa83b795f3ef5fd7d2c02b37d4e96cbd9dc94f88`
- C02 raid-night `migration/gsd-native` `d31b87399a491bd4b7ac0df65189c5b3c9ebd6fe`
  overall BLOCKED, development_status READY
- Pack 1.0.0 schema SHA256 `0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
