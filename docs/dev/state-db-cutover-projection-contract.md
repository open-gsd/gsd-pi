<!-- Project/App: gsd-pi -->
<!-- File Purpose: Frozen projection-format contract for the state-DB cutover milestone. -->

# Projection contract — frozen format, read-only projections, de facto public API

> **Status:** Active milestone contract. Recorded 2026-08-02 by the state-DB
> cutover milestone (wave 3, task T019). Companion to
> [`state-db-cutover-milestone-decision.md`](state-db-cutover-milestone-decision.md)
> (the decision record and its accepted residual risks) and
> [`ADR-046-database-authoritative-workflow-lifecycle.md`](ADR-046-database-authoritative-workflow-lifecycle.md).

## 1. The rule: projections are read-only views of DB state

The database (`.gsd/gsd.db`) is the single source of truth for workflow state.
Every markdown file this document inventories is a **projection** of that
database — a rendered view, not a record.

- **Writers MUST go through the DB.** No tool, agent, or human may hand-edit a
  projection to change project state. A projection edit is not a state change;
  it is drift that the next render silently discards. `.gsd/STATE.md` and
  `.gsd/gsd.db` are additionally protected at the tool boundary by
  `src/resources/extensions/gsd/write-intercept.ts`, which blocks direct Write
  and common shell writes to them. The Bash guard allows inspection with
  `sqlite3 -readonly .gsd/gsd.db 'SELECT 1'` (also `--readonly`), copies from
  the state file to another destination, and filename searches such as
  `grep -rn 'gsd.db|STATE.md' src/`. The SQLite exemption requires the flag
  among the leading option flags, before the database path; SQL text alone
  does not grant an exemption. SQLite library access remains blocked.
  `cp`/`mv` detection checks the destination, including a closing quote and
  supported trailing redirections or comments. Source-only `mv` commands
  also pass this check, even though moving the source removes it.
  This is a pattern guard, not a full shell parser: general quoted-argument
  parsing and SQLite options with separate values (such as `-init FILE`)
  remain outside its supported parsing. Regression cases live in
  `src/resources/extensions/gsd/tests/block-db-writes.test.ts`.
  The same module refuses a direct Write, Edit or shell write to a managed
  projection that has a save tool (root renders: PROJECT, PROJECT-DRAFT,
  REQUIREMENTS, REQUIREMENTS-DRAFT, DECISIONS, KNOWLEDGE, CAPTURES, QUEUE,
  QUEUE-ORDER.json, OVERRIDES.md, BACKLOG.md, ROADMAP; hierarchy kinds below
  `.gsd/milestones` and `.gsd/phases`: ROADMAP, PLAN, REPLAN, SUMMARY,
  VALIDATION, ASSESSMENT, UAT, CONTEXT, CONTEXT-DRAFT, RESEARCH, UI-SPEC,
  AI-SPEC, SPEC, PARKED, CONTINUE) and names that tool
  (`/gsd steer` for OVERRIDES.md: the user registers the override; `/gsd
  backlog` for BACKLOG.md: the user manages the items). It covers
  only the paths the renderers own: the root kinds at the `.gsd`
  root and the other kinds below `.gsd/milestones` and `.gsd/phases`. A file
  with such a name in another directory (for example a `/gsd milestone-summary`
  report in `.gsd/summaries`) is a document the agent writes directly.
  The shell check sees only a path written with its `.gsd` directory. The
  guard runs on the native engine (the planning tools policy consults the
  same block list, so a planning unit cannot allow a guarded write) and,
  through a PreToolUse hook, on claude-code-cli. cursor-agent pre-executes
  its tools and its protocol has no pre-execution hook, so a block is not
  possible there; the cursor adapter instead marks an executed write to a
  managed projection as a refused tool result naming the save tool
  (detect-and-report). A managed file with no save tool yet (LEARNINGS,
  SECRETS, VERIFICATION-FAILED) stays writable. Cases live in
  `tests/projection-write-guard.test.ts`.
