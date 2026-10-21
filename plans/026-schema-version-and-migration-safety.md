# Plan 026: Refuse newer-schema DBs, harden version detection, and close the DB before migration restore

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f095797f..HEAD -- src/resources/extensions/gsd/db/engine.ts src/resources/extensions/gsd/db-schema-metadata.ts src/resources/extensions/gsd/migrate/execution.ts src/resources/extensions/gsd/workflow-migration.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: bug + migration + tests
- **Planned at**: commit `f095797f`, 2026-07-07

## Why this matters

The SQLite DB at `.gsd/gsd.db` is the single source of truth for the GSD
workflow engine (markdown under `.planning/`/`.gsd/` is projection-only). The
schema-migration machinery has three verified gaps that can corrupt or
split-brain that authoritative store:

1. **No "DB newer than this binary" guard.** `migrateSchema` returns early when
   `currentVersion >= SCHEMA_VERSION` and the caller proceeds to read/write. An
   older gsd-pi (a stale global install, a not-yet-updated worktree, a
   background observer process) that opens a DB already migrated by a newer
   binary silently operates on a schema it does not understand. Multi-version
   coexistence is real in this codebase: sibling git worktrees share the same
   DB file (see `tests/worktree-db-same-file.test.ts`).
2. **Version-detection edge cases.** `getCurrentSchemaVersion` reads
   `MAX(version)` — on an empty `schema_version` table SQLite returns a row
   whose value is `NULL`, so the function returns `null` coerced as `number`,
   not `0`. Separately, `initSchema` treats *any* DB with an empty
   `schema_version` table as a fresh install and stamps it `SCHEMA_VERSION`
   (29) without running a single migration — if a legacy DB with real data but
   no version rows ever reaches this path, it is permanently mis-stamped as
   fully migrated and later throws "no such column" at first query.
3. **Migration restore swaps the DB file under a live connection.** In
   `executeMigrationWrite`, the import transaction commits to the target
   `gsd.db`; if a *later* step (verification/readiness/audit) throws, the catch
   calls `restoreMigrationTarget`, which `rmSync`s the whole `.gsd/` dir and
   copies the backup back — with no `closeWorkflowDatabase()` first. The
   process (and the workspace connection cache) still holds a handle to the
   deleted inode: subsequent reads see the stale migrated data and the first
   write fails with `SQLITE_READONLY_DBMOVED`.

Finally, the single most important upgrade guarantee — that a mid-migration
failure rolls back to the original schema version — has **no test**: the
BEGIN/COMMIT/ROLLBACK wrapper in `migrateSchema` is never driven through a
failing step, and the `needsAutoMigration`/`validateMigration` gates in
`workflow-migration.ts` have zero test references.

## Current state

Files and roles:

- `src/resources/extensions/gsd/db/engine.ts` — DB open, pragmas, base schema,
  `migrateSchema` runner. `SCHEMA_VERSION = 29` at line 96.
- `src/resources/extensions/gsd/db-schema-metadata.ts` — `getCurrentSchemaVersion`,
  `recordSchemaVersion`, `ensureColumn`.
- `src/resources/extensions/gsd/migrate/execution.ts` — `executeMigrationWrite`
  (the `.planning → .gsd` migration write pipeline).
- `src/resources/extensions/gsd/migrate/safety.ts` — `prepareMigrationTarget` /
  `restoreMigrationTarget`; already imports `closeWorkflowDatabase` from
  `../db-workspace.js` (line 10) and calls it at line 158.
- `src/resources/extensions/gsd/workflow-migration.ts` — `needsAutoMigration`
  (line 20), `validateMigration` (line 254).

Excerpt — `db/engine.ts` (~line 186), the early return with no `>` branch:

```ts
function migrateSchema(db: DbAdapter, dbPath: string | null): void {
  const currentVersion = getCurrentSchemaVersion(db);
  if (currentVersion >= SCHEMA_VERSION) return;

  backupDatabaseBeforeMigration(db, dbPath, currentVersion, { ... });

  db.exec("BEGIN");
  try {
    if (currentVersion < 2) {
      applyMigrationV2Artifacts(db);
      recordSchemaVersion(db, 2);
```

Excerpt — `db/engine.ts` `initSchema` (~lines 109–132), the fresh-stamp path:

```ts
    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      createCoordinationTablesV24(db);
      createRuntimeKvTableV25(db);
      // ... index creation ...
      recordSchemaVersion(db, SCHEMA_VERSION);
    }
```

Excerpt — `db-schema-metadata.ts:21-24`, the `MAX(version)`-is-NULL quirk:

```ts
export function getCurrentSchemaVersion(db: DbAdapter): number {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  return row ? (row["v"] as number) : 0;
}
```

Excerpt — `migrate/execution.ts:98-131`, the restore-under-open-handle path:

```ts
  const backup = prepareMigrationTarget(targetRoot);
  try {
    const written = await writeGSDDirectory(project, targetRoot);
    const legacyArchive = await archiveLegacyPlanningDirectory(sourcePath, targetRoot);
    const imported = await importWrittenMigrationToDb(targetRoot, preview);   // COMMITS to target gsd.db
    const verification = await verifyMigrationProjection(targetRoot, preview);
    verification.dbReadiness = await assertMigrationDbReadiness(targetRoot, preview);
    const audit = await writeMigrationAudit({ ... });
    return { backup, written, imported, legacyArchive, verification, audit };
  } catch (error) {
    restoreMigrationTarget(backup);   // rmSync + cpSync with NO DB close
    throw error;
  }
```

Conventions to match:

- Two-line file-purpose headers on new files; 2-space indent; single quotes in
  `src/resources/extensions/gsd/*.ts` (match the file you edit).
- Test-only seams are exported with an underscore prefix and `ForTest` suffix —
  exemplar: `_isLikelyWslDrvFsPathForTest` already exists in `db/engine.ts`
  (used at line ~98).
- Errors at startup gates print remediation and fail loudly; empty catches
  carry an intent comment.
- Tests: `node:test`, in `src/resources/extensions/gsd/tests/*.test.ts`,
  compiled to `dist-test/` before running.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0 |
| Compile tests | `pnpm run test:compile` | exit 0 |
| Run one test file | `node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/<name>.test.js` | all pass |
| Targeted existing suites | run `db-engine-logs`, `db-migration-steps`, `db-migration-steps.integration`, `gsd-db`, `migrate-safety-audit` (if present), `flat-phase-migration` test files via the single-file command | all pass |

Do NOT run the full `pnpm run test:unit` on every edit — it is slow and known
to flake under process-isolation contention. Run affected files standalone;
run the full suite once at the end if you want a final sweep, and re-check any
failure standalone before attributing it to your change.

## Scope

**In scope** (the only files you should modify):
- `src/resources/extensions/gsd/db/engine.ts`
- `src/resources/extensions/gsd/db-schema-metadata.ts`
- `src/resources/extensions/gsd/migrate/execution.ts`
- `src/resources/extensions/gsd/tests/db-engine-migrate-guards.test.ts` (create)
- `src/resources/extensions/gsd/tests/workflow-migration-gates.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- `src/resources/extensions/gsd/flat-phase-migration.ts` and the legacy/flat
  layout seam — governed by ADR-045 (`docs/dev/ADR-045-flat-phase-layout-completion.md`), maintainer decision pending.
- `src/resources/extensions/gsd/db-migration-steps.ts` — the individual
  migration steps are correct; do not restructure them.
- `db-provider.ts` / provider fallback packaging.
- Any change to `SCHEMA_VERSION` itself.

## Git workflow

- Branch: `advisor/026-schema-version-and-migration-safety`
- Conventional commits, one per step, e.g. `fix(gsd-db): refuse to open a newer-schema gsd.db`. Do not credit AI in commit messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Harden `getCurrentSchemaVersion` against the empty-table NULL

In `db-schema-metadata.ts`, make the function return `0` when the table is
empty or the value is not a number:

```ts
export function getCurrentSchemaVersion(db: DbAdapter): number {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  const v = row?.["v"];
  return typeof v === "number" ? v : 0;
}
```

**Verify**: `pnpm run typecheck:extensions` → exit 0.

### Step 2: Add the newer-DB refusal in `migrateSchema`

In `db/engine.ts`, immediately after `const currentVersion = getCurrentSchemaVersion(db);`,
add:

```ts
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `gsd.db schema is v${currentVersion}, newer than the v${SCHEMA_VERSION} this gsd-pi supports. ` +
      `Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) return;
```