- **Readers MUST NOT treat projections as authority.** Reading a projection is
  legitimate for display, for external integrations that only need a snapshot,
  and for drift detection (which compares projection against DB *by design*).
  Deriving lifecycle decisions — dispatch eligibility, status, completion —
  from a parsed projection is not.
- **Drift heals by re-render, never by import.** A projection that disagrees
  with the DB is repaired by re-rendering from the database, not by parsing
  the file back into state. The full render is `renderEveryProjection` in
  `src/resources/extensions/gsd/projection-worker.ts`: the `renderAllFromDb`
  sweep (`src/resources/extensions/gsd/markdown-renderer.ts`) covers every
  milestone hierarchy file, the root `ROADMAP.md` and `QUEUE.md`
  (`workflow-projections.ts`), `REQUIREMENTS.md`, `DECISIONS.md`, `PROJECT.md`
  and the root drafts (`db-writer.ts`), the PARKED markers
  (`milestone-park-projection.ts`) and the `.planning/` projections, and the
  same function adds `STATE.md` (`renderStateProjection`),
  `KNOWLEDGE.md` (`knowledge-projection.ts`), `OVERRIDES.md` (`overrides.ts`),
  `CAPTURES.md` (`captures.ts`) and `BACKLOG.md` (`backlog.ts`).
  `/gsd rebuild markdown` (`rebuildMarkdownProjectionsFromDb`) runs it.
  `QUEUE-ORDER.json` renders from `milestones.sequence` through the
  `queue-order` Projection Work kind (`renderQueueOrderFromDb` in
  `queue-order.ts`). A file with no DB source (`CODEBASE.md`,
  `.gsd/extensions/`) is not healed: nothing re-renders it. No repair path
  parses a projection back into state.

### Implicit disk ingress

No startup, database-open, state-derivation, dispatch, reconciliation,
`/gsd sync` or status-read path writes the database from a file. The gate is
`src/resources/extensions/gsd/tests/implicit-disk-to-db-authority.test.ts`
(part of G2 in `db-authority-gates.test.ts`).

| File | Former implicit path | Status |
|---|---|---|
| `QUEUE-ORDER.json` | Mirrored into `milestones.sequence` on every derive | Removed. The file is a render of the `milestone.reorder` Domain Operation. |
| `*-PLAN.md` | Presence cleared `slices.is_sketch` at dispatch and in drift repair | Removed. Only `gsd_plan_slice` and `gsd_plan_task` clear the flag. |
| `*-SUMMARY.md` | File mtime backfilled `completed_at` in drift repair | Removed. |
| `*-ASSESSMENT.md` | Content became a `run-uat` assessment row before milestone validation | Removed. A missing assessment stays missing. |
| `*-CONTEXT.md`, `*-ROADMAP.md` | The discuss handoff registered the CONTEXT file as an artifact, and a file on disk made the handoff ready | Removed. No path registers the file. The `discuss` and `discuss-headless` prompts save CONTEXT through `gsd_summary_save`. `checkAutoStartAfterDiscuss` in `discussion-handoff.ts` accepts a handoff only on database rows: a CONTEXT artifact row, or slices (a planned milestone needs no CONTEXT row). A file with no such row is refused, and the notice names `gsd_summary_save` or `gsd_plan_milestone`. |
| `state-manifest.json` | Blocked a STATE.md render and proved a milestone row | Removed. |
| `event-log.jsonl` | Fallback source for reopen and completion timestamps (`milestone-reopen-events.ts`) | Removed. Drift detection and doctor read milestone reopen and completion events from `workflow_domain_events` only. The unadopted reopen and complete tool branches record a `milestone.legacy_reopened` or `milestone.legacy_completed` event. An event that only the file or the milestone archive holds is reported by `/gsd doctor` (`legacy_milestone_event_unimported`) and imported by `/gsd doctor --fix`. The file is still appended by the tools as an audit trail; it is not rendered from the database yet. |
| `KNOWLEDGE.md` | Patterns and Lessons copied into memories at session start (`bootstrap/system-context.ts`) | Removed. Session start never imports the file. File rows with no database row stay in the render and in the readers until `/gsd recover` imports them through an Import Preview. The Preview lists every Rule, Pattern and Lesson row with a K, P or L id as a mapping and every other part of the file as not imported. A row with a memory id (`MEM###`) is not imported: it is an info report when an active database memory has that id and the same content, a conflict when the content is different, and a warning when no active memory has that id, because the next render removes it. A row whose database row was forgotten is listed as not imported: the next render removes it from the file. A row whose database row has different content is listed as a conflict and the database row is kept, so the next render replaces the file row. The file text replaces the database row only by an explicit `--choice=<K|P|L id>.use-file` in a new sealed Preview, and Forward Repair can restore the earlier database row. |

## 2. Frozen format inventory

For this milestone the projection format and locations are **FROZEN**: rendered
output stays **byte-compatible with the pre-cutover format and location**, and
the only permitted change is **additive** — the state-version stamp in §3.
Strip the stamp and the pre-cutover byte stream is reproduced exactly.

Projection root: `.gsd/` at the project root (`gsdProjectionRoot()` in
`paths.ts`). In real installs `<project>/.gsd` is a **symlink** into
`~/.gsd/projects/<hash>/` (ADR-002 amendment, ADR-031), so the files below
physically live outside the repository.

### 2.1 Root-level projections (`.gsd/`)

`GSD_ROOT_FILES` in `src/resources/extensions/gsd/paths.ts`:
`STATE.md`, `PROJECT.md`, `DECISIONS.md`, `QUEUE.md`, `REQUIREMENTS.md`,
`OVERRIDES.md`, `KNOWLEDGE.md`, `CODEBASE.md`. Legacy all-lowercase filenames
(`state.md`, `project.md`, …) remain recognized on read. `RUNTIME.md` is
resolved alongside them.

Seven of the eight have DB sources behind their render, and one does not projections. Two are not, and no renderer
treats them as state:

- `OVERRIDES.md`, `KNOWLEDGE.md` — projections. Their sources are the
  `override.*` events of `workflow_domain_events` (`renderOverridesProjection`
  in `overrides.ts`) and the memory rows (`renderKnowledgeProjection` in
  `knowledge-projection.ts`). A file block the database does not hold stays
  in the render untouched (a doctor import bridge, see §3.6).
- `CODEBASE.md` — **not a projection.** It is a generated codebase map
  (`writeCodebaseMap` in `codebase-generator.ts`, plain
  `atomicWriteSync`); no database table holds it and no repair re-renders
  it. It is inventoried here because it sits at the projection root and the
  write guard names it, not because it is DB-derived.

`STATE.md` is rendered by `renderStateProjection()` in
`workflow-projections.ts` (derived state → `atomicWriteSync`), **not** by the
`markdown-renderer.ts` write path, and therefore carries **no** stamp (§3.4).

`renderStateProjection()` is the only `STATE.md` writer and
`renderStateContent()` is the only content builder. The contract:

- It is rendered after each DB mutation (host and MCP child), in the full
  rebuild (`projection-worker.ts`), by doctor, on guided entry, and after
  `/gsd migrate` commits its import.
- It is never deleted. When the DB is unavailable the file stays unchanged and
  the render reports `stale`; no placeholder page is written.
- It is fully derived: each render replaces the file content, and writes
  nothing when the content is already current. It has no baseline in
  `.gsd/.compat.json`, the write guard never copies it to quarantine, and the
  external-edit observer skips it, so it is never moved away.
- A hand edit is lost on the next render by design.

Regression tests:
`src/resources/extensions/gsd/tests/workflow-projections.test.ts`,
`src/resources/extensions/gsd/tests/gsd-rebuild.test.ts` (observer skip), and
`packages/mcp-server/src/state-md-render.test.ts`.

### 2.2 Hierarchy projections — two layouts, both frozen

Layout selection is per project and layout-aware
(`layout-policy.ts`, `paths.ts`); both shapes stay supported and unchanged.