(replacing the current `>=` early return). Check how `migrateSchema`'s caller
handles a throw: the open path must fail loudly with this message rather than
swallowing it — if you find a catch that downgrades it to a warning and
continues with the connection open, extend that catch to close the connection
and rethrow for this specific error. Match `engine.ts`'s existing error/log
style.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/db-engine-migrate-guards.test.js` — write the test in step 5 first if you prefer test-first; otherwise re-run this verify after step 5.

### Step 3: Guard the fresh-install stamp against non-empty databases

First, investigate reachability: `git log --oneline --follow -- src/resources/extensions/gsd/db/engine.ts | tail -5`
and `git log -S 'schema_version' --oneline -- src/resources/extensions/gsd | tail -5`
to see whether `schema_version` has existed since the engine's first commit.

- If it has always existed, the "legacy DB without version rows" path is
  defensive only — implement the cheap guard below anyway (it also covers an
  externally truncated version table), but say so in the commit message.

In `initSchema`, before stamping `SCHEMA_VERSION` on `cnt === 0`, probe for
pre-existing user data:

```ts
    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      const hasData = ["milestones", "decisions", "memories"].some((t) => {
        try {
          const r = db.prepare(`SELECT count(*) as cnt FROM ${t}`).get();
          return ((r?.["cnt"] as number) ?? 0) > 0;
        } catch { /* table absent on a truly fresh DB — treat as no data */ return false; }
      });
      if (hasData) {
        // Legacy DB with data but no version row: record the baseline so
        // migrateSchema runs the full chain instead of stamping v29.
        recordSchemaVersion(db, 1);
      } else {
        // ... existing fresh-install block unchanged ...
      }
    }
```

The three table names above are literals chosen here, not caller input — no
interpolation concern. Keep the existing fresh block exactly as is in the
`else`.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/gsd-db.test.js` → all pass (fresh-DB creation still works).

### Step 4: Close the workflow DB before (and after) migration restore

In `migrate/execution.ts`, import `closeWorkflowDatabase` from
`../db-workspace.js` (same import `migrate/safety.ts` uses at line 10), and
change the catch:

```ts
  } catch (error) {
    // The import transaction may have committed and the process may hold an
    // open handle to the target gsd.db; close before the restore replaces the
    // file on disk, and leave closed so the next open rebinds to the restored file.
    try { closeWorkflowDatabase(); } catch { /* best-effort: restore must proceed */ }
    restoreMigrationTarget(backup);
    throw error;
  }
```

**Verify**: `pnpm run typecheck:extensions` → exit 0, then run the existing
migrate tests: `node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/migrate-writer.test.js dist-test/src/resources/extensions/gsd/tests/migrate-transformer.test.js` (adjust to the actual migrate test filenames present in `dist-test/`) → all pass.

### Step 5: Add a migration rollback/atomicity test (with a `ForTest` fault seam)

In `db/engine.ts`, add a module-level fault seam following the existing
underscore-`ForTest` convention:

```ts
let _migrationFaultForTest: boolean = false;
/** Test-only: force migrateSchema to throw after applying its steps but before COMMIT. */
export function _setMigrationFaultForTest(v: boolean): void { _migrationFaultForTest = v; }
```

Inside `migrateSchema`'s `try`, immediately before `db.exec("COMMIT")`, add:

```ts
    if (_migrationFaultForTest) throw new Error("migration fault injected for test");
```