| Artifact | Flat-phase layout (current) | Legacy layout (still read/written where present) |
|---|---|---|
| Milestone ROADMAP | `.gsd/phases/NN-slug/NN-ROADMAP.md` | `.gsd/milestones/MID/MID-ROADMAP.md` |
| Milestone-scoped artifacts (CONTEXT, RESEARCH, VALIDATION, SUMMARY, …) | `.gsd/phases/NN-slug/NN-<TYPE>.md` | `.gsd/milestones/MID/MID-<TYPE>.md` |
| Slice PLAN | `.gsd/phases/NN-slug/NN-MM-PLAN.md` | `.gsd/milestones/MID/slices/SID/SID-PLAN.md` |
| Slice SUMMARY / UAT and other slice-scoped artifacts | `.gsd/phases/NN-slug/NN-MM-<TYPE>.md` | `.gsd/milestones/MID/slices/SID/SID-<TYPE>.md` |
| Task SUMMARY | `.gsd/phases/NN-slug/SID-TID-SUMMARY.md` | `.gsd/milestones/MID/slices/SID/tasks/TID-SUMMARY.md` |

`NN` is the zero-padded phase number derived from the milestone id, `MM` the
zero-padded plan number derived from the slice id (`planFileName`,
`phaseDirName` in `layout-policy.ts`). In flat-phase layout tasks are
checkboxes inside the slice PLAN; only non-PLAN task artifacts get their own
file.

#### Writer seams

There are three write seams, not one. Which seam a file's writers use decides
whether it is stamped (§3.4).

1. **`writeAndStore`** (`markdown-renderer.ts`) — DB row plus stamped file
   plus artifact lineage plus marker baseline, atomically. The stamped
   renderers are `renderPlanFromDb`, `renderTaskPlanFromDb`,
   `renderRoadmapFromDb`, `renderMilestoneArtifactsFromDb`,
   `renderMilestoneSummary`, `renderSliceArtifactsFromDb`,
   `renderSliceSummary` (the slice `SUMMARY` and `UAT` files),
   `renderTaskSummary`, `renderReplanFromDb`, and
   `renderRoadmapAssessmentFromDb`. Every task-summary producer routes
   through `writeTaskSummaryProjection`, which owns layout-aware placement
   and delegates stamping, disk persistence, artifact lineage,
   compatibility-marker updates, and cache invalidation to `writeAndStore`.
   A lineage-write failure is surfaced to the caller; the disk copy remains
   a non-authoritative projection for reconciliation evidence.
2. **`writeProjectionFile` / `writeProjectionFileSync`**
   (`compat/compat-marker.ts`) — the shared write rule: nothing is written
   when the file and its marker baseline already hold the content; otherwise
   the file is written and its baseline is recorded. Stamping is the
   caller's choice here: `renderWorkCheckpoint` (the `CONTINUE` files)
   passes content through `stampProjectionContent`, so `CONTINUE` is
   stamped even though it does not use `writeAndStore`; every other user of
   this seam writes unstamped. Users: `regenerateDecisionsMarkdown`,
   `regenerateRequirementsMarkdown`, `regenerateRootArtifactsMarkdown`
   (`PROJECT.md`, `PROJECT-DRAFT.md`, `REQUIREMENTS-DRAFT.md`) and
   `saveArtifactToDbForWorkspace` (a `gsd_summary_save` artifact such as a
   `CONTEXT` file: the row commits first, the file follows it) in
   `db-writer.ts`; the root `ROADMAP.md` and `QUEUE.md` via
   `writeRootProjection` in `workflow-projections.ts`; `renderKnowledgeProjection`;
   `renderMilestoneValidation` (the milestone `VALIDATION` file, rendered
   from the `milestone-validation` assessment row; every writer of the file
   and the full rebuild call it).
3. **Direct `atomicWriteSync`** — no stamp, no marker baseline; some writers
   record the render in the marker via `noteRenderedProjectionFile` for the
   external-edit observer only. `renderStateProjection` (`STATE.md`),
   `renderMilestoneParkedMarker` (`PARKED`),
   `renderOverridesProjection` (`OVERRIDES.md`),
   `renderCapturesProjection` (`CAPTURES.md`),
   `renderBacklogProjection` (`BACKLOG.md`),
   `writeCodebaseMap` (`CODEBASE.md`), and `renderQueueOrder`
   (`QUEUE-ORDER.json`, via `saveJsonFile`). The completion tools also write
   through a plain atomic write (`saveFile` in `files.ts`): the milestone
   `SUMMARY` (`complete-milestone.ts`) and the slice `SUMMARY` and `UAT`
   (`complete-slice.ts`) are written there when their closeout commits, and
   re-rendered stamped by the sweep's `renderMilestoneSummary` /
   `renderSliceSummary`. The `.planning/` projections are written by
   `writePlanningDirectory` (`migrate/planning-writer.ts`), which records
   per-file SHAs via `applyPlanningProjectionWrites`.

A file may therefore be written stamped by one writer and unstamped by
another (slice `SUMMARY`/`UAT`, milestone `SUMMARY`). A reader must treat a
missing stamp as normal on every file (§3.4); it must never treat the
presence of a stamp as an integrity boundary for a file that has an
unstamped writer. REPLAN, the ROADMAP-ASSESSMENT and VALIDATION are rendered
from their structured source (the replan event, the assessment row) by the
same function in the tool and in the sweep.

### 2.3 What the freeze covers

Frozen: file names, directory shapes, both layouts, section ordering, heading
text, checkbox and badge syntax, and the trailing-newline byte stream of every
file above. Any change beyond appending the §3 stamp is out of scope for this
milestone.

### 2.4 Not a projection: `.gsd/extensions/`

`.gsd/extensions/` is an operator input directory, not a projection. The
ecosystem loader (`src/resources/extensions/gsd/ecosystem/loader.ts`) loads
the `.js` and `.ts` files in it as extensions, and only when the project is
trusted. No renderer writes the directory, no reader takes workflow state from
it, and a rebuild leaves it unchanged, so the rules of §1 and the freeze do
not apply to it. An extension reads workflow state through
`GSDExtensionAPI.getProjectSnapshot()`, which answers from the database.

## 3. The additive state-version stamp

### 3.1 Exact format

```html
<!-- gsd:state-version=<projectRevision>:<authorityEpoch> -->
```

Both values are decimal integers. The stamp occupies **one line at end of
file**, terminated by a newline, and is the file's last byte sequence.
Canonical regex (`markdown-renderer.ts`):
`/<!-- gsd:state-version=(\d+):(\d+) -->/`.

Values come from the `project_authority` singleton row (`revision`,
`authority_epoch`) — the same row the cutover receipt advances. When the DB or
that row is unavailable, the renderer stamps `0:0`.

### 3.2 Scope

Every projection written through `writeAndStore` in `markdown-renderer.ts` is
stamped. Re-render is **strip-then-stamp**, so replayed artifact content never
accumulates stamp lines: disk bytes, the `artifacts.full_content` row, and the
value returned to callers are identical.

### 3.3 How readers must treat it

**Ignore-safe.** It is an HTML comment: markdown renderers do not display it,
and a reader that does nothing about it sees exactly the pre-cutover content.
External readers are *not* required to parse it.

A reader that wants freshness may parse it (`readProjectionStateVersion`) and
compare `R:E` against the DB's current project revision/authority epoch. A
reader that wants to compare content must strip it first
(`stripProjectionStamp`) — never diff raw bytes across a stamp boundary.

### 3.4 What is not stamped

Every file with a writer that does not route through `writeAndStore` carries
no stamp (or can carry none, when a stamped and an unstamped writer share a
file). That set is: `STATE.md`, the root `ROADMAP.md` and `QUEUE.md`
(`workflow-projections.ts`), `DECISIONS.md`, `REQUIREMENTS.md`, `PROJECT.md`
and the root drafts (`db-writer.ts`), `KNOWLEDGE.md`
(`knowledge-projection.ts`), the milestone `VALIDATION` file
(`renderMilestoneValidation`), `PARKED` (`milestone-park-projection.ts`),
`OVERRIDES.md` (`overrides.ts`), `CAPTURES.md` (`captures.ts`),
`BACKLOG.md` (`backlog.ts`), `QUEUE-ORDER.json` (`queue-order.ts`),
`CODEBASE.md` (`codebase-generator.ts`), the `.planning/` projections
(planning-writer), and — from their completion-time writers — the milestone
`SUMMARY` and the slice `SUMMARY` and `UAT` files (`saveFile` in
`complete-milestone.ts` / `complete-slice.ts`). A reader must therefore
treat "no stamp" as normal, never as evidence of tampering or staleness.