Create `tests/db-engine-migrate-guards.test.ts` (model structure after
`tests/db-migration-steps.integration.test.ts`) covering:

1. **Newer-DB refusal**: open a fresh DB, then manually
   `recordSchemaVersion(db, SCHEMA_VERSION + 1)` (or raw INSERT), close, reopen
   → expect the open to throw with a message containing "newer than".
2. **Rollback atomicity**: build a DB at an older schema version (reuse however
   `db-migration-steps.integration.test.ts` constructs old-version fixtures),
   call `_setMigrationFaultForTest(true)`, attempt the open/migration → expect
   a throw; then verify `SELECT MAX(version) FROM schema_version` still equals
   the starting version and a table/column introduced by a later migration is
   absent. Reset the seam in `finally`.
3. **Legacy-data guard**: create a DB, insert one `milestones` row, delete all
   `schema_version` rows, reopen → expect the DB to be treated as version 1
   (migrations run; final version is `SCHEMA_VERSION`) rather than stamped
   without migrating — assert via a column that only a migration adds
   (pick one from `db-migration-steps.ts`, e.g. an `ensureColumn` target).

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/db-engine-migrate-guards.test.js` → all new tests pass.

### Step 6: Cover the auto-migration gates

Create `tests/workflow-migration-gates.test.ts` with unit tests for:

- `needsAutoMigration` returns `false` when the `milestones` table has rows;
  returns `true`/`false` per its documented trigger for a legacy-markdown
  fixture vs a fresh project (read `workflow-migration.ts:20-60` first and test
  what the gate actually checks — construct fixtures accordingly).
- `validateMigration` reports a discrepancy when the DB counts diverge from
  the markdown fixture, and reports none for a matching pair.

Model the DB/fixture setup after an existing test that already builds a
temp-project DB (e.g. `tests/gsd-db.test.ts` or the md-importer tests).

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/workflow-migration-gates.test.js` → all pass.

## Test plan

Covered by steps 5–6. Regression sweep: run the existing `db-engine-logs`,
`db-migration-steps` (unit + integration), `gsd-db`, `worktree-db`,
`flat-phase-migration` test files standalone → all pass.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] New tests in `db-engine-migrate-guards.test.ts` and `workflow-migration-gates.test.ts` exist and pass
- [ ] `grep -n 'currentVersion >= SCHEMA_VERSION' src/resources/extensions/gsd/db/engine.ts` returns no matches (replaced by the two-branch guard)
- [ ] `grep -n 'closeWorkflowDatabase' src/resources/extensions/gsd/migrate/execution.ts` returns a match in the catch path
- [ ] Existing migration/db test files listed above pass standalone
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `migrateSchema` / `initSchema` code no longer matches the excerpts
  (drift since `f095797f`).
- The open path's error handling swallows the newer-DB throw somewhere you
  cannot cleanly extend (e.g. a broad catch in `db-provider.ts` or callers) —
  report where, don't weaken the guard to a warning on your own.
- Building an old-version DB fixture for step 5 requires more than reusing the
  existing fixture helpers — do not hand-craft multi-version DDL from scratch.
- `needsAutoMigration`'s actual trigger logic differs materially from "empty
  milestones table + legacy markdown present" — report what it really checks
  instead of guessing fixtures.

## Maintenance notes

- Any future `SCHEMA_VERSION` bump now has a hard compatibility edge: older
  binaries refuse instead of corrupting. Release notes should mention that
  mixed-version worktrees must update together.
- The fault seam `_setMigrationFaultForTest` tests the whole-chain rollback
  only; it does not prove each individual step is transactional under
  implicit-commit DDL. If a future step uses DDL that implicitly commits in
  SQLite, the rollback test will NOT catch it — reviewers should check new
  steps for that class.
- Deferred (recorded in `plans/README.md` unplanned list): the `.planning`
  transformer's silent data-loss paths (duplicate phase numbers, phase-less
  milestones) in `migrate/transformer.ts`.