Only two stamped files do not go through `writeAndStore`: the `CONTINUE`
checkpoint files (`renderWorkCheckpoint` stamps explicitly through
`writeProjectionFile`). Stamped or not, most of the unstamped files above
(except `STATE.md`, `PARKED`, `OVERRIDES.md`, `CAPTURES.md`, `BACKLOG.md`,
`QUEUE-ORDER.json`, `CODEBASE.md` and the `.planning/` projections) are
written by the one rule, `writeProjectionFile` in `compat/compat-marker.ts`,
which `writeAndStore` also uses: nothing is written when the file and its
marker baseline already hold the content; otherwise the file is written and
its baseline is recorded. `STATE.md` is overwritten on every render and has
no baseline; the direct-`atomicWriteSync` writers record a
`noteRenderedProjectionFile` render note only.

### 3.5 How drift detection uses it

Drift judgments are **stamp-insensitive**: the on-disk bytes are stripped of
the stamp before comparison against the DB render intent
(`markdown-renderer.ts`, `detectProjectionDrift` / the plan- and
roadmap-render-intent checks), so a stamp-only difference is **never** content
drift. The stamp additionally serves as a fast-path freshness signal for the
drift detectors under `state-reconciliation/drift/`: a projection whose `R:E`
equals the DB's current revision/authority epoch is fresh without a content
parse; an unstamped or mismatched projection falls back to the existing content
comparison. Verdicts and reasons are byte-identical for equivalent states
either way.

### 3.6 Declared non-authority runtime stores and import bridges

Not every file under `.gsd/` is a projection. These runtime stores are
written directly (append or rewrite, outside every seam in §2.2), hold state
the workflow database does not model, and are **declared non-authority**:
no dispatch, derivation or lifecycle decision reads workflow state from
them. The format freeze (§2) does not apply to them.

| Store | Files | Writers / readers |
|---|---|---|
| Notifications | `.gsd/notifications.jsonl` | `notification-store.ts` (append, mark-all-read/clear rewrite, own lock file); unread counts feed stop notices |
| Doctor history | `.gsd/doctor-history.jsonl` | `doctor-history.ts`, appended on every `/gsd doctor` run |
| Activity log | `.gsd/activity/<seq>-<unit>-<id>.jsonl` | `activity-log.ts`; input for `undo.ts` and the forensics views |
| Execution history | `.gsd/exec/*.meta.json` | `exec-history.ts`; read by `tools/exec-search-tool.ts` and compaction snapshots |
| Exports and reports | `.gsd/export-*.json` / `.md`, `.gsd/reports/` | `export.ts` (`writeReportSnapshot`), `src/web/export-service.ts` |
| Metrics ledger | `.gsd/metrics.json` | `export.ts` reads it from disk (`loadLedgerFromDisk`) |

Two legacy **import bridges** also read `.gsd/` files into the database.
They run only behind an explicit operator command and are the only paths
that turn file bytes into DB rows: the Import Preview/Application family
(`legacy-import-*.ts`, including `/gsd doctor --fix` and `/gsd recover`)
and the `/gsd migrate` import (`migrate/execution.ts`, whose hierarchy
upserts land through the pre-adoption `ELSE` arms in `gsd-db.ts`). The
file-only override and capture blocks that the database does not hold stay
in their rendered files and are imported only by `/gsd doctor --fix`
(`importFileOverrides` in `overrides.ts`, `importFileCaptures` in
`captures.ts`). Every increment of these bridges is counted by a
`legacy.*` telemetry counter (see `legacy-telemetry.ts` and the G8 gate).

## 4. This layer is a de facto public API

The projection layer is a **de facto public API**. Tools outside this
repository parse these files, and because `.gsd` is a symlink into
`~/.gsd/projects/<hash>/`, the full reader set is unobservable from the repo —
no repo-side evidence can enumerate it.

Consequences, binding for this milestone:

1. The format is frozen (§2) and changes are additive-only (§3). No renaming,
   no reordering, no relocation.
2. **Any future versioning of this format requires its own milestone** — with
   an explicit compatibility plan, a deprecation window, and a release-note
   directive. It may not ride along inside an unrelated change.
3. The compatibility window that governs legacy import/export and downgrade is
   ADR-046's, verbatim: *"Explicit legacy import/export compatibility remains
   for two stable releases and at least 60 days, whichever is longer, beginning
   when Import Preview and Import Application ship."* This milestone's ruling
   (2026-08-01) restates it as the downgrade window: **2 stable releases + ≥60
   days**. Time alone is not a Removal Gate.

## 5. Known external reader surfaces

Known does not mean complete (§4). These are the surfaces observable from this
repo. "Decision-bearing" means the read feeds a decision (dispatch,
completion, routing); "display-only" means the bytes reach a human or a
client payload without steering GSD. Every reader below is a **fallback**:
when the workflow database is available it answers first, and the
projection read is labelled `readMetadata { source: projection, authority:
projection-fallback }`.

| Surface | What it reads | Decision-bearing | Evidence |
|---|---|---|---|
| `@opengsd/mcp-server` `gsd_query` fallback | Raw `STATE.md`, `PROJECT.md`, `REQUIREMENTS.md` contents; milestone `SUMMARY` **existence** (`hasSummary`) in the milestones listing | `hasSummary` yes (clients use it as a completion signal); document bodies display-only | `packages/mcp-server/src/server.ts:334`, `:342`, `:350`, `:361` (fallback block at `:330`) |
| `@opengsd/mcp-server` graph build fallback | Parses `.gsd/` projections (STATE.md, milestone ROADMAPs, slice PLANs, KNOWLEDGE.md) when the workflow database is not available | Yes (the graph drives client navigation) | `packages/mcp-server/src/server.ts:297` (`readGraphDatabaseSource`), `packages/mcp-server/src/readers/graph.ts` |
| `@opengsd/mcp-server` roadmap/history/captures/knowledge tools | File fallbacks `readRoadmap`, `readHistory`, `readCaptures`, `readKnowledge` when the DB bridge is unavailable | Display-only (labelled projection-fallback) | `packages/mcp-server/src/server.ts:1545`, `:1566`, `:1623`, `:1647` |
| `@opengsd/mcp-server` `gsd_query` tool description | Tells clients the tool "reads the workflow database … `.gsd/` projections otherwise" | — | `packages/mcp-server/src/server.ts:1401` |
| `@opengsd/mcp-server` progress reader | Parses `STATE.md` fields and the milestone registry; derives from the filesystem when the file is missing | Yes (`readProgress` reports active refs) | `packages/mcp-server/src/readers/state.ts:171`-`:205` |
| `@opengsd/mcp-server` doctor-lite | `STATE.md` **existence** check when the DB is unavailable | Yes (drives the "run /gsd status" repair advice) | `packages/mcp-server/src/readers/doctor-lite.ts:63`-`:73` |
| Welcome screen fallback | Raw `STATE.md` read when the DB has no bound milestone | Display-only (banner text) | `src/welcome-screen.ts:97` |
| Web project discovery | Parses `STATE.md` for active milestone/slice/phase when the DB cannot be read | Yes (selects the active project context) | `src/web/project-discovery-service.ts:138` |
| `integrations/hermes` (Python) | Requires `.gsd/` with `STATE.md` present; an absent/empty `STATE.md` is documented as the cause of an empty snapshot | Yes (its `read progress` depends on it) | `integrations/hermes/docs/setup.md:35`, `:235`; fixture `integrations/hermes/tests/fixtures/minimal-project/.gsd/STATE.md` |

Because the format is frozen and the stamp is ignore-safe, none of these
readers can break at the moment DB authority flips.
